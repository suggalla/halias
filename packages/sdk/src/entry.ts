import { poseidonHash } from "./crypto";
import { randomFieldElement } from "./random";

export const ETH_TOKEN_ADDRESS = 0n;

export interface Entry {
  blinding: bigint;
  amount: bigint;
  tokenAddress: bigint;
  commitment: bigint;
  // Both set after on-chain inclusion, and both are needed: the pool is a sequence of trees,
  // so a leaf index alone does not identify a note.
  treeNumber?: number;
  leafIndex?: number;
}

export type OwnedEntry = Entry & { treeNumber: number; leafIndex: number };

// nullifierKeyHash = Poseidon(nullifierKey, 1) — pass the hash, not the raw key.
// Raw nullifierKey is never stored on-chain; callers compute the hash before building entries.
export function buildEntry(
  spendingCommitment: bigint,
  nullifierKeyHash: bigint,
  blinding: bigint,
  amount: bigint,
  tokenAddress: bigint = ETH_TOKEN_ADDRESS,
): Entry {
  const commitment = poseidonHash([spendingCommitment, nullifierKeyHash, blinding, amount, tokenAddress]);
  return { blinding, amount, tokenAddress, commitment };
}

// Domain tag keeps the nullifier in a different Poseidon arity/domain from
// nullifierKeyHash = Poseidon(nullifierKey, 1), so the two can never collide.
// Must stay in sync with NoteNullifier in transact.circom.
/// The BN254 scalar field, and the modulus every public signal lives in.
///
/// One declaration for the whole SDK. It was written out in three places here and nine more
/// across the tests, with nothing asserting they agreed — and a wrong digit does not fail
/// loudly: a signal reduced mod the wrong prime produces a proof that verifies against
/// nothing, or an amount that decodes to something else entirely. Same reasoning as
/// {NULLIFIER_DOMAIN}, and the same fix.
///
/// Must equal `FIELD_PRIME` in contracts/base/Constants.sol.
export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const NULLIFIER_DOMAIN = 1314148940n; // "NTRL" ascii (0x4e54524c) — a domain tag, and any value distinct from the other
// Poseidon inputs would do. Frozen: it is baked into the circuit and the proving key.

/// Nullifier for a note, derivable only after on-chain inclusion — both coordinates come from
/// the Transact event.
///
/// Keys on the note's GLOBAL position. `leafIndex` addresses only within one tree, so leaf 5
/// of tree 0 and leaf 5 of tree 3 would otherwise produce the same nullifier, and whichever
/// note was spent second would read as already spent and be permanently unspendable. This
/// must stay identical to NoteNullifier in transact.circom, including POOL_LEVELS — a
/// disagreement here does not fail loudly, it destroys notes.
export const POOL_LEVELS = 16;

export function computeNullifier(
  nullifierKey: bigint,
  treeNumber: number,
  leafIndex: number,
): bigint {
  const globalIndex = (BigInt(treeNumber) << BigInt(POOL_LEVELS)) + BigInt(leafIndex);
  return poseidonHash([nullifierKey, globalIndex, NULLIFIER_DOMAIN]);
}

export function randomBlinding(): bigint {
  return randomFieldElement();
}
