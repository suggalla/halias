import { ethers } from "ethers";
import { MerkleTree, PoolTrees } from "./merkle";
import { SMT, aliasHashToSmtKey } from "./smt";
import { buildEntry, computeNullifier, OwnedEntry, ETH_TOKEN_ADDRESS, POOL_LEVELS } from "./entry";
import { decodeOutputBlob, tryDecryptOutput, poseidonHash } from "./crypto";

export const TRANSACT_ABI = [
  "event Transact(uint256 publicAmount, uint256 indexed tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1, bytes32 outputCommitment0, bytes32 outputCommitment1, uint32 outputTreeNumber, uint32 outputLeafIndex0, uint32 outputLeafIndex1, bytes encryptedOutput0, bytes encryptedOutput1)",
  // An exit spent its inputs and created nothing, so it moves the nullifier set but not the
  // tree. Its own event rather than a flag on Transact: a scanner that inserted for one of
  // these would build a tree that silently disagrees with the contract's, and the only
  // symptom is every proof afterwards being rejected.
  "event PoolExit(uint256 publicAmount, uint256 indexed tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1)",
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
  nullifierKeyHash: bigint;    // Poseidon(nullifierKey, 1) — not in events; read from contract for proof construction
  leafHash: bigint;            // Poseidon(spendingPubkey, nullifierKeyHash, dataHash) — emitted in events; used for SMT
  encryptionPubkey: Uint8Array;
  dataHash: bigint;
}

export interface ScanResult {
  poolTrees: PoolTrees;
  smt: SMT;
  outputs: Output[];
  registryEntries: RegistryEntry[];
  aliasHashByPubkey: Map<bigint, bigint>;
  spentNullifiers: Set<bigint>;
}

export async function scanEvents(
  provider: ethers.Provider,
  // Pool and registry are separate contracts since the split, so their logs come from
  // separate addresses. Passing one address for both silently yields an empty registry.
  poolAddress: string,
  registryAddress: string,
  fromBlock: number = 0,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  onProgress?: (pct: number) => void,
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

  // Used only to size the chunks. It is deliberately NOT the upper bound of the last one:
  // ethers caches getBlockNumber(), so a value read here can already be behind by the time
  // the scan runs. A transaction that just landed then falls outside the range and its logs
  // are silently dropped — which looks like "my registration did not happen" rather than
  // like a stale read, and is invisible until something downstream reads an empty set.
  const latestBlock = await provider.getBlockNumber();

  const allLogs: ethers.Log[] = [];
  let cur = fromBlock;
  const total = latestBlock - fromBlock;
  while (cur <= latestBlock) {
    const isLast = cur + chunkSize - 1 >= latestBlock;
    const end = Math.min(cur + chunkSize - 1, latestBlock);
    if (onProgress) onProgress(Math.floor(((cur - fromBlock) / (total || 1)) * 100));
    // The final chunk ends at "latest", resolved by the node, so anything mined since the
    // block number was read is still picked up.
    const chunk = await provider.getLogs({
      address: [poolAddress, registryAddress],
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
  const spentNullifiers = new Set<bigint>();
  const registryByAlias = new Map<string, RegistryEntry>();
  const aliasHashByPubkey = new Map<bigint, bigint>();

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
        nullifierKeyHash:  0n,            // not in event; fetch from contract when building proofs
        leafHash:          BigInt(e.args[2]),  // Poseidon(pubkey, nullifierKeyHash, dataHash)
        encryptionPubkey:  ethers.getBytes(e.args[3]),
        dataHash:          0n,
      };
      registryByAlias.set(aliasHash, entry);
      aliasHashByPubkey.set(spendingPubkey, BigInt(aliasHash));

    } else if (topic === dataUpdTopic) {
      const e = regIface.parseLog({ topics: log.topics as string[], data: log.data })!;
      const aliasHash = e.args[0] as string;
      const existing = registryByAlias.get(aliasHash);
      if (existing) {
        existing.dataHash = BigInt(e.args[1]);
        existing.leafHash  = BigInt(e.args[2]);
        registryByAlias.set(aliasHash, existing);
      }

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
        nullifierKeyHash: 0n,
        leafHash:         BigInt(e.args[2]),
        encryptionPubkey: ethers.getBytes(e.args[3]),
        dataHash:         0n,
      };
      registryByAlias.set(aliasHash, entry);
      if (existing) aliasHashByPubkey.delete(existing.spendingPubkey);
      aliasHashByPubkey.set(newSpendingPubkey, BigInt(aliasHash));

    }
  }

  // Sorted by global position, so trees are filled in the order the chain filled them —
  // which PoolTrees.insert asserts, because building on a gap yields a tree that silently
  // disagrees with the contract's.
  const sortedOutputs = [...outputsByGlobalIndex.values()]
    .sort((a, b) => globalIndex(a.treeNumber, a.leafIndex) - globalIndex(b.treeNumber, b.leafIndex));
  const poolTrees = new PoolTrees();
  for (const out of sortedOutputs) {
    poolTrees.insert(out.treeNumber, out.leafIndex, out.commitment);
  }

  const registryEntries = [...registryByAlias.values()];
  const smt = new SMT();
  for (const entry of registryEntries) {
    smt.update(entry.registrySlot, aliasHashToSmtKey(BigInt(entry.aliasHash)), entry.leafHash);
  }

  return { poolTrees, smt, outputs: sortedOutputs, registryEntries, aliasHashByPubkey, spentNullifiers };
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
