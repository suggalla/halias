import { poseidonHash } from "./crypto";
import { POOL_LEVELS } from "./entry";

// One definition, in entry.ts — see the note there.
const LEVELS = POOL_LEVELS;

/// The pool is a sequence of trees, so a client holds several. Trees other than the newest
/// are frozen on chain and never change again, which is why keeping them all in memory is
/// cheap and why a proof against an old one stays valid indefinitely.
export class PoolTrees {
  private trees = new Map<number, MerkleTree>();

  tree(treeNumber: number): MerkleTree {
    let t = this.trees.get(treeNumber);
    if (!t) { t = new MerkleTree(); this.trees.set(treeNumber, t); }
    return t;
  }

  insert(treeNumber: number, leafIndex: number, leaf: bigint) {
    const t = this.tree(treeNumber);
    // Events arrive in order, so an index should be exactly the next slot. Anything else means
    // a gap — a dropped log — and building on it would silently produce a tree that disagrees
    // with the contract's, whose only symptom is every proof being rejected.
    if (leafIndex !== t.leaves.length) {
      throw new Error(
        `pool scan gap: tree ${treeNumber} expected leaf ${t.leaves.length}, got ${leafIndex}`,
      );
    }
    t.insert(leaf);
  }

  /// The newest tree — where a new note will land, and the anchor a dummy input uses.
  /// Zero when nothing has been scanned yet, which is correct: tree 0's empty root is
  /// published by the pool's constructor.
  get latest(): number {
    let n = 0;
    for (const k of this.trees.keys()) if (k > n) n = k;
    return n;
  }

  /// Flattened for serialisation: [treeNumber, leaves...] per tree, in tree order.
  entries(): [number, bigint[]][] {
    return this.numbers.map(n => [n, this.trees.get(n)!.leaves] as [number, bigint[]]);
  }

  get size(): number { return this.trees.size; }
  get numbers(): number[] { return [...this.trees.keys()].sort((a, b) => a - b); }
  /// Total leaves across every tree — the anonymity set, not a position.
  get totalLeaves(): number {
    let n = 0;
    for (const t of this.trees.values()) n += t.leaves.length;
    return n;
  }
}

export class MerkleTree {
  levels: number;
  leaves: bigint[];
  private _zeros: bigint[] | null = null;
  private _cachedLayers: bigint[][] | null = null;

  constructor(levels: number = LEVELS) {
    this.levels = levels;
    this.leaves = [];
  }

  get zeros(): bigint[] {
    if (!this._zeros) this._zeros = this._computeZeros();
    return this._zeros;
  }

  _computeZeros(): bigint[] {
    const zeros: bigint[] = [0n];
    for (let i = 0; i < this.levels; i++) {
      zeros.push(poseidonHash([zeros[i], zeros[i]]));
    }
    return zeros;
  }

  insert(leaf: bigint) {
    this.leaves.push(leaf);
    this._cachedLayers = null;
  }

  _buildLayers(): bigint[][] {
    if (this._cachedLayers) return this._cachedLayers;
    const layers: bigint[][] = [[...this.leaves]];
    for (let level = 0; level < this.levels; level++) {
      const cur = layers[level];
      const next: bigint[] = [];
      const len = Math.max(cur.length, 1);
      for (let i = 0; i < Math.ceil(len / 2); i++) {
        const left  = cur[2 * i]     ?? this.zeros[level];
        const right = cur[2 * i + 1] ?? this.zeros[level];
        next.push(poseidonHash([left, right]));
      }
      layers.push(next);
    }
    this._cachedLayers = layers;
    return layers;
  }

  getRoot(): bigint {
    const layers = this._buildLayers();
    return layers[this.levels][0] ?? this.zeros[this.levels];
  }

  getProof(leafIndex: number): { pathElements: bigint[]; pathIndices: number[] } {
    const layers = this._buildLayers();
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let level = 0; level < this.levels; level++) {
      const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(layers[level][sibIdx] ?? this.zeros[level]);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }
}
