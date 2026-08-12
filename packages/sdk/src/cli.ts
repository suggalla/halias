#!/usr/bin/env node

import path from "path";
import * as dotenv from "dotenv";
import { normalizeAlias } from "./alias";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

// ── Output helpers ────────────────────────────────────────────────────────────

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";

let jsonMode = false;

function field(key: string, value: string) {
  if (jsonMode) return;
  const pad = 12;
  process.stdout.write(`  ${key.padEnd(pad)}${value}\n`);
}

function ok(msg: string) {
  if (jsonMode) return;
  process.stdout.write(`${GREEN}${msg}${RESET}\n`);
}

function dim(msg: string) {
  if (jsonMode) return;
  process.stdout.write(`${DIM}${msg}${RESET}\n`);
}

function outputJson(data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(data, (_, v) =>
    typeof v === "bigint" ? v.toString() : v, 2) + "\n");
}

// Inline spinner for proof generation
async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (jsonMode) return fn();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const start = Date.now();
  process.stdout.write(`  ${label}  `);
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${label}  ${frames[i++ % frames.length]}`);
  }, 80);
  try {
    const result = await fn();
    clearInterval(timer);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${label}  done ${DIM}(${elapsed}s)${RESET}\n`);
    return result;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r  ${label}  ${RED}failed${RESET}\n`);
    throw e;
  }
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { args: string[]; flags: Record<string, string | true> } {
  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      args.push(argv[i]);
    }
  }
  return { args, flags };
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stdout.write(`halias — private payments with trust

USAGE
  halias <command> [args] [flags]

COMMANDS
  register <alias>                       Register a .hls alias
  deposit  <amount>                      Deposit ETH into pool
  send     <alias.hls> <amount>          Private transfer to alias
  withdraw <address>  <amount>           Withdraw to address
  balance                                Show pool balance
  scan                                   Show all received notes
  lookup   <alias.hls>                   Lookup alias info
  invite   create <amount>               Create a funded invite link for a new user
  invite   claim <code> <alias>          Claim an invite and register your alias

FLAGS
  --token <address>    ERC-20 token address (default: ETH)
  --relayer <addr>     Pay a third party to broadcast (with --relayer-fee)\n  --relayer-fee <eth>  Fee paid to the relayer out of the note
  --json               Output JSON

ENVIRONMENT
  PRIVATE_KEY          Wallet private key (required)
  RPC_URL              RPC endpoint
  CHAIN_ID             Chain ID (default: 11155111 / Sepolia)
`);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  const { ethers } = await import("ethers");
  const { Halias }  = await import("./halias");
  const { FileCache } = await import("./cache");
  const { getNetwork, getPoolAddress, getRegistryAddress, getDomainAddress, getStartBlock } =
    await import("halias-deployments");

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) {
    process.stderr.write("Error: PRIVATE_KEY environment variable required\n");
    process.exit(1);
  }

  const CHAIN_ID = parseInt(process.env.CHAIN_ID || "11155111");
  const RPC_URL  = process.env.RPC_URL;
  const CACHE_DIR = process.env.HALIAS_CACHE_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".halias", "cache");

  const protocolDir = path.dirname(require.resolve("halias-protocol/package.json"));
  const out = path.join(protocolDir, "circuits", "out", "transact");

  const network  = getNetwork(CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC_URL || network.rpcUrl);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);

  const halias = new Halias({
    provider,
    signer,
    chainId: CHAIN_ID,
    poolAddress:     getPoolAddress(CHAIN_ID),
    registryAddress: getRegistryAddress(CHAIN_ID),
    domainAddress:   getDomainAddress(CHAIN_ID),
    startBlock: getStartBlock(CHAIN_ID),
    artifacts: {
      transactWasm: path.join(out, "transact_js", "transact.wasm"),
      transactZkey: path.join(out, "ceremony", "transact_final.zkey"),
    },
    cache: new FileCache(CACHE_DIR),
  });

  await halias.init();
  return { halias, ethers };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw = process.argv.slice(2);
  const { args, flags } = parseArgs(raw);

  jsonMode = !!flags["json"];

  const [command, sub] = args;

  if (!command || command === "help" || command === "--help" || flags["help"]) {
    usage();
    return;
  }

  const KNOWN = ["register", "deposit", "send", "withdraw", "balance", "scan", "lookup", "invite", "keys"];
  if (!KNOWN.includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n`);
    usage();
    process.exit(1);
  }

  const { halias, ethers } = await bootstrap();

  const tokenAddress = flags["token"]
    ? BigInt(flags["token"] as string)
    : 0n;

  const tokenLabel = tokenAddress === 0n
    ? "ETH"
    : `ERC-20 (${flags["token"]})`;

  // ── register ─────────────────────────────────────────────────────────────

  if (command === "register") {
    const alias = args[1];
    if (!alias) { process.stderr.write("Usage: halias register <alias.hls>\n"); process.exit(1); }
    const clean = normalizeAlias(alias);
    if (!/^[a-z0-9]+$/.test(clean)) { process.stderr.write("Error: alias must be lowercase alphanumeric\n"); process.exit(1); }

    dim("Registering...");
    const result = await halias.register(`${clean}.hls`);

    if (jsonMode) { outputJson({ alias: `${clean}.hls`, txHash: result.txHash }); return; }
    ok(`Registered ${clean}.hls`);
    field("tx", result.txHash);
    return;
  }

  // ── deposit ───────────────────────────────────────────────────────────────

  if (command === "deposit") {
    const amount = args[1];
    if (!amount) { process.stderr.write("Usage: halias deposit <amount> [--token <addr>]\n"); process.exit(1); }

    const result = await withSpinner("Generating proof", () => halias.deposit(amount, tokenAddress));

    if (jsonMode) { outputJson({ amount: ethers.formatEther(result.amount), token: tokenLabel, txHash: result.txHash }); return; }
    ok(`Deposited ${amount} ${tokenLabel}`);
    field("tx", result.txHash);
    return;
  }

  // ── send ──────────────────────────────────────────────────────────────────

  if (command === "send") {
    const to     = args[1];
    const amount = args[2];
    if (!to || !amount) { process.stderr.write("Usage: halias send <alias.hls> <amount> [--token <addr>]\n"); process.exit(1); }

    const result = await withSpinner("Generating proof", () => halias.send(to, amount, tokenAddress));

    if (jsonMode) { outputJson({ to, amount, token: tokenLabel, txHash: result.txHash }); return; }
    ok(`Sent ${amount} ${tokenLabel} to ${to}`);
    field("tx", result.txHash);
    return;
  }

  // ── withdraw ──────────────────────────────────────────────────────────────

  if (command === "withdraw") {
    const address = args[1];
    const amount  = args[2];
    if (!address || !amount) { process.stderr.write("Usage: halias withdraw <address> <amount> [--token <addr>]\n"); process.exit(1); }

    const result = await withSpinner("Generating proof", () => halias.withdraw(address, amount, tokenAddress));

    if (jsonMode) { outputJson({ recipient: result.recipient, amount, token: tokenLabel, txHash: result.txHash }); return; }
    ok(`Withdrew ${amount} ${tokenLabel} to ${result.recipient}`);
    field("tx", result.txHash);
    return;
  }

  // ── balance ───────────────────────────────────────────────────────────────

  if (command === "balance") {
    const result = await halias.balance(tokenAddress);

    if (jsonMode) {
      outputJson({
        total: ethers.formatEther(result.total),
        token: tokenLabel,
        notes: result.entries.map(e => ({ leafIndex: e.leafIndex, amount: ethers.formatEther(e.amount) })),
      });
      return;
    }

    if (result.entries.length === 0) { process.stdout.write(`  No balance.\n`); return; }
    field("total", `${ethers.formatEther(result.total)} ${tokenLabel}`);
    field("notes", String(result.entries.length));
    process.stdout.write("\n");
    for (const e of result.entries) {
      process.stdout.write(`  #${e.leafIndex}`.padEnd(10) + `${ethers.formatEther(e.amount)} ${tokenLabel}\n`);
    }
    return;
  }

  // ── scan ──────────────────────────────────────────────────────────────────

  if (command === "scan") {
    const entries = await halias.scan(tokenAddress);

    if (jsonMode) {
      outputJson({
        token: tokenLabel,
        notes: entries.map(e => ({
          leafIndex: e.leafIndex,
          amount: ethers.formatEther(e.amount),
          spent: e.spent,
        })),
      });
      return;
    }

    if (entries.length === 0) { process.stdout.write("  No notes found.\n"); return; }
    const unspent = entries.filter(e => !e.spent);
    const spent   = entries.filter(e => e.spent);
    field("received", String(entries.length));
    field("unspent",  String(unspent.length));
    field("spent",    String(spent.length));
    process.stdout.write("\n");
    for (const e of entries) {
      const status = e.spent ? `${DIM}spent${RESET}` : `${GREEN}unspent${RESET}`;
      process.stdout.write(`  #${e.leafIndex}`.padEnd(10) + `${ethers.formatEther(e.amount).padEnd(14)} ${tokenLabel}  ${status}\n`);
    }
    return;
  }

  // ── lookup ────────────────────────────────────────────────────────────────

  if (command === "lookup") {
    const alias = args[1];
    if (!alias) { process.stderr.write("Usage: halias lookup <alias.hls>\n"); process.exit(1); }

    const result = await halias.lookup(alias);
    const clean  = normalizeAlias(alias);

    if (jsonMode) {
      outputJson({
        alias: `${clean}.hls`,
        attested: result.dataHash !== 0n,
        dataHash: result.dataHash.toString(),
        spendingPubkey: result.spendingPubkey.toString(),
        encryptionPubkey: ethers.hexlify(result.encryptionPubkey),
      });
      return;
    }

    process.stdout.write(`  ${clean}.hls\n\n`);
    field("attested", result.dataHash !== 0n ? `${GREEN}yes${RESET}` : `${DIM}no${RESET}`);
    if (result.dataHash !== 0n) field("dataHash", result.dataHash.toString(16).slice(0, 16) + "…");
    return;
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  if (command === "keys") {
    // Print this account's public keys (shareable identifiers, not secrets)
    const keys = (halias as any).keys;
    const { ethers: e2 } = await import("ethers");
    const encPubkey = e2.hexlify(keys.encryption.publicKey);
    if (jsonMode) { outputJson({ spendingPubkey: keys.spendingPubkey.toString(), encryptionPubkey: encPubkey }); return; }
    field("spendingPubkey",   keys.spendingPubkey.toString(16).slice(0, 16) + "…");
    field("encryptionPubkey", encPubkey);
    return;
  }

  // ── invite ────────────────────────────────────────────────────────────────

  if (command === "invite") {
    if (sub === "create") {
      const amount = args[2];
      if (!amount) {
        process.stderr.write("Usage: halias invite create <amount-eth>\n");
        process.exit(1);
      }

      const result = await withSpinner("Registering invite account + funding note", () =>
        halias.createInvite(amount)
      );

      if (jsonMode) { outputJson({ inviteCode: result.inviteCode, amount: ethers.formatEther(result.amount), txHash: result.txHash }); return; }
      ok(`Invite created for ${ethers.formatEther(result.amount)} ETH`);
      field("code", result.inviteCode);
      field("tx",   result.txHash);
      process.stdout.write(`\n${DIM}  Send this code to the recipient. Anyone holding it can claim${RESET}\n`);
      process.stdout.write(`${DIM}  the funds, so share it over a private channel.${RESET}\n`);
      process.stdout.write(`${DIM}  You can reclaim it until they do — the secret is yours too.${RESET}\n`);
      return;
    }

    if (sub === "claim") {
      const code  = args[2];
      const alias = args[3];
      if (!code || !alias) {
        process.stderr.write("Usage: halias invite claim <invite-code> <alias.hls>\n");
        process.exit(1);
      }

      const { decodeInviteCode } = await import("./invite");
      const secret = decodeInviteCode(code);

      // A relayer fee lets a third party broadcast this when the claimer holds no ETH.
      const relayerFee  = flags["relayer-fee"] ? ethers.parseEther(flags["relayer-fee"] as string) : 0n;
      const relayerAddr = (flags["relayer"] as string) || undefined;

      const result = await withSpinner("Generating proof + registering", () =>
        halias.claimInvite(secret, alias, { relayerFee, relayer: relayerAddr })
      );

      if (jsonMode) { outputJson({ alias, txHash: result.txHash }); return; }
      ok(`Claimed invite and registered ${alias}`);
      field("tx", result.txHash);
      return;
    }

    process.stderr.write("Usage: halias invite <create|claim> ...\n");
    process.exit(1);
  }
}

main().catch((err) => {
  if (jsonMode) {
    outputJson({ error: err.message || String(err) });
  } else {
    process.stderr.write(`${RED}Error:${RESET} ${err.message || err}\n`);
  }
  process.exit(1);
});
