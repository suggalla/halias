import hre, { ethers } from "hardhat";
import { loadDeployment, saveDeployment } from "./deployment";

// Deploys the whole system.
//
// The three contracts depend on each other in a cycle — the pool reads the registry, the
// domain writes to it and spends from the pool, and the registry must name its controller
// before that contract exists. HaliasDeployer closes the loop on-chain in one constructor,
// so this script has exactly one deployment step for them and no address bookkeeping.
//
// That is a deliberate change from the previous idempotent, step-by-step script. Predicting
// addresses off-chain from a nonce is correct only while nothing else sends a transaction
// from the deployer account in between; if something does, the registry ends up naming a
// controller that will never hold code, nothing reverts, and the failure surfaces later as a
// registration that cannot work. On-chain it is atomic.
//
// Env:
//   ADMIN            admin for HaliasDomain (defaults to the deployer)
//   VERIFIER         reuse an already-deployed TransactVerifier

// Is `addr` running exactly this contract's code?
//
// "Has code" is not enough, and the way that fails is worth recording. On a restarted local
// node every cached address is empty; redeploying the first contract can land it exactly on
// the second one's old address, at which point the second's existence check passes against
// the *wrong contract's* code. PoseidonT4 calls then execute PoseidonT3, every wiring check
// in this script still passes because none of them hash anything, and the failure surfaces
// later as a bare `require(false)` from the first registration.
async function runsExactly(name: string, addr: string, libs?: any): Promise<boolean> {
  const onChain = await ethers.provider.getCode(addr);
  if (onChain === "0x") return false;
  const artifact = await hre.artifacts.readArtifact(name);
  let expected = artifact.deployedBytecode;
  // Library placeholders are filled at link time, so compare only the unlinked prefix when
  // the artifact still carries them.
  if (expected.includes("__$")) return onChain.length === expected.length;
  return onChain.toLowerCase() === expected.toLowerCase();
}

// Poseidon comes from poseidon-solidity's canonical deployment, not from our own build.
//
// Compiling it here produces 29,315 bytes for T3 and 32,895 for T4 — viaIR inlines the round
// constants — against EIP-170's 24,576 limit, so `factory.deploy()` fails on any real network.
// The local node hides it: hardhat.config sets allowUnlimitedContractSize.
//
// The package ships each library pre-deployed through the deterministic-deployment proxy at
// 0x4e59...956c, so the addresses below are the same on every EVM chain and are already live
// on the major ones. Where the library is absent we deploy it through that same proxy and get
// the identical address, so nothing here is chain-specific.
//
// The proxy itself is bootstrapped by Nick's method: fund a keyless address, then broadcast a
// pre-signed transaction. That transaction is pre-EIP-155 (no chain id), which a few chains
// reject — on one of those the proxy has to arrive by whatever means that chain provides, and
// this script will say so rather than deploying an over-sized library that cannot be created.
const POSEIDON_CHECK = {
  // Poseidon over BN254, from circomlibjs — the same implementation the circuits use.
  PoseidonT3: { args: [1n, 2n],     out: 7853200120776062878684798364095072458815029376092732009249414926327459813530n },
  PoseidonT4: { args: [1n, 2n, 3n], out: 6542985608222806190361240322586112750744169038454362455181422643027100751666n },
};

async function ensurePoseidon(deployer: any): Promise<{ t3: string; t4: string }> {
  const { proxy, PoseidonT3, PoseidonT4 } = require("poseidon-solidity");

  if ((await ethers.provider.getCode(proxy.address)) === "0x") {
    console.log(`  CREATE2 proxy      missing at ${proxy.address} — bootstrapping`);
    await (await deployer.sendTransaction({ to: proxy.from, value: proxy.gas })).wait();
    await (await ethers.provider.broadcastTransaction(proxy.tx)).wait();
    if ((await ethers.provider.getCode(proxy.address)) === "0x") {
      throw new Error(
        `deterministic-deployment proxy could not be created at ${proxy.address}. ` +
        `This chain most likely rejects the pre-EIP-155 transaction Nick's method uses.`,
      );
    }
  }

  for (const [name, lib] of [["PoseidonT3", PoseidonT3], ["PoseidonT4", PoseidonT4]] as const) {
    if ((await ethers.provider.getCode(lib.address)) === "0x") {
      await (await deployer.sendTransaction({ to: proxy.address, data: lib.data })).wait();
      if ((await ethers.provider.getCode(lib.address)) === "0x") {
        throw new Error(`${name} was not created at ${lib.address}`);
      }
      console.log(`  ${name.padEnd(18)} deployed ${lib.address}`);
    } else {
      console.log(`  ${name.padEnd(18)} canonical ${lib.address}`);
    }

    // Bytecode equality is not available here — the canonical build is not ours — so verify
    // behaviour instead, which is the property that actually matters. A wrong library at the
    // right address produces roots the circuit cannot prove against, and nothing else in this
    // script hashes anything, so this is the only place it would be caught.
    const { args, out } = POSEIDON_CHECK[name];
    const sig = `hash(uint256[${args.length}])`;
    const data = ethers.concat([
      ethers.id(sig).slice(0, 10),
      ethers.AbiCoder.defaultAbiCoder().encode([`uint256[${args.length}]`], [args]),
    ]);
    const got = BigInt(await ethers.provider.call({ to: lib.address, data }));
    if (got !== out) throw new Error(`${name} at ${lib.address} hashed ${got}, expected ${out}`);
  }

  return { t3: PoseidonT3.address, t4: PoseidonT4.address };
}

async function deployOrReuse(name: string, key: string, cfg: Record<string, any>, libs?: any) {
  const existing = process.env[key.toUpperCase()] ?? cfg[key];
  if (existing) {
    if (await runsExactly(name, existing, libs)) {
      console.log(`  ${name.padEnd(18)} reused   ${existing}`);
      return existing as string;
    }
    console.log(`  ${name.padEnd(18)} stale    ${existing} is not ${name} — redeploying`);
  }
  const factory = libs
    ? await ethers.getContractFactory(name, { libraries: libs })
    : await ethers.getContractFactory(name);
  const c = await factory.deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ${name.padEnd(18)} deployed ${addr}`);
  return addr;
}

/// Wallets that must have a balance on a fresh local chain.
///
/// Hardhat funds its own twenty accounts and nothing else, so a MetaMask account starts every
/// reset at zero — the app connects, then fails on the first transaction for a reason that
/// looks like a bug in the app. These are dev wallets on a throwaway chain; override with
/// FUND_ADDRESSES=0x…,0x… and FUND_ETH.
const DEV_WALLETS = [
  "0xDa5C820D6d7381Ef43209D071fe7fd56AaAD22A6",
  // A second account, so paying an alias from a wallet unconnected to it can be exercised
  // the way a user would actually do it.
  "0xC46b971bEba81D75f4CFD990C9C1226E6b78B27D",
];

/// Top up to a target rather than sending a fixed amount, so re-running the deploy against a
/// live chain is a no-op instead of piling on ETH every time.
async function fundDevWallets(): Promise<void> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  // Real ETH has to be sent deliberately, never as a side effect of deploying.
  if (chainId !== 31337) return;

  const targets = (process.env.FUND_ADDRESSES ?? DEV_WALLETS.join(","))
    .split(",").map((a) => a.trim()).filter(Boolean);
  if (targets.length === 0) return;

  const target = ethers.parseEther(process.env.FUND_ETH ?? "1000");
  const [payer] = await ethers.getSigners();

  console.log(`
funding dev wallets to ${ethers.formatEther(target)} ETH`);
  for (const to of targets) {
    if (!ethers.isAddress(to)) {
      console.log(`  skip ${to} — not an address`);
      continue;
    }
    const have = await ethers.provider.getBalance(to);
    if (have >= target) {
      console.log(`  ok   ${to}  ${ethers.formatEther(have)} ETH — already funded`);
      continue;
    }
    await (await payer.sendTransaction({ to, value: target - have })).wait();
    console.log(`  sent ${to}  ${ethers.formatEther(target - have)} ETH`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = process.env.HARDHAT_NETWORK ?? "localhost";
  const admin = process.env.ADMIN ?? deployer.address;
  const cfg = loadDeployment();

  console.log(`\nHalias deploy — ${network}`);
  console.log(`  deployer           ${deployer.address}`);
  console.log(`  admin              ${admin}`);
  console.log(`  balance            ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const { t3: poseidonT3, t4: poseidonT4 } = await ensurePoseidon(deployer);
  const verifier = await deployOrReuse("TransactVerifier", "verifier", cfg);

  // Reuse before redeploying, like every step above.
  //
  // This one was deploying unconditionally, so re-running the script — to change the admin,
  // to fund a wallet, to re-check wiring — silently replaced a live pool. The old contracts
  // keep the funds and every registered alias, while the config and app move to an empty
  // deployment. Nothing reports it; the app simply comes up with no aliases.
  const existing = cfg.pool && cfg.registry && cfg.domain
    && (await ethers.provider.getCode(cfg.pool)) !== "0x";

  let pool: string, registry: string, domain: string, startBlock: number;
  let deployerAddress: string = cfg.deployer ?? ethers.ZeroAddress;

  if (existing && !process.env.FORCE_REDEPLOY) {
    ({ pool, registry, domain } = cfg as any);
    startBlock = cfg.startBlock ?? 0;
    console.log(`  HaliasDeployer     reusing  ${deployerAddress}`);
    console.log(`    -> HaliasRegistry         ${registry}`);
    console.log(`    -> HaliasPool             ${pool}`);
    console.log(`    -> HaliasDomain           ${domain}`);
    console.log(`  (set FORCE_REDEPLOY=1 to replace them — this abandons existing aliases)`);
  } else {
    // One transaction. Either all three exist and are wired, or the deployment reverts —
    // HaliasDeployer asserts its own address prediction before returning.
    startBlock = await ethers.provider.getBlockNumber();
    const deployerContract = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 },
    })).deploy(verifier, admin);
    await deployerContract.waitForDeployment();

    pool     = await deployerContract.pool();
    registry = await deployerContract.registry();
    domain   = await deployerContract.domain();
    deployerAddress = await deployerContract.getAddress();

    console.log(`  HaliasDeployer     deployed ${deployerAddress}`);
    console.log(`    -> HaliasRegistry         ${registry}`);
    console.log(`    -> HaliasPool             ${pool}`);
    console.log(`    -> HaliasDomain           ${domain}`);
  }

  // Read the wiring back from chain rather than trusting the constructor. A deployment that
  // looks fine and is mis-wired is inert in a way nothing else would catch until a user hits
  // it, so it is worth the three calls.
  const poolC = await ethers.getContractAt("HaliasPool", pool);
  const regC  = await ethers.getContractAt("HaliasRegistry", registry);
  const domC  = await ethers.getContractAt("HaliasDomain", domain);

  const checks: [string, string, string][] = [
    ["registry.controller", await regC.controller(), domain],
    ["pool.registry",       await poolC.registry(),  registry],
    ["domain.pool",         await domC.pool(),       pool],
    ["domain.registry",     await domC.registry(),   registry],
    ["domain.admin",        await domC.admin(),      admin],
  ];
  console.log("");
  for (const [label, got, want] of checks) {
    const ok = got.toLowerCase() === want.toLowerCase();
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(20)} ${got}`);
    if (!ok) throw new Error(`${label} is ${got}, expected ${want}`);
  }

  saveDeployment({
    poseidonT3, poseidonT4,
    verifier,
    deployer: deployerAddress,
    // The three the SDK and app read. `halias` is deliberately absent: the monolith is gone,
    // and a stale key would let a client silently point at the wrong contract.
    pool, registry, domain,
    admin,
    startBlock,
  });

  await fundDevWallets();

  console.log(`\nRegistration fee: ${ethers.formatEther(await domC.registrationFee())} ETH`);
  console.log("Verify with:");
  console.log(`  npx hardhat verify --network ${network} ${registry} ${domain}`);
  console.log(`  npx hardhat verify --network ${network} ${pool} ${verifier} ${registry}`);
  console.log(`  npx hardhat verify --network ${network} ${domain} ${pool} ${registry} ${admin}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
