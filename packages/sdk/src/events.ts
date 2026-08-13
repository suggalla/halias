import { ethers } from "ethers";
import { PoolTrees } from "./merkle";
import { buildEntry, OwnedEntry, POOL_LEVELS } from "./entry";
import { decodeOutputBlob, tryDecryptOutput, poseidonHash } from "./crypto";

export const TRANSACT_ABI = [
  "event Transact(uint256 publicAmount, address indexed tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1, bytes32 outputCommitment0, bytes32 outputCommitment1, uint32 outputTreeNumber, uint32 outputLeafIndex0, uint32 outputLeafIndex1, bytes encryptedOutput0, bytes encryptedOutput1)",
  // An exit spent its inputs and created nothing, so it moves the nullifier set but not the
  // tree. Its own event rather than a flag on Transact: a scanner that inserted for one of
  // these would build a tree that silently disagrees with the contract's, and the only
  // symptom is every proof afterwards being rejected.
  "event PoolExit(uint256 publicAmount, address indexed tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1)",
];
export const REGISTRY_ABI = [
  "event AliasRegistered(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 leaf, bytes32 encryptionPubkey, uint32 slot)",
  "event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 dataHash, bytes32 leaf)",
  // Renamed with the split: the registry moves keys, the domain moves ownership, so
  // the previous/new owner arguments are no longer part of this event.
  "event AliasReassigned(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 leaf, bytes32 encryptionPubkey)",
];

// Pool commitments are addressed by (tree, leaf). A single ordering key keeps sorting and map
// identity simple, and matches the global index the nullifier keys on — POOL_LEVELS is
// imported rather than redeclared, because two copies could drift and the one in entry.ts is
// the one the nullifier uses.
export const globalIndex = (treeNumber: number, leafIndex: number) =>
  treeNumber * (1 << POOL_LEVELS) + leafIndex;

const DEFAULT_CHUNK_SIZE = 2_000;
const DELAY_MS = 50;
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface Output {
  commitment: bigint;
  /// Which tree holds it. The pool is a sequence of trees, so this and `leafIndex` together
  /// are the note's address — and both feed the nullifier.
  treeNumber: number;
  leafIndex: number;
  encryptedBlob: string;
  tokenAddress: bigint;
  spentNullifiers: [bigint, bigint];
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  /// Signed in the field: positive is a deposit, field-negative a withdrawal, zero a
  /// private transfer. Kept because it is the only thing that distinguishes those three
  /// after the fact — the commitments look identical.
  publicAmount: bigint;
  txHash: string;
}

export interface RegistryEntry {
  aliasHash: string;
  /// Where the alias was registered. Kept so a client can show its own registration in a
  /// history built from pool events, which carry no record of it — registering touches the
  /// registry and the domain, never the pool.
  txHash: string;
  blockNumber: number;
  registrySlot: number;        // position in the SMT, assigned at registration and never reused
  spendingPubkey: bigint;
  encryptionPubkey: Uint8Array;
  dataHash: bigint;
}

export interface ScanResult {
  poolTrees: PoolTrees;
  outputs: Output[];
  registryEntries: RegistryEntry[];
  aliasHashByPubkey: Map<bigint, bigint>;
  /// aliasHash → the plaintext registered under it, for those that published one.
  ///
  /// One-shot and set at registration, so this never goes stale. An alias registered without
  /// a name — an invite account, whose aliasHash is random — simply has no entry.
  namesByAlias: Map<string, string>;
  /// Spending pubkey → the block at which it became an alias's key.
  ///
  /// Not the same as the alias's registration block. A handover installs the new owner's
  /// keys, and notes sent before that were encrypted to the previous owner's — so for a
  /// received alias this is the reassignment, not the original registration.
  ///
  /// Nothing before it can decrypt to that key, which is what lets a scan skip the
  /// X25519 derivation for every output older than it.
  keyActiveFrom: Map<bigint, number>;
  spentNullifiers: Set<bigint>;
  /// The last block this result is known to include. Resume from `scannedThrough + 1`.
  ///
  /// Deliberately the block number read *before* the final chunk, not after. That chunk ends
  /// at "latest", which the node resolves to something at or beyond it, so the scan covers at
  /// least this far and possibly further. Reporting the conservative bound re-reads a few
  /// blocks on the next pass instead of skipping any — and the merge below is idempotent
  /// precisely so that overlap is free.
  scannedThrough: number;
  /// How many outputs this pass actually decrypted, as opposed to inherited. Diagnostic:
  /// it is the number that should be small once a cache is warm.
  newOutputs: Output[];
}

export async function scanEvents(
  provider: ethers.Provider,
  // Pool and registry are separate contracts since the split, so their logs come from
  // separate addresses. Passing one address for both silently yields an empty registry.
  poolAddress: string,
  registryAddress: string,
  /// Also scanned, for {NamePublished} alone. The plaintext behind an aliasHash exists
  /// nowhere else: the hash is one-way, and a client that loses local storage cannot
  /// recover the name it registered without this. It was being published and never read.
  controllerAddress: string,
  fromBlock: number = 0,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  onProgress?: (pct: number) => void,
  /// Everything an earlier scan already established. Given this, `fromBlock` should be
  /// `prior.scannedThrough + 1` and only the difference is fetched, decrypted and hashed.
  ///
  /// Merging rather than replacing is the whole point. Rebuilding from the events of a
  /// partial range alone would produce a registry tree containing only the aliases in that
  /// range, and a pool tree starting at whatever leaf the range began with — both of which
  /// disagree with the contract, and neither of which announces itself.
  prior?: ScanResult,
): Promise<ScanResult> {
  const jsIface        = new ethers.Interface(TRANSACT_ABI);
  const regIface       = new ethers.Interface(REGISTRY_ABI);
  const jsTopic        = jsIface.getEvent("Transact")!.topicHash;
  const exitTopic      = jsIface.getEvent("PoolExit")!.topicHash;
  const regTopic       = regIface.getEvent("AliasRegistered")!.topicHash;
  // There is no KeysUpdated: rotating keys goes through offer-to-self and accept, which
  // emits AliasReassigned like any other handover.
  const dataUpdTopic   = regIface.getEvent("AliasDataUpdated")!.topicHash;
  const transferTopic  = regIface.getEvent("AliasReassigned")!.topicHash;
  const nameIface      = new ethers.Interface(["event NamePublished(bytes32 indexed aliasHash, string name)"]);
  const nameTopic      = nameIface.getEvent("NamePublished")!.topicHash;
  // Filtered at the node rather than in JS. Without this, adding the domain would drag in
  // every transfer, offer and commitment it emits only to discard them here.
  const wanted = [jsTopic, exitTopic, regTopic, dataUpdTopic, transferTopic, nameTopic];

  // Used only to size the chunks. It is deliberately NOT the upper bound of the last one:
  // ethers caches getBlockNumber(), so a value read here can already be behind by the time
  // the scan runs. A transaction that just landed then falls outside the range and its logs
  // are silently dropped — which looks like "my registration did not happen" rather than
  // like a stale read, and is invisible until something downstream reads an empty set.
  const latestBlock = await provider.getBlockNumber();

  const allLogs: ethers.Log[] = [];
  let cur = fromBlock;
  const total = latestBlock - fromBlock;
  // At least one request, always, even when fromBlock is already past `latestBlock`.
  //
  // That happens routinely on a resumed scan: `latestBlock` comes from the provider, which
  // updates its view by polling and lags the node — awaiting a receipt does not advance it.
  // So a refresh straight after a transaction asks to resume from a block the provider does
  // not believe exists yet, and a `cur <= latestBlock` loop makes no request at all. The
  // transaction's own outputs are then missed until some later refresh, and a balance read
  // in between is simply wrong.
  //
  // A full rescan never saw this: it started far below `latestBlock`, so the loop always ran
  // and its final chunk ended at "latest" — resolved by the node, which does know about the
  // block just mined. Ending at "latest" is what makes one request sufficient here too.
  for (;;) {
    const isLast = cur + chunkSize - 1 >= latestBlock;
    const end = Math.min(cur + chunkSize - 1, latestBlock);
    if (onProgress) onProgress(Math.floor(((cur - fromBlock) / (total || 1)) * 100));
    // The final chunk ends at "latest", resolved by the node, so anything mined since the
    // block number was read is still picked up.
    const chunk = await provider.getLogs({
      address: [poolAddress, registryAddress, controllerAddress],
      topics: [wanted],
      fromBlock: cur,
      toBlock: isLast ? "latest" : end,
    });
    allLogs.push(...chunk);
    if (isLast) break;
    cur = end + 1;
    await delay(DELAY_MS);
  }
  if (onProgress) onProgress(100);

  const outputsByGlobalIndex = new Map<number, Output>();
  const spentNullifiers = new Set<bigint>(prior?.spentNullifiers ?? []);
  // Seeded from the prior scan so an AliasDataUpdated or AliasReassigned in this range can
  // still find the registration it amends, which may have happened thousands of blocks ago.
  // Without this a rotation would land as a record with no slot and no history.
  const registryByAlias = new Map<string, RegistryEntry>(
    (prior?.registryEntries ?? []).map((e) => [e.aliasHash, { ...e }]),
  );
  const aliasHashByPubkey = new Map<bigint, bigint>(prior?.aliasHashByPubkey ?? []);
  const keyActiveFrom = new Map<bigint, number>(prior?.keyActiveFrom ?? []);
  const namesByAlias = new Map<string, string>(prior?.namesByAlias ?? []);

  for (const log of allLogs) {
    const topic = log.topics[0];

    if (topic === jsTopic) {
      const e = jsIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const tokenAddress = BigInt(e.args[1]);
      const null0 = BigInt(e.args[2]);
      const null1 = BigInt(e.args[3]);
      spentNullifiers.add(null0);
      spentNullifiers.add(null1);

      const comm0 = BigInt(e.args[4]);
      const comm1 = BigInt(e.args[5]);
      const tree  = Number(e.args[6]);
      const idx0  = Number(e.args[7]);
      const idx1  = Number(e.args[8]);
      const blob0 = e.args[9];
      const blob1 = e.args[10];

      const base = {
        treeNumber: tree,
        spentNullifiers: [null0, null1] as [bigint, bigint],
        tokenAddress,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        publicAmount: BigInt(e.args[0]),
        txHash: log.transactionHash,
      };
      // Keyed on the global position, since a leaf index alone is no longer unique.
      outputsByGlobalIndex.set(globalIndex(tree, idx0),
        { commitment: comm0, leafIndex: idx0, encryptedBlob: blob0, ...base });
      outputsByGlobalIndex.set(globalIndex(tree, idx1),
        { commitment: comm1, leafIndex: idx1, encryptedBlob: blob1, ...base });

    } else if (topic === exitTopic) {
      // Nullifiers only. Nothing was inserted, so the tree must not advance here.
      const e = jsIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      spentNullifiers.add(BigInt(e.args[2]));
      spentNullifiers.add(BigInt(e.args[3]));

    } else if (topic === regTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash      = e.args[0] as string;
      const spendingPubkey = BigInt(e.args[1]);
      const entry: RegistryEntry = {
        aliasHash,
        txHash:            log.transactionHash,
        blockNumber:       log.blockNumber,
        registrySlot:      Number(e.args[4]) - 1,  // stored offset by one on-chain
        spendingPubkey,
        encryptionPubkey:  ethers.getBytes(e.args[3]),
        dataHash:          0n,
      };
      registryByAlias.set(aliasHash, entry);
      keyActiveFrom.set(entry.spendingPubkey, log.blockNumber);
      aliasHashByPubkey.set(spendingPubkey, BigInt(aliasHash));

    } else if (topic === dataUpdTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash = e.args[0] as string;
      const existing = registryByAlias.get(aliasHash);
      if (existing) {
        existing.dataHash = BigInt(e.args[1]);
        registryByAlias.set(aliasHash, existing);
      }

    } else if (topic === nameTopic) {
      const e = nameIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      namesByAlias.set(e.args[0] as string, e.args[1] as string);

    } else if (topic === transferTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash = e.args[0] as string;
      // AliasReassigned is (aliasHash, spendingPubkey, leaf, encryptionPubkey). The old
      // AliasTransferred carried the two owner addresses as well, so every index here
      // shifted by two when the registry stopped tracking ownership.
      const newSpendingPubkey = BigInt(e.args[1]);
      const existing = registryByAlias.get(aliasHash);
      const entry: RegistryEntry = {
        aliasHash,
        txHash:           existing ? existing.txHash : log.transactionHash,
        blockNumber:      existing ? existing.blockNumber : log.blockNumber,
        registrySlot:     existing ? existing.registrySlot : 0,  // reassignment keeps the slot
        spendingPubkey:  newSpendingPubkey,
        encryptionPubkey: ethers.getBytes(e.args[3]),
        dataHash:         0n,
      };
      registryByAlias.set(aliasHash, entry);
      keyActiveFrom.set(entry.spendingPubkey, log.blockNumber);
      if (existing) {
        aliasHashByPubkey.delete(existing.spendingPubkey);
        keyActiveFrom.delete(existing.spendingPubkey);
      }
      aliasHashByPubkey.set(newSpendingPubkey, BigInt(aliasHash));
      keyActiveFrom.set(newSpendingPubkey, log.blockNumber);

    }
  }

  // Sorted by global position, so trees are filled in the order the chain filled them —
  // which PoolTrees.insert asserts, because building on a gap yields a tree that silently
  // disagrees with the contract's.
  //
  // Anything the prior scan already holds is dropped first. The resumed range deliberately
  // overlaps (see `scannedThrough`), and re-inserting a leaf would not merely duplicate it —
  // insert() would throw, because the index is no longer the next free slot.
  //
  // The test is the tree's own leaf count, not a record of which outputs were seen. Trees
  // fill sequentially, so the count is exactly the boundary between known and new — and it
  // survives a cache round-trip, which a list of outputs does not. Keying this off
  // `prior.outputs` was wrong for that reason: a client resuming from cache has the trees but
  // not the outputs, so every overlapping leaf looked new and insert() threw a scan gap.
  const newOutputs = [...outputsByGlobalIndex.values()]
    .filter((o) => o.leafIndex >= (prior?.poolTrees.leafCount(o.treeNumber) ?? 0))
    .sort((a, b) => globalIndex(a.treeNumber, a.leafIndex) - globalIndex(b.treeNumber, b.leafIndex));

  const poolTrees = prior?.poolTrees ?? new PoolTrees();
  for (const out of newOutputs) {
    poolTrees.insert(out.treeNumber, out.leafIndex, out.commitment);
  }
  const outputs = [...(prior?.outputs ?? []), ...newOutputs];

  const registryEntries = [...registryByAlias.values()];

  return {
    poolTrees, outputs, registryEntries, aliasHashByPubkey, keyActiveFrom, namesByAlias,
    spentNullifiers,
    // Never below where this scan began: a lagging provider must not make the resume point
    // travel backwards.
    scannedThrough: Math.max(latestBlock, fromBlock - 1),
    newOutputs,
  };
}


export function findMyOutputs(
  outputs: Output[],
  spendingPubkey: bigint,
  nullifierKey: bigint,   // raw key — hashed internally before commitment check
  encryptionPrivKey: Uint8Array,
  // Undefined means every asset. Defaulting to ETH here silently discarded every ERC-20
  // note during refresh(), so a token deposit landed on chain and the client reported a
  // zero balance for it.
  tokenAddress?: bigint,
): OwnedEntry[] {
  const nullifierKeyHash = poseidonHash([nullifierKey, 1n]);
  const found: OwnedEntry[] = [];
  for (const out of outputs) {
    if (tokenAddress !== undefined && out.tokenAddress !== tokenAddress) continue;
    const decoded = decodeOutputBlob(out.encryptedBlob);
    if (!decoded) continue;
    const decrypted = tryDecryptOutput(decoded, encryptionPrivKey);
    if (!decrypted) continue;
    const entry = buildEntry(spendingPubkey, nullifierKeyHash, decrypted.blinding, decrypted.amount, out.tokenAddress);
    if (entry.commitment !== out.commitment) continue;
    found.push({ ...entry, treeNumber: out.treeNumber, leafIndex: out.leafIndex });
  }
  return found;
}
