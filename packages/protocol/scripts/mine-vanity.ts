import { ethers } from "hardhat";
import { keccak256, AbiCoder, solidityPacked, randomBytes } from "ethers";
import { loadDeployment, saveDeployment } from "./deployment";

/**
 * Mine a CREATE2 salt that produces a Halias contract address
 * starting with 0xA11A5...
 *
 * Reads factory + verifier addresses from deployments/<network>.json.
 * Saves the mined salt + predicted address back to the config.
 *
 * Usage:
 *   npx hardhat run scripts/mine-vanity.ts --network sepolia
 */

const TARGET_PREFIX = "a11a5"; // 5 hex chars = ~1M attempts avg

async function main() {
  const config = loadDeployment();
  const factoryAddress = config.factory;
  const poseidonT3 = config.poseidonT3;
  const withdrawVerifier = config.withdrawVerifier;
  const transferVerifier = config.transferVerifier;
  const ensAddr = process.env.ENS_ADDRESS || ethers.ZeroAddress;

  if (!factoryAddress) {
    console.error("factory not found in deployment config. Deploy Create2Factory first.");
    process.exit(1);
  }

  if (!poseidonT3 || !withdrawVerifier || !transferVerifier) {
    console.error("Verifier addresses not found in deployment config.");
    console.error("Deploy verifiers first: npx hardhat run scripts/deploy-verifiers.ts --network sepolia");
    process.exit(1);
  }

  // Link PoseidonT3 library into Halias bytecode
  const Halias = await ethers.getContractFactory("Halias", {
    libraries: { PoseidonT3: poseidonT3 },
  });

  // Init code = bytecode + ABI-encoded constructor args
  const abiCoder = new AbiCoder();
  const encodedArgs = abiCoder.encode(
    ["address", "address", "address"],
    [ensAddr, withdrawVerifier, transferVerifier]
  );
  const initCode = ethers.concat([Halias.bytecode, encodedArgs]);
  const initCodeHash = keccak256(initCode);

  console.log(`Mining for prefix: 0x${TARGET_PREFIX}...`);
  console.log(`Factory: ${factoryAddress}`);
  console.log(`InitCode hash: ${initCodeHash}`);
  console.log(`Target: ${TARGET_PREFIX.length} hex chars (~${Math.pow(16, TARGET_PREFIX.length).toLocaleString()} avg attempts)\n`);

  let attempts = 0;
  const startTime = Date.now();
  let lastReport = startTime;

  while (true) {
    const salt = ethers.hexlify(randomBytes(32));

    // CREATE2 address = keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
    const packed = solidityPacked(
      ["bytes1", "address", "bytes32", "bytes32"],
      ["0xff", factoryAddress, salt, initCodeHash]
    );
    const hash = keccak256(packed);
    const addr = hash.slice(26); // last 20 bytes, no 0x

    attempts++;

    if (addr.slice(0, TARGET_PREFIX.length) === TARGET_PREFIX) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const checksummed = ethers.getAddress("0x" + addr);
      console.log(`\n=== FOUND ===`);
      console.log(`Address: ${checksummed}`);
      console.log(`Salt:    ${salt}`);
      console.log(`Attempts: ${attempts.toLocaleString()}`);
      console.log(`Time: ${elapsed}s`);
      saveDeployment({ vanitySalt: salt, predictedAddress: checksummed });
      break;
    }

    // Progress every 5s
    const now = Date.now();
    if (now - lastReport > 5000) {
      const rate = Math.floor(attempts / ((now - startTime) / 1000));
      console.log(`  ${attempts.toLocaleString()} attempts... (${rate.toLocaleString()}/s)`);
      lastReport = now;
    }
  }
}

main().catch(console.error);
