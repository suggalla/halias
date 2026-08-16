import { ethers } from "hardhat";
import { saveDeployment } from "./deployment";

/**
 * Deploy PoseidonT3 and TransactVerifier.
 * Saves addresses to deployments/<network>.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-verifiers.ts --network sepolia
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);

  const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
  const poseidonT3 = await PoseidonT3.deploy();
  await poseidonT3.waitForDeployment();
  const poseidonAddr = await poseidonT3.getAddress();
  console.log(`PoseidonT3 deployed to: ${poseidonAddr}`);

  const TransactVerifier = await ethers.getContractFactory("TransactVerifier");
  const transactVerifier = await TransactVerifier.deploy();
  await transactVerifier.waitForDeployment();
  const jsvAddr = await transactVerifier.getAddress();
  console.log(`TransactVerifier deployed to: ${jsvAddr}`);

  saveDeployment({
    poseidonT3: poseidonAddr,
    transactVerifier: jsvAddr,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
