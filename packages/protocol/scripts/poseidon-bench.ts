import { ethers } from "hardhat";
// Our viaIR build of poseidon-solidity vs the package's canonical build, at the same call.
async function main() {
  const { proxy, PoseidonT3, PoseidonT4 } = require("poseidon-solidity");
  const [dep] = await ethers.getSigners();

  if ((await ethers.provider.getCode(proxy.address)) === "0x") {
    await (await dep.sendTransaction({ to: proxy.from, value: proxy.gas })).wait();
    await (await ethers.provider.broadcastTransaction(proxy.tx)).wait();
  }
  for (const lib of [PoseidonT3, PoseidonT4]) {
    if ((await ethers.provider.getCode(lib.address)) === "0x") {
      await (await dep.sendTransaction({ to: proxy.address, data: lib.data })).wait();
    }
  }

  const ours3 = await (await (await ethers.getContractFactory("PoseidonT3")).deploy()).getAddress();
  const ours4 = await (await (await ethers.getContractFactory("PoseidonT4")).deploy()).getAddress();

  const call = (n: number, args: bigint[]) => ethers.concat([
    ethers.id(`hash(uint256[${n}])`).slice(0, 10),
    ethers.AbiCoder.defaultAbiCoder().encode([`uint256[${n}]`], [args]),
  ]);

  const rows: [string, string, string][] = [
    ["PoseidonT3", ours3, PoseidonT3.address],
    ["PoseidonT4", ours4, PoseidonT4.address],
  ];
  for (const [name, mine, canon] of rows) {
    const n = name.endsWith("3") ? 2 : 3;
    const args = n === 2 ? [1n, 2n] : [1n, 2n, 3n];
    const a = await ethers.provider.estimateGas({ to: mine,  data: call(n, args) });
    const b = await ethers.provider.estimateGas({ to: canon, data: call(n, args) });
    const codeA = ((await ethers.provider.getCode(mine)).length - 2) / 2;
    const codeB = ((await ethers.provider.getCode(canon)).length - 2) / 2;
    console.log(`${name}  ours ${a} gas / ${codeA} bytes   canonical ${b} gas / ${codeB} bytes   ` +
                `saving ${a - b} (${Number((a - b) * 100n / a)}%)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
