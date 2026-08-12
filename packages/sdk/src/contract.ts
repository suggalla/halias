import { ethers } from "ethers";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// The pool, the registry and the domain are three separate contracts.
//
// Splitting the monolith split this file too. The shapes below are load-bearing in a way
// ordinary ABI fragments are not: `TransactParams` is hashed into `paramsHash`, a public
// signal the circuit constrains, so a field in the wrong order or the wrong type does not
// produce a decoding error — it produces a proof the pool rejects, with nothing to say why.
// SdkAbi.test.ts compares fragments against the compiled artifacts, and Alignment pins the
// hash itself against the contract's own computeParamsHash.

// TransactParams, as the pool declares it. Every member is fixed-size, so the struct is
// statically encoded — `relayerFee` is a two-member static struct, which preserves that.
const TRANSACT_PARAMS =
  "(bytes32[2] poolRoot, uint32[2] treeNumber, bytes32 registryRoot, uint256 publicAmount, address tokenAddress, " +
  "bytes32[2] inputNullifiers, bytes32[2] outputCommitments, address recipient, " +
  "(address relayer, uint256 amount) relayerFee, bytes32 externalData, bytes32 pendingLeaf, " +
  "bool outputsEmpty)";

const REGISTRATION =
  "(address owner, bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, " +
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
  "event Transact(uint256 publicAmount, address indexed tokenAddress, bytes32 indexed inputNullifier0, bytes32 indexed inputNullifier1, bytes32 outputCommitment0, bytes32 outputCommitment1, uint32 outputTreeNumber, uint32 outputLeafIndex0, uint32 outputLeafIndex1, bytes encryptedOutput0, bytes encryptedOutput1)",
  "event Withdrawal(address indexed recipient, uint256 amount, address indexed relayer, uint256 fee, address indexed tokenAddress)",
];

export const REGISTRY_ABI = [
  "function aliases(bytes32 aliasHash) external view returns (bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, bytes32 dataHash, uint256 registeredAt)",
  "function aliasSlot(bytes32 aliasHash) external view returns (uint32)",
  "function nextAliasSlot() external view returns (uint32)",
  "function isRegistered(bytes32 aliasHash) external view returns (bool)",
  "function leafOf(bytes32 aliasHash) external view returns (bytes32)",
  "function getRegistryRoot() external view returns (bytes32)",
  "function isKnownRegistryRoot(bytes32) external view returns (bool)",
  "function getSmtSiblings(uint32 slot) external view returns (bytes32[32] memory siblings)",
  "function controller() external view returns (address)",
  "event AliasRegistered(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 leaf, bytes32 encryptionPubkey, uint32 slot)",
  "event AliasDataUpdated(bytes32 indexed aliasHash, bytes32 dataHash, bytes32 leaf)",
  "event AliasReassigned(bytes32 indexed aliasHash, bytes32 spendingPubkey, bytes32 leaf, bytes32 encryptionPubkey)",
];

export const DOMAIN_ABI = [
  "function register(bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, string name, bytes32 salt) external payable",
  "function commit(bytes32 commitment) external",
  "function registrationCommitment(bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, address owner, bytes32 salt) external pure returns (bytes32)",
  "function MIN_COMMIT_AGE() external view returns (uint256)",
  `function claim(${REGISTRATION} r, ${TRANSACT_PARAMS} p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof, string name) external`,
  "function updateAliasData(bytes32 aliasHash, bytes32 newDataHash, uint256 deadline, bytes signature) external",
  "function offerAlias(bytes32 aliasHash, address to, uint256 deadline, bytes signature) external",
  "function cancelOffer(bytes32 aliasHash, uint256 deadline, bytes signature) external",
  "function acceptAlias(bytes32 aliasHash, bytes32 newSpendingPubkey, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey, uint256 deadline, bytes signature) external",
  "function acceptAliasDigest(bytes32 aliasHash, bytes32 newSpendingPubkey, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey, address to, uint256 deadline) external view returns (bytes32)",
  "function pendingAliasOwner(bytes32) external view returns (address)",
  "function aliasNonce(bytes32) external view returns (uint256)",
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
  spendingPubkey:   bigint;
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

export function getDomain(address: string, runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(address, DOMAIN_ABI, runner);
}

/// Assembles the calldata struct. Kept in one place so the field order cannot drift between
/// the call and the paramsHash preimage — they must agree or the proof is rejected.
export function buildTransactParams(
  poolRoot: [bigint, bigint],
  treeNumber: [number, number],
  registryRoot: bigint,
  publicAmount: bigint,
  tokenAddress: bigint,
  inputNullifiers: [bigint, bigint],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  pendingLeaf: bigint = 0n,
  outputsEmpty: boolean = false,
) {
  return {
    poolRoot:          [h32(poolRoot[0]), h32(poolRoot[1])],
    treeNumber,
    registryRoot:      h32(registryRoot),
    publicAmount,
    tokenAddress:      tokenAddr(tokenAddress),
    inputNullifiers:   [h32(inputNullifiers[0]), h32(inputNullifiers[1])],
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
  poolRoot: [bigint, bigint],
  treeNumber: [number, number],
  registryRoot: bigint,
  publicAmount: bigint,
  tokenAddress: bigint,
  inputNullifiers: [bigint, bigint],
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
export async function register(
  domain: ethers.Contract,
  aliasHash: bigint,
  spendingPubkey: bigint,
  nullifierKeyHash: bigint,
  encryptionPubkey: bigint,
  fee: bigint,
  name: string = "",
  /// Reports which of the two transactions is in flight. Registration is the only operation
  /// here that needs two wallet confirmations, and a caller that cannot say which one is
  /// which leaves the user staring at a second unexplained prompt.
  onStep?: (step: "commit" | "register") => void,
): Promise<ethers.ContractTransactionResponse> {
  const owner = await (domain.runner as ethers.Signer).getAddress();
  const salt  = ethers.hexlify(ethers.randomBytes(32));

  const commitment = await domain.registrationCommitment(
    h32(aliasHash), h32(spendingPubkey), h32(nullifierKeyHash), h32(encryptionPubkey),
    owner, salt,
  ) as string;

  // Must be mined, not merely sent: the reveal reads the commitment from state, and
  // MIN_COMMIT_AGE requires it to be at least one block old.
  // A commitment that already exists is not a failure.
  //
  // Anyone may commit — the hash is opaque and only the bound owner can ever reveal it — so
  // a griefer can watch for a commit and front-run it with the identical hash purely to make
  // this transaction revert with CommitmentPending. The commitment is live either way, which
  // is all the reveal needs, so treating that revert as fatal would hand them a denial of
  // service over a transaction that did exactly what we wanted.
  let commitTx: ethers.ContractTransactionResponse | null = null;
  onStep?.("commit");
  try {
    const sent = await domain.commit(commitment);
    await sent.wait();
    commitTx = sent;
  } catch (e: any) {
    const already = JSON.stringify(e?.info ?? e?.message ?? "").includes("CommitmentPending");
    if (!already) throw e;
    commitTx = null;
  }

  // No client-side wait. The reveal is a separate transaction, so it lands in a later block
  // than the commit by construction, and MIN_COMMIT_AGE is 1. Polling for the block to
  // advance hangs forever on a chain that only mines on demand — there is nothing to mine
  // while we wait — and adds nothing on a live one.
  //
  // If a builder does pack both into one block the contract reverts with CommitTooNew, which
  // is the protection working: that is precisely the position a front-runner is in.
  // Nonce taken from the commit rather than looked up. ethers caches the account's
  // transaction count, and two sends from one wallet in the same tick reuse the stale value
  // — "Nonce too low. Expected 16 but got 15" — even when the first was awaited. Deriving it
  // from the transaction we just mined is exact and costs no extra call.
  onStep?.("register");
  return domain.register(
    h32(aliasHash), h32(spendingPubkey), h32(nullifierKeyHash), h32(encryptionPubkey),
    name, salt,
    // Nonce from the commit when we sent one; otherwise let ethers resolve it, since no
    // second send is racing it.
    commitTx ? { value: fee, nonce: commitTx.nonce + 1 } : { value: fee },
  );
}

// ── Owner-authorised alias actions ───────────────────────────────────────────
//
// Each of these has two callers. The owner submitting for themselves passes no signature and
// the contract reads `msg.sender`; anyone else submits a signature the owner produced
// off-chain. There is no `updateKeys` — rotating keys is offering the alias to yourself and
// accepting with fresh ones, which replaces the spending pubkey too.

/// The contract reads an empty signature as "the sender is the owner".
const NO_SIGNATURE = "0x";

/// A signed action: the authority, and a submission anyone can pay for.
export interface SignedAction {
  signature: string;
  deadline:  bigint;
  submit:    (submitter?: ethers.Signer) => Promise<ethers.ContractTransactionResponse>;
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
  send: (deadline: bigint, signature: string, d: ethers.Contract) => Promise<ethers.ContractTransactionResponse>,
  opts: { deadlineSeconds?: number } = {},
): Promise<SignedAction> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 3600));
  const value = {
    ...fields,
    nonce: await domain.aliasNonce(h32(aliasHash)) as bigint,
    deadline,
  };
  const signature = await (owner as any).signTypedData(await eip712Domain(domain), types, value);
  return {
    signature,
    deadline,
    submit: (submitter?: ethers.Signer) =>
      send(deadline, signature, submitter ? domain.connect(submitter) as ethers.Contract : domain),
  };
}

export async function updateAliasData(
  domain: ethers.Contract,
  aliasHash: bigint,
  newDataHash: bigint,
): Promise<ethers.ContractTransactionResponse> {
  return domain.updateAliasData(h32(aliasHash), h32(newDataHash), 0n, NO_SIGNATURE);
}

export async function signUpdateAliasData(
  domain: ethers.Contract,
  aliasHash: bigint,
  newDataHash: bigint,
  owner: ethers.Signer,
  opts: { deadlineSeconds?: number } = {},
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

/// Offer an alias. Nothing moves until the recipient accepts with keys they control.
export async function offerAlias(
  domain: ethers.Contract,
  aliasHash: bigint,
  to: string,
  /// Pass when a transaction from the same account was just mined. Awaiting the receipt is
  /// not enough — `getTransactionCount(_, "pending")` has been observed lagging `"latest"` by
  /// one, so ethers resolves a nonce that is already spent and the send is rejected as
  /// "nonce too low". Same fix as {register}'s commit-then-reveal pair.
  nonce?: number,
): Promise<ethers.ContractTransactionResponse> {
  return domain.offerAlias(h32(aliasHash), to, 0n, NO_SIGNATURE,
                           nonce === undefined ? {} : { nonce });
}

export async function signOfferAlias(
  domain: ethers.Contract,
  aliasHash: bigint,
  to: string,
  owner: ethers.Signer,
  opts: { deadlineSeconds?: number } = {},
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
    (deadline, signature, d) => d.offerAlias(h32(aliasHash), to, deadline, signature),
    opts,
  );
}

export async function cancelOffer(
  domain: ethers.Contract,
  aliasHash: bigint,
  /// Same reason as {offerAlias}: an awaited receipt does not guarantee the node's pending
  /// nonce has caught up, and offering then cancelling is the natural back-to-back pair.
  nonce?: number,
): Promise<ethers.ContractTransactionResponse> {
  return domain.cancelOffer(h32(aliasHash), 0n, NO_SIGNATURE,
                            nonce === undefined ? {} : { nonce });
}

export async function signCancelOffer(
  domain: ethers.Contract,
  aliasHash: bigint,
  owner: ethers.Signer,
  opts: { deadlineSeconds?: number } = {},
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
  keys: { spendingPubkey: bigint; nullifierKeyHash: bigint; encryptionPubkey: bigint },
  recipient: ethers.Signer,
  opts: { deadlineSeconds?: number } = {},
): Promise<{ signature: string; deadline: bigint; submit: (submitter?: ethers.Signer) => Promise<ethers.ContractTransactionResponse> }> {
  const to = await recipient.getAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 3600));

  const domainData = await eip712Domain(domain);
  const types = {
    AcceptAlias: [
      { name: "aliasHash",        type: "bytes32" },
      { name: "spendingPubkey",   type: "bytes32" },
      { name: "nullifierKeyHash", type: "bytes32" },
      { name: "encryptionPubkey", type: "bytes32" },
      { name: "to",               type: "address" },
      { name: "nonce",            type: "uint256" },
      { name: "deadline",         type: "uint256" },
    ],
  };
  const value = {
    aliasHash:        h32(aliasHash),
    spendingPubkey:   h32(keys.spendingPubkey),
    nullifierKeyHash: h32(keys.nullifierKeyHash),
    encryptionPubkey: h32(keys.encryptionPubkey),
    to,
    nonce:    await domain.aliasNonce(h32(aliasHash)) as bigint,
    deadline,
  };
  const signature = await (recipient as any).signTypedData(domainData, types, value);

  return {
    signature,
    deadline,
    submit: (submitter?: ethers.Signer) => {
      const d = submitter ? domain.connect(submitter) as ethers.Contract : domain;
      return d.acceptAlias(
        h32(aliasHash), h32(keys.spendingPubkey), h32(keys.nullifierKeyHash),
        h32(keys.encryptionPubkey), deadline, signature,
      );
    },
  };
}

export async function lookupAlias(
  registry: ethers.Contract,
  aliasHash: bigint,
): Promise<{ spendingPubkey: bigint; nullifierKeyHash: bigint; encryptionPubkey: bigint; dataHash: bigint }> {
  const r = await registry.aliases(h32(aliasHash));
  return {
    spendingPubkey:   BigInt(r.spendingPubkey),
    nullifierKeyHash: BigInt(r.nullifierKeyHash),
    encryptionPubkey: BigInt(r.encryptionPubkey),
    dataHash:         BigInt(r.dataHash),
  };
}

/// The tuple form of a Registration, in the order the domain declares it. Order matters:
/// this is hashed, and a mismatch produces ClaimNotAuthorised rather than a decode error.
/// Exported because a prepared claim carries this shape to whoever submits it — the same
/// tuple the domain hashes, so the two cannot drift apart.
export function registrationTuple(r: Registration) {
  return {
    owner:            r.owner,
    aliasHash:        h32(r.aliasHash),
    spendingPubkey:   h32(r.spendingPubkey),
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

export async function claim(
  domain: ethers.Contract,
  registration: Registration,
  poolRoot: [bigint, bigint],
  treeNumber: [number, number],
  registryRoot: bigint,
  publicAmount: bigint,
  inputNullifiers: [bigint, bigint],
  outputCommitments: [bigint, bigint],
  params: TransactParams,
  encryptedOutput0: string,
  encryptedOutput1: string,
  proofBytes: string,
  name: string = "",
  pendingLeaf: bigint = 0n,
): Promise<ethers.ContractTransactionResponse> {
  return domain.claim(
    registrationTuple(registration),
    buildTransactParams(poolRoot, treeNumber, registryRoot, publicAmount, 0n,
                        inputNullifiers, outputCommitments, params, pendingLeaf),
    encryptedOutput0, encryptedOutput1, proofBytes, name,
  );
}

/// Mirrors HaliasPool._computeParamsHash exactly.
///
/// The pool hashes `p.relayerFee` as a struct, which ABI-encodes as two inline words. It
/// used to be one packed `bytes32`, so anything still producing the old preimage builds
/// proofs that verify against nothing. `contractAddress` is the POOL — not the domain —
/// because the pool hashes its own `address(this)`.
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
