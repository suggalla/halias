import { poseidonHash } from "./crypto";

const LEVELS = 32; // must match POOL_LEVELS baked into the circuit WASM

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
