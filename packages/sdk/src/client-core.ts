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
import { aliasHashToSmtKey } from "./smt";
import { proveTransact, dummyInput, dummyOutput, TransactOutput } from "./proof";
import { scanEvents, findMyOutputs, Output, RegistryEntry, ScanResult } from "./events";
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
  protected aliasHashByPubkey = new Map<bigint, bigint>(); // spendingPubkey → aliasHash (bigint)
  protected keyActiveFrom = new Map<bigint, number>();     // spendingPubkey → block it became active
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

  /// Where to resume from, kept as its own record rather than a field of the main blob.
  ///
  /// Two reasons. The blob can fail to write — localStorage has a hard per-origin quota and
  /// a large pool tree reaches it — and a cursor written beside data that never landed would
  /// skip the range that data covered. And clearing the cursor alone is exactly what a full
  /// rescan is, so it costs nothing and discards nothing.
  protected cursorKey(): string {
    return `${this.cacheKey()}:cursor`;
  }

  protected async loadCache(): Promise<void> {
    if (!this.config.cache) return;
    const raw = await this.config.cache.load(this.cacheKey());
    if (!raw) return;
    try {
      const d = deserializeCache(raw);
      this.poolTrees = d.poolTrees;
      this.registryEntries = d.registryEntries;
      this.aliasHashByPubkey = d.aliasHashByPubkey;
      this.keyActiveFrom = d.keyActiveFrom;
      this.spentNullifiers = d.spentNullifiers;
      this.lastBlock = d.lastBlock;
      this.myEntries = d.myEntries;
      this.allOutputs = d.outputs;

      // The cursor is authoritative when present, and its absence means resume from nothing.
      // A blob without one was written by a build that did not keep them apart, or by a run
      // whose cursor write did not land — either way, rescanning is the safe reading.
      const cursorRaw = await this.config.cache.load(this.cursorKey());
      this.lastBlock = cursorRaw ? (JSON.parse(cursorRaw).lastBlock ?? 0) : 0;
    } catch (e) {
      console.warn("Failed to load cache:", e);
    }
  }

  protected async saveCache(): Promise<void> {
    if (!this.config.cache) return;
    const raw = serializeCache({
      poolTrees: this.poolTrees,
      registryEntries: this.registryEntries,
      aliasHashByPubkey: this.aliasHashByPubkey,
      keyActiveFrom: this.keyActiveFrom,
      spentNullifiers: this.spentNullifiers,
      lastBlock: this.lastBlock,
      myEntries: this.myEntries,
      outputs: this.allOutputs,
    });
    await this.config.cache.save(this.cacheKey(), raw);
    // Only after the data it describes is safely stored. The other order loses notes.
    await this.config.cache.save(this.cursorKey(), JSON.stringify({ lastBlock: this.lastBlock }));
  }

  /// Throw away everything learned from the chain and read it again from the deployment
  /// block.
  ///
  /// The escape hatch, and worth having a visible one. Every incremental scan depends on a
  /// cursor being right, and the failure mode when it is not is a balance that is quietly
  /// too low rather than an error — the worst shape a bug can take here. This is the answer
  /// to "my balance looks wrong" that needs no diagnosis and cannot make anything worse.
  async rescan(): Promise<void> {
    this.ensureInit();
    this.poolTrees = new PoolTrees();
    this.registryEntries = [];
    this.aliasHashByPubkey = new Map();
    this.keyActiveFrom = new Map();
    this.spentNullifiers = new Set();
    this.myEntries = [];
    this.allOutputs = [];
    this.lastBlock = 0;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.ensureInit();

    // Resume from the cache when there is one, rather than rescanning from the deployment
    // block. The scan itself is cheap; what is not is what follows it — every output costs an
    // X25519 shared-secret derivation to trial-decrypt (~541 microseconds, and several times
    // that in a browser), and every registration costs a REGISTRY_LEVELS-deep SMT path.
    // Repeating both for the entire history on every call is what made a warm client as slow
    // as a cold one.
    //
    // scanEvents merges into the state handed to it, which is what makes this safe: a partial
    // range on its own would rebuild a registry holding only the aliases it saw and a pool
    // tree starting at whatever leaf the range began with. Neither disagreement announces
    // itself — the symptom is proofs being rejected much later.
    const prior = this.lastBlock > 0 ? this.priorScan() : undefined;
    const fromBlock = prior ? this.lastBlock + 1 : (this.config.startBlock ?? 0);

    const result = await scanEvents(
      this.config.provider,
      this.config.poolAddress,
      this.config.registryAddress,
      fromBlock,
      this.config.rpcChunkSize,
      this.config.onProgress,
      prior,
    );

    this.poolTrees = result.poolTrees;
    this.registryEntries = result.registryEntries;
    this.aliasHashByPubkey = result.aliasHashByPubkey;
    this.keyActiveFrom = result.keyActiveFrom;
    this.spentNullifiers = result.spentNullifiers;
    this.allOutputs = result.outputs;

    // Conservative, and reported by the scan rather than read here: the final chunk ends at
    // "latest", so it covers at least this block and possibly more. Resuming one past it
    // re-reads a little; resuming past what was actually covered would skip notes.
    this.lastBlock = result.scannedThrough;

    // Only the outputs this pass had not already seen are trial-decrypted. Entries found by
    // earlier passes are still ours — a note does not stop being ours once it is spent, and
    // spent-ness is applied at read time from spentNullifiers, not here.
    // Trial decryption is the expensive half — one X25519 shared secret per output — and
    // nothing older than this key can possibly decrypt to it. The scan itself still runs from
    // the deployment block: the pool tree needs every commitment to produce a sibling path,
    // so events cannot be skipped, only the decryption attempts.
    const keys = this.keys!;
    const activeFrom = this.keyActiveFrom.get(keys.spendingPubkey);
    const candidates = activeFrom === undefined
      ? result.newOutputs
      : result.newOutputs.filter((o) => o.blockNumber >= activeFrom);
    const found = findMyOutputs(
      candidates,
      keys.spendingPubkey,
      keys.nullifierKey,
      keys.encryption.privateKey,
    );
    this.myEntries = prior ? [...this.myEntries, ...found] : found;


    await this.saveCache();
  }

  /// The state a resumed scan continues from, in the shape scanEvents merges into.
  private priorScan(): ScanResult {
    return {
      poolTrees: this.poolTrees,
      outputs: this.allOutputs,
      registryEntries: this.registryEntries,
      aliasHashByPubkey: this.aliasHashByPubkey,
      keyActiveFrom: this.keyActiveFrom,
      spentNullifiers: this.spentNullifiers,
      scannedThrough: this.lastBlock,
      newOutputs: [],
    };
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

  /// One past the nonce of the last transaction this client sent, or null before it has
  /// sent one. Kept locally because the node's own answer is not reliable at this moment.
  private nonceHint: number | null = null;

  /// The nonce to sign the next transaction with.
  ///
  /// ethers resolves nonces from the *pending* count, which has been observed lagging
  /// "latest" by one immediately after a receipt — so a second transaction signs with a
  /// nonce already spent and is rejected as "nonce too low". Awaiting the receipt does not
  /// close that window, and a UI sends back-to-back writes constantly.
  ///
  /// So the count this client knows it has reached wins, and the chain's answer is a floor
  /// rather than the answer. Taking the maximum covers the case the local count cannot see:
  /// the same account sending a transaction from somewhere else — a wallet UI, another tab —
  /// which would otherwise leave this hint permanently behind and every send rejected.
  protected async nextNonce(): Promise<number> {
    const onChain = await this.config.signer.getNonce("latest");
    return this.nonceHint === null ? onChain : Math.max(onChain, this.nonceHint);
  }

  /// Wait for inclusion, then resync. Every mutating call ends this way: skipping the
  /// resync leaves the client's view of its own notes behind the chain.
  protected async settle(tx: ethers.ContractTransactionResponse): Promise<string> {
    // Recorded before awaiting: this is what the client knows it consumed, whatever the node
    // reports next.
    this.nonceHint = tx.nonce + 1;
    const receipt = await tx.wait();
    await this.refresh();
    return receipt!.hash;
  }

  /// The registry witness for an alias, read from the chain rather than from a local copy.
  ///
  /// Root and siblings come back together, pinned to one block, and that is the point. They
  /// have to describe the same tree: siblings from one block against a root from another
  /// produce a proof that verifies against nothing, with no error to say why. Reading them
  /// as one value makes that impossible rather than merely unlikely.
  ///
  /// A pinned block that lags head is fine — the pool accepts any root inside
  /// REGISTRY_ROOT_MAX_AGE — so consistency is what matters here, not freshness.
  ///
  /// Identity and position stay separate, matching the circuit: aliasHash is the
  /// field-reduced key hashed into the leaf, registrySlot is the position the contract
  /// assigned. aliasHash must be reduced — a raw 256-bit keccak is >= p about 81% of the
  /// time and would not match the on-chain leaf.
  protected async registryProof(pubkey: bigint, label = "Recipient pubkey"): Promise<{
    aliasHash: bigint;
    registrySlot: number;
    siblings: bigint[];
    dataHash: bigint;
    registryRoot: bigint;
  }> {
    const aliasHash = this.aliasHashByPubkey.get(pubkey);
    if (aliasHash === undefined) throw new Error(`${label} not found in registry`);
    const h = "0x" + aliasHash.toString(16).padStart(64, "0");
    const blockTag = await this.headBlock();

    // The slot comes first because the sibling lookup needs it. The contract stores it
    // one-based so that zero reads as "unassigned", and takes the path key, which is one
    // less — the same derivation its own tree walk uses.
    const oneBased = Number(await this.registry.aliasSlot(h, { blockTag }) as bigint);
    if (oneBased === 0) {
      throw new Error(`${label} is not registered as of block ${blockTag}`);
    }
    const slot = oneBased - 1;

    const [siblings, root, record] = await Promise.all([
      this.registry.getSmtSiblings(slot, { blockTag }) as Promise<string[]>,
      this.registry.getRegistryRoot({ blockTag }) as Promise<string>,
      this.registry.aliases(h, { blockTag }) as Promise<{ dataHash: string }>,
    ]);

    return {
      aliasHash: aliasHashToSmtKey(aliasHash),
      registrySlot: slot,
      siblings: siblings.map(BigInt),
      dataHash: BigInt(record.dataHash),
      registryRoot: BigInt(root),
    };
  }

  /// The head block, read from the node rather than from the provider's view of it.
  ///
  /// `getBlockNumber()` is updated by polling and lags — awaiting a receipt does not advance
  /// it. Pinning registry reads to a stale number is not merely stale here, it is wrong: a
  /// registration that has already been mined reads as unregistered, and the witness cannot
  /// be built at all. The relay quote reads the node directly for the same reason.
  protected async headBlock(): Promise<number> {
    const raw = (this.config.provider as { send?: (m: string, p: unknown[]) => Promise<string> }).send;
    if (raw) {
      try { return Number(await raw.call(this.config.provider, "eth_blockNumber", [])); }
      catch { /* provider exposes no raw channel; fall through */ }
    }
    return this.config.provider.getBlockNumber();
  }

  /// This client's own registry witness.
  protected selfRegistryProof() {
    return this.registryProof(this.keys!.spendingPubkey, "Account");
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
