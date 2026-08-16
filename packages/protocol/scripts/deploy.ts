import { ethers } from "hardhat";
import { keccak256, AbiCoder, solidityPacked, randomBytes } from "ethers";
import { loadDeployment, saveDeployment } from "./deployment";

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
 *   ENTRY_POINT    — ERC-4337 EntryPoint address (defaults to v0.7 canonical)
 *   STAKE_AMOUNT   — ETH to stake in EntryPoint for both Halias and HaliasPaymaster
 *                    (e.g. "0.1" — required for production bundlers, skip on local dev)
 *   VANITY_PREFIX  — hex prefix to mine (defaults to "a11a5")
 *   SKIP_VANITY=1  — skip vanity mining, deploy Halias with random salt
 */

const TARGET_PREFIX = process.env.VANITY_PREFIX || "a11a5";
const ENTRY_POINT  = process.env.ENTRY_POINT  || "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const STAKE_AMOUNT = process.env.STAKE_AMOUNT ? ethers.parseEther(process.env.STAKE_AMOUNT) : 0n;

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

async function main() {
  const [deployer] = await ethers.getSigners();
  const config = loadDeployment();
  let totalGasCost = 0n;

  console.log(`Deployer:     ${deployer.address}`);
  console.log(`Network:      ${process.env.HARDHAT_NETWORK || "localhost"}`);
  console.log(`EntryPoint:   ${ENTRY_POINT}`);
  console.log(`Stake amount: ${STAKE_AMOUNT > 0n ? ethers.formatEther(STAKE_AMOUNT) + " ETH" : "none (local dev)"}\n`);

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

  // ── Step 2: PoseidonT3 ──────────────────────────────────────────────────────
  let poseidonT3Addr = config.poseidonT3;
  if (poseidonT3Addr) {
    console.log(`[skip] PoseidonT3:         ${poseidonT3Addr}`);
  } else {
    console.log("[deploy] PoseidonT3...");
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const t3 = await PoseidonT3.deploy();
    const receipt = await t3.deploymentTransaction()!.wait();
    poseidonT3Addr = await t3.getAddress();
    console.log(`  -> ${poseidonT3Addr}`);
    totalGasCost += logGas(receipt!);
    saveDeployment({ poseidonT3: poseidonT3Addr });
  }

  // ── Step 3: PoseidonT4 ──────────────────────────────────────────────────────
  let poseidonT4Addr = config.poseidonT4;
  if (poseidonT4Addr) {
    console.log(`[skip] PoseidonT4:         ${poseidonT4Addr}`);
  } else {
    console.log("[deploy] PoseidonT4...");
    const PoseidonT4 = await ethers.getContractFactory("PoseidonT4");
    const t4 = await PoseidonT4.deploy();
    const receipt = await t4.deploymentTransaction()!.wait();
    poseidonT4Addr = await t4.getAddress();
    console.log(`  -> ${poseidonT4Addr}`);
    totalGasCost += logGas(receipt!);
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
  const HaliasFactory = await ethers.getContractFactory("Halias", {
    libraries: { PoseidonT3: poseidonT3Addr, PoseidonT4: poseidonT4Addr },
  });
  const abiCoder = new AbiCoder();
  const encodedArgs = abiCoder.encode(
    ["address", "address"],
    [verifierAddr, ENTRY_POINT]
  );
  const initCode = ethers.concat([HaliasFactory.bytecode, encodedArgs]);

  let salt = config.vanitySalt;
  if (salt) {
    console.log(`[skip] Vanity salt:        ${salt}`);
  } else if (process.env.SKIP_VANITY === "1") {
    salt = ethers.hexlify(randomBytes(32));
    console.log(`[skip] Vanity mining skipped, using random salt`);
    saveDeployment({ vanitySalt: salt });
  } else {
    console.log(`[mine] Searching for 0x${TARGET_PREFIX}... prefix`);
    const initCodeHash = keccak256(initCode);
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

  // ── Step 7: HaliasAccountImpl ──────────────────────────────────────────────
  // Singleton EIP-7702 delegation target. One deploy shared by all users.
  let accountImplAddr = config.haliasAccountImpl;
  if (accountImplAddr) {
    console.log(`[skip] HaliasAccountImpl:  ${accountImplAddr}`);
  } else {
    console.log("[deploy] HaliasAccountImpl...");
    const AccountImpl = await ethers.getContractFactory("HaliasAccountImpl");
    const impl = await AccountImpl.deploy(ENTRY_POINT);
    const receipt = await impl.deploymentTransaction()!.wait();
    accountImplAddr = await impl.getAddress();
    console.log(`  -> ${accountImplAddr}`);
    totalGasCost += logGas(receipt!);
    saveDeployment({ haliasAccountImpl: accountImplAddr });
  }

  // ── Step 8: HaliasPaymaster ────────────────────────────────────────────────
  let paymasterAddr = config.haliasPaymaster;
  if (paymasterAddr) {
    console.log(`[skip] HaliasPaymaster:    ${paymasterAddr}`);
  } else {
    console.log("[deploy] HaliasPaymaster...");
    const Paymaster = await ethers.getContractFactory("HaliasPaymaster");
    const pm = await Paymaster.deploy(ENTRY_POINT, haliasAddr);
    const receipt = await pm.deploymentTransaction()!.wait();
    paymasterAddr = await pm.getAddress();
    console.log(`  -> ${paymasterAddr}`);
    totalGasCost += logGas(receipt!);
    saveDeployment({ haliasPaymaster: paymasterAddr });
  }

  // ── Step 9 & 10: Stake Halias + HaliasPaymaster ───────────────────────────
  // Halias must be staked so HaliasPaymaster can read halias.registrationFee()
  // during validatePaymasterUserOp (ERC-7562: a staked contract's storage may be
  // read by other entities). The paymaster is staked so bundlers accept it.
  const UNSTAKE_DELAY = 86400; // 1 day — increase to 7 days for mainnet
  if (STAKE_AMOUNT > 0n) {
    const halias   = await ethers.getContractAt("Halias",          haliasAddr);
    const paymaster = await ethers.getContractAt("HaliasPaymaster", paymasterAddr);

    const haliasStake = await ethers.provider.send("eth_call", [{
      to: ENTRY_POINT,
      data: ethers.id("getDepositInfo(address)").slice(0, 10) +
            haliasAddr.slice(2).padStart(64, "0"),
    }, "latest"]);
    const alreadyStaked = haliasStake !== "0x" && BigInt(haliasStake.slice(0, 66)) > 0n;

    if (alreadyStaked) {
      console.log(`[skip] Halias stake:       already staked`);
    } else {
      console.log(`[stake] Halias (${ethers.formatEther(STAKE_AMOUNT)} ETH, ${UNSTAKE_DELAY}s delay)...`);
      const tx1 = await halias.addStake(UNSTAKE_DELAY, { value: STAKE_AMOUNT });
      totalGasCost += logGas((await tx1.wait())!);
      console.log(`  -> staked`);
    }

    console.log(`[stake] HaliasPaymaster (${ethers.formatEther(STAKE_AMOUNT)} ETH, ${UNSTAKE_DELAY}s delay)...`);
    const tx2 = await paymaster.addStake(UNSTAKE_DELAY, { value: STAKE_AMOUNT });
    totalGasCost += logGas((await tx2.wait())!);
    console.log(`  -> staked`);

    saveDeployment({ stakeAmount: ethers.formatEther(STAKE_AMOUNT) });
  } else {
    console.log(`[skip] Staking — set STAKE_AMOUNT for production (e.g. STAKE_AMOUNT=0.1)`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(56)}`);
  console.log("Deployment complete:");
  console.log(`  Create2Factory      ${factoryAddr}`);
  console.log(`  PoseidonT3          ${poseidonT3Addr}`);
  console.log(`  PoseidonT4          ${poseidonT4Addr}`);
  console.log(`  TransactVerifier    ${verifierAddr}`);
  console.log(`  Halias              ${haliasAddr}`);
  console.log(`  HaliasAccountImpl   ${accountImplAddr}`);
  console.log(`  HaliasPaymaster     ${paymasterAddr}`);
  console.log(`  Staked              ${STAKE_AMOUNT > 0n ? ethers.formatEther(STAKE_AMOUNT) + " ETH each" : "no (local dev)"}`);
  if (totalGasCost > 0n) console.log(`  Total gas cost      ${ethers.formatEther(totalGasCost)} ETH`);
  console.log(`${"=".repeat(56)}`);
  console.log("\nPost-deploy checklist:");
  if (STAKE_AMOUNT === 0n) {
    console.log("  [ ] Stake both contracts before using production bundlers:");
    console.log(`        STAKE_AMOUNT=0.1 npx hardhat run scripts/deploy.ts --network sepolia`);
  } else {
    console.log(`  [x] Both contracts staked (${ethers.formatEther(STAKE_AMOUNT)} ETH each)`);
  }
  console.log("  [ ] Fund HaliasPaymaster EntryPoint deposit:");
  console.log(`        entryPoint.depositTo(paymasterAddr, { value: parseEther("1") })`);
  console.log(`  [ ] SDK config: update HALIAS_ADDRESS, ACCOUNT_IMPL_ADDRESS, PAYMASTER_ADDRESS`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
