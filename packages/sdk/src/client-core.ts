import { ethers } from "ethers";
import { normalizeAlias } from "./alias";
import {
  init as initCrypto,
  deriveKeysFromRoot,
  poseidonHash,
  encryptOutput,
  encodeOutputBlob,
  HaliasKeys,
} from "./crypto";
import { SeedSource } from "./seed";
import { ViewKeys, keysFromViewKeys } from "./viewkey";
import { computeNullifier, randomBlinding, OwnedEntry, POOL_LEVELS } from "./entry";
import { PoolTrees } from "./merkle";
import { SMT, aliasHashToSmtKey, rootFromSiblings } from "./smt";
import { dummyInput, dummyOutput, TransactOutput, TransactInput, ArtifactPaths, POOL_INPUTS } from "./proof";
import { scanEvents, findMyOutputs, Output, RegistryEntry, ScanResult } from "./events";
import { getPool, getRegistry, getController } from "./contract";
import { CacheStore, serializeCache, deserializeCache } from "./cache";


export interface HaliasConfig {
  provider: ethers.Provider;
  // Broadcasts and pays gas. It has no part in key derivation — see seed.ts.
  signer: ethers.Signer;
  // Where the note keys come from. Optional so a caller that already holds a root can pass it
  // to init() instead; one of the two has to be present before init().
  seed?: SeedSource;
  chainId: number;
  // Three contracts since the split. The pool hashes its own address into
  // paramsHash, so poolAddress is the one that must be right for a proof to verify.
  poolAddress: string;
  registryAddress: string;
  controllerAddress: string;
  artifacts: {
    transactWasm: string;
    transactZkey: string;
    /// The claim circuit. Optional: a client that never claims an invite never fetches it,
    /// which matters because it is the larger of the two (51 MB against 39 MB).
    claimWasm?: string;
    claimZkey?: string;
  };
  cache?: CacheStore;
  startBlock?: number;
  rpcChunkSize?: number;
  onProgress?: (pct: number) => void;
}

/// What a token's base units mean, and what to call it.
///
/// Every amount in this SDK is a bigint of base units, which is the only representation the
/// circuit and the contract ever see. Turning a human "1.5" into base units needs the token's
/// decimals, and getting that wrong is not a display bug: `parseEther` on a 6-decimal token
/// computes 10¹² times the intended amount. USDC and USDT are 6, WBTC is 8, and they are
/// exactly the tokens someone would want to send privately.
export interface TokenInfo {
  address: bigint;
  symbol: string;
  decimals: number;
}

/// ETH, which is `address(0)` in a note and never needs a contract call.
export const ETH_TOKEN_INFO: TokenInfo = { address: 0n, symbol: "ETH", decimals: 18 };

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
export interface BalanceResult {
  /// What these amounts are denominated in. Every figure below is base units, so a caller
  /// that formats without this is guessing at the scale — which is wrong by a factor of a
  /// million for USDC. Returned rather than looked up separately so a UI cannot render a
  /// balance it has no decimals for.
  token: TokenInfo;
  total: bigint;
  /// Unspent notes, smallest first.
  entries: OwnedEntry[];
  /// The most that can leave in one transaction — the largest notes the circuit has slots
  /// for. Below `total` whenever the balance is spread wider than that, and the number a UI
  /// has to show alongside the balance: offering to send `total` when only `sendableNow` can
  /// move is a promise the wallet cannot keep. `consolidate()` closes the gap.
  sendableNow: bigint;
}
export interface ConsolidateResult {
  /// One per merge. Empty when the notes already satisfied the goal and nothing was sent.
  txHashes: string[];
  /// Spendable notes remaining afterwards.
  notes: number;
  /// Their total, which is the balance minus any relayer fees paid along the way.
  total: bigint;
}
export interface LookupResult   { spendingCommitment: bigint; nullifierKeyHash: bigint; encryptionPubkey: Uint8Array; dataHash: bigint }
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
  protected aliasHashByPubkey = new Map<bigint, bigint>(); // spendingCommitment → aliasHash (bigint)
  protected keyActiveFrom = new Map<bigint, number>();     // spendingCommitment → block it became active
  protected namesByAlias  = new Map<string, string>();     // aliasHash → published plaintext
  protected registryEntries: RegistryEntry[] = [];
  /// The registry tree, rebuilt from the same events the entries come from.
  ///
  /// Held so a membership path can be derived rather than fetched. `getSmtSiblings(slot)` was
  /// the last targeted read on the send path — it names the slot, and slot↔alias is public
  /// from AliasRegistered, so asking told whoever answered who was about to be paid.
  ///
  /// Needs no extra request — every field of every registration is already scanned — and the
  /// cost is CPU, not bandwidth. Measured at 10,000 aliases: 20,022 nodes, 2.4 MB of heap,
  /// 8 µs to read a path, 1.5 MB serialised, and **1.27 s to build** via {SMT.fromLeaves}.
  ///
  /// That last number was 17.9 s until the build stopped calling `update` in a loop, which
  /// recomputed every ancestor once per descendant — 33 hashes per alias where hashing each
  /// node exactly once needs 2. Worth stating because the naive version looked reasonable and
  /// was 14x off, and because it is the number that decides whether this design holds: at
  /// ~0.13 ms/alias the tree is a fraction of the 541 µs/note the same sync already spends on
  /// trial decryption, where at 1.85 ms/alias it was competing with it.
  ///
  /// Extrapolates to ~13 s at 100k aliases and ~2 min at a million, so it is bounded, not
  /// unbounded. Persisting it would make even that once per device rather than once per
  /// session — `serializeNodes`/`fromSerialized` exist and are not yet wired up, and loading
  /// 10,000 aliases back measures 19 ms. See docs/rpc-surface.md.
  protected registrySMT: SMT = new SMT();
  protected myEntries: OwnedEntry[] = [];
  protected allOutputs: Output[] = [];
  protected spentNullifiers = new Set<bigint>();
  protected nextDummyIdx = 0;
  protected selfAliasHash: bigint | null = null;
  protected lastBlock = 0;
  protected synced = false;
  protected initialized = false;
  protected viewOnly = false;
  protected aliasIndex = 0;
  protected root: bigint | null = null;

  constructor(config: HaliasConfig) {
    this.config = config;
    this.pool     = getPool(config.poolAddress, config.signer);
    this.registry = getRegistry(config.registryAddress, config.signer);
    this.domain   = getController(config.controllerAddress, config.signer);
  }

  /// Bind this client to one alias identity.
  ///
  /// `aliasIndex` selects which alias of the set this client acts as. Each index has its own
  /// spending key, nullifier key and encryption key, so balances and notes do not merge
  /// across aliases. All of them come from the one root, so switching alias costs nothing.
  ///
  /// `root` reuses a root the caller already holds. Anything building more than one client —
  /// enumerating aliases, switching between them — should pass it rather than re-deriving,
  /// since a mnemonic source stretches the phrase through PBKDF2 on every call.
  async init(aliasIndex: number = 0, root?: bigint): Promise<void> {
    await initCrypto();
    this.aliasIndex = aliasIndex;
    if (root === undefined && !this.config.seed) {
      throw new Error("init() needs a root or a seed source: pass config.seed, or init(index, root)");
    }
    this.root = root ?? (await this.config.seed!.root());
    this.keys = deriveKeysFromRoot(this.root, aliasIndex);
    this.initialized = true;
  }

  /// Bind this client to a view key: it can read one alias and can spend nothing.
  ///
  /// There is no root, so nothing here can derive another alias or another index — a view key
  /// is scoped to the one alias it was exported from, and holding it reveals no others.
  ///
  /// Spending is refused by {ensureSpendable} rather than by an absent key. The key really is
  /// absent, but a missing witness surfaces as a proof that fails to verify, which is a
  /// terrible way to learn you were never able to do this.
  async initViewOnly(view: ViewKeys, aliasIndex: number = 0): Promise<void> {
    await initCrypto();
    this.aliasIndex = aliasIndex;
    this.root = null;
    this.keys = keysFromViewKeys(view);
    this.viewOnly = true;
    this.initialized = true;
  }

  /// True when this client holds only a viewing key.
  get isViewOnly(): boolean {
    return this.viewOnly;
  }

  /// Refuse anything that would need a spending key. Called by every operation that sends a
  /// transaction, so the refusal arrives before a wallet opens rather than after a proof.
  protected ensureSpendable() {
    if (this.viewOnly) {
      throw new Error("This is a view-only key — it can read this alias but cannot spend from it");
    }
  }

  /// The secret behind every alias. Exposed so a caller can derive further clients without
  /// re-stretching the phrase; it never leaves the client.
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
      this.namesByAlias = d.namesByAlias;
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
      namesByAlias: this.namesByAlias,
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
    this.namesByAlias = new Map();
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
      this.config.controllerAddress,
      fromBlock,
      this.config.rpcChunkSize,
      this.config.onProgress,
      prior,
    );

    this.poolTrees = result.poolTrees;
    this.registryEntries = result.registryEntries;
    this.rebuildRegistryTree();
    this.aliasHashByPubkey = result.aliasHashByPubkey;
    this.keyActiveFrom = result.keyActiveFrom;
    this.namesByAlias = result.namesByAlias;
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
    const activeFrom = this.keyActiveFrom.get(keys.spendingCommitment);
    const candidates = activeFrom === undefined
      ? result.newOutputs
      : result.newOutputs.filter((o) => o.blockNumber >= activeFrom);
    const found = findMyOutputs(
      candidates,
      keys.spendingCommitment,
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
      namesByAlias: this.namesByAlias,
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

  /// Real inputs, padded out to the circuit's width with dummies.
  ///
  /// Every transaction spends exactly {POOL_INPUTS} inputs whether or not it has that many
  /// notes to spend. That is not a formality — a dummy's nullifier is published and marked
  /// spent exactly like a real one, so padding is what stops the number of notes a wallet
  /// holds from being visible to anyone reading the chain.
  ///
  /// A dummy still names a (root, tree) pair the pool will check, so it borrows the anchor.
  /// Returned as the four parallel arrays both `proveTransact` and `transact` want, from one
  /// place, because a witness and its calldata disagreeing about input order is a proof that
  /// verifies against nothing.
  protected padInputs(
    real: Array<{ input: TransactInput; nullifier: bigint; root: bigint; tree: number }>,
    anchor: { root: bigint; tree: number },
  ): { poolRoot: bigint[]; treeNumber: number[]; inputNullifiers: bigint[]; inputs: TransactInput[] } {
    if (real.length > POOL_INPUTS) {
      throw new Error(`a transaction spends at most ${POOL_INPUTS} notes, got ${real.length}`);
    }
    const dBase = this.consumeDummyIdx(POOL_INPUTS - real.length);
    const all = [...real];
    for (let i = real.length; i < POOL_INPUTS; i++) {
      const d = dummyInput(anchor.tree, dBase + (i - real.length), POOL_LEVELS);
      all.push({ input: d.input, nullifier: d.nullifier, root: anchor.root, tree: anchor.tree });
    }
    return {
      poolRoot:        all.map(a => a.root),
      treeNumber:      all.map(a => a.tree),
      inputNullifiers: all.map(a => a.nullifier),
      inputs:          all.map(a => a.input),
    };
  }

  protected getArtifacts(): { transact: ArtifactPaths; claim: ArtifactPaths } {
    const a = this.config.artifacts;
    return {
      transact: { wasmPath: a.transactWasm, zkeyPath: a.transactZkey },
      // Falls back to the ordinary artifacts when unconfigured. Not a silent wrong answer: the
      // ordinary circuit constrains pendingLeaf to zero, so a claim built against it fails to
      // prove rather than producing something the pool would accept.
      claim: {
        wasmPath: a.claimWasm ?? a.transactWasm,
        zkeyPath: a.claimZkey ?? a.transactZkey,
      },
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
      commitment: poseidonHash([out.spendingCommitment, out.nullifierKeyHash, out.blinding, out.amount, tokenAddress]),
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
  protected async registryProof(spendingCommitment: bigint, label = "Recipient spendingCommitment"): Promise<{
    aliasHash: bigint;
    registrySlot: number;
    siblings: bigint[];
    dataHash: bigint;
    registryRoot: bigint;
  }> {
    const aliasHash = this.aliasHashByPubkey.get(spendingCommitment);
    if (aliasHash === undefined) throw new Error(`${label} not found in registry`);
    const h = "0x" + aliasHash.toString(16).padStart(64, "0");
    const blockTag = await this.headBlock();

    // The slot, from the scan rather than from the chain.
    //
    // `aliasSlot(h)` is a targeted read naming the alias this proof is for — on a send, the
    // recipient — and it was answering a question this client had already answered:
    // AliasRegistered carries the slot, and every one of those events is scanned into
    // `registryEntries`. Asking again told a node who was about to be paid and returned a
    // value already in memory.
    //
    // Safe to take locally because a slot is assigned once and never reassigned; a
    // reassignment keeps it. So unlike the keys or the dataHash there is no staleness to
    // reason about — a slot read at any block is the slot at every later block.
    //
    // See docs/rpc-surface.md.
    const entry = this.registryEntries.find((e) => BigInt(e.aliasHash) === aliasHash);
    let slot: number;
    if (entry) {
      slot = entry.registrySlot;
    } else {
      const oneBased = Number(await this.registry.aliasSlot(h, { blockTag }) as bigint);
      if (oneBased === 0) {
        throw new Error(`${label} is not registered as of block ${blockTag}`);
      }
      slot = oneBased - 1;
    }

    // The root is the one read that is safe to make: every caller asks for it and every caller
    // gets the same answer, so it carries nothing about who this client is about to pay. It is
    // also what makes the rest of this function possible — the check that turns local data from
    // trusted into verified.
    const aliasKey = aliasHashToSmtKey(aliasHash);
    const root = BigInt(await this.registry.getRegistryRoot({ blockTag }) as string);

    // The witness, derived locally and checked against that root.
    //
    // `getSmtSiblings(slot)` and `aliases(h)` were the last two targeted reads on the send
    // path. Between them they named the recipient twice: slot↔alias is public from
    // AliasRegistered, so asking for a slot's path is asking about a person. Both are
    // answerable from data already scanned — the tree is rebuilt from the same events
    // (see {rebuildRegistryTree}), and `dataHash` comes from AliasDataUpdated.
    //
    // Local data can be stale, so it is proved rather than assumed. Walking the derived path
    // from the leaf these fields imply must reproduce the root the chain just reported. That
    // single comparison covers everything at once: a rotated key, an updated `dataHash`, any
    // registration landing since the last scan — all of them change the leaf or the path, and
    // all of them fail here rather than several seconds later as a rejected proof.
    //
    // This is strictly more checking than the old code did. Fetching both values and using
    // them unchecked builds a proof against fields nobody confirmed belonged together.
    if (entry && entry.nullifierKeyHash !== 0n) {
      const leaf = poseidonHash([
        entry.spendingCommitment, entry.nullifierKeyHash, entry.dataHash,
      ]);
      const siblings = this.registrySMT.getSiblings(slot);
      if (rootFromSiblings(aliasKey, leaf, slot, siblings) === root) {
        return { aliasHash: aliasKey, registrySlot: slot, siblings, dataHash: entry.dataHash,
                 registryRoot: root };
      }
    }

    // Out of date, or scanned before the events carried enough to rebuild the tree. Ask —
    // once, on the rare path, instead of every time on the common one. Both reads are pinned
    // to the same block as the root, so the path and the leaf agree with what they must prove
    // against.
    const [siblingsRaw, record] = await Promise.all([
      this.registry.getSmtSiblings(slot, { blockTag }) as Promise<string[]>,
      this.registry.aliases(h, { blockTag }) as Promise<{ dataHash: string }>,
    ]);
    return {
      aliasHash: aliasKey,
      registrySlot: slot,
      siblings: siblingsRaw.map(BigInt),
      dataHash: BigInt(record.dataHash),
      registryRoot: root,
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

  /// What each slot's leaf was built from, so an unchanged slot costs nothing to skip.
  ///
  /// Compared as raw fields rather than as the leaf hash: hashing to discover that nothing
  /// changed is most of the work this exists to avoid.
  private appliedLeaves = new Map<number, string>();

  /// Bring the registry tree up to date with scanned registrations.
  ///
  /// Runs after every scan, so it does the smaller of two jobs rather than one fixed job.
  ///
  /// A slot may be revisited — a rotation or a `dataHash` change rewrites one in place, and
  /// `registryEntries` carries current state rather than history — but `update` is a write to
  /// a position, not an append, so replaying only the entries whose fields actually moved is
  /// exact. Order does not matter: each update recomputes its path from siblings already
  /// stored. Unchanged slots are skipped on their raw fields, so a scan that found no new
  /// registrations does no hashing at all.
  ///
  /// Entries from a cache written before AliasRegistered carried `nullifierKeyHash` cannot
  /// produce a leaf. Rather than build a tree that is wrong in a way nothing would notice, the
  /// whole thing is dropped and {registryProof} falls back to fetching. A rescan fixes it.
  protected rebuildRegistryTree(): void {
    const fieldsOf = (e: RegistryEntry) =>
      `${e.spendingCommitment}:${e.nullifierKeyHash}:${e.dataHash}`;
    const leafOf = (e: RegistryEntry) => ({
      slot:  e.registrySlot,
      key:   aliasHashToSmtKey(BigInt(e.aliasHash)),
      value: poseidonHash([e.spendingCommitment, e.nullifierKeyHash, e.dataHash]),
    });

    if (this.registryEntries.some((e) => e.nullifierKeyHash === 0n)) {
      this.registrySMT = new SMT();
      this.appliedLeaves.clear();
      return;
    }

    const changed = this.registryEntries.filter(
      (e) => this.appliedLeaves.get(e.registrySlot) !== fieldsOf(e));
    if (changed.length === 0) return;

    // Patch or rebuild, whichever is fewer hashes.
    //
    // `update` costs 33 hashes for one entry — it walks all 32 levels — while `fromLeaves`
    // costs about 2 per entry for the entire tree, because each node is hashed once instead of
    // once per descendant. So patching wins until the changed set passes N/16, and past that
    // rebuilding the whole thing is genuinely cheaper. Measured at 10,000 aliases: 17.9 s of
    // `update` calls against 1.27 s of `fromLeaves`, same tree.
    if (changed.length * 33 > this.registryEntries.length * 2) {
      this.registrySMT = SMT.fromLeaves(this.registryEntries.map(leafOf));
      this.appliedLeaves.clear();
      for (const e of this.registryEntries) this.appliedLeaves.set(e.registrySlot, fieldsOf(e));
      return;
    }

    for (const e of changed) {
      const { slot, key, value } = leafOf(e);
      this.registrySMT.update(slot, key, value);
      this.appliedLeaves.set(slot, fieldsOf(e));
    }
  }

  /// This client's own registry witness.
  protected selfRegistryProof() {
    return this.registryProof(this.keys!.spendingCommitment, "Account");
  }

  // ── token metadata ─────────────────────────────────────────────────────────
  //
  // Resolved once per token and kept, because it cannot change: `decimals()` and `symbol()`
  // are fixed for the life of an ERC-20, and a note's token address is part of its
  // commitment. Two accessors rather than one because the callers differ — an entry point
  // can await, but the formatting inside a synchronous helper cannot, so every public
  // operation primes the cache first and the sync readers below are then always warm.

  protected tokenMeta = new Map<bigint, TokenInfo>([[0n, ETH_TOKEN_INFO]]);

  /// Symbol and decimals for a token, cached. ETH needs no call.
  async tokenInfo(tokenAddress: bigint): Promise<TokenInfo> {
    const hit = this.tokenMeta.get(tokenAddress);
    if (hit) return hit;

    const address  = ethers.getAddress(ethers.toBeHex(tokenAddress, 20));
    const contract = new ethers.Contract(
      address,
      ["function decimals() view returns (uint8)", "function symbol() view returns (string)"],
      this.config.provider,
    );

    // Decimals must be right — an amount is wrong by orders of magnitude without it, so a
    // token that will not answer is one this client refuses to denominate anything in.
    const decimals = Number(await contract.decimals());

    // A symbol is a label. Pre-ERC-20-standard tokens return bytes32 here and revert against
    // this ABI, which is no reason to refuse to move the funds.
    let symbol: string;
    try { symbol = String(await contract.symbol()); }
    catch { symbol = `${address.slice(0, 6)}…${address.slice(-4)}`; }

    const info: TokenInfo = { address: tokenAddress, symbol, decimals };
    this.tokenMeta.set(tokenAddress, info);
    return info;
  }

  /// Cached decimals, for the synchronous paths. Falls back to 18 — the ERC-20 default and
  /// always correct for ETH — which only matters if a caller reaches one of these before any
  /// entry point has primed the cache.
  protected decimalsOf(tokenAddress: bigint): number {
    return this.tokenMeta.get(tokenAddress)?.decimals ?? 18;
  }

  /// Cached symbol, for error messages and display.
  protected symbolOf(tokenAddress: bigint): string {
    return this.tokenMeta.get(tokenAddress)?.symbol ?? (tokenAddress === 0n ? "ETH" : "tokens");
  }

  /// A human amount into base units, in this token's decimals.
  protected parseAmount(amount: string, tokenAddress: bigint): bigint {
    return ethers.parseUnits(amount, this.decimalsOf(tokenAddress));
  }

  /// Base units back into a human amount, in this token's decimals.
  protected formatAmount(amount: bigint, tokenAddress: bigint): string {
    return ethers.formatUnits(amount, this.decimalsOf(tokenAddress));
  }

  /// Unspent notes of one token, smallest first.
  protected spendable(tokenAddress: bigint): OwnedEntry[] {
    return this.myEntries
      .filter(e =>
        e.amount > 0n &&
        e.tokenAddress === tokenAddress &&
        !this.spentNullifiers.has(computeNullifier(this.keys!.nullifierKey, e.treeNumber, e.leafIndex)))
      .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  }

  /// The notes to spend for `amount` — one or two, smallest that cover it.
  ///
  /// As many notes as the circuit will take, whenever that many exist, even when fewer would
  /// do. The circuit consumes {POOL_INPUTS} inputs and produces two outputs, so a full
  /// transaction is a net loss of {POOL_INPUTS} - 2 notes: filling the slots consolidates for
  /// free, and leaving them empty lets a wallet paid in many small amounts slowly become
  /// unable to spend its own balance.
  ///
  /// Smallest-first for the same reason. Taking the largest notes that cover the amount pays
  /// the bill and leaves every small note where it was, forever; taking the smallest that
  /// cover it drains them.
  ///
  /// {POOL_INPUTS} is still a ceiling, so a balance spread wider than that cannot go in one
  /// transaction however it is selected — but at four rather than two, ten notes now take
  /// three transactions instead of nine. {consolidate} is the answer past that, and the error
  /// here says so rather than claiming the balance is insufficient, which was the old message
  /// and was false.
  protected selectEntries(amount: bigint, tokenAddress: bigint): OwnedEntry[] {
    const notes = this.spendable(tokenAddress);
    const total = notes.reduce((s, e) => s + e.amount, 0n);
    if (total < amount) {
      throw new Error(
        `Balance ${this.formatAmount(total, tokenAddress)} ${this.symbolOf(tokenAddress)} ` +
        `is less than ${this.formatAmount(amount, tokenAddress)}`);
    }

    // Smallest set that covers it. Notes are sorted ascending, so accumulating from the front
    // and stopping the moment the running sum suffices gives the smallest-first set; if the
    // whole window still falls short, drop the smallest and pull in the next largest.
    //
    // Then top up to the full width from whatever is left, because unused slots are free
    // consolidation — spending a note costs nothing extra once its slot is already paid for.
    const pick = (): OwnedEntry[] | null => {
      for (let start = 0; start < notes.length; start++) {
        let sum = 0n;
        const taken: OwnedEntry[] = [];
        for (let i = start; i < notes.length && taken.length < POOL_INPUTS; i++) {
          taken.push(notes[i]);
          sum += notes[i].amount;
          if (sum >= amount) return taken;
        }
        // The largest POOL_INPUTS notes could not cover it, so no window can.
        if (start === 0 && notes.length <= POOL_INPUTS) break;
      }
      // Fall back to the largest notes available, which is the best any selection can do.
      const largest = notes.slice(-POOL_INPUTS);
      return largest.reduce((t, e) => t + e.amount, 0n) >= amount ? largest : null;
    };

    const chosen = pick();
    if (chosen) {
      // Top up with the smallest notes not already taken, for the free consolidation.
      const used = new Set(chosen);
      for (const n of notes) {
        if (chosen.length >= POOL_INPUTS) break;
        if (!used.has(n)) { chosen.push(n); used.add(n); }
      }
      return chosen;
    }

    throw new Error(
      `Balance ${this.formatAmount(total, tokenAddress)} ${this.symbolOf(tokenAddress)} is ` +
      `spread across ${notes.length} notes and a transaction spends at most ${POOL_INPUTS}. ` +
      `Consolidate first — see consolidate().`);
  }

  /// The circuit's input slots, filled from `entries` and padded with dummies.
  ///
  /// Each input names its own root and tree, so the notes need not live in the same tree —
  /// which matters once the pool has rolled over, because the notes a wallet holds will
  /// straddle the boundary. A dummy borrows the first real input's anchor: it proves nothing,
  /// but the pool still checks the pair it names.
  ///
  /// Always {POOL_INPUTS} slots, however few notes are real. Padding is what keeps the count
  /// private — a dummy nullifier is published and spent like any other.
  protected buildInputs(entries: OwnedEntry[]): {
    nullifiers: bigint[];
    poolRoots: bigint[];
    treeNumbers: number[];
    inputs: TransactInput[];
    total: bigint;
  } {
    const keys = this.keys!;
    const real = entries.map((e) => {
      const anchor = this.poolAnchor(e.treeNumber);
      const proof  = this.poolTrees.tree(e.treeNumber).getProof(e.leafIndex);
      return {
        nullifier: computeNullifier(keys.nullifierKey, e.treeNumber, e.leafIndex),
        root: anchor.root,
        tree: anchor.tree,
        input: {
          spendingPrivKey: keys.spendingPrivKey,
          viewingPrivKey:  keys.viewingPrivKey,
          blinding: e.blinding,
          amount:   e.amount,
          pathIndices:  proof.pathIndices,
          pathElements: proof.pathElements,
        },
        amount: e.amount,
      };
    });

    const anchor = real[0] ? { root: real[0].root, tree: real[0].tree } : this.poolAnchor();
    const padded = this.padInputs(real, anchor);

    return {
      nullifiers:  padded.inputNullifiers,
      poolRoots:   padded.poolRoot,
      treeNumbers: padded.treeNumber,
      inputs:      padded.inputs,
      total:       real.reduce((t, r) => t + r.amount, 0n),
    };
  }

}
