import { ethers } from "ethers";
import { randomBytes, toHex } from "./random";
import { poseidonHash } from "./crypto";
import { computeNullifier, POOL_LEVELS } from "./entry";

// @ts-expect-error — snarkjs ships no types.
import * as snarkjs from "snarkjs";

export interface ArtifactPaths {
  wasmPath: string;
  zkeyPath: string;
}

export interface TransactInput {
  spendingPrivKey: bigint;
  viewingPrivKey: bigint;
  blinding: bigint;
  amount: bigint;
  pathIndices: number[];   // length = pool levels (32)
  pathElements: bigint[];  // length = pool levels (32)
}

export interface TransactOutput {
  spendingCommitment: bigint;              // spendingCommitment of recipient
  nullifierKeyHash: bigint;    // Poseidon(nullifierKey, 1) — read from registry; raw key never leaves recipient
  blinding: bigint;
  amount: bigint;
  aliasHash: bigint;           // aliasHash % FIELD_PRIME — identity bound into the leaf
  registrySlot: number;        // slot assigned at registration — the tree position for this recipient
  dataHash: bigint;            // attestation/reputation data commitment
  registrySiblings: bigint[];  // length = registry levels (32); SMT proof
}

/// The registry insertion this proof performs, if any.
///
/// Only a claim has one. It exists because a claim's change note is a non-zero output, so it
/// needs registry membership for an alias that is not in the tree yet — the circuit derives
/// the post-insertion tree from `registryRoot` rather than the client guessing at it. The
/// leaf is public and the contract supplies it; the slot and siblings are private and are
/// proved to be a genuinely empty position under `registryRoot`.
export interface PendingRegistration {
  leaf: bigint;             // SMT leaf hash: Poseidon(aliasKey, leafValue, 1)
  slot: number;             // a free slot in the tree at registryRoot
  siblings: bigint[];       // its siblings there — length = registry levels (32)
}

export interface TransactProveInput {
  /// One per input: two notes may live in different trees.
  poolRoot: [bigint, bigint];
  treeNumber: [number, number];
  registryRoot: bigint;
  publicAmount: bigint;   // positive = deposit, 0 = transfer, field-negative = withdraw
  tokenAddress: bigint;   // 0n for ETH
  paramsHash: bigint;     // commitment to TransactParams
  inputNullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint];
  inputs: [TransactInput, TransactInput];
  outputs: [TransactOutput, TransactOutput];
  /// Omitted on every path but a claim, where it must match what the domain armed.
  pending?: PendingRegistration;
  /// Take the cheap exit: spend the inputs and insert nothing.
  ///
  /// Only legal when both outputs are zero-amount — the circuit enforces that direction, so
  /// setting it while holding real change makes the proof invalid rather than destroying the
  /// change. The converse is NOT enforced: a caller with nothing to keep may still leave this
  /// unset and insert two dummy commitments, which costs ~1.87M more gas and is the reason
  /// to do it — an exit is distinguishable on chain, where every ordinary transact looks
  /// alike. Off by default.
  outputsEmpty?: boolean;
}

// Tree depths, baked into the compiled circuit. Changing either here without recompiling
// produces witnesses of the wrong shape rather than a type error. POOL_LEVELS is imported
// from entry.ts rather than redeclared: it is the split point of the nullifier's global index,
// so a second copy drifting from it corrupts nullifiers rather than merely failing to prove.
const REGISTRY_LEVELS = 32;

/// What an ordinary transaction supplies: no insertion, and dummy witness values for the
/// slot and siblings the circuit computes but then discards.
const NO_PENDING: PendingRegistration = {
  leaf: 0n,
  slot: 0,
  siblings: new Array(REGISTRY_LEVELS).fill(0n),
};

function s(v: bigint): string { return v.toString(); }

function serializeForCircuit(inp: TransactProveInput): Record<string, unknown> {
  const pending = inp.pending ?? NO_PENDING;
  return {
    poolRoot:             inp.poolRoot.map(s),
    treeNumber:           inp.treeNumber.map(String),
    registryRoot:         s(inp.registryRoot),
    publicAmount:         s(inp.publicAmount),
    tokenAddress:         s(inp.tokenAddress),
    paramsHash:           s(inp.paramsHash),
    outputsEmpty:         inp.outputsEmpty ? "1" : "0",
    pendingLeaf:          s(pending.leaf),
    pendingSlot:          String(pending.slot),
    pendingSiblings:      pending.siblings.map(s),
    inputNullifier:       inp.inputNullifiers.map(s),
    outputCommitment:     inp.outputCommitments.map(s),
    inSpendingPrivateKey: inp.inputs.map(i => s(i.spendingPrivKey)),
    inViewingPrivateKey:  inp.inputs.map(i => s(i.viewingPrivKey)),
    inBlinding:           inp.inputs.map(i => s(i.blinding)),
    inAmount:             inp.inputs.map(i => s(i.amount)),
    inPathIndices:        inp.inputs.map(i => i.pathIndices.map(String)),
    inPathElements:       inp.inputs.map(i => i.pathElements.map(s)),
    outSpendingCommitment:            inp.outputs.map(o => s(o.spendingCommitment)),
    outBlinding:          inp.outputs.map(o => s(o.blinding)),
    outAmount:            inp.outputs.map(o => s(o.amount)),
    outNullifierKeyHash:  inp.outputs.map(o => s(o.nullifierKeyHash)),
    outDataHash:          inp.outputs.map(o => s(o.dataHash)),
    outAliasHash:         inp.outputs.map(o => s(o.aliasHash)),
    outRegistryIndex:     inp.outputs.map(o => String(o.registrySlot)),
    outRegistrySiblings:  inp.outputs.map(o => o.registrySiblings.map(s)),
  };
}

export async function proveTransact(
  input: TransactProveInput,
  paths: ArtifactPaths,
): Promise<{ proofBytes: string; publicSignals: string[] }> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    serializeForCircuit(input),
    paths.wasmPath,
    paths.zkeyPath,
  );
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [pA, pB, pC] = JSON.parse("[" + calldata + "]");
  const proofBytes = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [pA, pB, pC],
  );
  return { proofBytes, publicSignals };
}

// ── Dummy input/output helpers ────────────────────────────────────────────────


export interface DummyInput {
  input: TransactInput;
  nullifier: bigint;
}

/// A zero-amount input, used to pad a transaction to the circuit's two.
///
/// It proves nothing — a zero amount disables the Merkle check — but it still publishes a
/// nullifier, so that nullifier must not collide with anything. Uniqueness comes from the
/// freshly random keys, not from the index; the index only has to be *representable*, since
/// the circuit packs it from `pathIndices` and folds it into the global position.
///
/// `treeNumber` must match the tree of whatever root this input names, because the pool
/// checks that pairing for both inputs whether or not either is a dummy. Callers pass the
/// same tree and root as the real input beside it, which costs nothing: two genuine notes
/// spent together are usually proven against one root anyway.
export function dummyInput(
  treeNumber: number,
  leafIndex: number = 0,
  poolLevels: number = POOL_LEVELS,
): DummyInput {
  const idx = leafIndex % (1 << poolLevels);
  const spendingPrivKey = BigInt("0x" + toHex(randomBytes(31)));
  const viewingPrivKey  = BigInt("0x" + toHex(randomBytes(31)));
  const nullifierKey    = poseidonHash([viewingPrivKey]);
  const nullifier       = computeNullifier(nullifierKey, treeNumber, idx);
  return {
    input: {
      spendingPrivKey,
      viewingPrivKey,
      blinding:    0n,
      amount:      0n,
      pathIndices: Array.from({ length: poolLevels }, (_, i) => (idx >> i) & 1),
      pathElements: new Array(poolLevels).fill(0n),
    },
    nullifier,
  };
}

export function dummyOutput(blinding: bigint = 0n): TransactOutput {
  return {
    spendingCommitment:             poseidonHash([0n]),
    nullifierKeyHash:   0n,   // registry proof skipped for zero-amount outputs; value unconstrained
    blinding,
    amount:             0n,
    aliasHash:          0n,
    registrySlot:       0,
    dataHash:           0n,
    registrySiblings:   new Array(REGISTRY_LEVELS).fill(0n),
  };
}
