import { ethers } from "ethers";
import { NULLIFIER_DOMAIN, POOL_LEVELS } from "halias-sdk";
import { poseidonHash } from "./poseidon";

// One nullifier derivation for the whole suite.
//
// Spelled out per file — `poseidonHash([key, (tree << LEVELS) + leaf, 1314148940n])`, with the
// domain as a literal and POOL_LEVELS hardcoded beside it — this is the wrong shape for a value
// whose entire job is to agree across three independent implementations: `NoteNullifier` in
// transact.circom, `computeNullifier` in the SDK, and every test that names a nullifier. A copy
// that drifts raises no error anyone can read; it produces a proof that verifies against
// nothing.
//
// Deliberately NOT a re-export of the SDK's function. Tests that simply call the SDK cannot
// also check the SDK, and this constant has to agree across implementations that were written
// separately. So the arithmetic below is the tests' own, and only the two constants come from
// the SDK — which turns "the tests hardcode 1314148940" into "the tests fail loudly if the SDK
// ever changes it". SdkPreimage.test.ts closes the loop by asserting this function and the
// SDK's agree, and that POOL_LEVELS matches the pool's own LEVELS(). Agreement with the
// circuit is proven where it can only be proven: E2E.test.ts, against the real verifier.
//
// Requires initPoseidon() — every suite here already awaits it in `before`.

export { NULLIFIER_DOMAIN, POOL_LEVELS };

/// The global position a nullifier commits to: `treeNumber * 2^POOL_LEVELS + leafIndex`.
///
/// Exposed separately so a test can assert on the index itself rather than only on the hash of
/// it. A nullifier that is merely "different" says nothing about *why*.
export function globalIndex(treeNumber: number, leafIndex: number): bigint {
  return (BigInt(treeNumber) << BigInt(POOL_LEVELS)) + BigInt(leafIndex);
}

/// A note's nullifier, as the circuit and the SDK both compute it.
export function nullifierFor(
  nullifierKey: bigint,
  leafIndex: number,
  treeNumber = 0,
): bigint {
  return poseidonHash([nullifierKey, globalIndex(treeNumber, leafIndex), NULLIFIER_DOMAIN]);
}

/// The same value as the 32-byte word `transact` takes in calldata.
///
/// Both forms exist because converting at every call site is exactly where a `toBeHex` gets
/// forgotten, and the resulting mismatch surfaces as an unexplained revert.
export function nullifierHex(
  nullifierKey: bigint,
  leafIndex: number,
  treeNumber = 0,
): string {
  return ethers.toBeHex(nullifierFor(nullifierKey, leafIndex, treeNumber), 32);
}
