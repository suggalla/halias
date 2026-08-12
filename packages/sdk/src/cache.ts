import { ethers } from "ethers";
import { MerkleTree, PoolTrees } from "./merkle";
import { SMT } from "./smt";
import type { RegistryEntry } from "./events";

export interface CacheStore {
  load(key: string): Promise<string | null>;
  save(key: string, data: string): Promise<void>;
}

export interface CacheData {
  poolTrees: PoolTrees;
  smt: SMT;
  registryEntries: RegistryEntry[];
  aliasHashByPubkey: Map<bigint, bigint>;
  spentNullifiers: Set<bigint>;
  lastBlock: number;
}

interface SerializedCache {
  lastBlock: number;
  /// [treeNumber, leaves] per tree. Replaced `poolLeaves`, which could not express which
  /// tree a commitment belonged to — and the tree number feeds the nullifier, so guessing
  /// it would produce notes that look unspendable.
  poolTrees?: [number, string[]][];
  smtNodes: Record<string, string>;
  smtRoot: string;
  spentNullifiers: string[];
  registryEntries: Array<{
    aliasHash: string;
    spendingPubkey: string;
    nullifierKeyHash: string;
    leafHash: string;
    encryptionPubkey: string;
    dataHash: string;
  }>;
  aliasHashByPubkey: Record<string, string>;
}

export function serializeCache(d: CacheData): string {
  const data: SerializedCache = {
    lastBlock:    d.lastBlock,
    // Per tree, since a leaf index alone no longer identifies a note. A cache written by
    // an older build has `poolLeaves` and no tree numbers; it is rejected rather than
    // guessed at, because assuming tree 0 would produce wrong nullifiers.
    poolTrees:    d.poolTrees.entries().map(([n, ls]) => [n, ls.map(l => "0x" + l.toString(16))]),
    smtNodes:     d.smt.serializeNodes(),
    smtRoot:      "0x" + d.smt.root.toString(16),
    spentNullifiers: [...d.spentNullifiers].map(n => "0x" + n.toString(16)),
    registryEntries: d.registryEntries.map(e => ({
      aliasHash:        e.aliasHash,
      spendingPubkey:   "0x" + e.spendingPubkey.toString(16),
      nullifierKeyHash: "0x" + e.nullifierKeyHash.toString(16),
      leafHash:         "0x" + e.leafHash.toString(16),
      encryptionPubkey: ethers.hexlify(e.encryptionPubkey),
      dataHash:         "0x" + e.dataHash.toString(16),
    })),
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

  const smt = SMT.fromSerialized(d.smtNodes, BigInt(d.smtRoot));

  const registryEntries: RegistryEntry[] = d.registryEntries.map(e => ({
    aliasHash:        e.aliasHash,
    // Defaulted: a cache written before these fields existed is still usable, it just
    // cannot show where the registration happened until the next full scan.
    txHash:           String((e as any).txHash ?? ""),
    blockNumber:      Number((e as any).blockNumber ?? 0),
    registrySlot:     Number((e as any).registrySlot ?? 0),
    spendingPubkey:   BigInt(e.spendingPubkey),
    nullifierKeyHash: BigInt(e.nullifierKeyHash),
    leafHash:         BigInt(e.leafHash),
    encryptionPubkey: ethers.getBytes(e.encryptionPubkey),
    dataHash:         BigInt(e.dataHash),
  }));

  const aliasHashByPubkey = new Map<bigint, bigint>(
    Object.entries(d.aliasHashByPubkey).map(([k, v]) => [BigInt(k), BigInt(v)])
  );

  const spentNullifiers = new Set<bigint>(d.spentNullifiers.map(BigInt));

  return { poolTrees, smt, registryEntries, aliasHashByPubkey, spentNullifiers, lastBlock: d.lastBlock };
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
