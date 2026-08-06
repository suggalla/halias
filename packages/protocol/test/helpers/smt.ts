import { poseidonHash } from "./poseidon";

const REGISTRY_LEVELS = 64;
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Must be called after initPoseidon().
function computeZeros(): bigint[] {
  const zeros: bigint[] = [0n];
  for (let i = 0; i < REGISTRY_LEVELS; i++) {
    zeros.push(poseidonHash([zeros[i], zeros[i]]));
  }
  return zeros;
}

// Lazy singleton — recomputed if Poseidon hasn't been initialized yet.
let _zeros: bigint[] | null = null;
function getZeros(): bigint[] {
  if (!_zeros) _zeros = computeZeros();
  return _zeros;
}

// SMTHash1(key, value) = Poseidon(key, value, 1) — leaf hash (circomlib convention)
function smtHash1(key: bigint, value: bigint): bigint {
  return poseidonHash([key, value, 1n]);
}

// SMTHash2(left, right) = Poseidon(left, right) — internal node hash
function smtHash2(left: bigint, right: bigint): bigint {
  return poseidonHash([left, right]);
}

export class SMT {
  private nodes = new Map<string, bigint>();
  public root: bigint;

  constructor() {
    this.root = getZeros()[REGISTRY_LEVELS];
  }

  update(key: bigint, value: bigint): void {
    // Use lower registryLevels bits for tree navigation (matches the circuit's pathIndices).
    // Full key is only used in the leaf hash (smtHash1), binding the specific alias.
    const pathKey = key & ((1n << BigInt(REGISTRY_LEVELS)) - 1n);
    const zeros = getZeros();
    let current = smtHash1(key, value);
    for (let i = 0; i < REGISTRY_LEVELS; i++) {
      const nodePath    = pathKey >> BigInt(i);
      const siblingPath = nodePath ^ 1n;
      const isRight     = (nodePath & 1n) === 1n;
      const sibling     = this.nodes.get(`${i}:${siblingPath}`) ?? zeros[i];
      this.nodes.set(`${i}:${nodePath}`, current);
      current = isRight ? smtHash2(sibling, current) : smtHash2(current, sibling);
    }
    this.root = current;
  }

  getSiblings(key: bigint): bigint[] {
    const pathKey = key & ((1n << BigInt(REGISTRY_LEVELS)) - 1n);
    const zeros = getZeros();
    return Array.from({ length: REGISTRY_LEVELS }, (_, i) => {
      const siblingPath = (pathKey >> BigInt(i)) ^ 1n;
      return this.nodes.get(`${i}:${siblingPath}`) ?? zeros[i];
    });
  }
}

// aliasHash (bytes32 from contract) → SMT key (aliasHash % FIELD_PRIME)
export function aliasHashToKey(aliasHash: string): bigint {
  return BigInt(aliasHash) % FIELD_PRIME;
}


// Compute nullifierKeyHash = Poseidon(nullifierKey, 1) — what the contract stores and the circuit uses.
// Raw nullifierKey is never stored on-chain or emitted in events.
export function toNullifierKeyHash(nullifierKey: bigint): bigint {
  return poseidonHash([nullifierKey, 1n]);
}

// Recompute registry leaf: Poseidon(pubkey, nullifierKeyHash, dataHash)
export function registryLeaf(pubkey: bigint, nullifierKey: bigint, dataHash: bigint = 0n): bigint {
  return poseidonHash([pubkey, toNullifierKeyHash(nullifierKey), dataHash]);
}
