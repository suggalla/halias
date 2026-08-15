import { ethers } from "ethers";
import { FIELD_PRIME } from "halias-sdk";

// The field every value in this system lives in, and how to pick one at random.
//
// `FIELD_PRIME` was written out eleven times across nine test files, three more inside the
// SDK, and once in Constants.sol — fourteen copies of a 77-digit number with nothing asserting
// they agreed. A transposed digit does not fail loudly: a value reduced mod the wrong prime
// produces a proof that verifies against nothing, or an amount that decodes to something else.
//
// Now one declaration in the SDK, re-exported here, with SdkPreimage.test.ts pinning it
// against the contract's arithmetic. Same shape as helpers/nullifier.ts.
export { FIELD_PRIME };

/// A random value that is actually a field element.
///
/// The reason this exists rather than `keccak256(randomBytes(32))`: a raw keccak is a 256-bit
/// number and the field is ~254 bits, so **about 81% of them are out of range**. Every key and
/// hash the registry accepts is bounds-checked — `SpendingCommitmentOutOfField`,
/// `NullifierKeyHashOutOfField`, `DataHashOutOfField` — so a test using a raw keccak fails on
/// the bound rather than on whatever it meant to check, and does so most of the time.
///
/// That is not hypothetical: raw keccaks were being passed as `dataHash` and silently reduced
/// to the same leaf as a different value, which is the injectivity break the field guards were
/// added for. See docs/prior-art-review.md.
export function randField(): string {
  return ethers.toBeHex(BigInt(ethers.keccak256(ethers.randomBytes(32))) % FIELD_PRIME, 32);
}

/// The same, as a bigint — for callers building witnesses rather than calldata.
export function randFieldBig(): bigint {
  return BigInt(ethers.keccak256(ethers.randomBytes(32))) % FIELD_PRIME;
}
