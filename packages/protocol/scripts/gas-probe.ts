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
  // A level of registry depth, end to end: the hash, the sibling read and the node write.
  // Warmed first — the first few walks into a fresh tree pay cold writes that a steady-state
  // registry does not, which is the same reason gasbench reports register #2 and not #1.
  for (let i = 0; i < 8; i++) await used(probe.walk(32n));
  const w32 = await used(probe.walk(32n));
  const w16 = await used(probe.walk(16n));
  const perLevel = Math.round((w32 - w16) / 16);
  console.log("");
  console.log(`  one registry level          ${perLevel} gas (hash + sibling read + node write)`);
  console.log(`  32 -> 16 saves              ${16 * perLevel}`);
  console.log(`  32 -> 20 saves              ${12 * perLevel}`);
  console.log(`  32 -> 24 saves              ${8 * perLevel}`);

  // The same level if the tree were append-only. Averaged over four inserts because the
  // even branch writes and the odd branch does not, so a single sample is one or the other.
  for (let i = 0; i < 8; i++) await used(probe.walkAppend(32n));
  let a32 = 0, a16 = 0;
  for (let i = 0; i < 4; i++) { a32 += await used(probe.walkAppend(32n)); a16 += await used(probe.walkAppend(16n)); }
  const perLevelAppend = Math.round((a32 - a16) / 4 / 16);
  console.log(`  one append-only level       ${perLevelAppend} gas`);
  console.log(`  immutability saves, at 32   ${32 * (perLevel - perLevelAppend)}`);
  console.log("");
  console.log(`  Groth16 per public signal   ~6150 (ECMUL 6000 + ECADD 150)`);
  console.log(`  20 signals cost             ~${20 * 6150}`);
  console.log(`  packing to 1 would save     ~${19 * 6150}`);
  console.log(`  ... and cost, on chain      ${fold - noop} (Poseidon) or ${kec - noop} (keccak)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
