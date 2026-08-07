import { ethers } from "hardhat";
import { keccak256, solidityPacked, randomBytes } from "ethers";
import { loadDeployment, saveDeployment } from "./deployment";
import { buildHaliasInitCode } from "./haliasInitCode";

/**
 * Master deployment script — deploys the full Halias v1.5 stack.
 *
 * Reads deployments/<network>.json and skips any contract that already
 * has an address. Run it repeatedly to resume a partial deployment.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network sepolia
 *
 * Optional env:
 *   VANITY_PREFIX  — hex prefix to mine (defaults to "a11a5")
 *   SKIP_VANITY=1  — skip vanity mining, deploy Halias with random salt
 */

const TARGET_PREFIX = process.env.VANITY_PREFIX || "a11a5";

// poseidon-solidity ships precompiled, EIP-170-safe bytecode deployed via a deterministic
// CREATE2 proxy to fixed addresses on every chain. We deploy through the proxy rather than
// recompiling from source (our viaIR settings bloat the libs past the 24,576-byte limit).
const poseidon = require("poseidon-solidity") as {
  proxy: { from: string; gas: bigint | number | string; tx: string; address: string };
  PoseidonT3: { address: string; data: string };
  PoseidonT4: { address: string; data: string };
};

function logGas(receipt: { gasUsed: bigint; gasPrice: bigint }): bigint {
  const cost = receipt.gasUsed * receipt.gasPrice;
  console.log(`  gas:  ${receipt.gasUsed.toLocaleString()} @ ${ethers.formatUnits(receipt.gasPrice, "gwei")} gwei = ${ethers.formatEther(cost)} ETH`);
  return cost;
}

async function deploy(name: string, factory: any, ...args: any[]): Promise<string> {
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction()!.wait();
  const addr = await contract.getAddress();
  console.log(`  -> ${addr}`);
  return addr;
}

// Deploy a poseidon-solidity library at its canonical address via the deterministic proxy.
// Idempotent: skips if the library (or proxy) already has code on-chain.
async function deployPoseidonLib(name: string, lib: { address: string; data: string }): Promise<string> {
  const [sender] = await ethers.getSigners();

  // Ensure the deterministic deployment proxy exists (present on virtually every chain).
  if (await ethers.provider.getCode(poseidon.proxy.address) === "0x") {
    console.log("  [proxy] funding keyless deployer + deploying CREATE2 proxy...");
    await (await sender.sendTransaction({ to: poseidon.proxy.from, value: BigInt(poseidon.proxy.gas) })).wait();
    await (await ethers.provider.broadcastTransaction(poseidon.proxy.tx)).wait();
  }

  if (await ethers.provider.getCode(lib.address) !== "0x") {
    console.log(`  [skip] ${name} already deployed: ${lib.address}`);
    return lib.address;
  }

  await (await sender.sendTransaction({ to: poseidon.proxy.address, data: lib.data })).wait();
  console.log(`  -> ${name} ${lib.address}`);
  return lib.address;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const config = loadDeployment();
  let totalGasCost = 0n;

  console.log(`Deployer:     ${deployer.address}`);
  console.log(`Network:      ${process.env.HARDHAT_NETWORK || "localhost"}`);
  console.log("");

  // ── Step 1: Create2Factory ──────────────────────────────────────────────────
  let factoryAddr = config.factory;
  if (factoryAddr) {
    console.log(`[skip] Create2Factory:     ${factoryAddr}`);
  } else {
    console.log("[deploy] Create2Factory...");
    const Factory = await ethers.getContractFactory("Create2Factory");
    const factory = await Factory.deploy();
    const receipt = await factory.deploymentTransaction()!.wait();
    factoryAddr = await factory.getAddress();
    console.log(`  -> ${factoryAddr}`);
    totalGasCost += logGas(receipt!);
    saveDeployment({ deployer: deployer.address, factory: factoryAddr });
  }

  // ── Step 2: PoseidonT3 (deterministic proxy → canonical address) ─────────────
  let poseidonT3Addr = config.poseidonT3;
  if (poseidonT3Addr) {
    console.log(`[skip] PoseidonT3:         ${poseidonT3Addr}`);
  } else {
    console.log("[deploy] PoseidonT3 (via deterministic proxy)...");
    poseidonT3Addr = await deployPoseidonLib("PoseidonT3", poseidon.PoseidonT3);
    saveDeployment({ poseidonT3: poseidonT3Addr });
  }

  // ── Step 3: PoseidonT4 (deterministic proxy → canonical address) ─────────────
  let poseidonT4Addr = config.poseidonT4;
  if (poseidonT4Addr) {
    console.log(`[skip] PoseidonT4:         ${poseidonT4Addr}`);
  } else {
    console.log("[deploy] PoseidonT4 (via deterministic proxy)...");
    poseidonT4Addr = await deployPoseidonLib("PoseidonT4", poseidon.PoseidonT4);
    saveDeployment({ poseidonT4: poseidonT4Addr });
  }

  // ── Step 4: TransactVerifier ────────────────────────────────────────────────
  let verifierAddr = config.transactVerifier;
  if (verifierAddr) {
    console.log(`[skip] TransactVerifier:   ${verifierAddr}`);
  } else {
    console.log("[deploy] TransactVerifier...");
    const TransactVerifier = await ethers.getContractFactory("TransactVerifier");
    const verifier = await TransactVerifier.deploy();
    const receipt = await verifier.deploymentTransaction()!.wait();
    verifierAddr = await verifier.getAddress();
    console.log(`  -> ${verifierAddr}`);
    totalGasCost += logGas(receipt!);
    saveDeployment({ transactVerifier: verifierAddr });
  }

  // ── Step 5: Mine vanity salt for Halias ────────────────────────────────────
  // initCode embeds PoseidonT3 + PoseidonT4 addresses (external library linking),
  // so salt must be (re)mined whenever either library is redeployed.
  const { initCode, initCodeHash } = await buildHaliasInitCode({
    poseidonT3: poseidonT3Addr,
    poseidonT4: poseidonT4Addr,
    transactVerifier: verifierAddr,
    admin: deployer.address,
  });

  let salt = config.vanitySalt;
  if (salt) {
    console.log(`[skip] Vanity salt:        ${salt}`);
  } else if (process.env.SKIP_VANITY === "1") {
    salt = ethers.hexlify(randomBytes(32));
    console.log(`[skip] Vanity mining skipped, using random salt`);
    saveDeployment({ vanitySalt: salt });
  } else {
    console.log(`[mine] Searching for 0x${TARGET_PREFIX}... prefix`);
    let attempts = 0;
    const startTime = Date.now();
    let lastReport = startTime;

    while (true) {
      salt = ethers.hexlify(randomBytes(32));
      const packed = solidityPacked(
        ["bytes1", "address", "bytes32", "bytes32"],
        ["0xff", factoryAddr, salt, initCodeHash]
      );
      const hash = keccak256(packed);
      const addr = hash.slice(26);
      attempts++;

      if (addr.slice(0, TARGET_PREFIX.length) === TARGET_PREFIX) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const checksummed = ethers.getAddress("0x" + addr);
        console.log(`  -> Found in ${attempts.toLocaleString()} attempts (${elapsed}s)`);
        console.log(`  -> Salt: ${salt}`);
        console.log(`  -> Predicted: ${checksummed}`);
        saveDeployment({ vanitySalt: salt, predictedAddress: checksummed });
        break;
      }

      const now = Date.now();
      if (now - lastReport > 5000) {
        const rate = Math.floor(attempts / ((now - startTime) / 1000));
        console.log(`  ${attempts.toLocaleString()} attempts... (${rate.toLocaleString()}/s)`);
        lastReport = now;
      }
    }
  }

  // ── Step 6: Deploy Halias via CREATE2 ──────────────────────────────────────
  let haliasAddr = config.halias;
  if (haliasAddr) {
    console.log(`[skip] Halias:             ${haliasAddr}`);
  } else {
    console.log("[deploy] Halias via CREATE2...");
    const factory = await ethers.getContractAt("Create2Factory", factoryAddr);
    const predicted = await factory.computeAddress(initCode, salt);
    console.log(`  Predicted: ${predicted}`);

    const tx = await factory.deploy(initCode, salt);
    const receipt = await tx.wait();
    haliasAddr = predicted;

    const prefix = predicted.slice(2, 7).toLowerCase();
    console.log(`  -> ${predicted} ${prefix === TARGET_PREFIX ? "(vanity match!)" : ""}`);
    totalGasCost += logGas(receipt!);
    saveDeployment({ halias: haliasAddr, deployTxHash: receipt?.hash, startBlock: receipt?.blockNumber });
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(56)}`);
  console.log("Deployment complete:");
  console.log(`  Create2Factory      ${factoryAddr}`);
  console.log(`  PoseidonT3          ${poseidonT3Addr}`);
  console.log(`  PoseidonT4          ${poseidonT4Addr}`);
  console.log(`  TransactVerifier    ${verifierAddr}`);
  console.log(`  Halias              ${haliasAddr}`);
  if (totalGasCost > 0n) console.log(`  Total gas cost      ${ethers.formatEther(totalGasCost)} ETH`);
  console.log(`${"=".repeat(56)}`);
  console.log("\nPost-deploy checklist:");
  console.log(`  [ ] SDK config: update HALIAS_ADDRESS`);
  console.log(`  [ ] Verify contracts on the block explorer`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
