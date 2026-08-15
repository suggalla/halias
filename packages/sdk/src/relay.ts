import { ethers } from "ethers";
import { buildTransactParams, getPool, getController } from "./contract";

/// Handing a signed withdrawal to someone else to submit.
///
/// A user holding notes but no ETH cannot pay for inclusion. The pool solves this by letting
/// the prover name a relayer and a fee inside `paramsHash` — the pool pays that address out
/// of the withdrawal itself, and a submitter cannot alter either. What was missing was a way
/// to move the transaction from one party to the other.
///
/// **The blob is safe to publish.** The fee goes to the bound relayer no matter who submits,
/// so anyone else who takes it pays gas and receives nothing. There is no incentive to steal
/// it and no way to redirect the payout, which means it can travel over any channel — a
/// message, a QR code, a public board — with no trust in the carrier.

const RELAY_VERSION = 1;

/// A claim is a different call on a different contract, so the blob has to say which.
///
/// `pool.transact(params, enc0, enc1, proof)` settles an ordinary transaction. Redeeming an
/// invite is `domain.claim(registration, params, enc0, enc1, proof, name)` — the domain
/// writes the registry, calls the pool, and is paid by it. Same proof, same fee mechanism,
/// different entry point.
export type RelayKind = "transact" | "claim";

export interface ClaimExtras {
  /// The contract to call. The pool address still pins the proof; this is where it goes.
  domain: string;
  /// Bound into `paramsHash` via `externalData`, which is what stops a submitter minting the
  /// alias to itself — the domain recomputes this hash from its own arguments.
  registration: {
    owner: string;
    aliasHash: string;
    spendingCommitment: string;
    nullifierKeyHash: string;
    encryptionPubkey: string;
  };
  /// Published alongside the registration, or "" to keep the name private.
  name: string;
}

export interface RelayPayload {
  v: number;
  kind: RelayKind;
  /// Both pin the blob to one deployment. A proof commits to the chain id and the pool
  /// address inside `paramsHash`, so a blob presented elsewhere simply fails to verify —
  /// but failing early with a clear reason beats a relayer paying gas to discover it.
  chainId: number;
  pool: string;
  params: ReturnType<typeof buildTransactParams>;
  encryptedOutput0: string;
  encryptedOutput1: string;
  proof: string;
  /// Present only when `kind` is "claim".
  claim?: ClaimExtras;
  /// Unix seconds at which this blob was built.
  ///
  /// A blob is a proof against a registry root, and a superseded root stays acceptable for
  /// REGISTRY_ROOT_MAX_AGE. That window is also how long an alias's *old* keys remain
  /// payable after it changes hands — so a blob prepared before a handover and submitted
  /// after it pays the previous owner, while the sender's client says otherwise (F8).
  ///
  /// Interactive sends are exposed only for the seconds between proving and inclusion. A
  /// prepared blob is the case that can sit around, so it carries its age and is refused
  /// once it is close to the window. Cheap, and it targets the actual trigger — the precise
  /// alternative is scanning for an AliasReassigned against every recipient.
  builtAt?: number;
}

/// How stale a prepared blob may be before {quoteRelay} refuses it.
///
/// Deliberately under the contract's REGISTRY_ROOT_MAX_AGE rather than equal to it: a blob
/// that is inside the window when quoted but outside it when mined wastes the submitter's
/// gas, and the margin covers inclusion.
const RELAY_MAX_AGE_SECONDS = 45 * 60;

export function encodeRelayBlob(p: RelayPayload): string {
  if (p.builtAt === undefined) p = { ...p, builtAt: Math.floor(Date.now() / 1000) };
  return Buffer.from(
    JSON.stringify(p, (_, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)),
  ).toString("base64");
}

export function decodeRelayBlob(blob: string): RelayPayload {
  const raw = JSON.parse(Buffer.from(blob.trim(), "base64").toString("utf-8"));
  if (raw?.v !== RELAY_VERSION) throw new Error(`Unsupported relay blob version ${raw?.v}`);
  if (raw.kind !== "transact" && raw.kind !== "claim")
    throw new Error(`Unknown relay kind ${raw?.kind}`);
  if (raw.kind === "claim" && !raw.claim?.domain)
    throw new Error("Claim blob is missing its registration");
  // Only the fields the encoder turned into hex because they were bigints come back. The
  // address-typed members — `recipient`, `relayerFee.relayer`, and `tokenAddress` — survive
  // JSON as the strings they already were, and reviving one into a bigint would hand ethers
  // the wrong type for an `address` parameter.
  const big = (x: any) => (typeof x === "string" && x.startsWith("0x") ? BigInt(x) : x);
  raw.params.publicAmount = big(raw.params.publicAmount);
  raw.params.relayerFee.amount = big(raw.params.relayerFee.amount);
  return raw as RelayPayload;
}

export interface RelayQuote {
  /// Whether the transaction would succeed right now.
  valid: boolean;
  /// Why not, when it would not — a spent nullifier, an unknown root, a bad proof.
  reason: string | null;
  /// What the pool pays the relayer. Fixed by the proof; this is not a quote that can move.
  fee: bigint;
  gasEstimate: bigint;
  gasPrice: bigint;
  gasCost: bigint;
  /// What the fee is denominated in. `0x0…0` is ETH.
  ///
  /// A relayer is paid out of the note, so the fee is in whatever the note holds — while the
  /// gas it spends is always ETH. Carrying this is what lets a caller label the amounts
  /// correctly instead of assuming, and what makes `profit` below refusable rather than wrong.
  tokenAddress: string;
  /// fee - gasCost. Negative means submitting costs more than it pays.
  ///
  /// **Null when the fee is not in ETH.** Then the two sides are different assets and there is
  /// no exchange rate here to bridge them; returning a bigint would be subtracting wei from
  /// token base units and reporting the result as money. A caller that needs the comparison
  /// has to price the token itself.
  profit: bigint | null;
  relayer: string;
  recipient: string;
  /// Total leaving the pool; the recipient receives this minus the fee.
  withdrawing: bigint;
  /// A relayed transfer moves value between two aliases and pays the fee out of the pool,
  /// so nothing else leaves and `recipient` is the zero address. A claim registers an alias
  /// and is paid out of the invite note it spends.
  kind: "withdrawal" | "transfer" | "claim";
}

/// What submitting this blob would do and cost, right now.
///
/// Two separate questions, and they fail differently. *Will it succeed* is answered by
/// simulating — that catches a spent nullifier, a root the pool has forgotten, a malformed
/// proof, all of which would otherwise burn gas on a revert. *Is it worth submitting* is
/// arithmetic against the current gas price, and has to be re-asked at submit time because
/// the fee is fixed while gas is not.
export async function quoteRelay(
  provider: ethers.Provider,
  payload: RelayPayload,
  submitter: string,
): Promise<RelayQuote> {
  const fee = BigInt(payload.params.relayerFee.amount);
  const { contract, method, args } = bind(payload, provider);

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;

  let valid = true;
  let reason: string | null = null;
  let gasEstimate = 0n;

  // Age is checked separately from simulation, because a stale blob still simulates
  // cleanly: the root it proves against is inside the contract's window, so the call would
  // succeed. Simulation cannot tell anyone the recipient's keys changed underneath it.
  const age = payload.builtAt === undefined ? 0 : Math.floor(Date.now() / 1000) - payload.builtAt;
  const stale = age > RELAY_MAX_AGE_SECONDS;
  if (stale) {
    valid = false;
    reason = `Prepared ${Math.floor(age / 60)} minutes ago — rebuild it. A proof this old `
           + `can still be accepted on chain, and would pay keys the recipient may since `
           + `have replaced.`;
  }

  try {
    if (stale) throw new Error("stale");
    // `from` matters: the estimate must reflect the account that will actually send.
    // Estimated straight off the node, not through ethers' view of the chain.
    //
    // ethers resolves reads against a block number it updates by polling, and `tx.wait()`
    // does not advance it — measured one block behind on a local node. A quote taken just
    // after someone else's submission landed therefore estimates against a state where the
    // nullifier is still unspent and reports "would succeed", which is precisely the answer
    // quoting exists to prevent: the relayer pays gas to discover a dead blob.
    const req = await contract[method].populateTransaction(...args);
    const raw = (provider as { send?: (m: string, p: unknown[]) => Promise<string> }).send;
    gasEstimate = raw
      ? BigInt(await raw.call(provider, "eth_estimateGas",
          [{ ...req, from: submitter, value: "0x0" }, "latest"]))
      // Not every Provider exposes a raw channel (a browser wallet's, for instance). Fall
      // back to ethers' own path, which is correct but may lag by a block.
      : await contract[method].estimateGas(...args, { from: submitter });
  } catch (e: any) {
    if (!stale) {
      valid = false;
      reason = e?.shortMessage ?? e?.reason ?? e?.message ?? "would revert";
    }
  }

  const gasCost = gasEstimate * gasPrice;
  const tokenAddress = payload.params.tokenAddress;
  const feeIsEth = BigInt(tokenAddress) === 0n;
  return {
    valid,
    reason,
    fee,
    gasEstimate,
    gasPrice,
    gasCost,
    tokenAddress,
    // Only when both sides are ETH. Subtracting a gas cost in wei from a fee in USDC base
    // units produces a number, and every use of that number would be wrong.
    profit: feeIsEth ? fee - gasCost : null,
    relayer: payload.params.relayerFee.relayer,
    recipient: payload.params.recipient,
    withdrawing: absoluteAmount(BigInt(payload.params.publicAmount)),
    // A relayed transfer names no public recipient — the only thing leaving the pool is the
    // fee itself. Worth distinguishing, because "withdrawing 0.01 to 0x000…0" describes it
    // accurately and explains it not at all.
    kind:
      payload.kind === "claim"
        ? "claim"
        : payload.params.recipient === ethers.ZeroAddress
          ? "transfer"
          : "withdrawal",
  };
}

/// What an ordinary `transact` costs.
///
/// Measured against the real verifier: deposit 1,482,757, transfer 1,460,515 — a spread under
/// 2%. The work is fixed regardless of what the call is doing or what the amounts are, which
/// is why a single constant works at all.
///
/// Still dominated by the pool tree rather than the proof: the insertion is 16 Poseidon hashes
/// at ~58,430 gas each — about 63% of the total — against ~250,000 for Groth16 verification.
/// It was 32 hashes and ~2.52M before the pool became a sequence of shallow trees; the 41%
/// saving is larger than the hashing alone because the tree's storage reads and writes scale
/// with depth too.
///
/// Sitting above the observed maximum with margin for the paths not measured here (ERC-20
/// moves a token, a claim writes the registry and pays the domain).
export const TRANSACT_GAS = 1_600_000n;

/// What an exit costs — a transact that spends its inputs and inserts nothing.
///
/// It skips the tree walk entirely, which is where a transact's gas actually goes. Measured at
/// 365,543 against the 32-level tree; the walk it skips is now half as long, so the saving is
/// smaller in relative terms but the figure itself barely moves — what remains is Groth16
/// verification plus two nullifier writes, neither of which depends on tree depth.
export const EXIT_GAS = 400_000n;


/// Suggest a fee before the proof exists.
///
/// This looks circular — the fee is committed inside `paramsHash`, so it has to be chosen
/// before the proof, but a real `estimateGas` needs the proof. It is not, because the fee is
/// not an input to what the call costs: gas is fixed work plus one payout, and TRANSACT_GAS
/// captures it. So the price of inclusion is knowable up front, and only the margin on top
/// is a matter of negotiation.
///
/// `marginPct` is what the submitter earns above cost. Zero is a fee that exactly reimburses
/// gas — enough for another wallet of your own, not enough for a stranger.
///
/// `exit` selects the cheap path, which costs about a seventh of an ordinary transact. It has
/// to be passed rather than inferred, because at the point a fee is chosen the proof does not
/// exist yet and nothing else reveals which shape the transaction will take.
export async function suggestRelayFee(
  provider: ethers.Provider,
  opts: { marginPct?: number; exit?: boolean } = {},
): Promise<{ gasEstimate: bigint; gasPrice: bigint; gasCost: bigint; suggested: bigint }> {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const estimate = opts.exit ? EXIT_GAS : TRANSACT_GAS;
  const gasCost = estimate * gasPrice;
  const margin = BigInt(Math.max(0, Math.round(opts.marginPct ?? 20)));
  return {
    gasEstimate: estimate,
    gasPrice,
    gasCost,
    suggested: (gasCost * (100n + margin)) / 100n,
  };
}

/// Submit someone else's prepared withdrawal.
///
/// `minProfit` is the guard that makes this safe to automate: the quote is taken again
/// immediately before sending, so a gas spike between deciding and submitting cannot turn a
/// profitable relay into a loss.
export async function submitRelay(
  signer: ethers.Signer,
  payload: RelayPayload,
  // `null` means "I have priced this myself" — the only way to submit a fee denominated in a
  // token, since nothing here can compare one to a gas cost.
  opts: { minProfit?: bigint | null } = {},
): Promise<{ txHash: string; quote: RelayQuote }> {
  const from = await signer.getAddress();
  const quote = await quoteRelay(signer.provider!, payload, from);

  if (!quote.valid) throw new Error(`Will not succeed: ${quote.reason}`);

  // The profit guard only means anything when the fee and the gas are the same asset. For a
  // token fee `profit` is null, and the choice is between refusing and submitting blind —
  // refuse, because the caller who knows what the token is worth can pass `minProfit: null` to
  // say so deliberately. Silently skipping the check is how an automated relayer ends up
  // paying to move someone else's money.
  if (quote.profit === null) {
    if (opts.minProfit !== null) {
      throw new Error(
        `This fee is paid in ${quote.tokenAddress}, not ETH, so it cannot be compared against ` +
        `a gas cost here. Price it yourself and pass minProfit: null to submit anyway.`,
      );
    }
  } else {
    const floor = opts.minProfit ?? 0n;
    if (quote.profit < floor)
      throw new Error(
        `Fee ${ethers.formatEther(quote.fee)} does not cover gas ` +
          `${ethers.formatEther(quote.gasCost)} (shortfall ${ethers.formatEther(-quote.profit)} ETH)`,
      );
  }

  const { contract, method, args } = bind(payload, signer);
  const tx = await contract[method](...args);
  const receipt = await tx.wait();
  return { txHash: receipt!.hash, quote };
}

/// The single place that knows how each kind is called. Quoting and submitting must agree
/// exactly — an estimate against one entry point and a send against another would price the
/// wrong transaction.
function bind(payload: RelayPayload, runner: ethers.ContractRunner) {
  if (payload.kind === "claim") {
    const c = payload.claim!;
    return {
      contract: getController(c.domain, runner),
      method: "claim",
      args: [
        c.registration, payload.params,
        payload.encryptedOutput0, payload.encryptedOutput1, payload.proof, c.name,
      ] as const,
    };
  }
  return {
    contract: getPool(payload.pool, runner),
    method: "transact",
    args: [
      payload.params, payload.encryptedOutput0, payload.encryptedOutput1, payload.proof,
    ] as const,
  };
}

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_ABS = 1n << 248n;

/// `publicAmount` is signed in the field: positive is a deposit, `p - x` a withdrawal.
function absoluteAmount(publicAmount: bigint): bigint {
  return publicAmount >= FIELD_PRIME - MAX_ABS ? FIELD_PRIME - publicAmount : publicAmount;
}
