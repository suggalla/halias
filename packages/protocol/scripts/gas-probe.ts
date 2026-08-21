import { ethers } from "hardhat";
import { ensurePoseidon } from "./poseidon";

async function main() {
  const { PoseidonT3, PoseidonT4 } = await ensurePoseidon();
  const probe = await (await ethers.getContractFactory("GasProbe", {
    libraries: { PoseidonT3, PoseidonT4 },
  })).deploy();
  await probe.waitForDeployment();

  const v = Array.from({ length: 20 }, (_, i) => BigInt(i + 1) * 7919n);
  const used = async (p: any) => Number((await (await p).wait()).gasUsed);

  // Warm the storage slot first: the first SSTORE to `sink` is 20k, every later one 2.9k,
  // and that difference is larger than some of what is being measured.
  await used(probe.chainT3(1n));

  // Slope, not difference: (cost of 33 hashes - cost of 1) / 32. Every fixed cost cancels.
  const t3 = Math.round((await used(probe.chainT3(33n)) - await used(probe.chainT3(1n))) / 32);
  const t4 = Math.round((await used(probe.chainT4(33n)) - await used(probe.chainT4(1n))) / 32);
  const noop = await used(probe.noop(v));
  const fold = await used(probe.probeFold20(v));
  const kec  = await used(probe.probeKeccak20(v));

  console.log(`  one Poseidon(2), marginal   ${t3} gas`);
  console.log(`  one Poseidon(3), marginal   ${t4} gas`);
  console.log(`  a 32-level walk, hashing     ${32 * t3}`);
  console.log(`  a 16-level walk, hashing     ${16 * t3}   (saves ${16 * t3})`);
  console.log(`  fold 20 -> 1 via Poseidon   ${fold - noop} gas over that`);
  console.log(`  hash 20 -> 1 via keccak     ${kec - noop} gas over that`);
  console.log("");
  console.log(`  Groth16 per public signal   ~6150 (ECMUL 6000 + ECADD 150)`);
  console.log(`  20 signals cost             ~${20 * 6150}`);
  console.log(`  packing to 1 would save     ~${19 * 6150}`);
  console.log(`  ... and cost, on chain      ${fold - noop} (Poseidon) or ${kec - noop} (keccak)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
