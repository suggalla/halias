import { ethers } from "ethers";
import { randomBytes } from "crypto";
import { poseidonHash } from "./crypto";

const snarkjs = require("snarkjs");

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
  pubkey: bigint;              // spendingPubkey of recipient
  nullifierKeyHash: bigint;    // Poseidon(nullifierKey, 1) — read from registry; raw key never leaves recipient
  blinding: bigint;
  amount: bigint;
  aliasHash: bigint;           // aliasHash % FIELD_PRIME — private SMT key for this recipient
  dataHash: bigint;            // attestation/reputation data commitment
  registrySiblings: bigint[];  // length = registry levels (32); SMT proof
}

export interface TransactProveInput {
  poolRoot: bigint;
  registryRoot: bigint;
  publicAmount: bigint;   // positive = deposit, 0 = transfer, field-negative = withdraw
  tokenAddress: bigint;   // 0n for ETH
  paramsHash: bigint;     // commitment to TransactParams
  inputNullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint];
  inputs: [TransactInput, TransactInput];
  outputs: [TransactOutput, TransactOutput];
}

function s(v: bigint): string { return v.toString(); }

function serializeForCircuit(inp: TransactProveInput): Record<string, unknown> {
  return {
    poolRoot:             s(inp.poolRoot),
    registryRoot:         s(inp.registryRoot),
    publicAmount:         s(inp.publicAmount),
    tokenAddress:         s(inp.tokenAddress),
    paramsHash:           s(inp.paramsHash),
    inputNullifier:       inp.inputNullifiers.map(s),
    outputCommitment:     inp.outputCommitments.map(s),
    inSpendingPrivateKey: inp.inputs.map(i => s(i.spendingPrivKey)),
    inViewingPrivateKey:  inp.inputs.map(i => s(i.viewingPrivKey)),
    inBlinding:           inp.inputs.map(i => s(i.blinding)),
    inAmount:             inp.inputs.map(i => s(i.amount)),
    inPathIndices:        inp.inputs.map(i => i.pathIndices.map(String)),
    inPathElements:       inp.inputs.map(i => i.pathElements.map(s)),
    outPubkey:            inp.outputs.map(o => s(o.pubkey)),
    outBlinding:          inp.outputs.map(o => s(o.blinding)),
    outAmount:            inp.outputs.map(o => s(o.amount)),
    outNullifierKeyHash:  inp.outputs.map(o => s(o.nullifierKeyHash)),
    outDataHash:          inp.outputs.map(o => s(o.dataHash)),
    outAliasHash:         inp.outputs.map(o => s(o.aliasHash)),
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

const REGISTRY_LEVELS = 32;
const POOL_LEVELS     = 32;

export interface DummyInput {
  input: TransactInput;
  nullifier: bigint;
}

const DUMMY_IDX_START = (1 << 30);

export function dummyInput(leafIndex: number = 0, poolLevels: number = POOL_LEVELS): DummyInput {
  const finalIdx = DUMMY_IDX_START + leafIndex;
  const spendingPrivKey = BigInt("0x" + randomBytes(31).toString("hex"));
  const viewingPrivKey  = BigInt("0x" + randomBytes(31).toString("hex"));
  const nullifierKey    = poseidonHash([viewingPrivKey]);
  const nullifier       = poseidonHash([nullifierKey, BigInt(finalIdx)]);
  return {
    input: {
      spendingPrivKey,
      viewingPrivKey,
      blinding:    0n,
      amount:      0n,
      pathIndices: Array.from({ length: poolLevels }, (_, i) => (finalIdx >> i) & 1),
      pathElements: new Array(poolLevels).fill(0n),
    },
    nullifier,
  };
}

export function dummyOutput(blinding: bigint = 0n): TransactOutput {
  return {
    pubkey:             poseidonHash([0n]),
    nullifierKeyHash:   0n,   // registry proof skipped for zero-amount outputs; value unconstrained
    blinding,
    amount:             0n,
    aliasHash:          0n,
    dataHash:           0n,
    registrySiblings:   new Array(REGISTRY_LEVELS).fill(0n),
  };
}
