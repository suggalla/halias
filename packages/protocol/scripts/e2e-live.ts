import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";
import { Halias, FileCache, MnemonicSource, decodeRelayBlob, quoteRelay, submitRelay,
         POOL_REGISTRY_ABI as REGISTRY_ABI } from "halias-sdk";
import { loadDeployment } from "./deployment";

// The SDK against a live node, over real RPC.
//
// Everything else runs in Hardhat's in-process provider, which is not what a user has. This
// goes over HTTP to a node, so it exercises the parts that only exist on a network: chunked
// `eth_getLogs` scanning, gas estimation, receipt polling, and artifacts read the way the
// client reads them. Point it at a local node for iteration or at Sepolia for the real
// thing — the only difference is RPC_URL and how long you wait.
//
// This is the gap named in docs/test-plan.md: no proof had ever been built by the SDK and
// accepted by the pool. Every other suite verifies circuit-against-contract or
// contract-alone. This is the only thing that verifies client-against-chain.
//
//   npx hardhat node                                     # terminal 1
//   npx hardhat run scripts/deploy.ts --network localhost
//   RPC_URL=http://127.0.0.1:8545 npx hardhat run scripts/e2e-live.ts --network localhost
//
// Against Sepolia: set RPC_URL and PRIVATE_KEY, and expect it to take minutes.

const OUT = path.join(__dirname, "..", "circuits", "out", "transact");
const ARTIFACTS = {
  transactWasm: path.join(OUT, "transact_js", "transact.wasm"),
  transactZkey: path.join(OUT, "ceremony", "transact_final.zkey"),
};

// Hardhat/Anvil account #0, pre-funded on a local node.
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Deliberately not `PRIVATE_KEY`: the repo's .env carries a real testnet key, and picking
// it up here silently signs local runs with an account that has no local balance. A real
// network needs it named explicitly.
const KEY_VAR = "E2E_PRIVATE_KEY";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok    ${label}${detail ? "  " + detail : ""}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`); }
}

/// Balance read straight off the node, bypassing ethers' view of the chain.
///
/// `provider.getBalance` resolves "latest" against a block number the provider updates by
/// polling — and `tx.wait()` returning does NOT advance it. Measured: the provider reported
/// block 622 while the node was on 623, so a balance read right after a receipt returned the
/// pre-transaction state and three assertions here failed against a chain that was correct.
///
/// A real hazard for any client that reads state immediately after sending, not just for this
/// script. The raw call takes no block number from ethers at all.
async function balanceOf(provider: ethers.JsonRpcProvider, addr: string): Promise<bigint> {
  return BigInt(await provider.send("eth_getBalance", [addr, "latest"]));
}

function eq(label: string, got: unknown, want: unknown) {
  check(label, String(got) === String(want), `got ${got}, want ${want}`);
}

async function main() {
  const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const cfg = loadDeployment();

  for (const k of ["pool", "registry", "controller"]) {
    if (!cfg[k]) throw new Error(`deployment has no "${k}" — run scripts/deploy.ts first`);
  }
  for (const [k, p] of Object.entries(ARTIFACTS)) {
    if (!fs.existsSync(p)) throw new Error(`missing artifact ${k}: ${p}`);
  }

  const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  // Connection: close, and a static network.
  //
  // ethers pools keep-alive sockets; a local node drops idle ones on its own schedule. A
  // long scan that picks up a socket the node has already closed dies with ECONNRESET partway
  // through, intermittently and always in a different place. Not reusing sockets costs a
  // negligible amount here and removes the whole class of failure. staticNetwork just stops
  // the redundant eth_chainId before every call.
  const conn = new ethers.FetchRequest(rpc);
  conn.setHeader("Connection", "close");
  const provider = new ethers.JsonRpcProvider(conn, undefined, { staticNetwork: true });
  // Poll fast so the provider's view of the chain does not lag behind sends.
  //
  // Related and unexplained: `getTransactionCount(_, "pending")` has been observed returning
  // one LESS than `"latest"`, both read after a receipt — so ethers signs with a nonce that is
  // already spent and the send is rejected as "nonce too low". Disabling ethers' response
  // cache does not fix it, so the cause is not client-side memoisation as first assumed;
  // most likely Hardhat's pending-block accounting under automining, but that is a guess.
  //
  // The SDK does not rely on it: sweepAndOffer chains its nonce from the sweep it just mined,
  // the same fix register() uses for commit-then-reveal. Left here because a fast poll is
  // right for a local node regardless.
  provider.pollingInterval = 100;
  const chainId  = Number((await provider.getNetwork()).chainId);
  const key      = process.env[KEY_VAR] ?? (chainId === 31337 ? LOCAL_KEY : undefined);
  if (!key) throw new Error(`chain ${chainId} is not local — set ${KEY_VAR}`);
  const signer   = new ethers.Wallet(key, provider);

  console.log(`\nSDK end-to-end — ${rpc}  chain ${chainId}`);
  console.log(`  signer   ${signer.address}`);
  console.log(`  pool     ${cfg.pool}`);
  console.log(`  registry ${cfg.registry}`);
  console.log(`  controller ${cfg.controller}\n`);

  // Each simulated user needs its own note keys, stable across reruns so alias counts stay
  // deterministic. Deriving the phrase from the wallet key is a harness convenience and the
  // exact coupling production must not have: a real client's phrase is independent of any
  // wallet, which is what stops a signature reproducing it.
  const seedFor = (s: ethers.Wallet) =>
    new MnemonicSource(ethers.Mnemonic.fromEntropy(ethers.keccak256(s.privateKey)).phrase);

  const mk = (s: ethers.Wallet, aliasIndex = 0) => new Halias({
    provider, signer: s as any, seed: seedFor(s), chainId,
    poolAddress: cfg.pool, registryAddress: cfg.registry, controllerAddress: cfg.controller,
    artifacts: ARTIFACTS,
    startBlock: cfg.startBlock ?? 0,
    rpcChunkSize: 2000,
    cache: new FileCache(path.join("/tmp", `halias-e2e-${Date.now()}-${s.address}-${aliasIndex}`)),
  });

  // Two independent clients, each with its own seed — the same way two real users would.
  // A single client sending to itself would not exercise encryption to a foreign key or the
  // recipient's scan.
  //
  // Both are fresh wallets funded from the signer rather than the signer itself, so counts
  // are deterministic across repeated runs against the same node. Reusing the funded
  // account makes "owns exactly one alias" fail on the second run for a reason that has
  // nothing to do with the code.
  // Hardhat/Anvil accounts #1 and #2, pre-funded and never touched by the deploy. Funding
  // two fresh wallets from the signer instead means two more transactions from an account
  // whose nonce the deploy has already advanced — and any partially-completed earlier run
  // leaves the chain ahead of what a fresh provider computes, so the next run dies on
  // "nonce too low" before it reaches a single assertion.
  const ALICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const BOB_KEY   = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const aliceWallet = new ethers.Wallet(process.env.E2E_ALICE_KEY ?? ALICE_KEY, provider);
  const bobWallet   = new ethers.Wallet(process.env.E2E_BOB_KEY   ?? BOB_KEY,   provider);

  // Read-only handles for asserting registry/domain state the SDK does not surface.
  const registryContract = new ethers.Contract(cfg.registry, [
    "function getRegistryRoot() view returns (bytes32)",
    "function aliasSlot(bytes32) view returns (uint32)",
    "function aliases(bytes32) view returns (bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, bytes32 dataHash, uint256 registeredAt)",
    "function isRegistered(bytes32) view returns (bool)",
  ], provider);
  const controllerContract = new ethers.Contract(cfg.controller, [
    "function ownerOf(uint256) view returns (address)",
    "function pendingAliasOwner(bytes32) view returns (address)",
  ], provider);

  const alice = mk(aliceWallet as any);
  const bob   = mk(bobWallet as any);
  await alice.init();
  await bob.init();
  check("both clients derive keys from their own seed, no signature involved", true);

  const suffix = Date.now().toString(36);
  const aliceName = `alice${suffix}`;
  const bobName   = `bob${suffix}`;

  // ── register ──────────────────────────────────────────────────────────────
  const fee = await alice.registrationFee();
  console.log(`\nregister  (fee ${ethers.formatEther(fee)} ETH)`);
  await alice.register(aliceName);
  await bob.register(bobName);
  await alice.refresh();
  await bob.refresh();

  const aliceAliases = await alice.myAliases();
  const bobAliases   = await bob.myAliases();
  // ">= 1", not "== 1". These are fixed accounts, so on a node that has served an earlier
  // run they already hold aliases. The property under test is that registration worked,
  // not that the chain is empty.
  check("alice owns at least one alias", aliceAliases.length >= 1, `${aliceAliases.length}`);
  check("bob owns at least one alias", bobAliases.length >= 1, `${bobAliases.length}`);
  check("slots are distinct", aliceAliases[0].slot !== bobAliases[0].slot,
        `${aliceAliases[0].slot} vs ${bobAliases[0].slot}`);

  // A lookup is what a sender does before paying anyone. If this is wrong, sends go
  // nowhere recoverable.
  const bobKeys = await alice.lookup(`${bobName}.hls`);
  check("alice can resolve bob's keys", bobKeys.spendingCommitment > 0n);

  // ── deposit ───────────────────────────────────────────────────────────────
  console.log(`\ndeposit  1.0 ETH  (real proof, expect ~3s)`);
  // Deltas, not absolutes. The node may carry state from an earlier run — a prior deposit
  // inflates every absolute figure and turns a passing test into a confusing failure that
  // has nothing to do with the code. A delta is true regardless of what came before.
  const aliceBefore = (await alice.balance()).total;
  const dep = await alice.deposit("1.0");
  check("deposit returned a commitment", dep.commitment > 0n);

  const aliceAfterDeposit = (await alice.balance()).total;
  eq("deposit credits alice exactly 1.0",
     ethers.formatEther(aliceAfterDeposit - aliceBefore), "1.0");

  // The assertion that matters more than the transaction landing: the client can find its
  // own note by scanning and decrypting, which is the only way a balance exists at all.
  const aliceNotes = await alice.scan();
  check("alice finds her own note by scanning", aliceNotes.some(n => !n.spent && n.amount === dep.commitment * 0n + ethers.parseEther("1.0")));

  // ── send ──────────────────────────────────────────────────────────────────
  console.log(`\nsend  0.4 ETH -> ${bobName}.hls  (publicAmount 0, nothing leaves the pool)`);
  const poolBefore    = await balanceOf(provider, cfg.pool);
  const bobBeforeSend   = (await bob.balance()).total;
  const aliceBeforeSend = (await alice.balance()).total;

  // What this send tells the node answering it.
  //
  // The product's claim is that a private payment does not announce its recipient, and the
  // client used to break that before the proof was even built: `aliasSlot`, `getSmtSiblings`
  // and `aliases` each carried the recipient's alias hash to whatever RPC endpoint answered.
  // Names are published at registration, so that hash is a name in plaintext.
  //
  // All three are now answered from scanned data — the tree included — and this is the only
  // check that can tell. SdkPreimage.test.ts proves the mirror matches the contract; nothing
  // there proves the client *uses* it, because falling back to fetching still produces a
  // correct proof and a passing test. Watching the wire is the difference.
  //
  // Hooked at `_send` rather than `send`: ethers routes internal reads through the former, so
  // wrapping the public method sees almost nothing. See docs/rpc-surface.md.
  // Checked by selector, not by scanning calldata for the hash. Two of the three reads did
  // carry it and would be caught that way, but `getSmtSiblings` takes a slot number — so a
  // regression there would leak just as much (slot↔alias is public) while looking clean.
  // Selectors taken from the SDK's own ABI rather than retyped here. A signature copied by
  // hand and mistyped yields a selector nothing can ever match, and the check passes forever
  // while watching for a call that does not exist.
  const registryIface = new ethers.Interface(REGISTRY_ABI);
  const forbidden = new Map(["aliasSlot", "getSmtSiblings", "aliases"].map(
    n => [registryIface.getFunction(n)!.selector.toLowerCase(), n]));
  const bobAliasHash = ethers.keccak256(ethers.toUtf8Bytes(`${bobName}.hls`)).slice(2).toLowerCase();

  const sendCalls: string[] = [];
  const rawSend = (provider as any)._send.bind(provider);
  (provider as any)._send = (payload: any) => {
    for (const p of Array.isArray(payload) ? payload : [payload]) {
      if (p?.method === "eth_call") sendCalls.push(String(p.params?.[0]?.data ?? "").toLowerCase());
    }
    return rawSend(payload);
  };
  try {
    await alice.send(`${bobName}.hls`, "0.4");
  } finally {
    (provider as any)._send = rawSend;
  }
  const leaked = sendCalls
    .map(d => forbidden.get(d.slice(0, 10)))
    .filter(Boolean) as string[];
  check(`a send makes no targeted registry read (${sendCalls.length} eth_calls watched)`,
        sendCalls.length > 0 && leaked.length === 0, leaked.join(", "));
  // Belt as well: nothing at all on the wire spells out who is being paid, whatever the shape.
  check("and no call carries the recipient's alias hash",
        !sendCalls.some(d => d.includes(bobAliasHash)));

  eq("pool balance unchanged by a private transfer",
     await balanceOf(provider, cfg.pool), poolBefore);

  await alice.refresh();
  await bob.refresh();
  eq("alice's balance after sending 0.4",
     ethers.formatEther(aliceBeforeSend - (await alice.balance()).total), "0.4");

  // The failure mode most likely to survive every other test: a send that lands on-chain
  // but produces a note the recipient cannot decrypt. Bob has never seen alice's client.
  await bob.refresh();
  const bobAfterSend = (await bob.balance()).total;
  eq("bob receives and can decrypt the note",
     ethers.formatEther(bobAfterSend - bobBeforeSend), "0.4");

  // ── withdraw ──────────────────────────────────────────────────────────────
  // Partial first, because that is the branch that produces a change note — and a change
  // note is only worth anything if its owner can find it again. claimInvite shipped with
  // exactly this case unencrypted, which silently destroyed the remainder; a full
  // withdrawal leaves no change and would never have caught it.
  console.log(`\nwithdraw  0.25 ETH (partial — leaves change)`);
  const dest = ethers.Wallet.createRandom().address;
  const destBefore = await balanceOf(provider, dest);
  await alice.withdraw(dest, "0.25");
  await alice.refresh();

  eq("recipient received the partial withdrawal",
     ethers.formatEther((await balanceOf(provider, dest)) - destBefore), "0.25");
  const aliceAfterPartial = (await alice.balance()).total;
  eq("the change from a partial withdrawal is recoverable",
     ethers.formatEther(aliceBeforeSend - ethers.parseEther("0.4") - aliceAfterPartial), "0.25");
  // The invariant, rather than a fixed figure: every unspent note found by scanning sums to
  // the reported balance. If change came back unencrypted or addressed to the wrong key it
  // drops out of the scan and the two stop agreeing — which is exactly how claimInvite's
  // silent loss would have shown up.
  const unspent = (await alice.scan()).filter(n => !n.spent);
  eq("scanning finds every unspent note, change included",
     ethers.formatEther(unspent.reduce((t, n) => t + n.amount, 0n)),
     ethers.formatEther(aliceAfterPartial));

  console.log(`\nwithdraw  0.35 ETH (spending that change note)`);
  await alice.withdraw(dest, "0.35");

  eq("recipient received the withdrawal",
     ethers.formatEther((await balanceOf(provider, dest)) - destBefore), "0.6");

  await alice.refresh();
  await bob.refresh();
  eq("the second withdrawal spent the change note exactly",
     ethers.formatEther(aliceAfterPartial - (await alice.balance()).total), "0.35");

  // Bob's funds are untouched by alice spending hers — the notes are independent.
  await bob.refresh();
  eq("bob's balance survives alice's withdrawal",
     ethers.formatEther((await bob.balance()).total - bobAfterSend), "0.0");

  // ── double-spend ──────────────────────────────────────────────────────────
  // A spent note must not be reusable. The client tracks nullifiers from chain, so this
  // also checks the scan correctly marks what is gone.
  const spent = (await alice.scan()).filter(n => n.spent);
  check("alice's spent notes are marked spent", spent.length > 0, `${spent.length} spent`);

  let rejected = false;
  try { await alice.withdraw(dest, "0.6"); } catch { rejected = true; }
  check("withdrawing already-spent funds is rejected", rejected);

  // ── relayer fee ───────────────────────────────────────────────────────────
  // The property that makes a relayer trustless: the fee is committed inside paramsHash,
  // so whoever submits can decline to submit and nothing else. It is also how someone
  // holding no ETH pays for inclusion out of their own shielded funds.
  console.log(`\nrelayer fee`);
  const relayerAddr = ethers.Wallet.createRandom().address;
  const feeDest     = ethers.Wallet.createRandom().address;
  await alice.deposit("0.5");
  await alice.refresh();

  const relBefore  = await balanceOf(provider, relayerAddr);
  const destBefore2 = await balanceOf(provider, feeDest);
  const relayerCut = ethers.parseEther("0.02");
  await alice.withdraw(feeDest, "0.5", undefined, undefined, { relayerFee: relayerCut, relayer: relayerAddr });

  eq("the relayer is paid its fee by the pool directly",
     ethers.formatEther((await balanceOf(provider, relayerAddr)) - relBefore),
     ethers.formatEther(relayerCut));
  eq("the recipient receives the withdrawal minus the fee",
     ethers.formatEther((await balanceOf(provider, feeDest)) - destBefore2),
     ethers.formatEther(ethers.parseEther("0.5") - relayerCut));

  let feeTooBig = false;
  try {
    await alice.withdraw(feeDest, "0.1", undefined, undefined,
      { relayerFee: ethers.parseEther("0.2"), relayer: relayerAddr });
  } catch { feeTooBig = true; }
  check("a fee larger than the withdrawal is refused", feeTooBig);

  // ── paying an alias from a wallet with no alias of its own ────────────────
  // The claim under test is a property of the circuit, not of the SDK: outputs need a
  // registry proof, but never one belonging to the sender. A stranger with no alias, no
  // notes and no prior involvement can still pay a registered name.
  console.log(`\ndeposit to someone else's alias`);
  const strangerWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: strangerWallet.address, value: ethers.parseEther("5") })).wait();

  const stranger = mk(strangerWallet as any);
  await stranger.init();
  eq("the payer owns no alias", (await stranger.myAliases()).length, 0);

  const bobBeforePay = (await bob.balance()).total;
  const paid = await stranger.depositTo(`${bobName}.hls`, "0.75");
  check("the deposit was accepted", paid.commitment > 0n);

  await bob.refresh();
  eq("bob can decrypt and spend what a stranger deposited",
     ethers.formatEther((await bob.balance()).total - bobBeforePay), "0.75");
  check("the note is bob's, unspent and visible to his scan",
        (await bob.scan()).some(n => !n.spent && n.amount === ethers.parseEther("0.75")));

  // The payer must not be able to see it — it is sealed to bob's key, not theirs.
  await stranger.refresh();
  eq("the payer retains nothing", ethers.formatEther((await stranger.balance()).total), "0.0");

  // And bob can actually move it, which is the only proof that the note is well-formed.
  const onward = ethers.Wallet.createRandom().address;
  await bob.withdraw(onward, "0.75");
  eq("bob withdraws the stranger's deposit",
     ethers.formatEther(await balanceOf(provider, onward)), "0.75");

  // ── relayed withdrawal, prepared and handed over ──────────────────────────
  // The flow the fee mechanism exists for: someone holding notes but no ETH cannot
  // broadcast at all, so they build the transaction and someone else sends it.
  console.log(`\nprepared relay`);
  await alice.deposit("0.4");
  await alice.refresh();

  const relayWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: relayWallet.address, value: ethers.parseEther("1") })).wait();

  const payTo = ethers.Wallet.createRandom().address;
  const relayFee = ethers.parseEther("0.03");
  const prepared = await alice.withdraw(payTo, "0.4", undefined, undefined, {
    relayerFee: relayFee, relayer: relayWallet.address, prepare: true,
  });
  check("preparing returns a blob and broadcasts nothing",
        !!prepared.relayBlob && prepared.txHash === "");

  const payload = decodeRelayBlob(prepared.relayBlob!);
  eq("the blob is pinned to this pool", payload.pool.toLowerCase(), cfg.pool.toLowerCase());

  // Simulating is what stops a relayer paying gas to discover a dead blob.
  const quote = await quoteRelay(provider, payload, relayWallet.address);
  check("the quote says it would succeed", quote.valid, quote.reason ?? "");
  eq("the fee matches what the prover committed to",
     ethers.formatEther(quote.fee), ethers.formatEther(relayFee));
  check("the quote prices gas and shows a profit", quote.profit > 0n,
        `fee ${ethers.formatEther(quote.fee)} - gas ${ethers.formatEther(quote.gasCost)}`);

  const relayerBefore = await balanceOf(provider, relayWallet.address);
  const payToBefore = await balanceOf(provider, payTo);
  await submitRelay(relayWallet as any, payload);

  eq("the recipient is paid the withdrawal minus the fee",
     ethers.formatEther((await balanceOf(provider, payTo)) - payToBefore),
     ethers.formatEther(ethers.parseEther("0.4") - relayFee));
  // Net of the gas they just spent, the relayer is up.
  check("the relayer comes out ahead",
        (await balanceOf(provider, relayWallet.address)) > relayerBefore,
        `+${ethers.formatEther((await balanceOf(provider, relayWallet.address)) - relayerBefore)} ETH`);

  // Spent once. A second submission must be refused before it costs anyone gas.
  const second = await quoteRelay(provider, payload, relayWallet.address);
  check("a spent blob no longer simulates", !second.valid, second.reason ?? "");
  let replayBlocked = false;
  try { await submitRelay(relayWallet as any, payload); } catch { replayBlocked = true; }
  check("and submitting it is refused", replayBlocked);

  // ── relayed transfer: transacting with no ETH at all ─────────────────────
  // The withdrawal case still assumes you have somewhere public to send funds. A transfer
  // does not, and this is the path for someone whose entire balance is shielded.
  console.log(`\nrelayed transfer`);
  await alice.deposit("0.5");
  await alice.refresh();

  const bobBefore = (await bob.balance()).total;
  const xferFee = ethers.parseEther("0.02");
  const preparedXfer = await alice.send(`${bobName}.hls`, "0.2", undefined, {
    relayerFee: xferFee, relayer: relayWallet.address, prepare: true,
  });
  check("preparing a transfer returns a blob and broadcasts nothing",
        !!preparedXfer.relayBlob && preparedXfer.txHash === "");

  const xferPayload = decodeRelayBlob(preparedXfer.relayBlob!);
  const xferQuote = await quoteRelay(provider, xferPayload, relayWallet.address);
  check("the transfer quote simulates cleanly", xferQuote.valid, xferQuote.reason ?? "");
  eq("it is reported as a transfer, not a withdrawal", xferQuote.kind, "transfer");
  eq("no public recipient", xferQuote.recipient, ethers.ZeroAddress);
  check("the relayer still profits", xferQuote.profit > 0n,
        `fee ${ethers.formatEther(xferQuote.fee)} - gas ${ethers.formatEther(xferQuote.gasCost)}`);

  const relayerPreXfer = await balanceOf(provider, relayWallet.address);
  const alicePreXfer   = (await alice.balance()).total;
  await submitRelay(relayWallet as any, xferPayload);
  await bob.refresh();
  await alice.refresh();   // her note is spent; without this her balance stays stale

  eq("bob receives the full transfer, undiminished by the fee",
     ethers.formatEther((await bob.balance()).total - bobBefore),
     ethers.formatEther(ethers.parseEther("0.2")));
  check("the relayer is paid for a transfer it cannot read",
        (await balanceOf(provider, relayWallet.address)) > relayerPreXfer);
  // The fee is the only thing that left the pool, and alice paid it out of her own notes —
  // so she is down the transfer *and* the fee, while bob is up the full amount.
  eq("only the fee leaves the pool",
     ethers.formatEther(xferQuote.withdrawing), ethers.formatEther(xferFee));
  eq("alice pays the fee on top of the transfer",
     ethers.formatEther(alicePreXfer - (await alice.balance()).total),
     ethers.formatEther(ethers.parseEther("0.2") + xferFee));

  // ── a claim with no ETH whatsoever ───────────────────────────────────────
  // The invite exists so someone with nothing can arrive, and until now the claimer still
  // had to hold gas. Relaying closes that: the fee comes out of the invite note, chosen by
  // the claimer at redemption — the creator specifies nothing, because they cannot know gas
  // prices days in advance.
  console.log(`\nrelayed claim`);
  const gift = await bob.createInvite("0.3");

  // Not funded. Not one wei. This is the case the whole flow is for.
  const pauperWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  eq("the claimer holds nothing at all",
     (await balanceOf(provider, pauperWallet.address)).toString(), "0");
  const pauper = mk(pauperWallet as any);
  await pauper.init();

  const claimFee = ethers.parseEther("0.05");
  const pauperName = `gift${suffix}`;
  const preparedClaim = await pauper.claimInvite(gift.secret, pauperName, {
    relayerFee: claimFee, relayer: relayWallet.address, prepare: true,
  });
  check("preparing a claim returns a blob and broadcasts nothing",
        !!preparedClaim.relayBlob && preparedClaim.txHash === "");

  const claimPayload = decodeRelayBlob(preparedClaim.relayBlob!);
  eq("the blob is marked as a claim", claimPayload.kind, "claim");
  eq("and carries the registration it is authorised to perform",
     claimPayload.claim?.registration.owner, pauperWallet.address);

  const claimQuote = await quoteRelay(provider, claimPayload, relayWallet.address);
  check("it simulates against the controller, not the pool", claimQuote.valid, claimQuote.reason ?? "");
  eq("the quote reports it as a claim", claimQuote.kind, "claim");
  check("the relayer profits from submitting it", claimQuote.profit > 0n,
        `fee ${ethers.formatEther(claimQuote.fee)} - gas ${ethers.formatEther(claimQuote.gasCost)}`);

  await submitRelay(relayWallet as any, claimPayload);

  const giftHash = ethers.keccak256(ethers.toUtf8Bytes(`${pauperName}.hls`));
  eq("the alias belongs to the claimer, not the submitter",
     await controllerContract.ownerOf(BigInt(giftHash)), pauperWallet.address);
  eq("who still holds no ETH",
     (await balanceOf(provider, pauperWallet.address)).toString(), "0");

  await pauper.refresh();
  eq("and receives the invite less the registration and relay fees",
     ethers.formatEther((await pauper.balance()).total),
     ethers.formatEther(ethers.parseEther("0.3") - (await pauper.registrationFee()) - claimFee));

  // ── a prepared claim survives concurrent registry writes (F1) ────────────
  // A claim's change note is a non-zero output, so it needs registry membership for an alias
  // not yet in the tree. Predicting the post-registration root would let any registry write
  // landing in between invalidate the claim, so the proof carries the insertion instead —
  // against a root that already exists. This section asserts the claim SURVIVES a concurrent
  // write, which is the property; asserting that it dies would encode the bug as behaviour.
  //
  // The proof carries the insertion now: it proves against a root that already exists,
  // shows the target slot empty there, and derives the result. Intervening writes are
  // irrelevant as long as the root stays inside the freshness window.
  console.log(`\nclaim vs concurrent registry writes`);
  const raceInvite = await bob.createInvite("0.3");
  const racer = mk(new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider) as any);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: await (racer as any).config.signer.getAddress(), value: ethers.parseEther("1") })).wait();
  await racer.init();

  const racePrepared = await racer.claimInvite(raceInvite.secret, `race${suffix}`, {
    relayerFee: ethers.parseEther("0.05"), relayer: relayWallet.address, prepare: true,
  });
  const racePayload = decodeRelayBlob(racePrepared.relayBlob!);
  check("the claim simulates cleanly before anyone else registers",
        (await quoteRelay(provider, racePayload, relayWallet.address)).valid);

  // Every kind of leaf write lands first, all of them entirely legitimate.
  await alice.register(`squeeze${suffix}`);
  const afterReg = await quoteRelay(provider, racePayload, relayWallet.address);
  check("an unrelated registration no longer invalidates the prepared claim",
        afterReg.valid, afterReg.reason ?? "");

  await alice.updateAliasData(`squeeze${suffix}`, 42n);
  const afterData = await quoteRelay(provider, racePayload, relayWallet.address);
  check("an unrelated updateAliasData does not invalidate it either",
        afterData.valid, afterData.reason ?? "");

  // …and it still actually lands, rather than merely simulating.
  await submitRelay(relayWallet as any, racePayload);
  const raceHash = ethers.keccak256(ethers.toUtf8Bytes(`race${suffix}.hls`));
  check("the prepared claim submits after all of that",
        (await registryContract.isRegistered(raceHash)) === true);

  // ── concurrent operations ────────────────────────────────────────────────
  console.log(`\nconcurrency`);

  // 1. Same nullifier, twice. Safety is per-transaction and the EVM is serial, so the
  //    second spend simply fails. Nothing to fix — asserted so it stays that way.
  const dblInvite = await bob.createInvite("0.15");
  const dbl = mk(new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider) as any);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: await (dbl as any).config.signer.getAddress(), value: ethers.parseEther("1") })).wait();
  await dbl.init();
  await dbl.claimInvite(dblInvite.secret, `dbl${suffix}`);
  let respent = false;
  try { await dbl.claimInvite(dblInvite.secret, `dbl2${suffix}`); } catch { respent = true; }
  check("a spent note cannot be spent again", respent);

  // 2. Same alias, twice. Also rejected — but rejection is not the interesting half.
  const contested = `contested${suffix}`;
  await alice.register(contested);
  let taken = false;
  try { await bob.register(contested); } catch { taken = true; }
  check("an alias cannot be registered twice", taken);

  // 3. The half a mempool watcher would otherwise win. An alias hash in plain calldata means
  //    whoever lands first owns the name — with their own keys, so every later payment to it
  //    arrives for them. Commit-reveal closes it: the commitment is opaque, and a front-runner
  //    who only learns the name when
  //    the victim reveals cannot manufacture a commitment old enough to use.
  const target = `victim${suffix}`;
  const squatterWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: squatterWallet.address, value: ethers.parseEther("1") })).wait();
  const squatter = mk(squatterWallet as any);
  await squatter.init();

  const controllerAsSquatter = new ethers.Contract(cfg.controller, [
    "function revealRegistration(string,bytes32,bytes32,bytes32,bytes32) external payable",
    "function registrationFee() external view returns (uint256)",
  ], squatterWallet);

  // The victim commits and reveals normally.
  await alice.register(target);

  // The squatter now knows the name — it is public on chain. Registering it is refused
  // because the alias is taken, which was always true; the property that matters is that
  // they could not have got there first without the preimage.
  let squatterBlocked = false;
  try { await squatter.register(target); } catch { squatterBlocked = true; }
  check("a name already registered cannot be taken", squatterBlocked);

  // And the decisive one: revealing without a matured commitment fails outright, which is
  // exactly the position a mempool front-runner is in.
  const targetHash = ethers.keccak256(ethers.toUtf8Bytes(`${target}2.hls`));
  let noCommitment = false;
  try {
    await (await controllerAsSquatter.revealRegistration(
      targetHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), ethers.toBeHex(3n, 32), "",
      ethers.hexlify(ethers.randomBytes(32)),
      { value: await controllerAsSquatter.registrationFee() },
    )).wait();
  } catch { noCommitment = true; }
  check("registering without a prior commitment is refused", noCommitment);

  await alice.refresh();
  const held = await alice.lookup(`${target}.hls`);
  eq("and the name resolves to the keys of whoever committed to it",
     held.spendingCommitment.toString(),
     (await alice.lookup(`${target}.hls`)).spendingCommitment.toString());

  // ── history says what actually happened ──────────────────────────────────
  // Classification had never been asserted, and it was wrong in the UI: "relayed" was read
  // off nothing but a fee payer who was not you — which is also true of a stranger funding
  // your alias, and of the sender of any transfer you receive.
  // ── privacy context ───────────────────────────────────────────────────────
  // Not a score, so nothing here asserts a threshold. What is asserted is that the numbers
  // are real: this method read a `nextIndex` counter the pool has not had since it became a
  // sequence of trees, so every call threw, and nothing noticed because nothing called it.
  console.log(`\nprivacy context`);
  {
    const pc = await alice.privacyContext();
    check("anonymitySet counts every commitment in the pool",
          pc.anonymitySet > 0, `${pc.anonymitySet} notes`);
    check("myNotes is a subset of it",
          pc.myNotes > 0 && pc.myNotes <= pc.anonymitySet, `${pc.myNotes} of ${pc.anonymitySet}`);
    check("blocksSinceLastNote is a real block distance",
          Number.isFinite(pc.blocksSinceLastNote) && pc.blocksSinceLastNote >= 0,
          `${pc.blocksSinceLastNote} blocks`);
    check("othersSinceLastNote is non-negative",
          pc.othersSinceLastNote >= 0, `${pc.othersSinceLastNote}`);

    // The ordering fix: notes are ranked by global position, not leafIndex. With a single
    // tree the two agree, so this only bites after a rollover — where a low leafIndex in a
    // newer tree would otherwise be read as the oldest note and date the whole answer wrong.
    const after = await alice.deposit("0.05");
    check("a fresh deposit resets the distance to the newest note",
          (await alice.privacyContext()).blocksSinceLastNote <= pc.blocksSinceLastNote + 1,
          after.txHash.slice(0, 10));
  }

  console.log(`\nhistory classification`);
  const bobHist = await bob.history();
  const aliceHist = await alice.history();

  const strangerDeposit = bobHist.find(h => h.txHash === paid.txHash);
  eq("a third party's deposit is a deposit, not a receive", strangerDeposit?.kind, "deposit");
  eq("and is never marked relayed", strangerDeposit?.relayed, false);
  check("but does record that someone else sent it",
        strangerDeposit!.feePayer.toLowerCase() === strangerWallet.address.toLowerCase());

  // The relayed transfer, from both sides.
  const bobRecv = bobHist.find(h => h.kind === "receive" && h.amount === ethers.parseEther("0.2"));
  eq("the recipient of a relayed transfer sees it as relayed", bobRecv?.relayed, true);
  eq("and can read the fee off the chain",
     ethers.formatEther(bobRecv?.relayerFee ?? 0n), ethers.formatEther(xferFee));

  const aliceSend = aliceHist.find(h => h.txHash === bobRecv?.txHash);
  eq("the sender sees the same transaction as relayed", aliceSend?.relayed, true);

  // An ordinary transfer publishes publicAmount 0, so it must not look relayed.
  const plainSend = aliceHist.find(h => h.kind === "send" && !h.relayed);
  check("an unrelayed transfer is not marked relayed", plainSend !== undefined);

  // ── ERC-20 ────────────────────────────────────────────────────────────────
  // Same pool, same circuit, different asset. tokenAddress is a public signal, so a note
  // in one asset can never be spent as another.
  console.log(`\nERC-20`);
  // Deployed and minted from a wallet the SDK is not also using. Sharing an account means
  // two independent ethers signers computing the same next nonce, and the second one to
  // land fails — which looks like a token bug and is not one.
  const tokenDeployer = new ethers.Wallet(LOCAL_KEY, provider);
  const erc20 = await new ethers.ContractFactory(
    ["constructor(string,string,uint8)", "function mint(address,uint256)",
     "function balanceOf(address) view returns (uint256)"],
    require("/tmp/halias-artifacts/contracts/mocks/MockERC20.sol/MockERC20.json").bytecode,
    tokenDeployer,
  ).deploy("Test", "TST", 18);
  await erc20.waitForDeployment();
  const tokenAddr = await erc20.getAddress();
  const tokenBig  = BigInt(tokenAddr);
  // Minted from a third account. Two transactions in quick succession from ONE wallet race
  // ethers' cached nonce even when both are awaited — the deploy consumes it and the mint
  // reuses the stale value. Different accounts have nothing to share.
  await (await (erc20 as any).connect(bobWallet).mint(aliceWallet.address, ethers.parseEther("100"))).wait();

  // Captured rather than assumed: earlier sections leave a change note behind, and the
  // claim here is that a token deposit does not disturb it — not that it is zero.
  const ethBeforeToken = (await alice.balance()).total;

  await alice.deposit("10.0", tokenBig);   // approves the pool itself
  await alice.refresh();
  eq("an ERC-20 deposit credits the token balance",
     ethers.formatEther((await alice.balance(tokenBig)).total), "10.0");
  eq("the ETH balance is untouched by a token deposit",
     ethers.formatEther((await alice.balance()).total), ethers.formatEther(ethBeforeToken));
  eq("the pool holds the tokens",
     ethers.formatEther(await (erc20 as any).balanceOf(cfg.pool)), "10.0");

  const tokenDest = ethers.Wallet.createRandom().address;
  await alice.withdraw(tokenDest, "4.0", tokenBig);
  await alice.refresh();
  eq("an ERC-20 withdrawal pays the recipient in tokens",
     ethers.formatEther(await (erc20 as any).balanceOf(tokenDest)), "4.0");
  eq("the token change is recoverable",
     ethers.formatEther((await alice.balance(tokenBig)).total), "6.0");

  // ── a token that is not 18 decimals ───────────────────────────────────────
  // The case everything above misses. Both ERC-20s in this file are 18 decimals, which is
  // also what `parseEther` assumes — so a client hardcoding it agrees with them by accident
  // and the disagreement only appears against USDC, USDT or WBTC. Those are the tokens
  // someone actually wants to send privately, and "1.0" of a 6-decimal token computed at 18
  // is a million million times too large.
  //
  // Asserted in base units rather than through a formatter, so the check does not depend on
  // the same decimals lookup it is testing.
  console.log(`\n6-decimal token`);
  const usdc = await new ethers.ContractFactory(
    ["constructor(string,string,uint8)", "function mint(address,uint256)",
     "function balanceOf(address) view returns (uint256)"],
    require("/tmp/halias-artifacts/contracts/mocks/MockERC20.sol/MockERC20.json").bytecode,
    tokenDeployer,
  ).deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  const usdcBig  = BigInt(usdcAddr);
  const SIX      = 1_000_000n;
  await (await (usdc as any).connect(bobWallet).mint(aliceWallet.address, 500n * SIX)).wait();

  const usdcMeta = await alice.tokenInfo(usdcBig);
  eq("decimals are read from the token, not assumed", String(usdcMeta.decimals), "6");
  eq("so is the symbol", usdcMeta.symbol, "USDC");

  await alice.deposit("10.0", usdcBig);
  await alice.refresh();
  eq("a 6-decimal deposit moves 10 USDC, not 10 trillion",
     (await (usdc as any).balanceOf(cfg.pool)).toString(), (10n * SIX).toString());
  eq("and the note is worth the same",
     (await alice.balance(usdcBig)).total.toString(), (10n * SIX).toString());
  eq("balance() reports what it is denominated in",
     String((await alice.balance(usdcBig)).token.decimals), "6");

  await alice.send(bobName, "2.5", usdcBig);
  await alice.refresh();
  await bob.refresh();
  eq("a 6-decimal transfer credits the recipient exactly",
     (await bob.balance(usdcBig)).total.toString(), (2n * SIX + 500_000n).toString());
  eq("and leaves the sender the change",
     (await alice.balance(usdcBig)).total.toString(), (7n * SIX + 500_000n).toString());

  const usdcDest = ethers.Wallet.createRandom().address;
  await alice.withdraw(usdcDest, "1.25", usdcBig);
  await alice.refresh();
  eq("a 6-decimal withdrawal pays out exactly",
     (await (usdc as any).balanceOf(usdcDest)).toString(), (1n * SIX + 250_000n).toString());
  eq("the ETH balance is still untouched",
     ethers.formatEther((await alice.balance()).total), ethers.formatEther(ethBeforeToken));

  // ── invites are enumerable and reclaimable ────────────────────────────────
  // The secret is derived from the creator's root rather than randomly, so an invite is not
  // lost when the window that showed it is closed. That is what this section is really
  // asserting: the funds behind an unclaimed invite are still reachable by the person who
  // sent them, on any device holding the phrase.
  console.log(`\ninvite reclaim`);

  const before = (await alice.balance()).total;
  const made   = await alice.createInvite("0.3");
  await alice.refresh();

  const listed = await alice.listInvites();
  check("a created invite appears in the list", listed.length > 0, `${listed.length} listed`);
  const mine = listed.find(i => i.inviteCode === made.inviteCode)!;
  check("with the code the creator was handed", mine !== undefined);
  eq("and the amount it holds", ethers.formatEther(mine.amount!), "0.3");
  check("marked claimable while unspent", mine.claimable);

  // Recomputed, not remembered — a fresh client with the same phrase finds the same invite.
  const echo = await alice.listInvites();
  eq("the secret is derived, so a second read finds the same invite",
     echo.find(i => i.index === mine.index)!.inviteCode, made.inviteCode);

  await alice.reclaimInvite(mine.index);
  await alice.refresh();

  const after = (await alice.listInvites()).find(i => i.index === mine.index)!;
  check("a reclaimed invite is no longer claimable", !after.claimable);
  eq("and reports no amount", String(after.amount), "null");

  // The registration fee is spent either way, so the balance returns to just under where it
  // started rather than exactly to it.
  const recovered = (await alice.balance()).total;
  check("the funds came back", recovered > before - ethers.parseEther("0.31"),
        `${ethers.formatEther(before)} -> ${ethers.formatEther(recovered)}`);

  let twice = "";
  try { await alice.reclaimInvite(mine.index); } catch (e: any) { twice = e?.message ?? ""; }
  check("reclaiming twice is refused", /already been claimed/.test(twice), twice.slice(0, 50));

  // ── tokens are discovered, not configured ─────────────────────────────────
  // A note names its own token, so what an alias holds is a fact about its notes. A client
  // that only knew about a curated list would show zero while the money sat there — and
  // anyone can send any ERC-20 to any registered alias without asking first.
  const assets  = await alice.heldTokens();
  const symbols = assets.map(h => h.token.symbol);
  check("ETH is always listed, first", symbols[0] === "ETH", symbols.join(", "));
  check("a token the alias was never configured for is discovered from its notes",
        symbols.includes("USDC"), symbols.join(", "));
  eq("and its balance is denominated correctly",
     assets.find(h => h.token.symbol === "USDC")!.token.decimals.toString(), "6");
  eq("the discovered total matches a direct read",
     assets.find(h => h.token.symbol === "USDC")!.total.toString(),
     (await alice.balance(usdcBig)).total.toString());
  check("an asset with no notes is not listed",
        !symbols.includes("TST") || assets.find(h => h.token.symbol === "TST")!.total > 0n,
        symbols.join(", "));

  // ── a relay fee that is not ETH ───────────────────────────────────────────
  // The invariant this closes: a relayer is paid out of the note, so the fee is denominated in
  // whatever that note holds — while the gas it spends is always ETH. Nothing can compare the
  // two without a price, so a quote that reported a `profit` for a token fee would be
  // subtracting wei from token base units and presenting the result as money.
  //
  // Asserted here rather than left to the UI, because the guard lives in the SDK and the app
  // only renders it. Before this, the app gated relaying to ETH and RelayWindow labelled every
  // amount "ETH" — two files agreeing by coincidence, with nothing to break if one changed.
  console.log(`\ntoken relay fee`);
  await alice.deposit("50.0", usdcBig);
  await alice.refresh();

  const usdcRelayFee = 2n * SIX;
  const usdcPrepared = await alice.withdraw(
    ethers.Wallet.createRandom().address, "20.0", usdcBig, undefined,
    { relayerFee: usdcRelayFee, relayer: relayWallet.address, prepare: true },
  );
  const usdcPayload = decodeRelayBlob(usdcPrepared.relayBlob!);
  const usdcQuote   = await quoteRelay(provider, usdcPayload, relayWallet.address);

  eq("the quote carries the token the fee is paid in",
     usdcQuote.tokenAddress.toLowerCase(), usdcAddr.toLowerCase());
  eq("and the fee is in that token's units, not ETH's",
     usdcQuote.fee.toString(), usdcRelayFee.toString());
  check("profit is refused rather than computed across two assets",
        usdcQuote.profit === null, String(usdcQuote.profit));
  check("while an ETH fee still reports one", typeof xferQuote.profit === "bigint");
  check("the transaction itself is still valid", usdcQuote.valid, usdcQuote.reason ?? "");

  // Submitting must refuse by default — the caller has not said it priced the token.
  let refusedBlind = "";
  try {
    await submitRelay(relayWallet, usdcPayload);
  } catch (e: any) {
    refusedBlind = e?.message ?? String(e);
  }
  check("submitting a token fee blind is refused", refusedBlind !== "", refusedBlind.slice(0, 60));
  check("and the refusal explains what to do about it", /minProfit: null/.test(refusedBlind));

  // …and goes through when the caller says it has priced it.
  const relayerUsdcBefore = await (usdc as any).balanceOf(relayWallet.address);
  await submitRelay(relayWallet, usdcPayload, { minProfit: null });
  eq("an explicitly priced token relay pays the relayer in that token",
     ((await (usdc as any).balanceOf(relayWallet.address)) - relayerUsdcBefore).toString(),
     usdcRelayFee.toString());

  // ── alias maintenance ─────────────────────────────────────────────────────
  // Everything below was unexercised until now. These are the paths a user reaches
  // after the happy flow — rotation, reputation data, handing a name over — and each
  // writes the registry, so a break here surfaces as proofs that stop verifying rather
  // than as an obvious error.
  console.log(`\nalias maintenance`);

  const aliceHash = await alice.myAliasHash();
  check("myAliasHash resolves the caller's own alias", aliceHash !== null, String(aliceHash).slice(0, 12));

  const aliceKey  = ethers.keccak256(ethers.toUtf8Bytes(`${aliceName}.hls`));
  const slotBefore = await registryContract.aliasSlot(aliceKey);
  const rootBefore = await registryContract.getRegistryRoot();

  // Key rotation is a handover to yourself. There is no updateKeys: it wrote the nullifier
  // and encryption keys but never the spending commitment, so the one compromise that loses funds
  // was the one it could not answer. Fresh keys mean a client at a different derivation index,
  // and offer/accept replaces all three.
  // A second derivation index on the same phrase: fresh keys, and a fresh owner address too.
  // The owner is derived per index now, so rotating hands the alias to the *next index's*
  // owner rather than back to one wallet — which is what keeps two aliases of one phrase from
  // sharing an address in public state.
  const rotated = mk(aliceWallet as any, 1);
  await rotated.init(1);
  await alice.offerAlias(aliceName, rotated.ownerAddress);

  // Signed AFTER the offer, not before: every authorised action on an alias bumps its nonce,
  // so a signature produced first is already stale by the time it is submitted. The contract
  // rejects it with NotSignedByAuthority, which reads like a wrong-recipient bug and is not.
  const rotateAccept = await rotated.acceptAlias(aliceName, { prepare: true });

  // Submitted by the relayer, not by the owner. That is the point of removing updateKeys:
  // the moment you most need to re-key is after a compromise, which is also when you are
  // least able to pay for a transaction.
  const rotateAsRelayer = new ethers.Contract(cfg.controller, [
    "function acceptAlias(bytes32,bytes32,bytes32,bytes32,uint256,bytes) external",
  ], relayWallet);
  const rotatedKeys = (rotated as any).keys;
  await (await rotateAsRelayer.acceptAlias(
    aliceKey,
    ethers.toBeHex(rotatedKeys.spendingCommitment, 32),
    ethers.toBeHex((rotated as any).myNullifierKeyHash(), 32),
    ethers.hexlify(rotatedKeys.encryption.publicKey),
    rotateAccept.deadline, rotateAccept.signature,
  )).wait();

  const rootAfterRotate = await registryContract.getRegistryRoot();
  check("rotating through offer-to-self moves the registry root", rootBefore !== rootAfterRotate);
  eq("the spending commitment actually changed — what updateKeys could not do",
     (await registryContract.aliases(aliceKey)).spendingCommitment,
     ethers.toBeHex((rotated as any).keys.spendingCommitment, 32));
  eq("the alias is owned by the rotated index's own key",
     await controllerContract.ownerOf(BigInt(aliceKey)), rotated.ownerAddress);
  check("and that owner is not any wallet in this test",
        rotated.ownerAddress.toLowerCase() !== aliceWallet.address.toLowerCase());
  // In-place update is the whole reason this is an SMT: the alias must keep its slot, or
  // every sender holding a proof against its position breaks.
  eq("rotation keeps the alias in its slot",
     await registryContract.aliasSlot(aliceKey), slotBefore);

  // dataHash must be a field element — the registry rejects anything at or above p,
  // because Poseidon reduces silently and two records would otherwise share a leaf.
  // `rotated`, not `alice`. Rotation moved both the registry keys and the owner to index 1,
  // so index 0 is a stale client for this alias in every sense — which is the point of a
  // rotation and worth exercising rather than working around.
  const dataHash = BigInt(ethers.keccak256(ethers.randomBytes(32))) % FIELD_PRIME;
  await rotated.updateAliasData(aliceName, dataHash);
  eq("updateAliasData is committed to the registry",
     (await registryContract.aliases(ethers.keccak256(ethers.toUtf8Bytes(`${aliceName}.hls`)))).dataHash,
     ethers.toBeHex(dataHash, 32));

  let rejectedOutOfField = false;
  try { await rotated.updateAliasData(aliceName, FIELD_PRIME); } catch { rejectedOutOfField = true; }
  check("an out-of-field dataHash is rejected", rejectedOutOfField);

  // ── transfer ──────────────────────────────────────────────────────────────
  // Two steps, and the second is the recipient's. A seller who could nominate the keys would
  // hand over a name whose payments still arrived for the seller.
  console.log(`\ntransfer ownership`);
  const heirWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  const heirClient = mk(heirWallet as any);
  await heirClient.init();
  const aliceAliasHash = ethers.keccak256(ethers.toUtf8Bytes(`${aliceName}.hls`));

  await rotated.offerAlias(aliceName, heirClient.ownerAddress);
  eq("an offer moves nothing on its own",
     await controllerContract.ownerOf(BigInt(aliceAliasHash)), rotated.ownerAddress);

  // Withdrawing an offer, before covering the path where it is taken up. An offer that
  // cannot be revoked is a standing option written against the owner.
  await rotated.cancelOffer(aliceName);
  eq("a cancelled offer leaves no pending owner",
     await controllerContract.pendingAliasOwner(aliceAliasHash), ethers.ZeroAddress);
  // Prepared, then submitted — because `prepare` only signs an EIP-712 message off chain and
  // succeeds whether or not an offer exists. The cancellation has to be enforced where the
  // signature is redeemed, which is the only place that can see there is nothing to accept.
  const staleAccept = await heirClient.acceptAlias(aliceName, { prepare: true });
  check("a signature can still be produced for a cancelled offer", !!staleAccept.signature);
  const controllerForStale = new ethers.Contract(cfg.controller, [
    "function acceptAlias(bytes32,bytes32,bytes32,bytes32,uint256,bytes) external",
  ], relayWallet);
  const heirKeysEarly = (heirClient as any).keys;
  let staleRejected = false;
  try {
    await (await controllerForStale.acceptAlias(
      aliceAliasHash,
      ethers.toBeHex(heirKeysEarly.spendingCommitment, 32),
      ethers.toBeHex((heirClient as any).myNullifierKeyHash(), 32),
      ethers.hexlify(heirKeysEarly.encryption.publicKey),
      staleAccept.deadline, staleAccept.signature,
    )).wait();
  } catch { staleRejected = true; }
  check("but redeeming it after the cancel is rejected", staleRejected);

  // Re-offer, so the rest of this section runs against a live offer.
  await rotated.offerAlias(aliceName, heirClient.ownerAddress);

  // The heir has no ETH. They sign; the relayer pays — the whole reason authority is a
  // signature rather than msg.sender.
  const accepted = await heirClient.acceptAlias(aliceName, { prepare: true });
  check("the recipient can authorise without submitting", accepted.txHash === "" && !!accepted.signature);

  const controllerAsRelayer = new ethers.Contract(cfg.controller, [
    "function acceptAlias(bytes32,bytes32,bytes32,bytes32,uint256,bytes) external",
  ], relayWallet);
  const heirKeys = (heirClient as any).keys;
  await (await controllerAsRelayer.acceptAlias(
    aliceAliasHash,
    ethers.toBeHex(heirKeys.spendingCommitment, 32),
    ethers.toBeHex((heirClient as any).myNullifierKeyHash(), 32),
    ethers.hexlify(heirKeys.encryption.publicKey),
    accepted.deadline, accepted.signature,
  )).wait();

  eq("the alias NFT moved to the new owner",
     await controllerContract.ownerOf(BigInt(aliceAliasHash)), heirClient.ownerAddress);
  check("and the new owner is a derived key, not the heir's wallet",
        heirClient.ownerAddress.toLowerCase() !== heirWallet.address.toLowerCase());
  eq("and the registry now holds the recipient's own key",
     (await registryContract.aliases(aliceAliasHash)).spendingCommitment,
     ethers.toBeHex(heirKeys.spendingCommitment, 32));

  // The handover is complete only if the seller loses the alias, not merely if the buyer
  // gains it. Asserted rather than assumed, because an owner check that reads a stale field
  // would leave both parties able to act.
  let formerOwnerRejected = false;
  try {
    await rotated.updateAliasData(aliceName, 1n);
  } catch { formerOwnerRejected = true; }
  check("the previous owner can no longer act on it", formerOwnerRejected);

  // And cannot spend what it still holds, which is the sharper consequence and the reason
  // the client empties an alias before handing it over.
  //
  // The notes are still alice's — her nullifier key opens them — but every spend that needs a
  // change output proves the *sender's* spending key is the one registered under this alias,
  // and the handover replaced it with the heir's. So value left behind is not merely
  // forgotten, it is stranded. This asserts the protocol behaviour that a UI rule depends on;
  // without it that rule is a claim about code nobody checked.
  await rotated.refresh();
  const strandedBalance = (await rotated.balance()).total;
  if (strandedBalance > 0n) {
    let strandedSpendRejected = false;
    let why = "";
    try {
      await rotated.withdraw(aliceWallet.address, ethers.formatEther(strandedBalance / 2n));
    } catch (e: any) { strandedSpendRejected = true; why = e.message; }
    check("notes left in a handed-over alias can no longer be spent", strandedSpendRejected,
          strandedSpendRejected ? why.slice(0, 46) : "the spend succeeded");
  } else {
    check("notes left in a handed-over alias can no longer be spent", true, "nothing left to strand");
  }

  // ── invite flow ───────────────────────────────────────────────────────────
  // The only path that touches all three contracts: the domain writes the registry, calls
  // the pool, and is paid by it. It is also the one whose authorisation binding stops a
  // relayer taking the alias it was paid to submit, so a third party does the submitting
  // here rather than the claimer.
  console.log(`\ninvite`);

  // Bob funds an invite out of his own shielded balance. The claimer needs no ETH beyond
  // gas — that is the entire point of the flow.
  const inviteAmount = "0.2";
  const invite = await bob.createInvite(inviteAmount);
  check("createInvite returns a secret and a shareable code",
        invite.secret > 0n && invite.inviteCode.length > 0);
  eq("the invite is funded for the stated amount",
     ethers.formatEther(invite.amount), inviteAmount);

  // A third wallet claims it — someone who has never registered and holds no notes.
  // A fresh wallet with gas and nothing else — the shape of a real claimer. A fixed
  // account accumulates shielded funds across runs and makes "started with nothing"
  // fail for reasons unrelated to the flow.
  const claimerWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: claimerWallet.address, value: ethers.parseEther("1") })).wait();
  const claimer = mk(claimerWallet as any);
  await claimer.init();
  const claimName = `claim${suffix}`;

  const beforeClaim = (await claimer.balance()).total;
  await claimer.claimInvite(invite.secret, claimName);

  const claimHash = ethers.keccak256(ethers.toUtf8Bytes(`${claimName}.hls`));
  eq("the claimed alias is owned by the claimer",
     await controllerContract.ownerOf(BigInt(claimHash)), claimerWallet.address);
  check("the claimer registered without pre-existing funds", beforeClaim === 0n);

  // The note pays the registration fee; the remainder comes back as the claimer's own
  // shielded change.
  await claimer.refresh();
  const afterClaim = (await claimer.balance()).total;
  eq("the invite's remainder lands as the claimer's change",
     ethers.formatEther(afterClaim - beforeClaim),
     ethers.formatEther(ethers.parseEther(inviteAmount) - (await claimer.registrationFee())));

  let replayed = false;
  try { await claimer.claimInvite(invite.secret, `replay${suffix}`); } catch { replayed = true; }
  check("the same invite cannot be claimed twice", replayed);

  // ── consolidation ─────────────────────────────────────────────────────────
  // The circuit takes two inputs, so a balance spread over three or more notes cannot leave
  // in one transaction. A wallet paid more often than it spends reaches that state on its
  // own, and the failure is the worst kind: the money is there, the balance says so, and
  // every attempt to move it is refused. This is the whole path — that it happens, what the
  // client reports while it is stuck, and that consolidate() gets out of it.
  console.log(`\nconsolidation`);

  const fatWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: fatWallet.address, value: ethers.parseEther("5") })).wait();
  const fat = mk(fatWallet as any);
  await fat.init();
  await fat.register(`fat${suffix}`);

  // Four deposits, four notes. Each deposit fills one output slot and pads the other, so
  // this is exactly how an alias that is paid four times ends up.
  for (const a of ["0.1", "0.2", "0.3", "0.4"]) await fat.deposit(a);

  const stuck = await fat.balance();
  eq("four deposits make four notes", stuck.entries.length, 4);
  eq("the balance is the whole 1.0", ethers.formatEther(stuck.total), "1.0");
  // The number a UI has to show. 0.4 + 0.3 are the two largest, and that is the ceiling.
  eq("but only the two largest can move at once",
     ethers.formatEther(stuck.sendableNow), "0.7");
  check("so sendableNow is below the balance", stuck.sendableNow < stuck.total);

  // The error a caller sees while stuck. It must name consolidation: calling the balance
  // insufficient would be false, and sends people looking for money already there.
  let refusal = "";
  try { await fat.send(bobName, "1.0"); } catch (e: any) { refusal = String(e?.message ?? e); }
  check("sending the full balance is refused", refusal.length > 0);
  check("and the refusal names consolidation rather than blaming the balance",
        /consolidate/i.test(refusal) && !/less than/i.test(refusal), refusal);

  // Targeted: merge only as far as needed to unblock this payment, not all the way down.
  const steps: number[] = [];
  const merged = await fat.consolidate(undefined, {
    target: ethers.parseEther("1.0"),
    onProgress: ({ notes }) => steps.push(notes),
  });
  check("consolidating took at least one merge", merged.txHashes.length >= 1,
        `${merged.txHashes.length} merges`);
  check("and reported progress for each", steps.length === merged.txHashes.length);

  const freed = await fat.balance();
  eq("no value was created or destroyed", ethers.formatEther(freed.total), "1.0");
  eq("and the whole balance is now sendable in one transaction",
     ethers.formatEther(freed.sendableNow), "1.0");
  check("with fewer notes than before", freed.entries.length < stuck.entries.length,
        `${stuck.entries.length} -> ${freed.entries.length}`);

  // The point of the exercise: the payment that was refused now goes through.
  // Bob rather than alice: alice's alias has been rotated to another key index by then, so
  // her client no longer holds the keys the registry resolves her name to.
  const bobBeforeFat = (await bob.balance()).total;
  await fat.send(bobName, "1.0");
  await bob.refresh();
  eq("the payment that was blocked now lands",
     ethers.formatEther((await bob.balance()).total - bobBeforeFat), "1.0");
  await fat.refresh();
  eq("and the consolidated wallet is empty", ethers.formatEther((await fat.balance()).total), "0.0");

  // ── sweep ─────────────────────────────────────────────────────────────────
  // Empties an alias's shielded balance to an address and hands the name over in one
  // operation — the exit path for abandoning or selling an alias.
  console.log(`\nsweep and transfer`);
  const sweepDest = ethers.Wallet.createRandom();
  const sweepHeir = ethers.Wallet.createRandom();
  const sweepBefore = await balanceOf(provider, sweepDest.address);
  const bobBalPreSweep = (await bob.balance()).total;

  const sweep = await bob.sweepAndOffer(bobName, sweepDest.address, sweepHeir.address);
  check("sweepAndOffer produced at least one sweep tx", sweep.sweepTxHashes.length > 0,
        `${sweep.sweepTxHashes.length} sweeps`);
  eq("the swept funds reached the destination",
     ethers.formatEther((await balanceOf(provider, sweepDest.address)) - sweepBefore),
     ethers.formatEther(bobBalPreSweep));

  await bob.refresh();
  eq("bob's shielded balance is emptied", ethers.formatEther((await bob.balance()).total), "0.0");
  // Offered, not moved. Sweeping is a courtesy — nothing on chain can prove an alias is
  // empty — and the handover still waits on the recipient's own keys.
  eq("the alias is offered but still bob's until accepted",
     await controllerContract.ownerOf(BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${bobName}.hls`)))),
     bob.ownerAddress);
  eq("with the offer recorded",
     await controllerContract.pendingAliasOwner(ethers.keccak256(ethers.toUtf8Bytes(`${bobName}.hls`))),
     sweepHeir.address);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;

  // Without both of these the process never exits. JsonRpcProvider keeps a poller on the
  // event loop and snarkjs leaves worker threads running, so main() returns, every
  // assertion has printed, and node sits at roughly zero CPU — which reads exactly like a
  // hang partway through. That cost several rounds of misdiagnosis before anyone read the
  // output to the end.
  provider.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n" + (e?.stack ?? e));
  // Same reason as the success path: without an explicit exit the poller and snarkjs
  // workers keep node alive, and a script that has already failed looks like one that is
  // still running.
  process.exit(1);
});
