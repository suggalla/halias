const { buildPoseidon } = require("circomlibjs");

let poseidon: any;
let F: any; // finite field

export async function initPoseidon() {
  poseidon = await buildPoseidon();
  F = poseidon.F;
}

export function poseidonHash(inputs: bigint[]): bigint {
  return F.toObject(poseidon(inputs));
}

export function toFieldElement(n: bigint | number): bigint {
  return BigInt(n);
}
