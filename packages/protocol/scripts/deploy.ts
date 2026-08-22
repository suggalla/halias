import hre, { ethers } from "hardhat";
import { loadDeployment, saveDeployment } from "./deployment";

/// One asset the app will offer. Decimals are recorded for the UI to render before it has
/// read the contract; the SDK still reads the real ones off chain and those win.
interface TokenRecord { address: string; symbol: string; decimals: number }
import { ensurePoseidon, verifyPoseidon } from "./poseidon";

// Deploys the whole system.
//
// The three contracts depend on each other in a cycle — the pool reads the registry, the
// controller writes to it and spends from the pool, and the registry must name its controller
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
//   ADMIN            admin for HaliasController (defaults to the deployer)
//   VERIFIER         reuse an already-deployed TransactVerifier
//   CLAIM_VERIFIER   reuse an already-deployed TransactClaimVerifier

// Is `addr` running exactly this contract's code?
//
// "Has code" is not enough, and the way that fails is worth recording. On a restarted local
// node every cached address is empty; redeploying the first contract can land it exactly on
// the second one's old address, at which point the second's existence check passes against
// the *wrong contract's* code. PoseidonT4 calls then execute PoseidonT3, every wiring check
// in this script still passes because none of them hash anything, and the failure surfaces
// later as a bare `require(false)` from the first registration.
async function runsExactly(name: string, addr: string, _libs?: any): Promise<boolean> {
  const onChain = await ethers.provider.getCode(addr);
  if (onChain === "0x") return false;
  const artifact = await hre.artifacts.readArtifact(name);
  const expected = artifact.deployedBytecode;
  // Library placeholders are filled at link time, so compare only the unlinked prefix when
  // the artifact still carries them.
  if (expected.includes("__$")) return onChain.length === expected.length;
  return onChain.toLowerCase() === expected.toLowerCase();
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

/// A dev-chain ERC-20, so the app's asset selector has something to select.
///
/// The token list the app offers comes from the deployment JSON, and nothing was writing one —
/// which meant the multi-asset UI could not render at all on a fresh local chain, and the only
/// ERC-20 coverage lived inside e2e-live where no interface ever sees it. Six decimals
/// deliberately: 18 is the case that agrees with a hardcoded `parseEther` by accident, so a
/// dev chain that only ever offers an 18-decimal token hides exactly the bug worth catching.
///
/// Local only, and idempotent — a re-run reuses the recorded address rather than deploying a
/// second one.
async function deployDevToken(existing: unknown): Promise<TokenRecord[]> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) return (existing as TokenRecord[]) ?? [];

  // Recorded *and* still on chain. A restarted node keeps the deployment JSON but throws away
  // its state, so trusting the record alone writes an address with no code behind it — the app
  // then offers the asset in its selector and every read against it fails. Everything else in
  // this script checks the chain before reusing an address; this has to as well.
  const already = (existing as TokenRecord[] | undefined)?.find((t) => t.symbol === "USDC");
  if (already && (await ethers.provider.getCode(already.address)) !== "0x") {
    console.log(`\ndev token\n  ok   USDC  ${already.address} — already deployed`);
    return existing as TokenRecord[];
  }
  if (already) {
    console.log(`\ndev token\n  stale USDC  ${already.address} has no code — redeploying`);
  }

  const [payer] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  await token.waitForDeployment();
  const address = await token.getAddress();

  // Funded so the selector is usable the moment the app loads, not after a mint step nobody
  // has been told about.
  for (const to of DEV_WALLETS) {
    if (ethers.isAddress(to)) await (await (token as any).connect(payer).mint(to, 1_000_000n * 1_000_000n)).wait();
  }
  console.log(`\ndev token\n  sent USDC  ${address}  1,000,000 to each dev wallet`);
  // Replaces any stale entry rather than appending beside it — two USDCs in the list would put
  // two identical buttons in the selector, one of them pointing at nothing.
  const kept = ((existing as TokenRecord[]) ?? []).filter((t) => t.symbol !== "USDC");
  return [...kept, { address, symbol: "USDC", decimals: 6 }];
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

  // Canonical addresses, identical on every EVM chain. Our own build of the same source is
  // over EIP-170 under viaIR and cannot be deployed to a real network at all.
  const poseidon = await ensurePoseidon();
  await verifyPoseidon(poseidon);
  const poseidonT3 = poseidon.PoseidonT3;
  const poseidonT4 = poseidon.PoseidonT4;
  console.log(`  PoseidonT3         canonical ${poseidonT3}`);
  console.log(`  PoseidonT4         canonical ${poseidonT4}`);
  const verifier = await deployOrReuse("TransactVerifier", "verifier", cfg);
  // The claim circuit's verifier. A separate contract because the two circuits have separate
  // proving keys — the pool picks between them by the leaf the registry armed.
  const claimVerifier = await deployOrReuse("TransactClaimVerifier", "claimVerifier", cfg);

  // Reuse before redeploying, like every step above.
  //
  // This one was deploying unconditionally, so re-running the script — to change the admin,
  // to fund a wallet, to re-check wiring — silently replaced a live pool. The old contracts
  // keep the funds and every registered alias, while the config and app move to an empty
  // deployment. Nothing reports it; the app simply comes up with no aliases.
  const existing = cfg.pool && cfg.registry && cfg.controller
    && (await ethers.provider.getCode(cfg.pool)) !== "0x";

  let pool: string, registry: string, controller: string, startBlock: number;
  let deployerAddress: string = cfg.deployer ?? ethers.ZeroAddress;

  if (existing && !process.env.FORCE_REDEPLOY) {
    ({ pool, registry, controller } = cfg as any);
    startBlock = cfg.startBlock ?? 0;
    console.log(`  HaliasDeployer     reusing  ${deployerAddress}`);
    console.log(`    -> HaliasRegistry         ${registry}`);
    console.log(`    -> HaliasPool             ${pool}`);
    console.log(`    -> HaliasController           ${controller}`);
    console.log(`  (set FORCE_REDEPLOY=1 to replace them — this abandons existing aliases)`);
  } else {
    // One transaction. Either all three exist and are wired, or the deployment reverts —
    // HaliasDeployer asserts its own address prediction before returning.
    startBlock = await ethers.provider.getBlockNumber();
    const deployerContract = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 },
    })).deploy(verifier, claimVerifier, admin);
    await deployerContract.waitForDeployment();

    pool     = await deployerContract.pool();
    registry = await deployerContract.registry();
    controller   = await deployerContract.controller();
    deployerAddress = await deployerContract.getAddress();

    console.log(`  HaliasDeployer     deployed ${deployerAddress}`);
    console.log(`    -> HaliasRegistry         ${registry}`);
    console.log(`    -> HaliasPool             ${pool}`);
    console.log(`    -> HaliasController           ${controller}`);
  }

  // Read the wiring back from chain rather than trusting the constructor. A deployment that
  // looks fine and is mis-wired is inert in a way nothing else would catch until a user hits
  // it, so it is worth the three calls.
  const poolC = await ethers.getContractAt("HaliasPool", pool);
  const regC  = await ethers.getContractAt("HaliasRegistry", registry);
  const domC  = await ethers.getContractAt("HaliasController", controller);

  const checks: [string, string, string][] = [
    ["registry.controller", await regC.controller(), controller],
    ["pool.registry",       await poolC.registry(),  registry],
    ["controller.pool",         await domC.pool(),       pool],
    ["controller.registry",     await domC.registry(),   registry],
    ["controller.admin",        await domC.admin(),      admin],
  ];
  console.log("");
  for (const [label, got, want] of checks) {
    const ok = got.toLowerCase() === want.toLowerCase();
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(20)} ${got}`);
    if (!ok) throw new Error(`${label} is ${got}, expected ${want}`);
  }

  await fundDevWallets();
  const tokens = await deployDevToken((cfg as any).tokens);

  saveDeployment({
    poseidonT3, poseidonT4,
    // Both verifiers, because both were deployed. The claim one was omitted, which left its
    // address recoverable only by calling the pool — fine for a client, awkward for anyone
    // re-verifying the source or passing CLAIM_VERIFIER to reuse it on a later deploy.
    // Neither is read at runtime; the pool holds both immutably.
    verifier, claimVerifier,
    deployer: deployerAddress,
    // The three the SDK and app read, and only those three. A fourth address here would let a
    // client silently point at something that is not the live pool.
    pool, registry, controller,
    admin,
    startBlock,
    // What the app offers in its asset selector. Empty on a real network — adding an asset
    // splits the anonymity set, so it is a deliberate per-deployment decision.
    ...(tokens.length > 0 ? { tokens } : {}),
  });

  // The README names these addresses, and it drifted the last time they changed — three dead
  // links in the one place a reader is most likely to trust. Rewritten here because this is
  // the moment they move; `npm run readme:sync` does the same by hand.
  if (network === "sepolia") {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [`${__dirname}/sync-readme.mjs`], { stdio: "inherit" });
  }

  console.log(`\nRegistration fee: ${ethers.formatEther(await domC.registrationFee())} ETH`);
  // Argument lists match each constructor exactly. The pool's omitted claimVerifier here,
  // which fails as "has 3 parameters but 2 arguments were provided" only after a round trip
  // to the explorer — and the whole point of printing these is that they can be pasted.
  //
  // HaliasDeployer is absent deliberately: it links PoseidonT3/T4 inside its constructor
  // only, so the addresses are not recoverable from deployed bytecode and hardhat-verify
  // cannot check it. It is a one-shot factory that nothing calls again.
  console.log("Verify with:");
  console.log(`  npx hardhat verify --network ${network} ${registry} ${controller}`);
  console.log(`  npx hardhat verify --network ${network} ${pool} ${verifier} ${claimVerifier} ${registry}`);
  console.log(`  npx hardhat verify --network ${network} ${controller} ${pool} ${registry} ${admin}`);
  console.log(`  npx hardhat verify --network ${network} ${verifier}`);
  console.log(`  npx hardhat verify --network ${network} ${claimVerifier}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
