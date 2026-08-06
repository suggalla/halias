import { poseidonHash } from "./crypto";

const REGISTRY_LEVELS = 64;

// Lazily computed: zeros[i] = hash of an empty subtree of height i.
// zeros[0] = 0n (sentinel for empty leaf), zeros[i+1] = Poseidon(zeros[i], zeros[i]).
// Must be computed after circomlibjs init().
let ZEROS: bigint[] | null = null;

function getZeros(): bigint[] {
  if (!ZEROS) {
    ZEROS = [0n];
    for (let i = 0; i < REGISTRY_LEVELS; i++) {
      ZEROS.push(poseidonHash([ZEROS[i], ZEROS[i]]));
    }
  }
  return ZEROS;
}

// SMT leaf hash: Poseidon(key, value, 1) — matches circomlib SMTHash1 via PoseidonT4 in Solidity.
function smtHash1(key: bigint, value: bigint): bigint {
  return poseidonHash([key, value, 1n]);
}

// SMT internal node hash: Poseidon(left, right) — matches circomlib SMTHash2 via PoseidonT3.
function smtHash2(left: bigint, right: bigint): bigint {
  return poseidonHash([left, right]);
}

// Sparse Merkle Tree (64 levels) mirroring Halias.sol _smtUpdate/_smtZeros.
// Key = aliasHash % FIELD_PRIME. Value = RegistryLeaf hash.
// Tree navigation uses the low REGISTRY_LEVELS bits of the key (matches the contract's
// smtKey mask and the circuit's pathIndices); the full key stays in the leaf hash.
// Supports in-place updates (key rotation, alias transfer).
export class SMT {
  private nodes = new Map<string, bigint>();
  public root: bigint;

  constructor() {
    this.root = getZeros()[REGISTRY_LEVELS];
  }

  update(key: bigint, value: bigint): void {
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

  serializeNodes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.nodes) {
      out[k] = "0x" + v.toString(16);
    }
    return out;
  }

  static fromSerialized(nodesRaw: Record<string, string>, root: bigint): SMT {
    const smt = new SMT();
    for (const [k, v] of Object.entries(nodesRaw)) {
      smt.nodes.set(k, BigInt(v));
    }
    smt.root = root;
    return smt;
  }
}

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function aliasHashToSmtKey(aliasHashBig: bigint): bigint {
  return aliasHashBig % FIELD_PRIME;
}
