import { poseidonHash } from "./crypto";

export const ETH_TOKEN_ADDRESS = 0n;

export interface Entry {
  blinding: bigint;
  amount: bigint;
  tokenAddress: bigint;
  commitment: bigint;
  leafIndex?: number;   // set after on-chain inclusion
}

export type OwnedEntry = Entry & { leafIndex: number };

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

// Nullifier derivable only after on-chain inclusion (leafIndex known from Transact event).
export function computeNullifier(nullifierKey: bigint, leafIndex: number): bigint {
  return poseidonHash([nullifierKey, BigInt(leafIndex), NULLIFIER_DOMAIN]);
}

export function randomBlinding(): bigint {
  return BigInt("0x" + require("crypto").randomBytes(31).toString("hex"));
}
