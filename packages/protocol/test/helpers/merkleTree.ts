import { poseidonHash } from "./poseidon";

const DEFAULT_LEVELS = 20;

export class MerkleTree {
  levels: number;
  leaves: bigint[];
  zeros: bigint[];

  constructor(levels: number = DEFAULT_LEVELS) {
    this.levels = levels;
    this.leaves = [];
    this.zeros = this._computeZeros();
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
  }

  _buildLayers(): bigint[][] {
    let layers: bigint[][] = [
      [...this.leaves],
    ];

    for (let level = 0; level < this.levels; level++) {
      const currentLayer = layers[level];
      const nextLayer: bigint[] = [];
      const layerLen = Math.max(currentLayer.length, 1);

      for (let i = 0; i < Math.ceil(layerLen / 2); i++) {
        const left = currentLayer[2 * i] ?? this.zeros[level];
        const right = currentLayer[2 * i + 1] ?? this.zeros[level];
        nextLayer.push(poseidonHash([left, right]));
      }
      layers.push(nextLayer);
    }

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
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(layers[level][siblingIdx] ?? this.zeros[level]);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }

    return { pathElements, pathIndices };
  }
}
