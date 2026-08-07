import { MerkleTree } from "./merkle";
import { SMT } from "./smt";
import type { RegistryEntry } from "./events";

export interface CacheStore {
  load(key: string): Promise<string | null>;
  save(key: string, data: string): Promise<void>;
}

export interface CacheData {
  poolTree: MerkleTree;
  smt: SMT;
  registryEntries: RegistryEntry[];
  aliasHashByPubkey: Map<bigint, bigint>;
  spentNullifiers: Set<bigint>;
  lastBlock: number;
}

interface SerializedCache {
  lastBlock: number;
  poolLeaves: string[];
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
    poolLeaves:   d.poolTree.leaves.map(l => "0x" + l.toString(16)),
    smtNodes:     d.smt.serializeNodes(),
    smtRoot:      "0x" + d.smt.root.toString(16),
    spentNullifiers: [...d.spentNullifiers].map(n => "0x" + n.toString(16)),
    registryEntries: d.registryEntries.map(e => ({
      aliasHash:        e.aliasHash,
      spendingPubkey:   "0x" + e.spendingPubkey.toString(16),
      nullifierKeyHash: "0x" + e.nullifierKeyHash.toString(16),
      leafHash:         "0x" + e.leafHash.toString(16),
      encryptionPubkey: "0x" + Buffer.from(e.encryptionPubkey).toString("hex"),
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

  const poolTree = new MerkleTree();
  for (const leaf of d.poolLeaves) poolTree.insert(BigInt(leaf));

  const smt = SMT.fromSerialized(d.smtNodes, BigInt(d.smtRoot));

  const registryEntries: RegistryEntry[] = d.registryEntries.map(e => ({
    aliasHash:        e.aliasHash,
    registrySlot:     Number((e as any).registrySlot ?? 0),
    spendingPubkey:   BigInt(e.spendingPubkey),
    nullifierKeyHash: BigInt(e.nullifierKeyHash),
    leafHash:         BigInt(e.leafHash),
    encryptionPubkey: Uint8Array.from(Buffer.from(e.encryptionPubkey.slice(2), "hex")),
    dataHash:         BigInt(e.dataHash),
  }));

  const aliasHashByPubkey = new Map<bigint, bigint>(
    Object.entries(d.aliasHashByPubkey).map(([k, v]) => [BigInt(k), BigInt(v)])
  );

  const spentNullifiers = new Set<bigint>(d.spentNullifiers.map(BigInt));

  return { poolTree, smt, registryEntries, aliasHashByPubkey, spentNullifiers, lastBlock: d.lastBlock };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs   = require("fs")   as typeof import("fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("path") as typeof import("path");

export class FileCache implements CacheStore {
  constructor(private dir: string) {}

  async load(key: string): Promise<string | null> {
    try {
      return fs.readFileSync(path.join(this.dir, `${key}.json`), "utf-8");
    } catch {
      return null;
    }
  }

  async save(key: string, data: string): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${key}.json`), data);
  }
}

export class BrowserCache implements CacheStore {
  constructor(private prefix: string = "halias") {}

  async load(key: string): Promise<string | null> {
    return localStorage.getItem(`${this.prefix}:${key}`);
  }

  async save(key: string, data: string): Promise<void> {
    localStorage.setItem(`${this.prefix}:${key}`, data);
  }
}
