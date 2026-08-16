import { ethers } from "hardhat";

// The shapes every suite needs to call `transact`, in one place.
//
// `TransactParams` has twelve members and each suite was writing all twelve out, usually to
// vary one. That is the shape of thing that drifts: a field added to the struct means finding
// every literal, and a suite that misses one fails with an ABI error naming nothing useful.
// It already happened once — `outputsEmpty` appears in eight files, wedged in at whatever
// indentation the edit landed on.
//
// Values here are deliberately inert: zero amount, zero recipient, no relayer, no pending
// insertion. A test overrides exactly the field it is about, so what it is testing is what is
// visible at the call site.

export const ZERO_PROOF = "0x" + "00".repeat(256);
export const NO_RELAYER = { relayer: ethers.ZeroAddress, amount: 0n };

/// A random 32-byte value. NOT a field element — see helpers/field.ts for that. Fine for
/// nullifiers and commitments, which the contract never bounds; wrong for anything the
/// registry checks.
export const rand32 = () => ethers.keccak256(ethers.randomBytes(32));

/// A no-op transact, anchored to whatever the pool and registry currently hold.
///
/// `currentAnchor` rather than `getLastRoot` plus a hardcoded tree: after a rollover those
/// two disagree, and every suite that hardcoded `treeNumber: [0, 0]` was correct only until
/// the pool rolled over — which is exactly the case PoolRollover exists to test.
///
/// Four inputs, all anchored to the same root and all with distinct nullifiers. A real
/// transaction pads unused slots with dummies exactly like this, which is what keeps the
/// number of real notes spent invisible on chain.
export async function transactParams(pool: any, registry: any, over: any = {}) {
  const [root, tree] = await pool.currentAnchor();
  return {
    poolRoot:          [root, root, root, root],
    treeNumber:        [Number(tree), Number(tree), Number(tree), Number(tree)],
    registryRoot:      await registry.getRegistryRoot(),
    publicAmount:      0n,
    tokenAddress:      ethers.ZeroAddress,
    inputNullifiers:   [rand32(), rand32(), rand32(), rand32()],
    outputCommitments: [rand32(), rand32()],
    recipient:         ethers.ZeroAddress,
    relayerFee:        NO_RELAYER,
    externalData:      ethers.ZeroHash,
    pendingLeaf:       ethers.ZeroHash,
    outputsEmpty:      false,
    ...over,
  };
}

/// A withdrawal's `publicAmount`: negative amounts are encoded as `p - amount`.
///
/// Written out per suite as `FIELD_PRIME - x`, which is correct and says nothing. The name is
/// the point — a bare subtraction from a 77-digit constant reads as arithmetic rather than as
/// "this is the withdrawal encoding".
export function withdrawOf(amount: bigint, fieldPrime: bigint): bigint {
  return fieldPrime - amount;
}
