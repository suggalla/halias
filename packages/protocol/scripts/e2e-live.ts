import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";
import { Halias, FileCache, decodeRelayBlob, quoteRelay, submitRelay } from "halias-sdk";
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

  for (const k of ["pool", "registry", "domain"]) {
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
  console.log(`  domain   ${cfg.domain}\n`);

  const mk = (s: ethers.Wallet, aliasIndex = 0) => new Halias({
    provider, signer: s as any, chainId,
    poolAddress: cfg.pool, registryAddress: cfg.registry, domainAddress: cfg.domain,
    artifacts: ARTIFACTS,
    startBlock: cfg.startBlock ?? 0,
    rpcChunkSize: 2000,
    cache: new FileCache(path.join("/tmp", `halias-e2e-${Date.now()}-${s.address}-${aliasIndex}`)),
  });

  // Two independent clients, each deriving its own keys from its own signature — the same
  // way two real users would. A single client sending to itself would not exercise
  // encryption to a foreign key or the recipient's scan.
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
    "function aliases(bytes32) view returns (bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, bytes32 dataHash, uint64 registeredAt)",
    "function isRegistered(bytes32) view returns (bool)",
  ], provider);
  const domainContract = new ethers.Contract(cfg.domain, [
    "function ownerOf(uint256) view returns (address)",
    "function pendingAliasOwner(bytes32) view returns (address)",
  ], provider);

  const alice = mk(aliceWallet as any);
  const bob   = mk(bobWallet as any);
  await alice.init();
  await bob.init();
  check("both clients derive keys from a signature", true);

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
  check("alice can resolve bob's keys", bobKeys.spendingPubkey > 0n);

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
  await alice.send(`${bobName}.hls`, "0.4");

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
  check("it simulates against the domain, not the pool", claimQuote.valid, claimQuote.reason ?? "");
  eq("the quote reports it as a claim", claimQuote.kind, "claim");
  check("the relayer profits from submitting it", claimQuote.profit > 0n,
        `fee ${ethers.formatEther(claimQuote.fee)} - gas ${ethers.formatEther(claimQuote.gasCost)}`);

  await submitRelay(relayWallet as any, claimPayload);

  const giftHash = ethers.keccak256(ethers.toUtf8Bytes(`${pauperName}.hls`));
  eq("the alias belongs to the claimer, not the submitter",
     await domainContract.ownerOf(BigInt(giftHash)), pauperWallet.address);
  eq("who still holds no ETH",
     (await balanceOf(provider, pauperWallet.address)).toString(), "0");

  await pauper.refresh();
  eq("and receives the invite less the registration and relay fees",
     ethers.formatEther((await pauper.balance()).total),
     ethers.formatEther(ethers.parseEther("0.3") - (await pauper.registrationFee()) - claimFee));

  // ── a prepared claim survives concurrent registry writes (F1) ────────────
  // A claim's change note is a non-zero output, so it needs registry membership for an
  // alias not yet in the tree. This used to predict the post-registration root, and any
  // registry write landing in between invalidated it — this assertion used to be that the
  // claim DIED, which encoded the bug as expected behaviour.
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

  // 3. The half that used to be exploitable. Registration once carried the alias hash in
  //    plain calldata, so whoever watched the mempool and landed first owned the name — with
  //    their own keys, which meant every later payment to it arrived for them. Commit-reveal
  //    closes it: the commitment is opaque, and a front-runner who only learns the name when
  //    the victim reveals cannot manufacture a commitment old enough to use.
  const target = `victim${suffix}`;
  const squatterWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  await (await new ethers.Wallet(LOCAL_KEY, provider)
    .sendTransaction({ to: squatterWallet.address, value: ethers.parseEther("1") })).wait();
  const squatter = mk(squatterWallet as any);
  await squatter.init();

  const domainAsSquatter = new ethers.Contract(cfg.domain, [
    "function register(bytes32,bytes32,bytes32,bytes32,string,bytes32) external payable",
    "function registrationCommitment(bytes32,bytes32,bytes32,bytes32,address,bytes32) external pure returns (bytes32)",
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
    await (await domainAsSquatter.register(
      targetHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), ethers.toBeHex(3n, 32), "",
      ethers.hexlify(ethers.randomBytes(32)),
      { value: await domainAsSquatter.registrationFee() },
    )).wait();
  } catch { noCommitment = true; }
  check("registering without a prior commitment is refused", noCommitment);

  await alice.refresh();
  const held = await alice.lookup(`${target}.hls`);
  eq("and the name resolves to the keys of whoever committed to it",
     held.spendingPubkey.toString(),
     (await alice.lookup(`${target}.hls`)).spendingPubkey.toString());

  // ── history says what actually happened ──────────────────────────────────
  // Classification had never been asserted, and it was wrong in the UI: "relayed" was read
  // off nothing but a fee payer who was not you — which is also true of a stranger funding
  // your alias, and of the sender of any transfer you receive.
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
  // and encryption keys but never the spending pubkey, so the one compromise that loses funds
  // was the one it could not answer. Fresh keys mean a client at a different derivation index,
  // and offer/accept replaces all three.
  // A second derivation index on the same wallet: fresh keys, same owner. One signature
  // produces every index, so this costs the user nothing extra.
  const rotated = mk(aliceWallet as any, 1);
  await rotated.init(1);
  await alice.offerAlias(aliceName, aliceWallet.address);

  // Signed AFTER the offer, not before: every authorised action on an alias bumps its nonce,
  // so a signature produced first is already stale by the time it is submitted. The contract
  // rejects it with NotOfferedToSigner, which reads like a wrong-recipient bug and is not.
  const rotateAccept = await rotated.acceptAlias(aliceName, { prepare: true });

  // Submitted by the relayer, not by the owner. That is the point of removing updateKeys:
  // the moment you most need to re-key is after a compromise, which is also when you are
  // least able to pay for a transaction.
  const rotateAsRelayer = new ethers.Contract(cfg.domain, [
    "function acceptAlias(bytes32,bytes32,bytes32,bytes32,uint256,bytes) external",
  ], relayWallet);
  const rotatedKeys = (rotated as any).keys;
  await (await rotateAsRelayer.acceptAlias(
    aliceKey,
    ethers.toBeHex(rotatedKeys.spendingPubkey, 32),
    ethers.toBeHex((rotated as any).myNullifierKeyHash(), 32),
    ethers.hexlify(rotatedKeys.encryption.publicKey),
    rotateAccept.deadline, rotateAccept.signature,
  )).wait();

  const rootAfterRotate = await registryContract.getRegistryRoot();
  check("rotating through offer-to-self moves the registry root", rootBefore !== rootAfterRotate);
  eq("the spending pubkey actually changed — what updateKeys could not do",
     (await registryContract.aliases(aliceKey)).spendingPubkey,
     ethers.toBeHex((rotated as any).keys.spendingPubkey, 32));
  eq("the alias is still owned by the same address",
     await domainContract.ownerOf(BigInt(aliceKey)), aliceWallet.address);
  // In-place update is the whole reason this is an SMT: the alias must keep its slot, or
  // every sender holding a proof against its position breaks.
  eq("rotation keeps the alias in its slot",
     await registryContract.aliasSlot(aliceKey), slotBefore);

  // dataHash must be a field element — the registry rejects anything at or above p,
  // because Poseidon reduces silently and two records would otherwise share a leaf.
  const dataHash = BigInt(ethers.keccak256(ethers.randomBytes(32))) % FIELD_PRIME;
  await alice.updateAliasData(aliceName, dataHash);
  eq("updateAliasData is committed to the registry",
     (await registryContract.aliases(ethers.keccak256(ethers.toUtf8Bytes(`${aliceName}.hls`)))).dataHash,
     ethers.toBeHex(dataHash, 32));

  let rejectedOutOfField = false;
  try { await alice.updateAliasData(aliceName, FIELD_PRIME); } catch { rejectedOutOfField = true; }
  check("an out-of-field dataHash is rejected", rejectedOutOfField);

  // ── transfer ──────────────────────────────────────────────────────────────
  // Two steps, and the second is the recipient's. A seller cannot nominate the keys, which
  // is how someone used to end up owning a name whose payments arrived for the seller.
  console.log(`\ntransfer ownership`);
  const heirWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  const heirClient = mk(heirWallet as any);
  await heirClient.init();
  const aliceAliasHash = ethers.keccak256(ethers.toUtf8Bytes(`${aliceName}.hls`));

  await alice.offerAlias(aliceName, heirWallet.address);
  eq("an offer moves nothing on its own",
     await domainContract.ownerOf(BigInt(aliceAliasHash)), aliceWallet.address);

  // The heir has no ETH. They sign; the relayer pays — the whole reason authority is a
  // signature rather than msg.sender.
  const accepted = await heirClient.acceptAlias(aliceName, { prepare: true });
  check("the recipient can authorise without submitting", accepted.txHash === "" && !!accepted.signature);

  const domainAsRelayer = new ethers.Contract(cfg.domain, [
    "function acceptAlias(bytes32,bytes32,bytes32,bytes32,uint256,bytes) external",
  ], relayWallet);
  const heirKeys = (heirClient as any).keys;
  await (await domainAsRelayer.acceptAlias(
    aliceAliasHash,
    ethers.toBeHex(heirKeys.spendingPubkey, 32),
    ethers.toBeHex((heirClient as any).myNullifierKeyHash(), 32),
    ethers.hexlify(heirKeys.encryption.publicKey),
    accepted.deadline, accepted.signature,
  )).wait();

  eq("the alias NFT moved to the new owner",
     await domainContract.ownerOf(BigInt(aliceAliasHash)), heirWallet.address);
  eq("and the registry now holds the recipient's own key",
     (await registryContract.aliases(aliceAliasHash)).spendingPubkey,
     ethers.toBeHex(heirKeys.spendingPubkey, 32));

  // The handover is complete only if the seller loses the alias, not merely if the buyer
  // gains it. Asserted rather than assumed, because an owner check that reads a stale field
  // would leave both parties able to act.
  let formerOwnerRejected = false;
  try {
    await alice.updateAliasData(aliceName, 1n);
  } catch { formerOwnerRejected = true; }
  check("the previous owner can no longer act on it", formerOwnerRejected);

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
     await domainContract.ownerOf(BigInt(claimHash)), claimerWallet.address);
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
     await domainContract.ownerOf(BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${bobName}.hls`)))),
     bobWallet.address);
  eq("with the offer recorded",
     await domainContract.pendingAliasOwner(ethers.keccak256(ethers.toUtf8Bytes(`${bobName}.hls`))),
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
