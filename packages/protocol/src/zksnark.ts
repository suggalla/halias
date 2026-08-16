const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");
const { resolvedPaths } = require("./config");

interface ProofResult {
  proof: Record<string, unknown>;
  publicSignals: string[];
}

interface ProveAndVerifyResult extends ProofResult {
  valid: boolean;
}

interface ParsedCalldata {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
}

async function generateProof(
  input: Record<string, string>,
  overrides?: { wasmPath?: string; zkeyPath?: string }
): Promise<ProofResult> {
  const wasmPath = overrides?.wasmPath ?? resolvedPaths.wasm;
  const zkeyPath = overrides?.zkeyPath ?? resolvedPaths.zkeyFinal;

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  return { proof, publicSignals };
}

async function verifyProof(
  proof: Record<string, unknown>,
  publicSignals: string[],
  vkeyPath?: string
): Promise<boolean> {
  const keyPath = vkeyPath ?? resolvedPaths.verificationKey;
  const vkey = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

async function proveAndVerify(
  input: Record<string, string>
): Promise<ProveAndVerifyResult> {
  const { proof, publicSignals } = await generateProof(input);
  const valid = await verifyProof(proof, publicSignals);
  return { proof, publicSignals, valid };
}

async function exportSolidityVerifier(zkeyPath?: string): Promise<string> {
  const keyPath = zkeyPath ?? resolvedPaths.zkeyFinal;

  const snarkjsRoot = path.resolve(path.dirname(require.resolve("snarkjs")), "..");
  const templatePath = path.join(snarkjsRoot, "templates", "verifier_groth16.sol.ejs");
  const template = fs.readFileSync(templatePath, "utf-8");

  const code: string = await snarkjs.zKey.exportSolidityVerifier(
    keyPath,
    { groth16: template }
  );

  return code;
}

async function exportCalldata(
  proof: Record<string, unknown>,
  publicSignals: string[]
): Promise<string> {
  return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}

function parseCalldata(calldataStr: string): ParsedCalldata {
  const [pA, pB, pC, pubSignals] = JSON.parse(`[${calldataStr}]`);
  return { pA, pB, pC, pubSignals };
}

module.exports = {
  generateProof,
  verifyProof,
  proveAndVerify,
  exportSolidityVerifier,
  exportCalldata,
  parseCalldata,
};
