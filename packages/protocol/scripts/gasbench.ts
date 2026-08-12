import { ethers } from "hardhat";
// Reports gas for the two hot paths so a type/storage change can be judged, not guessed.
async function main() {
  const [dep] = await ethers.getSigners();
  const P3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
  const P4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
  const libs = { PoseidonT3: await P3.getAddress(), PoseidonT4: await P4.getAddress() };
  const poolLibs = { PoseidonT3: await P3.getAddress() };

  const reg = await (await ethers.getContractFactory("HaliasRegistry", { libraries: libs }))
    .deploy(dep.address);
  const ver = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
  const pool = await (await ethers.getContractFactory("HaliasPool", { libraries: poolLibs }))
    .deploy(await ver.getAddress(), await reg.getAddress());

  const r32 = () => ethers.hexlify(ethers.randomBytes(32));
  // 31 bytes: a full 32 exceeds FIELD_PRIME ~81% of the time and the registry rejects it.
  const rF = () => ethers.zeroPadValue(ethers.hexlify(ethers.randomBytes(31)), 32);
  const base = async (over: any = {}) => ({
    poolRoot: [await pool.getLastRoot(), await pool.getLastRoot()], treeNumber: [0, 0],
    registryRoot: await reg.getRegistryRoot(),
    publicAmount: ethers.parseEther("1"), tokenAddress: ethers.ZeroAddress,
    inputNullifiers: [r32(), r32()], outputCommitments: [r32(), r32()],
    recipient: ethers.ZeroAddress, relayerFee: { relayer: ethers.ZeroAddress, amount: 0n },
    externalData: ethers.ZeroHash, pendingLeaf: ethers.ZeroHash, outputsEmpty: false, ...over,
  });
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);

  // Warm: first insert writes zero->nonzero slots, which is not representative.
  await (await pool.transact(await base(), "0x", "0x", proof, { value: ethers.parseEther("1") })).wait();
  const t = await (await pool.transact(await base(), "0x", "0x", proof, { value: ethers.parseEther("1") })).wait();
  console.log("transact      :", t!.gasUsed.toString());

  const rr = await (await reg.register(rF(), rF(), rF(), rF())).wait();
  console.log("register (SMT):", rr!.gasUsed.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
