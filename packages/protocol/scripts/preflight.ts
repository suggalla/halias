import { ethers } from "hardhat";
import { loadDeployment } from "./deployment";

// Pre-deploy sanity check. Answers, without spending anything: are we pointed at the
// chain we think, is the deployer funded, and is any of the stack already live?
async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer — is PRIVATE_KEY set in the root .env?");

  const net  = await ethers.provider.getNetwork();
  const bal  = await ethers.provider.getBalance(signer.address);
  const blk  = await ethers.provider.getBlockNumber();
  const fee  = await ethers.provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 0n;

  console.log(`chain id : ${net.chainId}`);
  console.log(`block    : ${blk}`);
  console.log(`deployer : ${signer.address}`);
  console.log(`balance  : ${ethers.formatEther(bal)} ETH`);
  console.log(`gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  // Dominated by the two Poseidon libraries, which is why they go through the
  // deterministic proxy rather than a normal deploy.
  const estGas  = 13_000_000n;
  const estCost = estGas * gasPrice;
  console.log(`estimate : ~${ethers.formatEther(estCost)} ETH for the full stack (~${estGas} gas)`);
  console.log(bal > estCost * 2n
    ? "funding  : OK"
    : "funding  : LOW — top up before deploying");

  console.log(`verify   : ${process.env.ETHERSCAN_API_KEY ? "ETHERSCAN_API_KEY set" : "no ETHERSCAN_API_KEY — contracts will deploy unverified"}`);

  const cfg = loadDeployment();
  const entries = Object.entries(cfg)
    .filter(([, v]) => typeof v === "string" && String(v).startsWith("0x") && String(v).length === 42);

  if (entries.length === 0) {
    console.log("\nexisting : none — this is a fresh deploy");
  } else {
    console.log("\nexisting deployment entries:");
    for (const [k, v] of entries) {
      const code = await ethers.provider.getCode(v as string);
      console.log(`  ${k.padEnd(18)} ${v}  ${code === "0x" ? "[NO CODE — will redeploy]" : "[live, will skip]"}`);
    }
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
