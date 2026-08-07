import { ethers } from "hardhat";
import { loadDeployment, saveDeployment } from "./deployment";

/**
 * Deploy Halias via CREATE2 factory with a pre-mined vanity salt.
 * Reads all addresses + salt from deployments/<network>.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-halias.ts --network sepolia
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);

  const config = loadDeployment();
  const factoryAddr = config.factory;
  const salt = config.vanitySalt;
  const poseidonT3 = config.poseidonT3;
  const transactVerifier = config.transactVerifier;

  if (!factoryAddr || !salt || !poseidonT3 || !transactVerifier) {
    console.error("Missing values in deployment config. Required: factory, vanitySalt, poseidonT3, transactVerifier");
    console.error("Run the prior deployment steps first.");
    process.exit(1);
  }

  const Halias = await ethers.getContractFactory("Halias", {
    libraries: { PoseidonT3: poseidonT3 },
  });

  const abiCoder = new ethers.AbiCoder();
  const encodedArgs = abiCoder.encode(
    ["address", "address"],
    [transactVerifier, deployer.address]
  );
  const initCode = ethers.concat([Halias.bytecode, encodedArgs]);

  const factory = await ethers.getContractAt("Create2Factory", factoryAddr);
  const predicted = await factory.computeAddress(initCode, salt);
  console.log(`Predicted address: ${predicted}`);

  const tx = await factory.deploy(initCode, salt);
  const receipt = await tx.wait();

  console.log(`\nHalias deployed to: ${predicted}`);
  console.log(`Tx hash: ${receipt?.hash}`);

  const prefix = predicted.slice(2, 7).toLowerCase();
  console.log(`Address prefix: 0x${prefix} ${prefix === "a11a5" ? "(vanity match!)" : "(mismatch)"}`);

  saveDeployment({
    halias: predicted,
    deployTxHash: receipt?.hash,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
