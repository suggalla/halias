// Times the scan itself, not process startup — which dominates at this pool size.
const { Halias, FileCache, init } = require("halias-sdk");
const { ethers } = require("ethers");
const { getPoolAddress, getRegistryAddress, getDomainAddress, getStartBlock } = require("halias-deployments");

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const signer = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
const dir = process.argv[2];
const mk = () => new Halias({
  provider, signer, chainId: 31337,
  poolAddress: getPoolAddress(31337), registryAddress: getRegistryAddress(31337),
  domainAddress: getDomainAddress(31337), startBlock: getStartBlock(31337),
  artifacts: { transactWasm: "/dev/null", transactZkey: "/dev/null" },
  cache: new FileCache(dir),
});

async function main(){
 await init();
 for (const label of ["first", "second"]) {
  const h = mk();
  await h.init(0);
  const t = Date.now();
  await h.balance();
  console.log(`${label.padEnd(7)} ${Date.now() - t} ms`);
}
}
main().catch(e=>{console.error(e);process.exit(1);});
