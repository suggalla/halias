import { expect } from "chai";
import { ethers } from "hardhat";
import {
  registerAlias, acceptAliasAs, signOwnerAction,
  offerAliasAs, cancelOfferAs, updateAliasDataAs, signClaimInvite,
} from "./helpers/register";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { aliasHashToKey } from "./helpers/smt";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";
import { registrationCommitment, deriveInviteKeys, inviteEntryHash, init as initSdkCrypto } from "halias-sdk";
import { FIELD_PRIME, randField } from "./helpers/field";
import { ZERO_PROOF, NO_RELAYER, rand32 } from "./helpers/tx";

// The SMT leaf a registration inserts: Poseidon(aliasKey, Poseidon(pk, nkh, dataHash), 1).
// A claim's proof performs this insertion itself, and the pool requires the public signal to
// equal what the registry armed — so a claim built without it is rejected outright.
const pendingLeafFor = (r: any) =>
  ethers.toBeHex(poseidonHash([
    aliasHashToKey(r.aliasHash),
    poseidonHash([BigInt(r.spendingCommitment), BigInt(r.nullifierKeyHash), 0n]),
    1n,
  ]), 32);

// HaliasController — names, ownership, fees, and the claim path.
//
// The claim path is why this file exists, and the reason is a bug shape worth stating rather
// than a history. Registering out of a pool note mints an alias to an owner; if that owner is
// taken from `msg.sender`, then on a *relayed* claim it is the relayer — who could keep the
// alias it was paid to submit, rotate its keys, and redirect every future payment to that
// name. So the owner is bound into `externalData` and committed inside `paramsHash`, and the
// tests below drive every claim through a relayer precisely so a regression cannot hide
// behind a self-submitted happy path.
//
// Ownership now comes from `Registration.owner`, hashed into externalData and committed
// inside paramsHash. "a relayer submitting a claim does not receive the alias" below is the
// regression test for that.


const REG_TUPLE =
  "tuple(address owner,bytes32 aliasHash,bytes32 spendingCommitment,bytes32 nullifierKeyHash,bytes32 encryptionPubkey)";

const withdrawOf = (amount: bigint) => FIELD_PRIME - amount;

let nameSeq = 0;
/// A fresh alias name and the hash the contract derives from it.
///
/// The contract derives the hash from the name, so a test wanting a particular hash has to
/// start from a name rather than picking a random one.
const freshName = (): { name: string; h: string } => {
  const name = `t${nameSeq++}x${Math.floor(Math.random() * 1e9)}.hls`;
  return { name, h: ethers.keccak256(ethers.toUtf8Bytes(name)) };
};
// dataHash is a Poseidon leaf input, so it has to land inside the scalar field.

describe("HaliasController", function () {
  this.timeout(120000);

  before(async function () {
    await initPoseidon();
  });

  let domain: any, registry: any, pool: any, token: any;
  let domainAddr: string, poolAddr: string;
  let admin: any, user: any, claimer: any, relayer: any, other: any;
  let FEE: bigint;

  const PK  = ethers.toBeHex(11n, 32);
  const NKH = ethers.toBeHex(22n, 32);
  const ENC = ethers.toBeHex(33n, 32);

  const encodeRegistration = (r: any) =>
    ethers.AbiCoder.defaultAbiCoder().encode([REG_TUPLE], [r]);

  function registration(overrides: any = {}) {
    return {
      owner: claimer.address, aliasHash: rand32(),
      spendingCommitment: PK, nullifierKeyHash: NKH, encryptionPubkey: ENC,
      ...overrides,
    };
  }

  async function claimParams(r: any, relayerFee = NO_RELAYER) {
    return {
      pendingLeaf:       pendingLeafFor(r),
      outputsEmpty:      false,
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
      registryRoot:      await registry.getRegistryRoot(),
      // Only the relayer is paid from the note. The registration fee was paid in ETH when
      // the invite was created, so a claim owes this contract nothing — and withdrawOf(0)
      // would be FIELD_PRIME, which is not a field element.
      publicAmount:      relayerFee.amount > 0n ? withdrawOf(relayerFee.amount) : 0n,
      tokenAddress:      ethers.ZeroAddress,
      inputNullifiers:   [rand32(), rand32(), rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient:         ethers.ZeroAddress,
      relayerFee,
      externalData:      ethers.keccak256(encodeRegistration(r)),
    };
  }

  // An invite entry: keys, and deliberately nothing else. Its identity is forced to
  // keccak256(spendingCommitment), so the caller cannot point it at a name — which is what
  // lets one fee buy this registration and the claimer's without selling two names for one.
  function inviteRegistration(owner: string, overrides: any = {}) {
    const spendingCommitment = ethers.toBeHex(randField(), 32);
    return {
      owner, aliasHash: ethers.keccak256(spendingCommitment),
      spendingCommitment, nullifierKeyHash: NKH, encryptionPubkey: ENC,
      ...overrides,
    };
  }

  // Funding an invite is a transfer, not a withdrawal: the value comes from the creator's own
  // shielded balance and never becomes public. Nothing may leave the pool here at all.
  async function inviteParams(r: any, overrides: any = {}) {
    return { ...await claimParams(r), publicAmount: 0n, recipient: ethers.ZeroAddress, ...overrides };
  }

  /// Create an invite and hand back the credit plus the key that can spend it.
  ///
  /// The owner is a throwaway wallet because that is what it is in practice — an address
  /// derived from the invite secret, holding no ETH and never submitting anything. Whoever
  /// holds the code can reconstruct it; that is the entire access control on the credit.
  async function makeInvite(submitter?: any) {
    const inviteOwner = ethers.Wallet.createRandom();
    const r = inviteRegistration(inviteOwner.address);
    await (await domain.connect(submitter ?? user)
      .createInvite(r, await inviteParams(r), "0x", "0x", ZERO_PROOF, { value: FEE })).wait();
    return { inviteOwner, entryHash: r.aliasHash, r };
  }

  /// Redeem a credit: the claimer's registration, signed by the invite key.
  async function claimAgainst(
    invite: { inviteOwner: any; entryHash: string },
    r: any,
    opts: { params?: any; name?: string; submitter?: any; sig?: any } = {},
  ) {
    const { deadline, signature } = opts.sig ??
      await signClaimInvite(domain, invite.inviteOwner, invite.entryHash, r.aliasHash);
    return domain.connect(opts.submitter ?? relayer).claim(
      r, opts.params ?? await claimParams(r), "0x", "0x", ZERO_PROOF, opts.name ?? "",
      invite.entryHash, deadline, signature,
    );
  }

  // Puts ETH in the pool so a claim has something to withdraw against.
  async function fundPool(amount: bigint) {
    await (await pool.transact({
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
      registryRoot: await registry.getRegistryRoot(),
      publicAmount: amount, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32(), rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER, externalData: ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
    }, "0x", "0x", ZERO_PROOF, { value: amount })).wait();
  }

  // Deploying the stack costs more than every assertion that follows it, and 47 tests each
  // wanted it clean. loadFixture runs it once and reverts the chain to that snapshot for the
  // rest, which is the same isolation for a fraction of the work.
  async function deployStack() {
    const [admin, user, claimer, relayer, other] = await ethers.getSigners();

    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    const registryLibs = { PoseidonT3: t3, PoseidonT4: t4 };
    const poolLibs     = { PoseidonT3: t3 };
    const verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();

    // Registry needs the domain, the domain needs the registry: the dependency is a
    // cycle, so one address has to be known before it exists. Production resolves this with
    // CREATE2; here the plain nonce-derived address is enough and exercises the same shape.
    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const domainAddr = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });

    const registry = await (await ethers.getContractFactory("HaliasRegistry", { libraries: registryLibs }))
      .deploy(domainAddr);
    const pool = await (await ethers.getContractFactory("HaliasPool", { libraries: poolLibs }))
      .deploy(verifier, verifier, await registry.getAddress());
    const domain = await (await ethers.getContractFactory("HaliasController"))
      .deploy(await pool.getAddress(), await registry.getAddress(), admin.address);

    expect(await domain.getAddress()).to.equal(domainAddr);

    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Test", "TST", 18);

    return {
      admin, user, claimer, relayer, other,
      registry, pool, domain, token,
      domainAddr, poolAddr: await pool.getAddress(),
      FEE: await domain.registrationFee(),
    };
  }

  beforeEach(async function () {
    ({ admin, user, claimer, relayer, other,
       registry, pool, domain, token,
       domainAddr, poolAddr, FEE } = await loadFixture(deployStack));
  });

  // ── Construction ────────────────────────────────────────────────────────────

  it("rejects any zero dependency", async function () {
    const F = await ethers.getContractFactory("HaliasController");
    const a = await registry.getAddress();
    await expect(F.deploy(ethers.ZeroAddress, a, admin.address)).to.be.revertedWithCustomError(F, "ZeroDependency");
    await expect(F.deploy(poolAddr, ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(F, "ZeroDependency");
    await expect(F.deploy(poolAddr, a, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroDependency");
  });

  it("is the registry's sole writer", async function () {
    expect(await registry.controller()).to.equal(domainAddr);
    await expect(registry.register(rand32(), PK, NKH, ENC))
      .to.be.revertedWithCustomError(registry, "NotController");
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe("register", function () {
    it("mints to the payer and writes the registry", async function () {
      const { name: hName, h } = freshName();
      await (await registerAlias(domain, user, hName, PK, NKH, ENC, FEE)).wait();

      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
      expect(await registry.isRegistered(h)).to.equal(true);
      expect(await domain.accumulatedFees()).to.equal(FEE);
    });

    it("requires exactly the registration fee", async function () {
      await expect(registerAlias(domain, user, freshName().name, PK, NKH, ENC, FEE - 1n))
        .to.be.revertedWithCustomError(domain, "WrongRegistrationFee");
      await expect(registerAlias(domain, user, freshName().name, PK, NKH, ENC, FEE + 1n))
        .to.be.revertedWithCustomError(domain, "WrongRegistrationFee");
    });

    it("always publishes the name, since the hash is derived from it", async function () {
      // There is no longer a way to register a name without publishing it, and no separate
      // hash argument that could disagree with it. Recovering an alias after losing local
      // storage depends on this: aliasHash is one-way and registration is the only moment
      // the plaintext can be supplied.
      const name = "alice.hls";
      const h = ethers.keccak256(ethers.toUtf8Bytes(name));
      await expect(registerAlias(domain, user, name, PK, NKH, ENC, FEE))
        .to.emit(domain, "NamePublished").withArgs(h, name);
      expect(await domain.aliasToHash(name)).to.equal(h);
    });

    it("registers in one transaction through the direct path", async function () {
      // No commitment, no maturity wait. The trade is stated at the function: the name is in
      // the calldata, so on a public mempool this is front-runnable — which is exactly what
      // the two-step path exists to prevent.
      const { name, h } = freshName();
      await expect(domain.connect(user).directRegistration(name, PK, NKH, ENC, user.address, { value: FEE }))
        .to.emit(domain, "NamePublished").withArgs(h, name);
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
    });

    it("charges the direct path the same fee, and refuses a name already taken", async function () {
      const { name } = freshName();
      await expect(domain.connect(user).directRegistration(name, PK, NKH, ENC, user.address, { value: FEE - 1n }))
        .to.be.revertedWithCustomError(domain, "WrongRegistrationFee");
      await (await domain.connect(user).directRegistration(name, PK, NKH, ENC, user.address, { value: FEE })).wait();
      // Both paths write through the same core, so taken-ness is enforced once, not twice.
      await expect(domain.connect(other).directRegistration(name, PK, NKH, ENC, user.address, { value: FEE }))
        .to.be.revertedWithCustomError(registry, "AliasTaken");
    });

    it("rejects an empty name rather than registering under keccak(\"\")", async function () {
      // That is one fixed hash, so exactly one alias could ever hold it and every attempt
      // after would read as an ordinary "alias taken".
      await expect(registerAlias(domain, user, "", PK, NKH, ENC, FEE))
        .to.be.revertedWithCustomError(domain, "EmptyName");
    });

    it("refuses an alias that is already taken, minting nothing", async function () {
      const { name: hName, h } = freshName();
      await (await registerAlias(domain, user, hName, PK, NKH, ENC, FEE)).wait();
      await expect(registerAlias(domain, other, hName, PK, NKH, ENC, FEE))
        .to.be.revertedWithCustomError(registry, "AliasTaken");
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
    });
  });

  // ── claim ───────────────────────────────────────────────────────────────────

  describe("createInvite", function () {
    it("registers a keys-only account and takes one fee, from the wallet", async function () {
      const inviteOwner = ethers.Wallet.createRandom();
      const r = inviteRegistration(inviteOwner.address);
      const before = await ethers.provider.getBalance(poolAddr);

      const tx = domain.connect(user).createInvite(r, await inviteParams(r), "0x", "0x", ZERO_PROOF, { value: FEE });
      await expect(tx)
        .to.emit(domain, "InviteCreated").withArgs(r.aliasHash, inviteOwner.address, user.address);
      // Nothing published, because there is no plaintext to publish. Every client labels
      // aliases from NamePublished, and this entry is meant to be invisible to all of them.
      await expect(tx).to.not.emit(domain, "NamePublished");

      // A leaf the note can prove membership against, a credit for the claimer to spend, and
      // no name: the entry is in the registry but not in the namespace.
      expect(await registry.isRegistered(r.aliasHash)).to.equal(true);
      expect(await domain.prepaidClaim(r.aliasHash)).to.equal(inviteOwner.address);
      // And no token, so it cannot be transferred, listed, or mistaken for an alias.
      await expect(domain.ownerOf(BigInt(r.aliasHash))).to.be.reverted;

      // One fee, and it came from the wallet — the pool's balance is untouched, which is the
      // legal line this whole design exists to hold.
      expect(await domain.accumulatedFees()).to.equal(FEE);
      expect(await ethers.provider.getBalance(poolAddr)).to.equal(before);
    });

    it("refuses an entry whose identity is not derived from its own keys", async function () {
      // THE REGRESSION TEST for two names on one fee. If the caller could choose the hash,
      // this path would register an arbitrary name and then hand out a second one free.
      const { h } = freshName();
      const r = inviteRegistration(other.address, { aliasHash: h });
      await expect(domain.connect(user).createInvite(r, await inviteParams(r), "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "NotAnInviteEntry");
      expect(await registry.isRegistered(h)).to.equal(false);
    });

    it("requires exactly the registration fee", async function () {
      const r = inviteRegistration(other.address);
      for (const value of [FEE - 1n, FEE + 1n, 0n]) {
        await expect(domain.connect(user).createInvite(r, await inviteParams(r), "0x", "0x", ZERO_PROOF, { value }))
          .to.be.revertedWithCustomError(domain, "WrongRegistrationFee");
      }
    });

    it("refuses to let anything leave the pool", async function () {
      // The point of paying in ETH. A withdrawal here would be protocol revenue drawn from
      // shielded funds however it were dressed up, so the recipient field is refused before
      // the pool is ever called.
      const r = inviteRegistration(other.address);
      const p = await inviteParams(r, { recipient: user.address, publicAmount: withdrawOf(FEE) });
      await expect(domain.connect(user).createInvite(r, p, "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "InviteMustNotPayOut");
    });

    it("refuses a withdrawal aimed at this contract by leaving the recipient empty", async function () {
      // The second half of the same guard: dodge `recipient` by omitting it, and the pool's
      // own payee check refuses to send value to nobody.
      await fundPool(FEE);
      const r = inviteRegistration(other.address);
      const p = await inviteParams(r, { publicAmount: withdrawOf(FEE) });
      await expect(domain.connect(user).createInvite(r, p, "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.be.revertedWithCustomError(pool, "BadPayee");
    });

    it("rejects a registration the proof did not authorise", async function () {
      const r = inviteRegistration(other.address);
      const p = await inviteParams(r);
      const tampered = inviteRegistration(relayer.address, { aliasHash: r.aliasHash });
      await expect(domain.connect(user).createInvite(tampered, p, "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "ClaimNotAuthorised");
    });

    it("rejects a token-denominated invite and a zero owner", async function () {
      const r = inviteRegistration(other.address);
      await expect(domain.connect(user).createInvite(
        r, await inviteParams(r, { tokenAddress: await token.getAddress() }), "0x", "0x", ZERO_PROOF, { value: FEE },
      )).to.be.revertedWithCustomError(domain, "ClaimMustBeETH");

      const z = inviteRegistration(ethers.ZeroAddress);
      await expect(domain.connect(user).createInvite(z, await inviteParams(z), "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "InvalidOwner");
    });

    it("accepts the entry hash the SDK derives, byte for byte", async function () {
      // A cross-system agreement, and a silent one when it breaks: the SDK computes this
      // hash to decide what to register and the claimer recomputes it from the secret to find
      // the note. Drift either reverts as NotAnInviteEntry or — worse — registers at a hash
      // the claimer cannot reproduce, stranding the funds. Only e2e-live covered it, and
      // e2e-live is not what CI runs.
      await initSdkCrypto();   // the SDK carries its own Poseidon, separate from the helpers'
      const temp = deriveInviteKeys(12345678901234567890n);
      const r = {
        owner: other.address,
        aliasHash: inviteEntryHash(temp.spendingCommitment),
        spendingCommitment: ethers.toBeHex(temp.spendingCommitment, 32),
        nullifierKeyHash:   ethers.toBeHex(temp.nullifierKeyHash, 32),
        encryptionPubkey:   ethers.toBeHex(temp.encryptionPubkeyField, 32),
      };
      await expect(domain.connect(user).createInvite(r, await inviteParams(r), "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.emit(domain, "InviteCreated").withArgs(r.aliasHash, other.address, user.address);
    });

    it("refuses to reuse an entry, since the same keys hash the same way", async function () {
      const { r } = await makeInvite();
      await expect(domain.connect(user).createInvite(r, await inviteParams(r), "0x", "0x", ZERO_PROOF, { value: FEE }))
        .to.be.revertedWithCustomError(registry, "AliasTaken");
    });
  });

  // ── claim ───────────────────────────────────────────────────────────────────

  describe("claim", function () {
    it("a relayer submitting a claim does not receive the alias", async function () {
      // THE REGRESSION TEST. The relayer submits, pays the gas, takes its fee — and the
      // alias belongs to the claimer named in the proof-bound registration.
      const relayerFee = ethers.parseEther("0.01");
      await fundPool(relayerFee);
      const invite = await makeInvite();

      const r = registration();
      const p = await claimParams(r, { relayer: relayer.address, amount: relayerFee });
      const before = await ethers.provider.getBalance(relayer.address);

      await expect(claimAgainst(invite, r, { params: p }))
        .to.emit(domain, "AliasClaimed").withArgs(r.aliasHash, claimer.address, relayer.address);

      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(claimer.address);
      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.not.equal(relayer.address);

      // And the relayer was paid by the pool directly, not by this contract.
      const spent = before - await ethers.provider.getBalance(relayer.address);
      expect(spent).to.be.lessThan(relayerFee);   // fee exceeded the gas it cost to submit
    });

    it("takes no second fee, and nothing at all out of the pool", async function () {
      // The arithmetic the whole prepaid design exists for: one fee, paid in ETH at creation,
      // buying both registrations. A claim that drew its fee from the note would be revenue
      // out of shielded funds — the thing this must never do.
      await fundPool(ethers.parseEther("1"));
      const invite = await makeInvite();
      const poolBefore = await ethers.provider.getBalance(poolAddr);

      const r = registration();
      await (await claimAgainst(invite, r)).wait();

      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(claimer.address);
      expect(await domain.accumulatedFees()).to.equal(FEE);
      expect(await ethers.provider.getBalance(poolAddr)).to.equal(poolBefore);
      expect(await ethers.provider.getBalance(domainAddr)).to.equal(FEE);
    });

    it("refuses a claim with no prepaid credit", async function () {
      // Without this the claim path is a free registration for anyone who calls it, and the
      // fee is optional for everybody.
      const r = registration();
      await expect(claimAgainst({ inviteOwner: ethers.Wallet.createRandom(), entryHash: rand32() }, r))
        .to.be.revertedWithCustomError(domain, "NoPrepaidClaim");
    });

    it("spends a credit exactly once", async function () {
      // A counter would have been fungible: hold one invite, watch the total, claim as many
      // names as anyone else had paid for. One credit, one name, keyed to the entry.
      const invite = await makeInvite();
      await (await claimAgainst(invite, registration())).wait();

      await expect(claimAgainst(invite, registration()))
        .to.be.revertedWithCustomError(domain, "NoPrepaidClaim");
    });

    it("refuses a credit signed by anyone but the invite key", async function () {
      // The credit is stored with the address allowed to spend it, so watching the chain for
      // an outstanding invite is not enough to take it. Only the code is.
      const invite = await makeInvite();
      const r = registration();
      const stranger = { inviteOwner: ethers.Wallet.createRandom(), entryHash: invite.entryHash };
      await expect(claimAgainst(stranger, r))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
      // Refused, and still there for its rightful holder.
      expect(await domain.prepaidClaim(invite.entryHash)).to.equal(invite.inviteOwner.address);
    });

    it("binds the signature to the name it authorises", async function () {
      // Otherwise a signature captured in flight — from a mempool, say — registers the credit
      // to a name of the observer's choosing instead.
      const invite = await makeInvite();
      const sig = await signClaimInvite(domain, invite.inviteOwner, invite.entryHash, rand32());
      await expect(claimAgainst(invite, registration(), { sig }))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
    });

    it("refuses an expired signature", async function () {
      const invite = await makeInvite();
      const r = registration();
      const deadline = BigInt(await time.latest()) - 1n;
      const sig = await signClaimInvite(domain, invite.inviteOwner, invite.entryHash, r.aliasHash, { deadline });
      await expect(claimAgainst(invite, r, { sig }))
        .to.be.revertedWithCustomError(domain, "AuthorizationExpired");
    });

    it("registers with no ETH of the claimer's own", async function () {
      // The onboarding claim: submitted by the claimer, from an address that has never held
      // anything. Nothing in the transaction is payable and no fee is owed.
      const invite = await makeInvite();
      const fresh = ethers.Wallet.createRandom().connect(ethers.provider);
      await (await user.sendTransaction({ to: fresh.address, value: ethers.parseEther("0.05") })).wait();
      const r = registration({ owner: fresh.address });

      await (await claimAgainst(invite, r, { submitter: fresh })).wait();
      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(fresh.address);
    });

    it("rejects a registration the proof did not authorise", async function () {
      const invite = await makeInvite();
      const r = registration();
      const p = await claimParams(r);

      // Every field is bound. Swapping any one of them invalidates the claim.
      for (const tampered of [
        { ...r, owner: relayer.address },
        { ...r, spendingCommitment: ethers.toBeHex(99n, 32) },
        { ...r, nullifierKeyHash: ethers.toBeHex(99n, 32) },
        { ...r, encryptionPubkey: ethers.toBeHex(99n, 32) },
      ]) {
        await expect(claimAgainst(invite, tampered, { params: p }))
          .to.be.revertedWithCustomError(domain, "ClaimNotAuthorised");
      }
    });

    it("rejects a claim that pays this contract anything", async function () {
      // Belt and braces around the fee: whatever the proof says, if value lands here the
      // claim is refused rather than quietly booked as revenue.
      await fundPool(ethers.parseEther("1"));
      const invite = await makeInvite();
      const r = registration();
      const p = { ...await claimParams(r), publicAmount: withdrawOf(FEE), recipient: domainAddr };
      p.externalData = ethers.keccak256(encodeRegistration(r));

      await expect(claimAgainst(invite, r, { params: p }))
        .to.be.revertedWithCustomError(domain, "ClaimMustPayNothing").withArgs(FEE);
    });

    it("rejects a token-denominated claim", async function () {
      const invite = await makeInvite();
      const r = registration();
      const p = { ...await claimParams(r), tokenAddress: await token.getAddress() };
      p.externalData = ethers.keccak256(encodeRegistration(r));

      await expect(claimAgainst(invite, r, { params: p }))
        .to.be.revertedWithCustomError(domain, "ClaimMustBeETH");
    });

    it("rejects a zero owner", async function () {
      const invite = await makeInvite();
      const r = registration({ owner: ethers.ZeroAddress });
      await expect(claimAgainst(invite, r))
        .to.be.revertedWithCustomError(domain, "InvalidOwner");
    });
  });

  // ── Alias maintenance ───────────────────────────────────────────────────────

  // ── F1: the claim no longer predicts a root ─────────────────────────────────

  describe("pending registration", function () {
    // A claim's change note is a non-zero output, so it needs registry membership for an
    // alias that is not in the tree when the proof is built. Predicting the post-registration
    // root would mean any other registry write landing in between kills the claim — cheap to
    // trigger deliberately, and worst on the onboarding path.
    //
    // Instead the proof carries the insertion, against a root that already exists. These are the
    // assertions that distinguish the two designs.

    it("survives registry writes landing between preparation and submission", async function () {
      await initPoseidon();
      await fundPool(FEE * 4n);
      const invite = await makeInvite();
      const r = registration();
      // Prepared against the root as it stands now.
      const p = await claimParams(r);

      // Three unrelated writes land first — one of each kind that touches a leaf.
      const { name: other1Name, h: other1 } = freshName();
      await (await registerAlias(domain, other, other1Name, PK, NKH, ENC, FEE)).wait();
      await (await updateAliasDataAs(domain, other, other1, randField())).wait();
      await (await offerAliasAs(domain, other, other1, user.address)).wait();
      await (await acceptAliasAs(domain, user, other1, PK, NKH, ENC)).wait();

      // The prepared claim still goes through: its root is superseded but known, and the
      // insertion is derived rather than guessed.
      await expect(claimAgainst(invite, r, { params: p }))
        .to.emit(registry, "AliasRegistered");
      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(claimer.address);
      // The NFT and the registry entry are written by different contracts, so one landing
      // without the other is a reachable state and worth ruling out explicitly.
      expect(await registry.isRegistered(r.aliasHash), "NFT minted without a registry entry")
        .to.equal(true);
    });

    it("refuses an ordinary transact that claims an insertion", async function () {
      // The whole reason pendingLeaf is a public signal the contract supplies. A prover who
      // could choose it would insert their own unregistered keys into a tree of their
      // choosing and pay themselves — which is precisely what the registry proof prevents.
      await expect(pool.connect(user).transact({
        poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
        registryRoot: await registry.getRegistryRoot(),
        publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
        inputNullifiers: [rand32(), rand32(), rand32(), rand32()],
        outputCommitments: [rand32(), rand32()],
        recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER,
        externalData: ethers.ZeroHash,
        pendingLeaf: rand32(),
      outputsEmpty:      false,
      }, "0x", "0x", ZERO_PROOF)).to.be.revertedWithCustomError(pool, "PendingLeafNotArmed");
    });

    it("refuses a claim carrying an insertion other than the one being registered", async function () {
      await initPoseidon();
      await fundPool(FEE * 4n);
      const invite = await makeInvite();
      const r = registration();
      const p = { ...(await claimParams(r)), pendingLeaf: rand32() , outputsEmpty: false};
      await expect(claimAgainst(invite, r, { params: p }))
        .to.be.revertedWithCustomError(pool, "PendingLeafNotArmed");
    });

    it("refuses a claim publishing a name that is not its own", async function () {
      // `claim` takes the alias hash and the plaintext name as separate arguments, so unlike
      // a reveal they can disagree — and `_publishName` is the only place they are checked
      // against each other.
      //
      // Worth refusing: every client reads NamePublished to label an alias. A claim that
      // published someone else's name for its own hash would make its alias *display* as that
      // name in histories and pickers, while payments to the real name still resolved
      // elsewhere. Nothing is stolen; the lie is in what people see.
      await initPoseidon();
      await fundPool(FEE * 4n);
      const invite = await makeInvite();
      const r = registration();
      await expect(claimAgainst(invite, r, { name: "somebodyelse.hls" }))
        .to.be.revertedWithCustomError(domain, "NameDoesNotMatchAlias");
    });

    it("does not leave the authorisation set for a later transaction", async function () {
      // Transient storage, so it cannot outlive the transaction that set it. If it were
      // persistent, the next ordinary transact would have to carry a stale leaf or revert.
      await initPoseidon();
      await fundPool(FEE * 4n);
      const invite = await makeInvite();
      const r = registration();
      await (await claimAgainst(invite, r)).wait();

      expect(await registry.pendingLeaf()).to.equal(ethers.ZeroHash);
      await expect(pool.connect(user).transact({
        poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
        registryRoot: await registry.getRegistryRoot(),
        publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
        inputNullifiers: [rand32(), rand32(), rand32(), rand32()],
        outputCommitments: [rand32(), rand32()],
        recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER,
        externalData: ethers.ZeroHash, pendingLeaf: ethers.ZeroHash,
      outputsEmpty:      false,
      }, "0x", "0x", ZERO_PROOF)).to.emit(pool, "Transact");
    });

    it("only the controller may arm an insertion", async function () {
      const { name: hName, h } = freshName();
      await (await registerAlias(domain, user, hName, PK, NKH, ENC, FEE)).wait();
      await expect(registry.connect(user).authorizePendingLeaf(h))
        .to.be.revertedWithCustomError(registry, "NotController");
    });
  });

  describe("alias maintenance", function () {
    let h: string;
    let hName: string;

    beforeEach(async function () {
      ({ name: hName, h } = freshName());
      await (await registerAlias(domain, user, hName, PK, NKH, ENC, FEE)).wait();
    });

    it("only the owner's signature authorises anything", async function () {
      // There is no sender-based path left: the owner of an alias is a key derived from a
      // recovery phrase, which holds no ETH and can only sign. So a stranger fails by
      // signing wrongly rather than by being the wrong caller.
      await expect(updateAliasDataAs(domain, other, h, randField()))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
      await expect(offerAliasAs(domain, other, h, other.address))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
      await expect(cancelOfferAs(domain, other, h))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
      // The positive control for the three refusals above. It has to show the write landed,
      // not merely that it was permitted — a signature check that passes and then does
      // nothing would satisfy a not-reverted assertion.
      const newData = randField();
      const leafBefore = await registry.getRegistryRoot();
      await expect(updateAliasDataAs(domain, user, h, newData))
        .to.emit(registry, "AliasDataUpdated");
      expect((await registry.aliases(h)).dataHash, "the record was not written")
        .to.equal(newData);
      expect(await registry.getRegistryRoot(), "the tree did not follow the record")
        .to.not.equal(leafBefore);
    });

    it("refuses an action with no signature at all", async function () {
      await expect(domain.connect(user).offerAlias(h, other.address, 1n << 40n, "0x"))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
    });

    it("an offer moves nothing until it is accepted", async function () {
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      // The seller still owns it and still receives to it — there is no in-transit state.
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
      expect((await registry.aliases(h)).spendingCommitment).to.equal(PK);
      expect(await domain.pendingAliasOwner(h)).to.equal(other.address);
    });

    it("the recipient chooses the keys, and a third party may submit", async function () {
      // The old transferAlias let the *seller* pick both the new owner and the new keys, with
      // nothing relating them — so a seller could hand over the token while keeping keys that
      // received every payment. Authority is the recipient's signature now, and because it is
      // a signature rather than msg.sender, a relayer can pay for inclusion.
      const newPk = ethers.toBeHex(66n, 32);
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await (await acceptAliasAs(domain, other, h, newPk, ethers.toBeHex(77n, 32),
                                 ethers.toBeHex(88n, 32), user)).wait();

      expect(await domain.ownerOf(BigInt(h))).to.equal(other.address);
      expect((await registry.aliases(h)).spendingCommitment).to.equal(newPk);
      // The old owner can no longer act on it.
      await expect(updateAliasDataAs(domain, user, h, randField()))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
    });

    it("a second offer replaces the first, which can no longer be taken", async function () {
      // The UI warns about this, so it had better be true. There is one pending owner, not a
      // queue: offering again overwrites, and the earlier recipient is left holding an offer
      // that names them and no longer exists.
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await (await offerAliasAs(domain, user, h, claimer.address)).wait();
      expect(await domain.pendingAliasOwner(h)).to.equal(claimer.address);

      await expect(acceptAliasAs(domain, other, h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
      // And the one it was replaced by still works.
      await (await acceptAliasAs(domain, claimer, h, PK, NKH, ENC)).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(claimer.address);
    });

    it("cannot be accepted by anyone but the address it was offered to", async function () {
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await expect(acceptAliasAs(domain, claimer, h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
    });

    it("cannot be accepted when nothing was offered", async function () {
      await expect(acceptAliasAs(domain, other, h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(domain, "NoOffer");
    });

    it("an accepted offer cannot be accepted twice", async function () {
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await (await acceptAliasAs(domain, other, h, PK, NKH, ENC)).wait();
      // The offer is consumed, not merely satisfied — otherwise a second acceptance would
      // reinstall keys on an alias its new owner now controls.
      await expect(acceptAliasAs(domain, other, h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(domain, "NoOffer");
    });

    it("keeps the alias in its slot across every mutation", async function () {
      const slot = await registry.aliasSlot(h);
      await (await updateAliasDataAs(domain, user, h, randField())).wait();
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await (await acceptAliasAs(domain, other, h, PK, NKH, ENC)).wait();
      expect(await registry.aliasSlot(h)).to.equal(slot);
    });

    it("has no updateKeys at all", async function () {
      // Removed rather than kept alongside. It wrote the nullifier and encryption keys but
      // never the spending commitment, so the one compromise that loses funds was the one it
      // could not answer — behind a name that implied otherwise. Rotation is an offer to
      // yourself, which replaces all three.
      expect(domain.interface.fragments.some((f: any) => f.name === "updateKeys")).to.equal(false);
    });

    it("rotates every key by offering the alias to yourself", async function () {
      const newPk = ethers.toBeHex(0x1111n, 32);
      await (await offerAliasAs(domain, user, h, user.address)).wait();
      await (await acceptAliasAs(domain, user, h, newPk, ethers.toBeHex(0x2222n, 32),
                                 ethers.toBeHex(0x3333n, 32))).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
      expect((await registry.aliases(h)).spendingCommitment).to.equal(newPk);
    });

    it("lets anyone submit an action the owner signed", async function () {
      // The point of the signature path: someone recovering from a compromised key is
      // exactly the person least likely to hold ETH, and rotation is what they need to do.
      const { deadline, signature } =
        await signOwnerAction(domain, user, "OfferAlias", h, { to: other.address });
      await (await domain.connect(other).offerAlias(h, other.address, deadline, signature)).wait();
      expect(await domain.pendingAliasOwner(h)).to.equal(other.address);
    });

    it("refuses a signature from anyone but the owner", async function () {
      const { deadline, signature } =
        await signOwnerAction(domain, other, "OfferAlias", h, { to: other.address });
      await expect(domain.connect(other).offerAlias(h, other.address, deadline, signature))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
    });

    it("refuses an expired signature", async function () {
      const past = BigInt(Math.floor(Date.now() / 1000) - 10);
      const { deadline, signature } = await signOwnerAction(
        domain, user, "OfferAlias", h, { to: other.address }, { deadline: past });
      await expect(domain.connect(other).offerAlias(h, other.address, deadline, signature))
        .to.be.revertedWithCustomError(domain, "AuthorizationExpired");
    });

    it("burns a signature after one use", async function () {
      const { deadline, signature } =
        await signOwnerAction(domain, user, "OfferAlias", h, { to: other.address });
      await (await domain.connect(other).offerAlias(h, other.address, deadline, signature)).wait();
      await expect(domain.connect(other).offerAlias(h, other.address, deadline, signature))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
    });

    it("invalidates an outstanding signature when the owner acts directly", async function () {
      // One sentence to reason about: any authorised action on an alias invalidates every
      // signature outstanding for it. Without this, an owner who signs an offer and then
      // changes their mind by acting directly leaves the old signature live for someone
      // else to submit afterwards.
      const { deadline, signature } =
        await signOwnerAction(domain, user, "OfferAlias", h, { to: other.address });
      await (await updateAliasDataAs(domain, user, h, randField())).wait();
      await expect(domain.connect(other).offerAlias(h, other.address, deadline, signature))
        .to.be.revertedWithCustomError(domain, "NotSignedByAuthority");
    });

    it("refuses to authorise anything against an alias that does not exist", async function () {
      // A malformed signature recovers to the zero address, which is also the owner of an
      // unregistered alias — so the zero check has to be explicit rather than left to the
      // signature comparison.
      const missing = rand32();
      await expect(offerAliasAs(domain, user, missing, other.address))
        .to.be.revertedWithCustomError(domain, "NotAliasOwner");
      await expect(domain.connect(user).offerAlias(missing, other.address, 1n << 40n, "0xdeadbeef"))
        .to.be.revertedWithCustomError(domain, "NotAliasOwner");
    });

    it("disables plain ERC-721 transfer and approval", async function () {
      // An approval that cannot be exercised looks like it delegates the alias and does
      // nothing, so it reverts rather than silently succeeding.
      await expect(domain.connect(user).transferFrom(user.address, other.address, BigInt(h)))
        .to.be.revertedWithCustomError(domain, "UseAcceptAlias");
      await expect(domain.connect(user)["safeTransferFrom(address,address,uint256)"](user.address, other.address, BigInt(h)))
        .to.be.revertedWithCustomError(domain, "UseAcceptAlias");
      await expect(domain.connect(user).approve(other.address, BigInt(h)))
        .to.be.revertedWithCustomError(domain, "AliasApprovalsDisabled");
      await expect(domain.connect(user).setApprovalForAll(other.address, true))
        .to.be.revertedWithCustomError(domain, "AliasApprovalsDisabled");
    });
  });

  // ── Admin ───────────────────────────────────────────────────────────────────

  describe("admin", function () {
    it("has no token rescue at all", async function () {
      // Removed rather than gated. It insured against tokens sent to a contract that never
      // holds any, at the cost of one more admin-reachable path an auditor has to rule out.
      expect(domain.interface.fragments.some((f: any) => f.name === "rescueToken")).to.equal(false);
    });

    it("gates every admin function", async function () {
      const r = domain.connect(other);
      await expect(r.setRegistrationFee(1n)).to.be.revertedWithCustomError(domain, "NotAdmin");
      await expect(r.setBaseTokenURI("x")).to.be.revertedWithCustomError(domain, "NotAdmin");
      await expect(r.withdrawFees(other.address, 0n)).to.be.revertedWithCustomError(domain, "NotAdmin");
      await expect(r.transferAdmin(other.address)).to.be.revertedWithCustomError(domain, "NotAdmin");
    });

    it("cannot withdraw more than it took in fees", async function () {
      await (await registerAlias(domain, user, freshName().name, PK, NKH, ENC, FEE)).wait();
      await expect(domain.withdrawFees(admin.address, FEE + 1n))
        .to.be.revertedWithCustomError(domain, "InsufficientFees");
      // Both halves: the counter cleared *and* the ETH arrived. A withdraw that zeroed the
      // accounting without transferring would pass the second assertion alone.
      await expect(domain.withdrawFees(admin.address, FEE))
        .to.changeEtherBalance(admin, FEE);
      expect(await domain.accumulatedFees()).to.equal(0n);
    });

    it("hands over the role in two steps", async function () {
      await (await domain.transferAdmin(other.address)).wait();
      expect(await domain.admin()).to.equal(admin.address);   // not yet
      await expect(domain.connect(user).acceptAdmin()).to.be.revertedWithCustomError(domain, "NotPendingAdmin");
      await (await domain.connect(other).acceptAdmin()).wait();
      expect(await domain.admin()).to.equal(other.address);
      await expect(domain.setRegistrationFee(1n)).to.be.revertedWithCustomError(domain, "NotAdmin");
    });

    it("a changed fee applies to the next registration", async function () {
      const newFee = ethers.parseEther("0.05");
      await (await domain.setRegistrationFee(newFee)).wait();
      await expect(registerAlias(domain, user, freshName().name, PK, NKH, ENC, FEE))
        .to.be.revertedWithCustomError(domain, "WrongRegistrationFee");
      const { name: ok, h: okHash } = freshName();
      await expect(registerAlias(domain, user, ok, PK, NKH, ENC, newFee))
        .to.emit(registry, "AliasRegistered");
      expect(await registry.isRegistered(okHash)).to.equal(true);
      expect(await domain.accumulatedFees(), "the new fee was not the amount taken")
        .to.equal(newFee);
    });

    it("has no way to reach the pool's funds", async function () {
      // The whole point of the split: the contract with an admin holds only revenue.
      await fundPool(ethers.parseEther("1"));
      const mutating = domain.interface.fragments
        .filter((f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f: any) => f.name);
      expect(mutating).to.not.include("transact");
      expect(await ethers.provider.getBalance(poolAddr)).to.equal(ethers.parseEther("1"));
      await expect(domain.withdrawFees(admin.address, 1n))
        .to.be.revertedWithCustomError(domain, "InsufficientFees");
    });
  });

  // ── receive() ───────────────────────────────────────────────────────────────

  it("accepts ETH only from the pool", async function () {
    // Untracked ETH would sit outside accumulatedFees where withdrawFees cannot reach it.
    await expect(user.sendTransaction({ to: domainAddr, value: 1n }))
      .to.be.revertedWithCustomError(domain, "OnlyPoolMaySendETH");
  });

  describe("commit-reveal concurrency", function () {
    it("refuses to reset a live commitment, so a reveal cannot be griefed", async function () {
      // The commitment hash is public the moment it is made. Without this rule anyone could
      // re-commit someone else's in the same block as their reveal, pushing madeAt forward
      // and failing the reveal with ReservationTooNew — repeatable indefinitely for gas.
      const [, victim, attacker] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), victim.address, salt);

      await (await domain.connect(victim).reserveRegistration(c)).wait();
      await expect(domain.connect(attacker).reserveRegistration(c))
        .to.be.revertedWithCustomError(domain, "ReservationPending");

      // The victim's reveal still lands.
      await ethers.provider.send("evm_mine", []);
      await (await domain.connect(victim).revealRegistration(hName, PK, NKH, ENC, victim.address, salt, { value: FEE })).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(victim.address);
    });

    it("rejects a reveal in the same block as its commitment", async function () {
      // Exactly the position a mempool front-runner is in: they learn the name only when the
      // reveal appears, so any commitment they make is this block's.
      const [, user] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), user.address, salt);

      await ethers.provider.send("evm_setAutomine", [false]);
      await domain.connect(user).reserveRegistration(c);
      const reveal = await domain.connect(user).revealRegistration(hName, PK, NKH, ENC, user.address, salt, { value: FEE });
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);

      // Named, not merely rejected. This is the front-running defence: the whole reason the
      // two-step flow exists is that a reveal in the reservation's own block must fail, and a
      // bare rejection would also pass if it failed for the fee, the name, or anything else.
      // The transaction is already sent, so the reason is read off the failure rather than
      // asserted through a matcher.
      const rc = await ethers.provider.getTransactionReceipt(reveal.hash);
      expect(rc!.status, "the reveal was supposed to fail").to.equal(0);

      // A mined failure carries no revert data, so the call is replayed against the state at
      // the block it failed in — where the reservation exists and the timestamp still matches
      // it. That reproduces the same revert with its reason attached.
      await expect(
        ethers.provider.call({
          to: reveal.to, from: reveal.from, data: reveal.data, value: reveal.value,
          blockTag: rc!.blockNumber,
        }),
      ).to.be.revertedWithCustomError(domain, "ReservationTooNew");
      // Named: ERC-721 distinguishes "no such token" from every other failure, and a bare
      // revert here would also pass if ownerOf were reverting for an unrelated reason.
      await expect(domain.ownerOf(BigInt(h)))
        .to.be.revertedWithCustomError(domain, "ERC721NonexistentToken").withArgs(BigInt(h));
      // And the failure left nothing behind — the name is still free, and the fee was not
      // taken. A registration that half-happened is the outcome worth ruling out.
      expect(await registry.isRegistered(h), "the alias was recorded anyway").to.equal(false);
    });

    it("refuses to reveal a name that was not the one reserved", async function () {
      // The name is inside the commitment, so revealing a different one hashes to a
      // reservation that was never made. Worth asserting rather than assuming: it is the
      // property that stops someone reserving a cheap name and revealing an expensive one.
      const { name: hName } = freshName();
      const other = freshName().name;
      const salt = rand32();
      const [, user] = await ethers.getSigners();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), user.address, salt);
      await (await domain.connect(user).reserveRegistration(c)).wait();
      await ethers.provider.send("evm_mine", []);

      await expect(
        domain.connect(user).revealRegistration(other, PK, NKH, ENC, user.address, salt, { value: FEE }),
      ).to.be.revertedWithCustomError(domain, "NoReservation");
    });

    it("lets an expired commitment be replaced", async function () {
      const [, user] = await ethers.getSigners();
      const { name: hName } = freshName();
      const salt = rand32();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), user.address, salt);

      await (await domain.connect(user).reserveRegistration(c)).wait();
      // Seconds, not blocks — MAX_RESERVATION_AGE bounds a duration, so advance time rather than
      // mining 86,401 blocks to reach it sideways.
      await time.increase(Number(await domain.MAX_RESERVATION_AGE()) + 1);

      // Replaced, not merely permitted. An expired commitment that is accepted but leaves the
      // old timestamp in place would satisfy a not-reverted check and then still be expired —
      // which is the bug this test exists to rule out.
      const stale = await domain.reservations(c);
      await expect(domain.connect(user).reserveRegistration(c)).to.emit(domain, "RegistrationReserved");
      expect(await domain.reservations(c), "the commitment was not refreshed")
        .to.not.equal(stale);
    });

    it("refuses a reveal whose commitment has expired", async function () {
      const [, user] = await ethers.getSigners();
      const { name: hName } = freshName();
      const salt = rand32();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), user.address, salt);

      await (await domain.connect(user).reserveRegistration(c)).wait();
      await time.increase(Number(await domain.MAX_RESERVATION_AGE()) + 1);

      await expect(domain.connect(user).revealRegistration(hName, PK, NKH, ENC, user.address, salt, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "ReservationExpired");
    });

    it("a copied commit costs the victim nothing but gas — they still get the name", async function () {
      // The alarming-sounding case, pinned down. An attacker watching the mempool copies the
      // commit hash and lands first. That is all they can do with it: the hash binds the
      // victim as owner, so the attacker cannot reveal it, and the commitment they created
      // is the very one the victim needed. The victim's own commit reverts and their
      // registration still succeeds.
      const [, victim, attacker] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), victim.address, salt);

      // Attacker front-runs with the identical hash.
      await (await domain.connect(attacker).reserveRegistration(c)).wait();

      // Victim's own commit now reverts — harmless, the commitment is already live.
      await expect(domain.connect(victim).reserveRegistration(c))
        .to.be.revertedWithCustomError(domain, "ReservationPending");

      // The attacker cannot turn it into a name of their own: the owner is inside the
      // commitment, so naming themselves hashes to something never committed.
      await ethers.provider.send("evm_mine", []);
      await expect(domain.connect(attacker).revealRegistration(hName, PK, NKH, ENC, attacker.address, salt, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "NoReservation");

      // The victim registers normally.
      await (await domain.connect(victim).revealRegistration(hName, PK, NKH, ENC, victim.address, salt, { value: FEE })).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(victim.address);
    });

    it("binds the owner, so a copied reveal cannot mint to the copier", async function () {
      // The owner is a parameter now rather than msg.sender, so this is what stops a reveal
      // being copied out of the mempool and redirected. It is committed to, so changing it
      // changes the hash — an attacker can only reveal the registration the victim intended.
      const [, victim, attacker] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = registrationCommitment(hName, BigInt(PK), BigInt(NKH), BigInt(ENC), victim.address, salt);
      await (await domain.connect(victim).reserveRegistration(c)).wait();
      await ethers.provider.send("evm_mine", []);

      // Naming themselves: never committed.
      await expect(domain.connect(attacker).revealRegistration(hName, PK, NKH, ENC, attacker.address, salt, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "NoReservation");

      // Copying it verbatim does work, and is worth nothing: the attacker pays the fee and
      // the victim gets the alias. Front-running a reveal is a donation, not a theft.
      await (await domain.connect(attacker).revealRegistration(hName, PK, NKH, ENC, victim.address, salt, { value: FEE })).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(victim.address);
    });
  });

});
