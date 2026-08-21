import { ethers } from "ethers";
import { FIELD_PRIME } from "./entry";


// The pool, the registry and the domain are three separate contracts.
//
// The shapes below are load-bearing in a way ordinary ABI fragments are not:
// `TransactParams` is hashed into `paramsHash`, a public signal the circuit constrains, so a
// field in the wrong order or the wrong type does not produce a decoding error — it produces
// a proof the pool rejects, with nothing to say why. SdkPreimage.test.ts pins the hash itself
// against the contract's own computeParamsHash, and compares every fragment against the
// compiled artifacts.

// TransactParams, as the pool declares it. Every member is fixed-size, so the struct is
// statically encoded — `relayerFee` is a two-member static struct, which preserves that.
const TRANSACT_PARAMS =
  "(bytes32[4] poolRoot, uint32[4] treeNumber, bytes32 registryRoot, uint256 publicAmount, address tokenAddress, " +
  "bytes32[4] inputNullifiers, bytes32[2] outputCommitments, address recipient, " +
  "(address relayer, uint256 amount) relayerFee, bytes32 externalData, bytes32 pendingLeaf, " +
  "bool outputsEmpty)";

const REGISTRATION =
  "(address owner, bytes32 aliasHash, bytes32 spendingCommitment, bytes32 nullifierKeyHash, " +
  "bytes32 encryptionPubkey)";

export const POOL_ABI = [
  // Deposit (publicAmount > 0), transfer (= 0), withdraw (field-negative).
  `function transact(${TRANSACT_PARAMS} p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof) external payable`,
  `function computeParamsHash(${TRANSACT_PARAMS} p, bytes encryptedOutput0, bytes encryptedOutput1) external view returns (uint256)`,
  "function spentNullifiers(bytes32) external view returns (bool)",
  "function poolTokenBalance(address) external view returns (uint256)",
  "function registry() external view returns (address)",
  // The pool is a sequence of trees, so an anchor is a (root, tree) pair and must be read as
  // one. `getLastRoot()` beside `treeNumber()` is the trap the pool documents: after a
  // rollover the first is the tree that just filled and the second is the new empty one, and
  // pairing them is rejected with PoolRootWrongTree. Neither is exposed here for that reason.
  //
  // Nothing in this SDK calls even this one — the Transact event carries outputTreeNumber
  // beside both leaf indices, so scanning reconstructs position without asking the chain. It
  // is exposed for consumers that want a cross-check against their own scan.
  "function currentAnchor() external view returns (bytes32 root, uint32 tree)",
  "function position() external view returns (uint32 tree, uint32 leaf)",
  "function poolRootTree(bytes32) external view returns (bool known, uint32 tree)",
  // tokenAddress is indexed — omitting that shifts every later argument during decoding.
  "event Transact(uint256 publicAmount, address indexed tokenAddress, bytes32[4] inputNullifiers, bytes32 outputCommitment0, bytes32 outputCommitment1, uint32 outputTreeNumber, uint32 outputLeafIndex0, uint32 outputLeafIndex1, bytes encryptedOutput0, bytes encryptedOutput1)",
  "event Withdrawal(address indexed recipient, uint256 amount, address indexed relayer, uint256 fee, address indexed tokenAddress)",
];

export const REGISTRY_ABI = [
  "function aliases(bytes32 aliasHash) external view returns (bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, bytes32 dataHash, uint256 registeredAt)",
  "function aliasSlot(bytes32 aliasHash) external view returns (uint32)",
  "function nextAliasSlot() external view returns (uint32)",
  "function isRegistered(bytes32 aliasHash) external view returns (bool)",
  "function leafOf(bytes32 aliasHash) external view returns (bytes32)",
  "function getRegistryRoot() external view returns (bytes32)",
  "function isKnownRegistryRoot(bytes32) external view returns (bool)",
  "function getSmtSiblings(uint32 slot) external view returns (bytes32[32] memory siblings)",
  "function getAliasesByPrefix(uint16 prefix, uint256 offset, uint256 limit) external view returns (tuple(bytes32 aliasHash, bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, bytes32 dataHash, uint32 pathKey)[] memory entries)",
  "function controller() external view returns (address)",
  "event AliasRegistered(bytes32 indexed aliasHash, bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 leaf, bytes32 encryptionPubkey, uint32 slot)",
  "event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 dataHash, bytes32 leaf)",
  "event AliasReassigned(bytes32 indexed aliasHash, bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 leaf, bytes32 encryptionPubkey)",
];

export const CONTROLLER_ABI = [
  "function revealRegistration(string name, bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, address owner, bytes32 salt) external payable",
  "function aliasToHash(string name) external pure returns (bytes32)",
  "function directRegistration(string name, bytes32 spendingCommitment, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, address owner) external payable",
  "function reserveRegistration(bytes32 commitment) external",
  "function MAX_RESERVATION_AGE() external view returns (uint256)",
  "function reservations(bytes32 commitment) external view returns (uint256 madeAt)",
  `function claim(${REGISTRATION} r, ${TRANSACT_PARAMS} p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof, string name, bytes32 inviteAliasHash, uint256 deadline, bytes signature) external`,
  `function createInvite(${REGISTRATION} r, ${TRANSACT_PARAMS} p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof) external payable`,
  "function prepaidClaim(bytes32 inviteAliasHash) external view returns (address)",
  "function updateAliasData(bytes32 aliasHash, bytes32 newDataHash, uint256 deadline, bytes signature) external",
  "function offerAlias(bytes32 aliasHash, address to, uint256 deadline, bytes signature) external",
  "function cancelOffer(bytes32 aliasHash, uint256 deadline, bytes signature) external",
  "function acceptAlias(bytes32 aliasHash, bytes32 newSpendingCommitment, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey, uint256 deadline, bytes signature) external",
  "function pendingAliasOwner(bytes32) external view returns (address)",
  "function aliasNonce(bytes32) external view returns (uint256)",
  "function aliasAuth(bytes32 aliasHash) external view returns (address owner, address pendingOwner, uint256 nonce)",
  "event AliasOffered(bytes32 indexed aliasHash, address indexed from, address indexed to)",
  // Both halves, so a client tracking pending offers can see one withdrawn as well as made.
  "event AliasOfferCancelled(bytes32 indexed aliasHash)",
  "function registrationFee() external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function pool() external view returns (address)",
  "function registry() external view returns (address)",
  "event NamePublished(bytes32 indexed aliasHash, string name)",
  "event AliasClaimed(bytes32 indexed aliasHash, address indexed owner, address indexed submitter)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

/// Payment to whoever submits the transaction, taken out of the value leaving the pool.
/// `amount === 0n` means no relayer, which is the ordinary self-submitted path.
export interface RelayerFee {
  relayer: string;
  amount:  bigint;
}

export const NO_RELAYER: RelayerFee = { relayer: ethers.ZeroAddress, amount: 0n };

export interface TransactParams {
  recipient:    string;      // withdrawal destination; may be zero when the fee consumes the payout
  relayerFee:   RelayerFee;
  externalData: string;      // bytes32; opaque to the pool, read only by the domain on a claim
}

export const ZERO_TRANSACT_PARAMS: TransactParams = {
  recipient:    ethers.ZeroAddress,
  relayerFee:   NO_RELAYER,
  externalData: ethers.ZeroHash,
};

/// The registration a claim is authorised to perform, hashed into `externalData`.
export interface Registration {
  owner:            string;
  aliasHash:        bigint;
  spendingCommitment:   bigint;
  nullifierKeyHash: bigint;
  encryptionPubkey: bigint;
}

function h32(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

/// A token identifier as the *contract* wants it. The SDK carries `tokenAddress` as a bigint
/// throughout, because that is what the note commitment hashes — it is a field element there,
/// not an address. The pool declares the calldata field as `address`, so this is the one
/// conversion, and it throws rather than truncating: a value that does not fit 160 bits is a
/// bug upstream, and silently dropping the high bits is exactly the confusion the narrower
/// type exists to prevent.
export function tokenAddr(n: bigint): string {
  if (n < 0n || n >= 1n << 160n) throw new Error(`tokenAddress out of 160-bit range: ${n}`);
  return ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
}

export function getPool(address: string, runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(address, POOL_ABI, runner);
}

export function getRegistry(address: string, runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(address, REGISTRY_ABI, runner);
}

export function getController(address: string, runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(address, CONTROLLER_ABI, runner);
}

/// Assembles the calldata struct. Kept in one place so the field order cannot drift between
/// the call and the paramsHash preimage — they must agree or the proof is rejected.
export function buildTransactParams(
  poolRoot: bigint[],
  treeNumber: number[],
  registryRoot: bigint,
  publicAmount: bigint,
  tokenAddress: bigint,
  inputNullifiers: bigint[],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  pendingLeaf: bigint = 0n,
  outputsEmpty: boolean = false,
) {
  return {
    poolRoot:          poolRoot.map(h32),
    treeNumber,
    registryRoot:      h32(registryRoot),
    publicAmount,
    tokenAddress:      tokenAddr(tokenAddress),
    inputNullifiers:   inputNullifiers.map(h32),
    outputCommitments: [h32(outputCommitments[0]), h32(outputCommitments[1])],
    recipient:         params.recipient,
    relayerFee:        { relayer: params.relayerFee.relayer, amount: params.relayerFee.amount },
    externalData:      params.externalData,
    // Zero on every path but a claim. The pool requires this to equal what the registry
    // armed, so a non-zero value here without a matching arm is rejected outright.
    pendingLeaf:       h32(pendingLeaf),
    // Spend the inputs and create nothing. Much cheaper — it skips the 32-hash tree walk
    // that is ~74% of a transact — but an exit is *distinguishable* on chain, where every
    // ordinary transact looks alike. Off by default for that reason.
    outputsEmpty,
  };
}

export async function transact(
  pool: ethers.Contract,
  poolRoot: bigint[],
  treeNumber: number[],
  registryRoot: bigint,
  publicAmount: bigint,
  tokenAddress: bigint,
  inputNullifiers: bigint[],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  proofBytes: string,
  value: bigint = 0n,
): Promise<ethers.ContractTransactionResponse> {
  return pool.transact(
    buildTransactParams(poolRoot, treeNumber, registryRoot, publicAmount, tokenAddress,
                        inputNullifiers, outputCommitments, params),
    encryptedOutput0, encryptedOutput1, proofBytes, { value },
  );
}

/// Register in two steps, because one step is a race.
///
/// The alias hash is public in calldata, so a single-transaction registration can be
/// front-run by anyone watching the mempool — and the front-runner registers with their own
/// keys, so payments to that name then arrive for them. Committing first means an observer
/// sees only an opaque hash.
///
/// The salt is random per registration and never reused. It is not a secret to protect
/// afterwards; it exists so the commitment cannot be brute-forced from the small space of
/// plausible names before the reveal.
/// Register in one transaction, skipping the commitment.
///
/// Safe only where the mempool is not public. The name is in this call's calldata, so on a
/// public mempool anyone can register it first with their own keys and receive every payment
/// meant for whoever asked for it — which is what {register}'s two steps exist to prevent.
/// Nothing here defaults to this; a caller has to choose it.
export async function directRegistration(
  domain: ethers.Contract,
  name: string,
  spendingCommitment: bigint,
  nullifierKeyHash: bigint,
  encryptionPubkey: bigint,
  fee: bigint,
  /// Who will hold the name — the client's derived owner address, not the payer.
  owner: string,
): Promise<ethers.ContractTransactionResponse> {
  return domain.directRegistration(
    name, h32(spendingCommitment), h32(nullifierKeyHash), h32(encryptionPubkey), owner,
    { value: fee },
  );
}

/// The commitment a registration reveals against, computed locally.
///
/// Mirrors `HaliasController.registrationCommitment`, which is
/// `keccak256(abi.encode(aliasToHash(name), spendingCommitment, nullifierKeyHash,
/// encryptionPubkey, owner, salt))` with `aliasToHash` being `keccak256(bytes(name))` over the
/// full name including its suffix.
///
/// Every field is bound, which is what makes a reveal unstealable: change the owner, a key, or
/// the salt and the result hashes to a commitment that was never made.
export function registrationCommitment(
  name: string,
  spendingCommitment: bigint,
  nullifierKeyHash: bigint,
  encryptionPubkey: bigint,
  owner: string,
  salt: string,
): string {
  const aliasHash = ethers.keccak256(ethers.toUtf8Bytes(name));
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "address", "bytes32"],
      [aliasHash, h32(spendingCommitment), h32(nullifierKeyHash), h32(encryptionPubkey),
       owner, salt],
    ),
  );
}

/// Register `name`. The alias hash is derived from it by the contract rather than passed
/// alongside it. Passing both and checking them against each other is only a way for them to
/// disagree.
export async function register(
  domain: ethers.Contract,
  name: string,
  spendingCommitment: bigint,
  nullifierKeyHash: bigint,
  encryptionPubkey: bigint,
  fee: bigint,
  /// Who will hold the name. Derived from the client's own phrase, not the wallet paying —
  /// so the alias belongs to the keys rather than to whichever account happened to send this.
  owner: string,
  /// The commit-reveal secret. Derived by the caller rather than random here — see
  /// {Halias-register} — so that the reveal needs nothing carried over from the commit.
  salt: string,
  /// Reports which of the two transactions is in flight. Registration is the only operation
  /// here that needs two wallet confirmations, and a caller that cannot say which one is
  /// which leaves the user staring at a second unexplained prompt.
  onStep?: (step: "commit" | "waiting" | "register") => void,
): Promise<ethers.ContractTransactionResponse> {
  // Computed here, never asked for over RPC.
  //
  // `registrationCommitment` is `pure`, so calling it is an eth_call — and its first argument
  // is the plaintext name. That hands the name to the RPC provider *before* the commitment is
  // broadcast, which defeats the entire mechanism: commit-reveal exists so that nobody learns
  // the name until front-running it is impossible, and a provider watching this call also sees
  // the mempool it would be front-run in. The round trip bought nothing — the encoding is four
  // lines and this file already reproduces harder ones.
  //
  // The contract's version stays as the reference. SdkPreimage.test.ts asserts the two agree
  // for random inputs, which is where a round trip belongs: in a test, not in the flow whose
  // secrecy is the point.
  const commitment = registrationCommitment(
    name, spendingCommitment, nullifierKeyHash, encryptionPubkey, owner, salt,
  );

  // Resumed, not replayed. The commitment is derived from the root, so it is the same value
  // on every attempt and on every device — which makes it an idempotency key the chain is
  // already storing. Reading it costs one eth_call and means a registration interrupted after
  // the commit continues from where it stopped, instead of re-sending a transaction whose
  // only possible outcome is a revert.
  //
  // Only the hash goes over the wire, never the name. `registrationCommitment` is `pure`, so
  // asking the chain to compute it would hand the plaintext name to the provider before the
  // commitment is broadcast, which is the one thing commit-reveal exists to prevent. This
  // asks about a hash that is about to be published anyway.
  //
  // Expiry is read rather than assumed: a reservation past MAX_RESERVATION_AGE is dead, and
  // treating it as live would reveal straight into ReservationExpired.
  let commitTx: ethers.ContractTransactionResponse | null = null;
  /// The block the reservation landed in. What the reveal has to get past — not "one more
  /// block than whenever we happened to start waiting".
  let commitBlock: number | null = null;
  let live = false;
  const madeAt = BigInt(await domain.reservations(commitment));
  if (madeAt !== 0n) {
    const maxAge = BigInt(await domain.MAX_RESERVATION_AGE());
    const head = await domain.runner?.provider?.getBlock("latest");
    const now = BigInt(head?.timestamp ?? Math.floor(Date.now() / 1000));
    live = now <= madeAt + maxAge;
  }

  if (!live) {
    // Must be mined, not merely sent: the reveal reads the commitment from state.
    //
    // A commitment that already exists is still not a failure, because the read above races
    // the chain. Anyone may commit — the hash is opaque and only the bound owner can ever
    // reveal it — so a griefer can watch for one and front-run it with the identical hash
    // purely to make this revert. The commitment is live either way, which is all the reveal
    // needs, so treating that as fatal would hand them a denial of service over a transaction
    // that did exactly what we wanted.
    onStep?.("commit");
    try {
      const sent = await domain.reserveRegistration(commitment);
      const receipt = await sent.wait();
      commitTx = sent;
      commitBlock = receipt?.blockNumber ?? null;
    } catch (e: any) {
      if (!isReservationPending(e)) throw e;
    }
  }

  // Retried on ReservationTooNew rather than assumed away. The reveal does land in a later
  // *block* than the commit by construction — but it is estimated first, and eth_estimateGas
  // simulates against the latest block, which is the one the commit just landed in. There
  // `block.timestamp == madeAt`, the contract's `<= madeAt` check fires, and the wallet
  // reports a failed estimation without ever sending anything. Nothing is mined, nothing is
  // spent, and the flow simply stops.
  //
  // Hardhat hides this by estimating against a pending block with an advanced timestamp, so
  // every local suite and e2e-live pass while a real chain stalls at the second step.
  //
  // Waiting unconditionally is the wrong fix: a chain that only mines on demand has nothing
  // to mine while we wait. Reacting to the revert costs nothing when it does not happen and
  // recovers when it does, and it is the same answer for a builder packing both into one
  // block — which is precisely the position a front-runner is in.
  // Waited for rather than discovered by failing. The reveal is estimated before it is sent,
  // against the block the commit landed in — where `block.timestamp == madeAt` and the
  // contract's guard fires — so attempting it immediately buys a rejected round trip and then
  // the same wait anyway. One block is irreducible: the guard is on the timestamp, and the
  // next block is when a later one exists.
  //
  // Only when we sent the commit ourselves. A resumed reservation is already old enough, and
  // waiting there would add a block to a flow that needs none.
  const provider = domain.runner?.provider;
  if (commitBlock !== null && provider) {
    await waitForBlockAfter(provider, commitBlock, onStep);
  }

  onStep?.("register");
  return revealWhenReservationRipens(
    domain, name, spendingCommitment, nullifierKeyHash, encryptionPubkey, owner, salt, fee,
    // The larger of the pin and what the chain reports.
    //
    // The pin exists because ethers caches the account's transaction count, and two sends in
    // one tick reuse the stale value — "Nonce too low. Expected 16 but got 15" — even when
    // the first was awaited. But a pin alone is wrong in the other direction now that a wait
    // sits between the two: anything else the wallet sent meanwhile has already consumed that
    // nonce, and reusing it fails just as hard. Taking the maximum covers both.
    await revealNonce(domain, commitTx),
  );
}

/// What nonce the reveal should sign with.
///
/// Undefined when we did not send the commit — nothing is racing it, so ethers resolving it
/// normally is correct and cheaper.
async function revealNonce(
  domain: ethers.Contract,
  commitTx: ethers.ContractTransactionResponse | null,
): Promise<number | undefined> {
  if (!commitTx) return undefined;
  const pinned = commitTx.nonce + 1;
  try {
    const signer = domain.runner as ethers.Signer | undefined;
    const pending = await signer?.getNonce?.("pending");
    return pending === undefined ? pinned : Math.max(pinned, pending);
  } catch {
    // A provider that will not answer is not a reason to abandon the registration — the pin
    // is the value that was right a moment ago.
    return pinned;
  }
}

/// `ReservationPending()`, as the wallet reports it.
///
/// Was matched on the name, which never appears: a wallet returns raw revert data and the
/// message "execution reverted". So the one revert this flow is designed to tolerate was
/// rethrown instead, and a resumable registration looked like a dead end.
const RESERVATION_PENDING = "0xf032bda0";

function isReservationPending(e: any): boolean {
  return revertBlob(e).includes(RESERVATION_PENDING) || revertBlob(e).includes("ReservationPending");
}

/// Everything a wallet might have put the revert data in. Providers disagree about the shape,
/// and the selector is worth finding wherever it landed.
function revertBlob(e: any): string {
  return JSON.stringify(e?.info ?? e?.error ?? e?.data ?? e?.message ?? "") +
         String(e?.data ?? "") + String(e?.shortMessage ?? "");
}

/// `ReservationTooNew()`, as the wallet reports it.
///
/// Matched on the selector rather than the name: an estimation failure arrives as raw revert
/// data, and only a provider that happens to know the ABI decodes it into something readable.
const RESERVATION_TOO_NEW = "0x9d7b5dd7";

function isReservationTooNew(e: any): boolean {
  return revertBlob(e).includes(RESERVATION_TOO_NEW) || revertBlob(e).includes("ReservationTooNew");
}

/// Send the reveal, waiting out a reservation the chain still considers same-second.
///
/// Bounded deliberately. If the revert is something else, or the block will not advance, this
/// has to surface rather than spin — a registration that hangs silently is worse than one
/// that fails and says why, because the reservation stays valid for a day and can be retried
/// by simply running the whole flow again.
async function revealWhenReservationRipens(
  domain: ethers.Contract,
  name: string,
  spendingCommitment: bigint,
  nullifierKeyHash: bigint,
  encryptionPubkey: bigint,
  owner: string,
  salt: string,
  fee: bigint,
  nonce?: number,
  attempts = 4,
): Promise<ethers.ContractTransactionResponse> {
  const overrides = nonce === undefined ? { value: fee } : { value: fee, nonce };
  const provider = domain.runner?.provider;

  for (let i = 0; ; i++) {
    try {
      return await domain.revealRegistration(
        name, h32(spendingCommitment), h32(nullifierKeyHash), h32(encryptionPubkey), owner,
        salt, overrides,
      );
    } catch (e: any) {
      if (i >= attempts - 1 || !isReservationTooNew(e) || !provider) throw e;
      // The safety net, for the case the proactive wait did not cover — a reservation made by
      // someone else in this same block, or a builder packing both transactions together.
      // Anchored to the current head, because that is the block the estimation just rejected.
      await waitForBlockAfter(provider, await provider.getBlockNumber());
    }
  }
}

/// Block until the head is past `block`, or give up.
///
/// Anchored to the block the reservation landed in rather than to whenever this was called.
/// Those differ whenever anything took time in between — awaiting the receipt, reading the
/// registration fee, deriving the salt — and by then the chain has often already moved, so
/// the correct wait is none at all. Waiting "one more block from now" spent a block interval
/// on a condition that was already true.
///
/// Checked before sleeping for the same reason, and the step is only announced once a wait is
/// actually going to happen: a "Waiting for the next block" that flashes up and vanishes is
/// worse than silence.
///
/// Giving up is not a failure — the caller retries the send regardless, and a chain that has
/// not produced a block in this long will report the real reason itself.
async function waitForBlockAfter(
  provider: ethers.Provider,
  block: number,
  onStep?: (step: "waiting") => void,
  timeoutMs = 30_000,
): Promise<void> {
  if (await provider.getBlockNumber() > block) return;
  onStep?.("waiting");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // A second, not two. Block times vary by chain and the cost of asking is one eth_blockNumber
    // — on a fast chain a two-second granularity is most of the wait it is measuring.
    await new Promise((r) => setTimeout(r, 1_000));
    if (await provider.getBlockNumber() > block) return;
  }
}

// ── Owner-authorised alias actions ───────────────────────────────────────────
//
// Each of these has two callers. The owner submitting for themselves passes no signature and
// the contract reads `msg.sender`; anyone else submits a signature the owner produced
// off-chain. There is no `updateKeys` — rotating keys is offering the alias to yourself and
// accepting with fresh ones, which replaces the spending commitment too.

/// The contract reads an empty signature as "the sender is the owner".

/// A signed action: the authority, and a submission anyone can pay for.
export interface SignedAction {
  signature: string;
  deadline:  bigint;
  /// `nonce` pins the submitter's transaction nonce, for the one caller that sends two
  /// transactions back to back with no proof between them — see {Halias-sweepAndOffer}.
  /// Awaiting a receipt is not enough to make ethers resolve the next one correctly.
  submit:    (submitter?: ethers.Signer, nonce?: number) => Promise<ethers.ContractTransactionResponse>;
}

async function eip712Domain(domain: ethers.Contract) {
  const net = await domain.runner!.provider!.getNetwork();
  return {
    name: "Halias",
    version: "1",
    chainId: Number(net.chainId),
    verifyingContract: await domain.getAddress(),
  };
}

/// Signs one owner action and hands back something anyone can submit.
///
/// The nonce is read at signing time and every authorised action on an alias bumps it, so a
/// signature is invalidated by any later action on the same alias — including one the owner
/// takes directly. That is deliberate: changing your mind by acting directly should not leave
/// an old signature live for someone else to submit afterwards.
async function signAliasAction(
  domain: ethers.Contract,
  owner: ethers.Signer,
  aliasHash: bigint,
  types: Record<string, { name: string; type: string }[]>,
  fields: Record<string, unknown>,
  send: (deadline: bigint, signature: string, d: ethers.Contract, nonce?: number) => Promise<ethers.ContractTransactionResponse>,
  opts: { deadlineSeconds?: number; nonce?: bigint } = {},
): Promise<SignedAction> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 3600));
  const value = {
    ...fields,
    // Supplied by the caller when it has already read it — every caller here resolves the
    // signer through aliasAuth first, which returns the nonce alongside. Fetched only when
    // nobody passed one, so a direct user of this function still works.
    nonce: opts.nonce ?? (await domain.aliasNonce(h32(aliasHash)) as bigint),
    deadline,
  };
  const signature = await (owner as any).signTypedData(await eip712Domain(domain), types, value);
  return {
    signature,
    deadline,
    submit: (submitter?: ethers.Signer, nonce?: number) =>
      send(deadline, signature,
           submitter ? domain.connect(submitter) as ethers.Contract : domain, nonce),
  };
}


export async function signUpdateAliasData(
  domain: ethers.Contract,
  aliasHash: bigint,
  newDataHash: bigint,
  owner: ethers.Signer,
  opts: { deadlineSeconds?: number; nonce?: bigint } = {},
): Promise<SignedAction> {
  return signAliasAction(
    domain, owner, aliasHash,
    { UpdateAliasData: [
      { name: "aliasHash", type: "bytes32" },
      { name: "dataHash",  type: "bytes32" },
      { name: "nonce",     type: "uint256" },
      { name: "deadline",  type: "uint256" },
    ] },
    { aliasHash: h32(aliasHash), dataHash: h32(newDataHash) },
    (deadline, signature, d) => d.updateAliasData(h32(aliasHash), h32(newDataHash), deadline, signature),
    opts,
  );
}


export async function signOfferAlias(
  domain: ethers.Contract,
  aliasHash: bigint,
  to: string,
  owner: ethers.Signer,
  opts: { deadlineSeconds?: number; nonce?: bigint } = {},
): Promise<SignedAction> {
  return signAliasAction(
    domain, owner, aliasHash,
    { OfferAlias: [
      { name: "aliasHash", type: "bytes32" },
      { name: "to",        type: "address" },
      { name: "nonce",     type: "uint256" },
      { name: "deadline",  type: "uint256" },
    ] },
    { aliasHash: h32(aliasHash), to },
    (deadline, signature, d, nonce) =>
      d.offerAlias(h32(aliasHash), to, deadline, signature,
                   nonce === undefined ? {} : { nonce }),
    opts,
  );
}


export async function signCancelOffer(
  domain: ethers.Contract,
  aliasHash: bigint,
  owner: ethers.Signer,
  opts: { deadlineSeconds?: number; nonce?: bigint } = {},
): Promise<SignedAction> {
  return signAliasAction(
    domain, owner, aliasHash,
    { CancelOffer: [
      { name: "aliasHash", type: "bytes32" },
      { name: "nonce",     type: "uint256" },
      { name: "deadline",  type: "uint256" },
    ] },
    { aliasHash: h32(aliasHash) },
    (deadline, signature, d) => d.cancelOffer(h32(aliasHash), deadline, signature),
    opts,
  );
}

/// Accept an offered alias.
///
/// The recipient signs; anyone may submit. That split is deliberate — a buyer with no ETH
/// still has to be the one asserting which keys are theirs, so authority comes from the
/// signature rather than from `msg.sender`, and a relayer can pay for inclusion.
export async function acceptAlias(
  domain: ethers.Contract,
  aliasHash: bigint,
  keys: { spendingCommitment: bigint; nullifierKeyHash: bigint; encryptionPubkey: bigint },
  recipient: ethers.Signer,
  opts: { deadlineSeconds?: number; nonce?: bigint } = {},
): Promise<{ signature: string; deadline: bigint; submit: (submitter?: ethers.Signer) => Promise<ethers.ContractTransactionResponse> }> {
  const to = await recipient.getAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 3600));

  const domainData = await eip712Domain(domain);
  const types = {
    AcceptAlias: [
      { name: "aliasHash",        type: "bytes32" },
      { name: "spendingCommitment",   type: "bytes32" },
      { name: "nullifierKeyHash", type: "bytes32" },
      { name: "encryptionPubkey", type: "bytes32" },
      { name: "to",               type: "address" },
      { name: "nonce",            type: "uint256" },
      { name: "deadline",         type: "uint256" },
    ],
  };
  const value = {
    aliasHash:        h32(aliasHash),
    spendingCommitment:   h32(keys.spendingCommitment),
    nullifierKeyHash: h32(keys.nullifierKeyHash),
    encryptionPubkey: h32(keys.encryptionPubkey),
    to,
    // From the caller when it already read it — {Halias-acceptOffer} resolves the signer
    // through aliasAuth, which returns the nonce with it.
    nonce:    opts.nonce ?? (await domain.aliasNonce(h32(aliasHash)) as bigint),
    deadline,
  };
  const signature = await (recipient as any).signTypedData(domainData, types, value);

  return {
    signature,
    deadline,
    submit: (submitter?: ethers.Signer) => {
      const d = submitter ? domain.connect(submitter) as ethers.Contract : domain;
      return d.acceptAlias(
        h32(aliasHash), h32(keys.spendingCommitment), h32(keys.nullifierKeyHash),
        h32(keys.encryptionPubkey), deadline, signature,
      );
    },
  };
}

export async function lookupAlias(
  registry: ethers.Contract,
  aliasHash: bigint,
): Promise<{ spendingCommitment: bigint; nullifierKeyHash: bigint; encryptionPubkey: bigint; dataHash: bigint }> {
  const r = await registry.aliases(h32(aliasHash));
  return {
    spendingCommitment:   BigInt(r.spendingCommitment),
    nullifierKeyHash: BigInt(r.nullifierKeyHash),
    encryptionPubkey: BigInt(r.encryptionPubkey),
    dataHash:         BigInt(r.dataHash),
  };
}

/// One registration as the prefix index returns it.
export interface PrefixEntry {
  aliasHash: bigint;
  spendingCommitment: bigint;
  nullifierKeyHash: bigint;
  encryptionPubkey: bigint;
  dataHash: bigint;
  /// Zero-based, already offset back by the contract — this is what getSmtSiblings takes,
  /// not what aliasSlot stores.
  pathKey: number;
}

/// Every registration sharing a prefix group, paged.
///
/// The privacy-preserving way to resolve a name. `aliases(aliasHash)` names one person to
/// whichever node answers, and since names are published at registration the hash reverses
/// trivially — on a send path that identifies the recipient of a payment that publishes
/// nothing. This asks for a group instead, and which group says nothing about which member
/// the caller came for.
///
/// Returns whole records, so resolving is one call. Following up with `aliases` per entry
/// would put the hash back on the wire individually and undo the point.
export async function getAliasesByPrefix(
  registry: ethers.Contract,
  prefix: number,
  offset = 0,
  limit = 256,
): Promise<PrefixEntry[]> {
  const rows = await registry.getAliasesByPrefix(prefix, offset, limit);
  return rows.map((r: any) => ({
    aliasHash:          BigInt(r.aliasHash),
    spendingCommitment: BigInt(r.spendingCommitment),
    nullifierKeyHash:   BigInt(r.nullifierKeyHash),
    encryptionPubkey:   BigInt(r.encryptionPubkey),
    dataHash:           BigInt(r.dataHash),
    pathKey:            Number(r.pathKey),
  }));
}

/// The tuple form of a Registration, in the order the domain declares it. Order matters:
/// this is hashed, and a mismatch produces ClaimNotAuthorised rather than a decode error.
/// Exported because a prepared claim carries this shape to whoever submits it — the same
/// tuple the domain hashes, so the two cannot drift apart.
export function registrationTuple(r: Registration) {
  return {
    owner:            r.owner,
    aliasHash:        h32(r.aliasHash),
    spendingCommitment:   h32(r.spendingCommitment),
    nullifierKeyHash: h32(r.nullifierKeyHash),
    encryptionPubkey: h32(r.encryptionPubkey),
  };
}

/// `externalData` for a claim: the domain recomputes this from its own arguments and
/// requires it to match, and the pool commits it into `paramsHash`. That is what stops a
/// submitter substituting itself for `owner` — the binding a relayer cannot forge.
export function encodeRegistration(r: Registration): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    [`tuple${REGISTRATION}`], [registrationTuple(r)],
  ));
}

/// Redeem an invite: register the claimer's name against the credit the inviter paid for.
///
/// `invite` carries the credit and the authority to spend it. The signature is by the invite
/// alias's owner — an address derived from the invite secret — so holding the code is what
/// entitles someone to the free registration, and the credit is one-use.
export async function claim(
  domain: ethers.Contract,
  registration: Registration,
  poolRoot: bigint[],
  treeNumber: number[],
  registryRoot: bigint,
  publicAmount: bigint,
  inputNullifiers: bigint[],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  proofBytes: string,
  name: string = "",
  pendingLeaf: bigint = 0n,
  invite?: { aliasHash: bigint; deadline: bigint; signature: string },
): Promise<ethers.ContractTransactionResponse> {
  if (!invite) throw new Error("claim needs the invite credit it is redeeming");
  return domain.claim(
    registrationTuple(registration),
    buildTransactParams(poolRoot, treeNumber, registryRoot, publicAmount, 0n,
                        inputNullifiers, outputCommitments, params, pendingLeaf),
    encryptedOutput0, encryptedOutput1, proofBytes, name,
    h32(invite.aliasHash), invite.deadline, invite.signature,
  );
}

/// Create an invite: register the keys-only entry its note is paid to, and fund it, in one
/// transaction.
///
/// Payable, and the fee is the creator's. The entry itself is free — it has no name and can
/// never be one — so the fee pays forward the registration the claimer will make. An invite
/// costs one fee and takes nothing from the pool.
export async function createInvite(
  domain: ethers.Contract,
  registration: Registration,
  poolRoot: bigint[],
  treeNumber: number[],
  registryRoot: bigint,
  publicAmount: bigint,
  inputNullifiers: bigint[],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  proofBytes: string,
  pendingLeaf: bigint,
  fee: bigint,
): Promise<ethers.ContractTransactionResponse> {
  return domain.createInvite(
    registrationTuple(registration),
    buildTransactParams(poolRoot, treeNumber, registryRoot, publicAmount, 0n,
                        inputNullifiers, outputCommitments, params, pendingLeaf),
    encryptedOutput0, encryptedOutput1, proofBytes,
    { value: fee },
  );
}

/// Sign the authority to spend an invite's prepaid registration.
///
/// Signed with the key derived from the invite secret, which is the whole entitlement — the
/// claimer reconstructs it from the code rather than being sent anything extra.
export async function signClaimInvite(
  domain: ethers.Contract,
  inviteOwner: ethers.Signer,
  inviteAliasHash: bigint,
  aliasHash: bigint,
  opts: { deadlineSeconds?: number } = {},
): Promise<{ aliasHash: bigint; deadline: bigint; signature: string }> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 3600));
  const net = await domain.runner!.provider!.getNetwork();
  const signature = await (inviteOwner as any).signTypedData(
    {
      name: "Halias",
      version: "1",
      chainId: Number(net.chainId),
      verifyingContract: await domain.getAddress(),
    },
    {
      ClaimInvite: [
        { name: "inviteAliasHash", type: "bytes32" },
        { name: "aliasHash",       type: "bytes32" },
        { name: "nonce",           type: "uint256" },
        { name: "deadline",        type: "uint256" },
      ],
    },
    {
      inviteAliasHash: h32(inviteAliasHash),
      aliasHash:       h32(aliasHash),
      nonce:           await domain.aliasNonce(h32(inviteAliasHash)) as bigint,
      deadline,
    },
  );
  return { aliasHash: inviteAliasHash, deadline, signature };
}

/// Mirrors HaliasPool._computeParamsHash exactly.
///
/// The pool hashes `p.relayerFee` as a struct, which ABI-encodes as two inline words — not as
/// one packed `bytes32`. Get that wrong and the preimage differs, which produces proofs that
/// verify against nothing rather than an error anyone can read. `contractAddress` is the POOL,
/// not the controller, because the pool hashes its own `address(this)`.
export function computeParamsHash(
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  chainId: bigint,
  poolAddress: string,
): bigint {
  return BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "bytes", "bytes", "tuple(address,uint256)", "bytes32"],
      [
        chainId,
        poolAddress,
        params.recipient,
        encryptedOutput0,
        encryptedOutput1,
        [params.relayerFee.relayer, params.relayerFee.amount],
        params.externalData,
      ],
    )
  )) % FIELD_PRIME;
}
