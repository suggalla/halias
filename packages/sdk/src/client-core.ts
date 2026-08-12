import { ethers } from "ethers";
import { normalizeAlias } from "./alias";
import {
  init as initCrypto,
  deriveRoot,
  deriveKeysFromRoot,
  poseidonHash,
  encryptOutput,
  encodeOutputBlob,
  HaliasKeys,
  Signer,
} from "./crypto";
import { buildEntry, computeNullifier, randomBlinding, OwnedEntry, ETH_TOKEN_ADDRESS } from "./entry";
import { MerkleTree, PoolTrees } from "./merkle";
import { SMT, aliasHashToSmtKey } from "./smt";
import { proveTransact, dummyInput, dummyOutput, TransactOutput } from "./proof";
import { scanEvents, findMyOutputs, Output, RegistryEntry } from "./events";
import { deriveInviteKeys, InviteKeys, encodeInviteCode } from "./invite";
import {
  getPool,
  getRegistry,
  getDomain,
  transact as contractTransact,
  register as contractRegister,
  updateAliasData as contractUpdateAliasData,
  lookupAlias as contractLookupAlias,
  claim as contractClaim,
  encodeRegistration,
  computeParamsHash,
  TransactParams,
  ZERO_TRANSACT_PARAMS,
  NO_RELAYER,
} from "./contract";
import { CacheStore, serializeCache, deserializeCache } from "./cache";
import { randomBytes, toHex } from "./random";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const REGISTRY_LEVELS = 32;

export interface HaliasConfig {
  provider: ethers.Provider;
  signer: ethers.Signer & Signer;
  chainId: number;
  // Three contracts since the split. The pool hashes its own address into
  // paramsHash, so poolAddress is the one that must be right for a proof to verify.
  poolAddress: string;
  registryAddress: string;
  domainAddress: string;
  artifacts: {
    transactWasm: string;
    transactZkey: string;
  };
  cache?: CacheStore;
  startBlock?: number;
  rpcChunkSize?: number;
  onProgress?: (pct: number) => void;
}

export interface DepositResult  { txHash: string; commitment: bigint; amount: bigint }
export interface SendResult {
  /// Empty when prepared rather than sent — nothing was broadcast.
  txHash: string;
  commitment: bigint;
  amount: bigint;
  /// Present only for a prepared transfer: the transaction, for someone else to submit.
  relayBlob?: string;
}
export interface WithdrawResult {
  /// Empty when prepared rather than sent — nothing was broadcast.
  txHash: string;
  recipient: string;
  amount: bigint;
  /// Present only for a prepared withdrawal: the transaction, for someone else to submit.
  relayBlob?: string;
}
export interface BalanceResult  { total: bigint; entries: OwnedEntry[] }
export interface LookupResult   { spendingPubkey: bigint; nullifierKeyHash: bigint; encryptionPubkey: Uint8Array; dataHash: bigint }
// secret is the whole invite — anyone holding it can claim the note. Treat it like cash.
export interface InviteResult   { txHash: string; secret: bigint; inviteCode: string; amount: bigint }
export interface ScanEntry      extends OwnedEntry { spent: boolean }


/// State, synchronisation, and the small derivations every operation depends on.
///
/// Split from the operations because the two change for different reasons: this is how the
/// client knows what it owns, and {Halias} is what it can do about it. Members are
/// `protected` rather than `private` so the operations can reach them and nothing outside
/// the package can.
export abstract class HaliasCore {
  protected config: HaliasConfig;
  protected pool: ethers.Contract;
  protected registry: ethers.Contract;
  protected domain: ethers.Contract;
  protected keys: HaliasKeys | null = null;
  protected poolTrees: PoolTrees = new PoolTrees();

  /// The (root, tree) pair an input names.
  ///
  /// A real note names the tree that holds it; its root is that tree's — frozen and published
  /// if the tree has rolled over, current otherwise, and either way permanently accepted. A
  /// dummy input proves nothing but the pool still checks the pair it names, so it borrows the
  /// real input's, or the newest tree when the transaction has no real input at all. Tree 0's
  /// empty root is published by the pool's constructor, so that case is covered on a fresh
  /// chain too.
  protected poolAnchor(treeNumber?: number): { root: bigint; tree: number } {
    const tree = treeNumber ?? this.poolTrees.latest;
    return { root: this.poolTrees.tree(tree).getRoot(), tree };
  }
  protected smt: SMT = new SMT();
  protected aliasHashByPubkey = new Map<bigint, bigint>(); // spendingPubkey → aliasHash (bigint)
  protected registryEntries: RegistryEntry[] = [];
  protected myEntries: OwnedEntry[] = [];
  protected allOutputs: Output[] = [];
  protected spentNullifiers = new Set<bigint>();
  protected nextDummyIdx = 0;
  protected selfAliasHash: bigint | null = null;
  protected lastBlock = 0;
  protected synced = false;
  protected initialized = false;
  protected aliasIndex = 0;
  protected root: bigint | null = null;

  constructor(config: HaliasConfig) {
    this.config = config;
    this.pool     = getPool(config.poolAddress, config.signer);
    this.registry = getRegistry(config.registryAddress, config.signer);
    this.domain   = getDomain(config.domainAddress, config.signer);
  }

  /// Bind this client to one alias identity.
  ///
  /// `aliasIndex` selects which alias of the wallet's set this client acts as. Each index
  /// has its own spending key, nullifier key and encryption key, so balances and notes do
  /// not merge across aliases. One signature covers all of them, so switching alias costs
  /// no extra prompt.
  /// `root` skips the signature prompt when the caller already has it. Anything building
  /// more than one client — enumerating aliases, switching between them — must pass it, or
  /// the wallet asks for a signature per client and the UI turns into a prompt loop.
  async init(aliasIndex: number = 0, root?: bigint): Promise<void> {
    await initCrypto();
    this.aliasIndex = aliasIndex;
    this.root = root ?? (await deriveRoot(this.config.signer));
    this.keys = deriveKeysFromRoot(this.root, aliasIndex);
    this.initialized = true;
  }

  /// The wallet-level secret behind every alias. Exposed so a caller can derive further
  /// clients without another prompt; it never leaves the browser.
  get derivationRoot(): bigint {
    if (this.root === null) throw new Error("Call init() first");
    return this.root;
  }

  /// Which alias of the wallet's set this client is acting as.
  get index(): number {
    return this.aliasIndex;
  }

  protected ensureInit() {
    if (!this.initialized) throw new Error("Call init() first");
  }

  protected async ensureSync(): Promise<void> {
    if (this.synced) return;
    await this.loadCache();
    await this.refresh();
    this.synced = true;
  }

  /// Chain *and* pool. Keying on the chain alone means a redeploy to the same chain silently
  /// reuses the previous pool's Merkle tree, spent-nullifier set and block height — all of
  /// which describe contracts that no longer exist. Nothing detects it, because the cache
  /// looks perfectly valid; scanning simply starts from the wrong place against the wrong
  /// tree. Including the address makes a redeploy a cache miss, which is what it is.
  protected cacheKey(): string {
    return `${this.config.chainId}:${this.config.poolAddress.toLowerCase()}`;
  }

  protected async loadCache(): Promise<void> {
    if (!this.config.cache) return;
    const raw = await this.config.cache.load(this.cacheKey());
    if (!raw) return;
    try {
      const d = deserializeCache(raw);
      this.poolTrees = d.poolTrees;
      this.smt = d.smt;
      this.registryEntries = d.registryEntries;
      this.aliasHashByPubkey = d.aliasHashByPubkey;
      this.spentNullifiers = d.spentNullifiers;
      this.lastBlock = d.lastBlock;
    } catch (e) {
      console.warn("Failed to load cache:", e);
    }
  }

  protected async saveCache(): Promise<void> {
    if (!this.config.cache) return;
    const raw = serializeCache({
      poolTrees: this.poolTrees,
      smt: this.smt,
      registryEntries: this.registryEntries,
      aliasHashByPubkey: this.aliasHashByPubkey,
      spentNullifiers: this.spentNullifiers,
      lastBlock: this.lastBlock,
    });
    await this.config.cache.save(this.cacheKey(), raw);
  }

  async refresh(): Promise<void> {
    this.ensureInit();
    // Always rescan from the deployment block rather than from lastBlock + 1.
    //
    // scanEvents rebuilds the registry SMT from the events it sees, and the assignments
    // below replace rather than merge, so an incremental scan would return a tree built
    // only from the new range and silently discard every earlier registration. Combined
    // with lastBlock jumping to head after the first scan, a freshly registered account
    // could not find itself — which is exactly what the live Sepolia run hit.
    //
    // Rescanning is correct but O(history); making scanEvents merge into an existing
    // tree, so the cache can warm-start an incremental scan, is the follow-up.
    const fromBlock = this.config.startBlock ?? 0;
    const result = await scanEvents(
      this.config.provider,
      this.config.poolAddress,
      this.config.registryAddress,
      fromBlock,
      this.config.rpcChunkSize,
      this.config.onProgress,
    );

    // Rebuilt from scratch, so start from empty trees rather than appending to the
    // commitments already inserted by a previous refresh. scanEvents has already assembled
    // and order-checked them, so take its set rather than replaying the outputs here — two
    // places building the same trees is two places to disagree with the contract.
    this.poolTrees = result.poolTrees;

    // Update SMT
    this.smt = result.smt;
    this.registryEntries = result.registryEntries;
    this.aliasHashByPubkey = result.aliasHashByPubkey;

    this.spentNullifiers = new Set(result.spentNullifiers);

    this.lastBlock = await this.config.provider.getBlockNumber();

    // Find our own regular outputs
    const keys = this.keys!;
    this.myEntries = findMyOutputs(
      result.outputs,
      keys.spendingPubkey,
      keys.nullifierKey,
      keys.encryption.privateKey,
    );

    // Retained so an invite claimer can locate the note belonging to a derived keypair.
    // Assigned, not appended: refresh() rescans from the start, so appending would
    // duplicate every output on each call.
    this.allOutputs = result.outputs;

    await this.saveCache();
  }

  protected consumeDummyIdx(count: number): number {
    const start = this.nextDummyIdx;
    this.nextDummyIdx += count;
    return start;
  }

  protected getArtifacts(): { wasmPath: string; zkeyPath: string } {
    return {
      wasmPath: this.config.artifacts.transactWasm,
      zkeyPath: this.config.artifacts.transactZkey,
    };
  }


  // ── Small shared derivations ───────────────────────────────────────────────
  //
  // Each of these was written out at four to seven call sites. They are one-liners, but
  // they are the kind that must agree everywhere: an alias hashed differently in two
  // places resolves to two different registry entries, and a blob encrypted to the wrong
  // key produces a note nobody can find.

  /// `alice`, `alice.hls`, `ALICE` all resolve to the same registry entry.
  protected aliasHashOf(alias: string): bigint {
    const clean = normalizeAlias(alias);
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes(clean + ".hls")));
  }

  /// The published form of our nullifier key. The raw key never leaves the client.
  protected myNullifierKeyHash(): bigint {
    return poseidonHash([this.keys!.nullifierKey, 1n]);
  }

  /// Ciphertext for an output note, in the layout scanners expect. `to` defaults to our
  /// own encryption key, which is what every change output wants.
  protected sealNote(blinding: bigint, amount: bigint, to?: Uint8Array): string {
    return encodeOutputBlob(encryptOutput(blinding, amount, to ?? this.keys!.encryption.publicKey));
  }

  /// A zero-value filler output and its commitment, for the second slot of a 2-out proof.
  protected filler(tokenAddress: bigint): { out: TransactOutput; commitment: bigint } {
    const out = dummyOutput(randomBlinding());
    return {
      out,
      commitment: poseidonHash([out.pubkey, out.nullifierKeyHash, out.blinding, out.amount, tokenAddress]),
    };
  }

  /// Wait for inclusion, then resync. Every mutating call ends this way: skipping the
  /// resync leaves the client's view of its own notes behind the chain.
  protected async settle(tx: ethers.ContractTransactionResponse): Promise<string> {
    const receipt = await tx.wait();
    await this.refresh();
    return receipt!.hash;
  }

  // Identity and position are separate, matching the circuit: aliasHash is the
  // field-reduced key hashed into the leaf, registrySlot is the tree position the
  // contract assigned. aliasHash must be reduced — a raw 256-bit keccak is >= p about
  // 81% of the time and would not match the on-chain leaf.
  protected selfSmtProof() {
    const pubkey = this.keys!.spendingPubkey;
    const aliasHash = this.aliasHashByPubkey.get(pubkey);
    if (aliasHash === undefined) throw new Error("Account not registered or not synced");
    const entry = this.registryEntries.find(e => BigInt(e.aliasHash) === aliasHash)!;
    return {
      aliasHash: aliasHashToSmtKey(aliasHash),
      registrySlot: entry.registrySlot,
      siblings: this.smt.getSiblings(entry.registrySlot),
      dataHash: entry.dataHash,
    };
  }

  protected recipientSmtProof(pubkey: bigint) {
    const aliasHash = this.aliasHashByPubkey.get(pubkey);
    if (aliasHash === undefined) throw new Error("Recipient pubkey not found in registry");
    const entry = this.registryEntries.find(e => BigInt(e.aliasHash) === aliasHash)!;
    return {
      aliasHash: aliasHashToSmtKey(aliasHash),
      registrySlot: entry.registrySlot,
      siblings: this.smt.getSiblings(entry.registrySlot),
      dataHash: entry.dataHash,
    };
  }

  protected selectEntry(amount: bigint, tokenAddress: bigint): OwnedEntry {
    const entry = this.myEntries.find(e =>
      e.amount >= amount &&
      e.tokenAddress === tokenAddress &&
      !this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.treeNumber, e.leafIndex))
    );
    if (!entry) throw new Error("Insufficient balance or no suitable UTXO found");
    return entry;
  }

}
