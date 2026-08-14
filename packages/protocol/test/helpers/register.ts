import { ethers } from "hardhat";

/// Register through the commit-reveal flow.
///
/// Registration is two transactions now: a commitment, then the reveal at least
/// MIN_COMMIT_AGE blocks later. Tests go through here rather than calling `register`
/// directly so that the delay is applied consistently — a test that skips it fails with
/// CommitTooNew, which looks like a bug in the thing under test rather than in the test.
export async function registerAlias(
  domain: any,
  signer: any,
  /// The plaintext, including the .hls suffix. The contract derives the alias hash from it;
  /// there is no separate hash argument to disagree with it.
  name: string,
  spendingPubkey: string,
  nullifierKeyHash: string,
  encryptionPubkey: string,
  fee: bigint,
  /// Who ends up holding the name. Defaults to the sender, which is what most tests mean —
  /// a client passes a key derived from its own phrase instead, so the alias is not tied to
  /// whichever wallet paid.
  owner?: string,
) {
  const d = domain.connect(signer);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const holder = owner ?? signer.address;
  const commitment = await d.registrationCommitment(
    name, spendingPubkey, nullifierKeyHash, encryptionPubkey, holder, salt,
  );
  await (await d.commitRegistration(commitment)).wait();
  // Hardhat mines one block per transaction, so the commit itself does not satisfy
  // MIN_COMMIT_AGE — the reveal would land in the very next block. One empty block does.
  await ethers.provider.send("evm_mine", []);
  return d.register(name, spendingPubkey, nullifierKeyHash, encryptionPubkey, holder, salt,
                    { value: fee });
}

/// Sign an owner-authorised action so someone else can submit and pay for it.
///
/// `nonce` is overridable so a test can deliberately sign a stale one.
export async function signOwnerAction(
  domain: any,
  owner: any,
  typeName: "OfferAlias" | "CancelOffer" | "UpdateAliasData",
  aliasHash: string,
  fields: Record<string, any>,
  opts: { nonce?: bigint; deadline?: bigint } = {},
): Promise<{ deadline: bigint; signature: string }> {
  const deadline = opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const net = await ethers.provider.getNetwork();
  const types: Record<string, { name: string; type: string }[]> = {
    OfferAlias: [
      { name: "aliasHash", type: "bytes32" }, { name: "to", type: "address" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
    CancelOffer: [
      { name: "aliasHash", type: "bytes32" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
    UpdateAliasData: [
      { name: "aliasHash", type: "bytes32" }, { name: "dataHash", type: "bytes32" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };
  const signature = await owner.signTypedData(
    { name: "Halias", version: "1", chainId: Number(net.chainId), verifyingContract: await domain.getAddress() },
    { [typeName]: types[typeName] },
    { aliasHash, ...fields, nonce: opts.nonce ?? await domain.aliasNonce(aliasHash), deadline },
  );
  return { deadline, signature };
}

/// Perform an owner action the way the contract now requires: signed, submitted by anyone.
///
/// There is no unsigned path any more — the owner of an alias is a key derived from a
/// recovery phrase, which holds no ETH and cannot send a transaction. These wrap the
/// signature so a test reads as "the owner did X" rather than as EIP-712 plumbing.
export async function offerAliasAs(
  domain: any, owner: any, aliasHash: string, to: string, submitter?: any,
) {
  const { deadline, signature } = await signOwnerAction(domain, owner, "OfferAlias", aliasHash, { to });
  return domain.connect(submitter ?? owner).offerAlias(aliasHash, to, deadline, signature);
}

export async function cancelOfferAs(domain: any, owner: any, aliasHash: string, submitter?: any) {
  const { deadline, signature } = await signOwnerAction(domain, owner, "CancelOffer", aliasHash, {});
  return domain.connect(submitter ?? owner).cancelOffer(aliasHash, deadline, signature);
}

export async function updateAliasDataAs(
  domain: any, owner: any, aliasHash: string, dataHash: string, submitter?: any,
) {
  const { deadline, signature } =
    await signOwnerAction(domain, owner, "UpdateAliasData", aliasHash, { dataHash });
  return domain.connect(submitter ?? owner).updateAliasData(aliasHash, dataHash, deadline, signature);
}

/// Complete an offered transfer: the recipient signs, anyone may submit.
export async function acceptAliasAs(
  domain: any,
  recipient: any,
  aliasHash: string,
  spendingPubkey: string,
  nullifierKeyHash: string,
  encryptionPubkey: string,
  submitter?: any,
) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const net = await ethers.provider.getNetwork();
  const sig = await recipient.signTypedData(
    { name: "Halias", version: "1", chainId: Number(net.chainId), verifyingContract: await domain.getAddress() },
    { AcceptAlias: [
      { name: "aliasHash", type: "bytes32" }, { name: "spendingPubkey", type: "bytes32" },
      { name: "nullifierKeyHash", type: "bytes32" }, { name: "encryptionPubkey", type: "bytes32" },
      { name: "to", type: "address" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] },
    { aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey,
      to: recipient.address, nonce: await domain.aliasNonce(aliasHash), deadline },
  );
  return domain.connect(submitter ?? recipient).acceptAlias(
    aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, deadline, sig,
  );
}
