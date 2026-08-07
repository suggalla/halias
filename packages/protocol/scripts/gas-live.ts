import { ethers } from "hardhat";
import * as path from "path";
import * as fs from "fs";
import { loadDeployment } from "./deployment";

const sdk = require("halias-sdk");

const WASM = path.resolve(__dirname, "../circuits/out/transact/transact_js/transact.wasm");
const ZKEY = path.resolve(__dirname, "../circuits/out/transact/ceremony/transact_final.zkey");

// Measures gas on the live deployment, with the real Groth16 verifier.
//
// The hardhat figures used MockTransactVerifier and an estimated +250k for the real
// proof. That estimate has never been checked, and Sepolia is post-Glamsterdam, so this
// confirms rather than assumes.
async function main() {
  const cfg = loadDeployment();
  const [signer] = await ethers.getSigners();
  const halias = await ethers.getContractAt("Halias", cfg.halias);
  const rand32 = () => ethers.keccak256(ethers.randomBytes(32));

  console.log(`Halias ${cfg.halias} on chain ${(await ethers.provider.getNetwork()).chainId}\n`);

  // register(): no proof needed, so this isolates the registry SMT cost exactly.
  const fee = await halias.registrationFee();
  const aliasHash = ethers.keccak256(ethers.toUtf8Bytes(`gas${Date.now().toString(36)}.hls`));
  const reg = await (await halias.register(
    aliasHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), rand32(), { value: fee },
  )).wait();
  console.log(`  register()          ${reg!.gasUsed.toLocaleString().padStart(10)} gas`);

  // updateKeys(): a second SMT update, this time over warm storage slots.
  const upd = await (await halias.updateKeys(aliasHash, ethers.toBeHex(3n, 32), rand32())).wait();
  console.log(`  updateKeys()        ${upd!.gasUsed.toLocaleString().padStart(10)} gas`);

  // transact(): needs a real proof, so go through the SDK exactly as a user would.
  const cacheDir = "/tmp/halias-gas-cache";
  fs.mkdirSync(cacheDir, { recursive: true });
  const client = new sdk.Halias({
    provider: ethers.provider, signer, chainId: Number((await ethers.provider.getNetwork()).chainId),
    contractAddress: cfg.halias, artifacts: { transactWasm: WASM, transactZkey: ZKEY },
    cache: new sdk.FileCache(cacheDir), startBlock: cfg.startBlock, rpcChunkSize: 400,
  });
  await client.init();

  const name = `gas${Date.now().toString(36)}`;
  await client.register(name);
  const dep = await client.deposit("0.002");
  const depReceipt = await ethers.provider.getTransactionReceipt(dep.txHash);
  console.log(`  transact (deposit)  ${depReceipt!.gasUsed.toLocaleString().padStart(10)} gas   [real Groth16]`);

  const snd = await client.send(`${name}.hls`, "0.0005");
  const sndReceipt = await ethers.provider.getTransactionReceipt(snd.txHash);
  console.log(`  transact (transfer) ${sndReceipt!.gasUsed.toLocaleString().padStart(10)} gas   [real Groth16]`);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
