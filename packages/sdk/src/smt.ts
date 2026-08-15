import { poseidonHash } from "./crypto";

const REGISTRY_LEVELS = 32;

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

/// The root a sibling path implies for a given leaf at a given slot.
///
/// The verifier's half of a membership proof, done locally. Its use here is not to check the
/// contract — it is to check *ourselves*: fields taken from a scan rather than fetched can be
/// stale, and the cheapest way to find out is to derive the root they imply and compare it
/// against the one the chain reported. Matching means the local copy was current; differing
/// means refetch, rather than discovering it as a rejected proof several seconds later.
///
/// Mirrors the circuit's walk exactly — smtHash1 for the leaf, smtHash2 upward, path bits
/// taken from the slot low-bit first.
export function rootFromSiblings(
  aliasKey: bigint,
  value: bigint,
  slot: number,
  siblings: bigint[],
): bigint {
  let current = smtHash1(aliasKey, value);
  for (let i = 0; i < siblings.length; i++) {
    const isRight = ((slot >> i) & 1) === 1;
    current = isRight ? smtHash2(siblings[i], current) : smtHash2(current, siblings[i]);
  }
  return current;
}

// Sparse Merkle Tree (32 levels), mirroring SMTRegistry's _smtUpdate/_smtZeros.
// Position = the slot the contract assigned at registration. Value = RegistryLeaf hash.
// The leaf still hashes aliasKey (aliasHash % FIELD_PRIME), so identity is bound by the
// leaf while the path follows the slot — matching the circuit exactly.
// Supports in-place updates (key rotation, alias transfer).
export class SMT {
  private nodes = new Map<string, bigint>();
  private _root: bigint | null = null;

  // Lazy, matching MerkleTree.zeros. Computing the empty root needs Poseidon, and
  // callers legitimately construct a tree before awaiting initCrypto() — Halias holds
  // one as a field, so doing this work in the constructor made `new Halias(...)` throw
  // before init() could ever be called.
  get root(): bigint {
    if (this._root === null) this._root = getZeros()[REGISTRY_LEVELS];
    return this._root;
  }

  set root(value: bigint) {
    this._root = value;
  }

  update(slot: number, aliasKey: bigint, value: bigint): void {
    const pathKey = BigInt(slot);
    const zeros = getZeros();
    let current = smtHash1(aliasKey, value);
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

  /// Build a whole tree at once, bottom-up.
  ///
  /// {update} is the wrong tool for the initial build and expensively so. It walks 32 levels
  /// per call, so N of them recompute every ancestor N times over: 33 hashes per alias, 330,000
  /// for ten thousand aliases, which measured at 18.5 s. Hashing each node exactly once instead
  /// costs N leaves plus ~N internal nodes — 20,023 for the same tree, **16.5x fewer**.
  ///
  /// Same tree, same node map, so {update} still applies afterwards for the handful of
  /// registrations a later scan turns up — that path is already cheap because it is a few
  /// aliases, not all of them.
  static fromLeaves(leaves: Array<{ slot: number; key: bigint; value: bigint }>): SMT {
    const smt = new SMT();
    const zeros = getZeros();

    // Level 0 is the leaf hashes, keyed by slot — the same positions {update} writes.
    let level = new Map<bigint, bigint>();
    for (const l of leaves) {
      const path = BigInt(l.slot);
      const h = smtHash1(l.key, l.value);
      smt.nodes.set(`0:${path}`, h);
      level.set(path, h);
    }

    // Each level up: pair occupied nodes with their sibling, falling back to the empty subtree
    // for that height. Only occupied parents are visited, which is what keeps this proportional
    // to the number of aliases rather than to the 2^32 the tree could hold.
    for (let i = 0; i < REGISTRY_LEVELS; i++) {
      const next = new Map<bigint, bigint>();
      for (const [path, value] of level) {
        const parent = path >> 1n;
        if (next.has(parent)) continue;   // the sibling already produced it
        const sibling = level.get(path ^ 1n) ?? zeros[i];
        const h = (path & 1n) === 1n
          ? smtHash2(sibling, value)
          : smtHash2(value, sibling);
        next.set(parent, h);
        smt.nodes.set(`${i + 1}:${parent}`, h);
      }
      level = next;
    }

    smt.root = level.get(0n) ?? zeros[REGISTRY_LEVELS];
    return smt;
  }

  // Snapshot used to build the tree state a pending registration WILL produce.
  // claimInvite must prove against the post-registration root, because
  // registerWithPoolNote registers before it verifies the proof.
  clone(): SMT {
    const copy = new SMT();
    (copy as any).nodes = new Map((this as any).nodes);
    copy.root = this.root;
    return copy;
  }

  getSiblings(slot: number): bigint[] {
    const pathKey = BigInt(slot);
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
