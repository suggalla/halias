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
  spendingPubkey: bigint,
  nullifierKeyHash: bigint,
  blinding: bigint,
  amount: bigint,
  tokenAddress: bigint = ETH_TOKEN_ADDRESS,
): Entry {
  const commitment = poseidonHash([spendingPubkey, nullifierKeyHash, blinding, amount, tokenAddress]);
  return { blinding, amount, tokenAddress, commitment };
}

// Domain tag keeps the nullifier in a different Poseidon arity/domain from
// nullifierKeyHash = Poseidon(nullifierKey, 1), so the two can never collide.
// Must stay in sync with NoteNullifier in transact.circom.
export const NULLIFIER_DOMAIN = 1314148940n; // "NULL" ascii (0x4e554c4c)

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
