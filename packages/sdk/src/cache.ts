import { ethers } from "ethers";
import { PoolTrees } from "./merkle";
import type { RegistryEntry, Output } from "./events";
import type { OwnedEntry } from "./entry";

export interface CacheStore {
  load(key: string): Promise<string | null>;
  save(key: string, data: string): Promise<void>;
}

export interface CacheData {
  poolTrees: PoolTrees;
  registryEntries: RegistryEntry[];
  aliasHashByPubkey: Map<bigint, bigint>;
  keyActiveFrom: Map<bigint, number>;
  namesByAlias: Map<string, string>;
  spentNullifiers: Set<bigint>;
  lastBlock: number;
  /// This client's own notes, already decrypted.
  ///
  /// Persisted because finding them is the expensive half of a scan — one X25519 shared
  /// secret per output — and a resumed scan only looks at blocks it has not seen. Without
  /// these a warm client would report a balance drawn from the new range alone.
  myEntries: OwnedEntry[];
  /// Every commitment seen, minus its ciphertext.
  ///
  /// history() and privacyContext() read this, so dropping it would make both report on the
  /// current session only. The `encryptedBlob` is deliberately not kept: its sole use is
  /// trial decryption, which has already happened for these, and it is the bulk of the bytes.
  /// {Halias-findInviteNote} is the one caller that needs ciphertext back and it forces a
  /// full rescan when it finds none.
  outputs: Output[];
}

interface SerializedCache {
  lastBlock: number;
  /// [treeNumber, leaves] per tree. Replaced `poolLeaves`, which could not express which
  /// tree a commitment belonged to — and the tree number feeds the nullifier, so guessing
  /// it would produce notes that look unspendable.
  poolTrees?: [number, string[]][];
  spentNullifiers: string[];
  registryEntries: Array<{
    aliasHash: string;
    registrySlot: number;
    txHash: string;
    blockNumber: number;
    spendingCommitment: string;
    nullifierKeyHash: string;
    encryptionPubkey: string;
    dataHash: string;
  }>;
  aliasHashByPubkey: Record<string, string>;
  keyActiveFrom?: Record<string, number>;
  namesByAlias?: Record<string, string>;
  // Typed rather than Record<string, unknown>: the shapes below are written and read here
  // and nowhere else, so declaring them removes the casts on the way back in.
  myEntries?: Array<{
    blinding: string; amount: string; tokenAddress: string; commitment: string;
    treeNumber: number; leafIndex: number;
  }>;
  outputs?: Array<{
    commitment: string; treeNumber: number; leafIndex: number; tokenAddress: string;
    publicAmount: string; spentNullifiers: string[]; blockNumber: number;
    transactionIndex: number; logIndex: number; txHash: string;
  }>;
}

export function serializeCache(d: CacheData): string {
  const data: SerializedCache = {
    lastBlock:    d.lastBlock,
    // Per tree, since a leaf index alone no longer identifies a note. A cache written by
    // an older build has `poolLeaves` and no tree numbers; it is rejected rather than
    // guessed at, because assuming tree 0 would produce wrong nullifiers.
    poolTrees:    d.poolTrees.entries().map(([n, ls]) => [n, ls.map(l => "0x" + l.toString(16))]),
    spentNullifiers: [...d.spentNullifiers].map(n => "0x" + n.toString(16)),
    registryEntries: d.registryEntries.map(e => ({
      aliasHash:        e.aliasHash,
      // The slot is the alias's position in the SMT and the tree is rebuilt from it. It was
      // omitted here and defaulted to 0 on the way back in, which a full rescan silently
      // corrected on every refresh. A resumed scan does not rescan, so an omitted slot stays
      // 0 — putting every alias at slot 0 and producing a registry root matching nothing.
      registrySlot:     e.registrySlot,
      txHash:           e.txHash,
      blockNumber:      e.blockNumber,
      spendingCommitment:   "0x" + e.spendingCommitment.toString(16),
      nullifierKeyHash: "0x" + e.nullifierKeyHash.toString(16),
      encryptionPubkey: ethers.hexlify(e.encryptionPubkey),
      dataHash:         "0x" + e.dataHash.toString(16),
    })),
    myEntries: d.myEntries.map(e => ({
      blinding:         "0x" + e.blinding.toString(16),
      amount:           "0x" + e.amount.toString(16),
      tokenAddress:     "0x" + e.tokenAddress.toString(16),
      commitment:       "0x" + e.commitment.toString(16),
      treeNumber:       e.treeNumber,
      leafIndex:        e.leafIndex,
    })),
    outputs: d.outputs.map(o => ({
      commitment:      "0x" + o.commitment.toString(16),
      treeNumber:      o.treeNumber,
      leafIndex:       o.leafIndex,
      tokenAddress:    "0x" + o.tokenAddress.toString(16),
      publicAmount:    "0x" + o.publicAmount.toString(16),
      spentNullifiers: o.spentNullifiers.map(n => "0x" + n.toString(16)),
      blockNumber:     o.blockNumber,
      transactionIndex: o.transactionIndex,
      logIndex:        o.logIndex,
      txHash:          o.txHash,
    })),
    namesByAlias: Object.fromEntries(d.namesByAlias),
    keyActiveFrom: Object.fromEntries(
      [...d.keyActiveFrom.entries()].map(([k, v]) => ["0x" + k.toString(16), v]),
    ),
    aliasHashByPubkey: Object.fromEntries(
      [...d.aliasHashByPubkey.entries()].map(([k, v]) => [
        "0x" + k.toString(16),
        "0x" + v.toString(16),
      ])
    ),
  };
  return JSON.stringify(data);
}

export function deserializeCache(raw: string): CacheData {
  const d: SerializedCache = JSON.parse(raw);

  if (!d.poolTrees) throw new Error("cache predates multi-tree pool; discard and rescan");
  const poolTrees = new PoolTrees();
  for (const [n, leaves] of d.poolTrees as [number, string[]][]) {
    leaves.forEach((leaf, i) => poolTrees.insert(n, i, BigInt(leaf)));
  }

  const registryEntries: RegistryEntry[] = d.registryEntries.map(e => ({
    aliasHash:        e.aliasHash,
    txHash:           String((e as any).txHash ?? ""),
    blockNumber:      Number((e as any).blockNumber ?? 0),
    registrySlot:     Number((e as any).registrySlot ?? 0),
    spendingCommitment:   BigInt(e.spendingCommitment),
    // Absent from caches written before the field was published in AliasRegistered. Zero
    // rather than a throw: a stale cache should degrade to one extra lookup, not refuse to
    // load — and a rescan repopulates it.
    nullifierKeyHash: BigInt((e as any).nullifierKeyHash ?? 0),
    encryptionPubkey: ethers.getBytes(e.encryptionPubkey),
    dataHash:         BigInt(e.dataHash),
  }));

  const aliasHashByPubkey = new Map<bigint, bigint>(
    Object.entries(d.aliasHashByPubkey).map(([k, v]) => [BigInt(k), BigInt(v)])
  );

  const keyActiveFrom = new Map<bigint, number>(
    Object.entries(d.keyActiveFrom ?? {}).map(([k, v]) => [BigInt(k), v]),
  );

  const namesByAlias = new Map<string, string>(Object.entries(d.namesByAlias ?? {}));

  const spentNullifiers = new Set<bigint>(d.spentNullifiers.map(BigInt));

  // A cache written before these existed carries a lastBlock but none of the notes found
  // below it. Resuming from that point would lose every one of them silently — the balance
  // would be whatever the new range happened to contain. Reporting lastBlock 0 turns it into
  // a full rescan, which is slow exactly once.
  // Every field a resumed scan relies on must be present. A cache missing any of them was
  // written by a build that expected the next full rescan to fill the gaps, and resuming
  // from it would carry the gaps forward instead.
  const warm =
    d.myEntries !== undefined &&
    d.outputs !== undefined &&
    d.registryEntries.every((e) => e.registrySlot !== undefined);

  const myEntries: OwnedEntry[] = (d.myEntries ?? []).map(e => ({
    blinding:     BigInt(e.blinding),
    amount:       BigInt(e.amount),
    tokenAddress: BigInt(e.tokenAddress),
    commitment:   BigInt(e.commitment),
    treeNumber:   e.treeNumber,
    leafIndex:    e.leafIndex,
  }));

  const outputs: Output[] = (d.outputs ?? []).map(o => ({
    commitment:       BigInt(o.commitment),
    treeNumber:       o.treeNumber,
    leafIndex:        o.leafIndex,
    // Not persisted: see CacheData.outputs. findInviteNote is the only reader that needs it
    // and it rescans when it sees this empty.
    encryptedBlob:    "",
    tokenAddress:     BigInt(o.tokenAddress),
    publicAmount:     BigInt(o.publicAmount),
    spentNullifiers:  o.spentNullifiers.map(BigInt) as [bigint, bigint],
    blockNumber:      o.blockNumber,
    transactionIndex: o.transactionIndex,
    logIndex:         o.logIndex,
    txHash:           o.txHash,
  }));

  return {
    poolTrees, registryEntries, aliasHashByPubkey, keyActiveFrom, namesByAlias, spentNullifiers,
    lastBlock: warm ? d.lastBlock : 0,
    myEntries, outputs,
  };
}

// Required lazily inside the methods, not at module scope. BrowserCache lives in this
// same module, so a top-level require("fs") would drag Node built-ins into every browser
// bundle that imports the cache at all.
// Dynamic import keeps this lazy — the point of the wrapper — while staying valid ESM.
// A static import would pull Node built-ins into every browser bundle. Cached after the
// first call so the repeated use below costs one import, not one per file operation.
let nodeMods: { fs: typeof import("fs"); path: typeof import("path") } | null = null;
async function nodeFs() {
  if (!nodeMods) {
    const [fs, path] = await Promise.all([import("fs"), import("path")]);
    nodeMods = { fs, path };
  }
  return nodeMods;
}

export class FileCache implements CacheStore {
  constructor(private dir: string) {}

  async load(key: string): Promise<string | null> {
    try {
      const { fs, path } = await nodeFs();
      return fs.readFileSync(path.join(this.dir, `${key}.json`), "utf-8");
    } catch {
      return null;
    }
  }

  async save(key: string, data: string): Promise<void> {
    const { fs, path } = await nodeFs();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${key}.json`), data);
  }
}

export class BrowserCache implements CacheStore {
  constructor(private prefix: string = "halias") {}

  async load(key: string): Promise<string | null> {
    return localStorage.getItem(this.full(key));
  }

  async save(key: string, data: string): Promise<void> {
    this.evictSiblings(key);
    try {
      localStorage.setItem(this.full(key), data);
    } catch (e) {
      // localStorage is a hard ~5 MB per origin and a large pool tree will reach it. The
      // cache is an optimisation — losing it costs a rescan, so a full quota must not take
      // the client down with it.
      console.warn("Cache write failed; continuing without a saved cache:", e);
    }
  }

  private full(key: string): string {
    return `${this.prefix}:${key}`;
  }

  /// Drop caches for the same chain but a different pool.
  ///
  /// Keys are `<chainId>:<poolAddress>`, so a redeploy leaves the previous pool's entry
  /// behind for good — dead weight against a quota that is already the binding constraint.
  /// Only one pool per chain is ever live, so any sibling is by definition stale.
  private evictSiblings(key: string): void {
    const chain = key.split(":")[0];
    if (!chain) return;
    const keep = this.full(key);
    const scope = `${this.prefix}:${chain}:`;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(scope) && k !== keep) localStorage.removeItem(k);
    }
  }
}
