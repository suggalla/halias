// Generate zero values for MerkleTreeWithHistory (depth 20, Poseidon)
// Run: npx ts-node --project tsconfig.hardhat.json scripts/generate-zeros.ts

async function main() {
  const { buildPoseidon } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const LEVELS = 20;
  const zeros: string[] = [];

  // Level 0: hash of empty leaf (0)
  let current = BigInt(0);
  zeros.push("0x" + current.toString(16).padStart(64, "0"));

  for (let i = 0; i < LEVELS; i++) {
    current = F.toObject(poseidon([current, current]));
    zeros.push("0x" + current.toString(16).padStart(64, "0"));
  }

  console.log("// Precomputed zero values for Poseidon Merkle tree (depth 20)");
  console.log("// zeros[0] = 0 (empty leaf)");
  console.log("// zeros[i] = Poseidon(zeros[i-1], zeros[i-1])");
  for (let i = 0; i <= LEVELS; i++) {
    console.log(`bytes32(${zeros[i]})${i < LEVELS ? "," : ""} // level ${i}`);
  }
}

main().catch(console.error);
