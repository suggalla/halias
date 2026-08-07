import { ethers } from "hardhat";
import * as path from "path";
import * as fs from "fs";
import { loadDeployment } from "./deployment";

// Live end-to-end exercise of every callable function on a deployed Halias.
//
// Deliberately routed through packages/sdk rather than test/helpers. The two are
// independent implementations of the same hashing, and every existing E2E test uses the
// helpers — which is exactly why a bug in the SDK's SMT key handling survived until it
// was read by eye. This is the leg that has never run.
//
//   npx hardhat run scripts/e2e-sepolia.ts --network sepolia

const sdk = require("halias-sdk");

const WASM = path.resolve(__dirname, "../circuits/out/transact/transact_js/transact.wasm");
const ZKEY = path.resolve(__dirname, "../circuits/out/transact/ceremony/transact_final.zkey");

const results: { name: string; ok: boolean; note: string }[] = [];
let failed = 0;

async function step(name: string, fn: () => Promise<string | void>) {
  process.stdout.write(`  ${name} ... `);
  try {
    const note = (await fn()) || "";
    console.log(`ok ${note}`);
    results.push({ name, ok: true, note: String(note) });
  } catch (e: any) {
    const msg = (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 160);
    console.log(`FAILED — ${msg}`);
    results.push({ name, ok: false, note: msg });
    failed++;
  }
}

// Asserts a call reverts, and names the reason when the node gives us enough to.
//
// Public RPCs frequently drop revert data on eth_estimateGas, leaving ethers with a bare
// "execution reverted". Insisting on the custom-error name would then fail every check
// for a reason that has nothing to do with the contract — the reasons themselves are
// already asserted exactly in the local suite. So decode when data is present, and
// otherwise record that the revert happened but went unnamed.
async function expectRevert(name: string, fn: () => Promise<any>, expect: string, iface?: any) {
  await step(name, async () => {
    try {
      await fn();
    } catch (e: any) {
      const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
      if (data && iface) {
        try {
          const parsed = iface.parseError(data);
          if (parsed?.name !== expect) throw new Error(`reverted with ${parsed?.name}, expected ${expect}`);
          return `(${expect})`;
        } catch (decodeErr: any) {
          if (decodeErr.message?.startsWith("reverted with")) throw decodeErr;
        }
      }
      const s = e.shortMessage || e.message || String(e);
      if (s.includes(expect)) return `(${expect})`;
      return `(reverted; RPC withheld the reason, expected ${expect})`;
    }
    throw new Error(`expected revert ${expect}, but the call succeeded`);
  });
}

const rand32 = () => ethers.keccak256(ethers.randomBytes(32));

async function main() {
  const cfg = loadDeployment();
  if (!cfg.halias) throw new Error("No halias address in the deployment config");

  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const halias = await ethers.getContractAt("Halias", cfg.halias);

  console.log(`Halias  : ${cfg.halias}`);
  console.log(`chain   : ${net.chainId}`);
  console.log(`caller  : ${signer.address}`);
  console.log(`balance : ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} ETH\n`);

  const startBlock = cfg.startBlock ?? 0;
  const cacheDir = "/tmp/halias-e2e-cache";
  fs.mkdirSync(cacheDir, { recursive: true });

  const mkClient = async (s: any) => {
    const c = new sdk.Halias({
      provider: ethers.provider,
      signer: s,
      chainId: Number(net.chainId),
      contractAddress: cfg.halias,
      artifacts: { transactWasm: WASM, transactZkey: ZKEY },
      cache: new sdk.FileCache(cacheDir),
      startBlock,
      rpcChunkSize: 5000,
    });
    await c.init();
    return c;
  };

  // ── Views (free) ────────────────────────────────────────────────────────────
  console.log("views");
  await step("LEVELS / REGISTRY_LEVELS", async () =>
    `pool=${await halias.LEVELS()} registry=${await halias.REGISTRY_LEVELS()}`);
  await step("REGISTRY_ROOT_MAX_AGE", async () => `${await halias.REGISTRY_ROOT_MAX_AGE()} blocks`);
  await step("registrationFee", async () => ethers.formatEther(await halias.registrationFee()) + " ETH");
  await step("accumulatedFees", async () => ethers.formatEther(await halias.accumulatedFees()) + " ETH");
  await step("getLastRoot / isKnownPoolRoot", async () => {
    const r = await halias.getLastRoot();
    if (!(await halias.isKnownPoolRoot(r))) throw new Error("current pool root not known");
    return r.slice(0, 12) + "…";
  });
  await step("getRegistryRoot / isKnownRegistryRoot", async () => {
    const r = await halias.getRegistryRoot();
    if (!(await halias.isKnownRegistryRoot(r))) throw new Error("current registry root not known");
    return r.slice(0, 12) + "…";
  });
  await step("getSmtSiblings", async () => `${(await halias.getSmtSiblings(0n)).length} siblings`);
  await step("registryRootBlock", async () => String(await halias.registryRootBlock(await halias.getRegistryRoot())));
  await step("nextIndex / lastRoot", async () => `nextIndex=${await halias.nextIndex()}`);
  await step("poolTokenBalance(0x0)", async () => String(await halias.poolTokenBalance(ethers.ZeroAddress)));
  await step("spentNullifiers(unknown)", async () => String(await halias.spentNullifiers(rand32())));
  await step("computeParamsHash", async () => {
    const h = await halias.computeParamsHash({
      poolRoot: ethers.ZeroHash, registryRoot: ethers.ZeroHash, publicAmount: 0n, tokenAddress: 0n,
      inputNullifiers: [ethers.ZeroHash, ethers.ZeroHash],
      outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
    }, "0x", "0x");
    return String(h).slice(0, 12) + "…";
  });

  // ── Registration + SDK flows ────────────────────────────────────────────────
  console.log("\nregistry + pool");
  const client = await mkClient(signer);
  const name = `e2e${Date.now().toString(36)}`;

  await step(`register(${name}.hls)`, async () => (await client.register(name)).txHash.slice(0, 12) + "…");
  await step("lookup resolves the alias", async () => {
    const r = await client.lookup(`${name}.hls`);
    if (r.spendingPubkey === 0n) throw new Error("alias did not resolve");
    return "resolved";
  });
  await step("ownerOf matches the registrant", async () => {
    const h = ethers.keccak256(ethers.toUtf8Bytes(`${name}.hls`));
    const o = await halias.ownerOf(BigInt(h));
    if (o !== signer.address) throw new Error(`owner ${o}`);
    return o.slice(0, 10) + "…";
  });

  await step("deposit 0.004 ETH (ZK proof)", async () => (await client.deposit("0.004")).txHash.slice(0, 12) + "…");
  await step("balance reflects the deposit", async () => {
    const b = await client.balance();
    if (b.total < ethers.parseEther("0.004")) throw new Error(`total ${ethers.formatEther(b.total)}`);
    return ethers.formatEther(b.total) + " ETH";
  });
  await step("scan returns unspent notes", async () => `${(await client.scan()).filter((e: any) => !e.spent).length} unspent`);

  await step("send 0.001 to self (private transfer)", async () =>
    (await client.send(`${name}.hls`, "0.001")).txHash.slice(0, 12) + "…");
  await step("withdraw 0.001 ETH", async () =>
    (await client.withdraw(signer.address, "0.001")).txHash.slice(0, 12) + "…");

  // ── Invite: create + claim, via a second funded account ─────────────────────
  console.log("\ninvite");
  let inviteCode = "";
  await step("createInvite 0.006 ETH", async () => {
    const r = await client.createInvite("0.006");
    inviteCode = r.inviteCode;
    return r.inviteCode.slice(0, 12) + "…";
  });

  const claimerWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  await step("fund a fresh claimer with gas only", async () => {
    await (await signer.sendTransaction({ to: claimerWallet.address, value: ethers.parseEther("0.01") })).wait();
    return claimerWallet.address.slice(0, 10) + "…";
  });

  const claimName = `c${Date.now().toString(36)}`;
  await step(`claimInvite -> ${claimName}.hls (fee paid from the note)`, async () => {
    const c = await mkClient(claimerWallet);
    const r = await c.claimInvite(BigInt(inviteCode), claimName);
    return r.txHash.slice(0, 12) + "…";
  });
  await step("claimer owns their new alias", async () => {
    const h = ethers.keccak256(ethers.toUtf8Bytes(`${claimName}.hls`));
    const o = await halias.ownerOf(BigInt(h));
    if (o !== claimerWallet.address) throw new Error(`owner ${o}`);
    return "confirmed";
  });

  // ── Alias management ────────────────────────────────────────────────────────
  console.log("\nalias management");
  const aliasHash = ethers.keccak256(ethers.toUtf8Bytes(`${name}.hls`));
  await step("updateAliasData", async () =>
    (await (await halias.updateAliasData(aliasHash, rand32())).wait()).hash.slice(0, 12) + "…");
  await step("updateKeys", async () => {
    const nk = ethers.toBeHex(BigInt(rand32()) % (1n << 250n), 32);
    return (await (await halias.updateKeys(aliasHash, nk, rand32())).wait()).hash.slice(0, 12) + "…";
  });

  const throwaway = ethers.Wallet.createRandom();
  const giftName = `g${Date.now().toString(36)}`;
  const giftHash = ethers.keccak256(ethers.toUtf8Bytes(`${giftName}.hls`));
  await step(`register ${giftName}.hls then transferAliasWithKeys`, async () => {
    const fee = await halias.registrationFee();
    await (await halias.register(giftHash,
      ethers.toBeHex(BigInt(rand32()) % (1n << 250n), 32),
      ethers.toBeHex(BigInt(rand32()) % (1n << 250n), 32), rand32(), { value: fee })).wait();
    await (await halias.transferAliasWithKeys(giftHash, throwaway.address,
      ethers.toBeHex(BigInt(rand32()) % (1n << 250n), 32),
      ethers.toBeHex(BigInt(rand32()) % (1n << 250n), 32), rand32())).wait();
    const o = await halias.ownerOf(BigInt(giftHash));
    if (o !== throwaway.address) throw new Error(`owner ${o}`);
    return "transferred";
  });

  // ── Blocked surfaces ────────────────────────────────────────────────────────
  console.log("\nblocked surfaces");
  await expectRevert("transferFrom is blocked",
    () => halias.transferFrom(signer.address, throwaway.address, BigInt(aliasHash)), "UseTransferAliasWithKeys", halias.interface);
  await expectRevert("safeTransferFrom is blocked",
    () => halias["safeTransferFrom(address,address,uint256)"](signer.address, throwaway.address, BigInt(aliasHash)),
    "UseTransferAliasWithKeys", halias.interface);
  await expectRevert("approve is blocked",
    () => halias.approve(throwaway.address, BigInt(aliasHash)), "AliasApprovalsDisabled", halias.interface);
  await expectRevert("setApprovalForAll is blocked",
    () => halias.setApprovalForAll(throwaway.address, true), "AliasApprovalsDisabled", halias.interface);
  await expectRevert("direct ETH is rejected",
    () => signer.sendTransaction({ to: cfg.halias, value: 1n }), "DirectETHNotAllowed", halias.interface);
  await expectRevert("duplicate alias is rejected",
    () => halias.register(aliasHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), rand32(),
      { value: ethers.parseEther("0.002") }), "AliasTaken", halias.interface);
  await expectRevert("wrong registration fee is rejected",
    () => halias.register(rand32(), ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), rand32(), { value: 1n }),
    "WrongRegistrationFee", halias.interface);
  await expectRevert("unknown pool root is rejected",
    async () => halias.transact({
      poolRoot: rand32(), registryRoot: await halias.getRegistryRoot(), publicAmount: 0n, tokenAddress: 0n,
      inputNullifiers: [rand32(), rand32()], outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
    }, "0x", "0x", "0x"), "PoolRootUnknown", halias.interface);
  await expectRevert("externalData on a non-withdrawal is rejected",
    async () => halias.transact({
      poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
      publicAmount: 0n, tokenAddress: 0n,
      inputNullifiers: [rand32(), rand32()], outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, externalData: ethers.toBeHex(1n, 32),
    }, "0x", "0x", "0x"), "RelayerFeeOnNonWithdrawal", halias.interface);
  await expectRevert("non-admin cannot set the fee",
    () => halias.connect(claimerWallet).setRegistrationFee(1n), "NotAdmin", halias.interface);

  // ── ERC-20 ──────────────────────────────────────────────────────────────────
  console.log("\nERC-20");
  let token: any;
  await step("deploy a test ERC-20", async () => {
    token = await (await ethers.getContractFactory("MockERC20")).deploy("E2E Token", "E2E", 18);
    await token.waitForDeployment();
    return (await token.getAddress()).slice(0, 12) + "…";
  });
  await step("rescueToken recovers a stray transfer", async () => {
    const addr = await token.getAddress();
    await (await token.mint(signer.address, ethers.parseEther("10"))).wait();
    await (await token.transfer(cfg.halias, ethers.parseEther("1"))).wait();
    const before = await token.balanceOf(signer.address);
    await (await halias.rescueToken(addr, signer.address, ethers.parseEther("1"))).wait();
    const after = await token.balanceOf(signer.address);
    if (after - before !== ethers.parseEther("1")) throw new Error("rescue amount mismatch");
    return "1.0 recovered";
  });
  await expectRevert("rescueToken cannot touch pool collateral",
    () => halias.rescueToken(token.target, signer.address, ethers.parseEther("1")), "RescueExceedsAvailable", halias.interface);

  // ── Admin ───────────────────────────────────────────────────────────────────
  console.log("\nadmin");
  await step("setBaseTokenURI", async () =>
    (await (await halias.setBaseTokenURI("https://halias.test/")).wait()).hash.slice(0, 12) + "…");
  await step("setRegistrationFee round-trip", async () => {
    const orig = await halias.registrationFee();
    await (await halias.setRegistrationFee(ethers.parseEther("0.003"))).wait();
    if ((await halias.registrationFee()) !== ethers.parseEther("0.003")) throw new Error("fee not set");
    await (await halias.setRegistrationFee(orig)).wait();
    return "restored";
  });
  await step("withdrawFees", async () => {
    const fees = await halias.accumulatedFees();
    if (fees === 0n) return "(no fees accrued)";
    await (await halias.withdrawFees(signer.address, fees)).wait();
    return ethers.formatEther(fees) + " ETH";
  });
  await step("transferAdmin / acceptAdmin round-trip", async () => {
    await (await halias.transferAdmin(claimerWallet.address)).wait();
    if ((await halias.pendingAdmin()) !== claimerWallet.address) throw new Error("pendingAdmin not set");
    await (await halias.connect(claimerWallet).acceptAdmin()).wait();
    if ((await halias.admin()) !== claimerWallet.address) throw new Error("admin not transferred");
    // Hand it back so the deployment stays usable.
    await (await halias.connect(claimerWallet).transferAdmin(signer.address)).wait();
    await (await halias.acceptAdmin()).wait();
    if ((await halias.admin()) !== signer.address) throw new Error("admin not restored");
    return "restored";
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed > 0) {
    console.log("\nfailures:");
    for (const r of results.filter(x => !x.ok)) console.log(`  ${r.name}: ${r.note}`);
    process.exitCode = 1;
  }
  console.log(`balance left: ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} ETH`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
