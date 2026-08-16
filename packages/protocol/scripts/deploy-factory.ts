import { ethers } from "hardhat";
import { saveDeployment } from "./deployment";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying Create2Factory with account: ${deployer.address}`);

  const Factory = await ethers.getContractFactory("Create2Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const addr = await factory.getAddress();
  console.log(`Create2Factory deployed to: ${addr}`);

  saveDeployment({ deployer: deployer.address, factory: addr });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
