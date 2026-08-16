import { ethers } from "hardhat";
import { anchorOf } from "../test/helpers/anchor";
// Reports gas for the two hot paths so a type/storage change can be judged, not guessed.
async function main() {
  const [dep] = await ethers.getSigners();

  // Which Poseidon the numbers are measured against. Production links the canonical build
  // (see ensurePoseidon in deploy.ts); our own viaIR build of the same source is both larger
  // and far slower, so measuring against it overstates every figure here.
  const canonical = process.env.OWN_POSEIDON !== "1";
  let t3: string, t4: string;
  if (canonical) {
    const { proxy, PoseidonT3, PoseidonT4 } = require("poseidon-solidity");
    if ((await ethers.provider.getCode(proxy.address)) === "0x") {
      await (await dep.sendTransaction({ to: proxy.from, value: proxy.gas })).wait();
      await (await ethers.provider.broadcastTransaction(proxy.tx)).wait();
    }
    for (const lib of [PoseidonT3, PoseidonT4]) {
      if ((await ethers.provider.getCode(lib.address)) === "0x") {
        await (await dep.sendTransaction({ to: proxy.address, data: lib.data })).wait();
      }
    }
    t3 = PoseidonT3.address; t4 = PoseidonT4.address;
  } else {
    t3 = await (await (await ethers.getContractFactory("PoseidonT3")).deploy()).getAddress();
    t4 = await (await (await ethers.getContractFactory("PoseidonT4")).deploy()).getAddress();
  }
  console.log(`poseidon      : ${canonical ? "canonical" : "own viaIR build"}`);
  const libs = { PoseidonT3: t3, PoseidonT4: t4 };
  const poolLibs = { PoseidonT3: t3 };

  const regF = await ethers.getContractFactory("HaliasRegistry", { libraries: libs });
  const reg = await regF.deploy(dep.address);
  console.log("deploy registry:", (await reg.deploymentTransaction()!.wait())!.gasUsed.toString());
  const ver = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
  const pool = await (await ethers.getContractFactory("HaliasPool", { libraries: poolLibs }))
    .deploy(await ver.getAddress(), await ver.getAddress(), await reg.getAddress());
  console.log("deploy pool    :", (await pool.deploymentTransaction()!.wait())!.gasUsed.toString());

  const r32 = () => ethers.hexlify(ethers.randomBytes(32));
  // 31 bytes: a full 32 exceeds FIELD_PRIME ~81% of the time and the registry rejects it.
  const rF = () => ethers.zeroPadValue(ethers.hexlify(ethers.randomBytes(31)), 32);
  const base = async (over: any = {}) => ({
    poolRoot: new Array(4).fill((await anchorOf(pool)).root), treeNumber: new Array(4).fill((await anchorOf(pool)).tree),
    registryRoot: await reg.getRegistryRoot(),
    publicAmount: ethers.parseEther("1"), tokenAddress: ethers.ZeroAddress,
    inputNullifiers: [r32(), r32(), r32(), r32()], outputCommitments: [r32(), r32()],
    recipient: ethers.ZeroAddress, relayerFee: { relayer: ethers.ZeroAddress, amount: 0n },
    externalData: ethers.ZeroHash, pendingLeaf: ethers.ZeroHash, outputsEmpty: false, ...over,
  });
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);

  // Warm: first insert writes zero->nonzero slots, which is not representative.
  await (await pool.transact(await base(), "0x", "0x", proof, { value: ethers.parseEther("1") })).wait();
  const t = await (await pool.transact(await base(), "0x", "0x", proof, { value: ethers.parseEther("1") })).wait();
  console.log("transact      :", t!.gasUsed.toString());

  // The exit path against an ordinary transact. An exit inserts nothing, so it skips the
  // tree walk — the saving is the whole reason it exists, set against every exit being
  // distinguishable on chain. Measure it rather than quote it.
  const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const withdrawOf = (x: bigint) => FIELD_PRIME - x;
  const w = await (await pool.transact(
    await base({ publicAmount: withdrawOf(ethers.parseEther("0.1")), recipient: dep.address }),
    "0x", "0x", proof)).wait();
  console.log("withdraw      :", w!.gasUsed.toString());
  const x = await (await pool.transact(
    await base({ publicAmount: withdrawOf(ethers.parseEther("0.1")), recipient: dep.address,
                 outputsEmpty: true }),
    "0x", "0x", proof)).wait();
  console.log("exit          :", x!.gasUsed.toString(),
              ` (${(100 - Number(x!.gasUsed) * 100 / Number(w!.gasUsed)).toFixed(1)}% cheaper)`);

  // Registration cost is not one number. Slots are sequential, so consecutive aliases share
  // every SMT node above the level where their paths diverge — the first write into an empty
  // subtree is zero -> non-zero (~22.1k), every later one is an overwrite (~5k). Reporting
  // only the first registration overstates the steady state by more than 3x.
  for (let i = 1; i <= 10; i++) {
    const r = await (await reg.register(rF(), rF(), rF(), rF())).wait();
    if (i <= 3 || i === 10) console.log(`register #${String(i).padEnd(2)}  :`, r!.gasUsed.toString());
  }
}
main().catch(e => { console.error(e); process.exit(1); });
