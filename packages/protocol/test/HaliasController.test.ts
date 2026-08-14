import { expect } from "chai";
import { ethers } from "hardhat";
import {
  registerAlias, acceptAliasAs, signOwnerAction,
  offerAliasAs, cancelOfferAs, updateAliasDataAs,
} from "./helpers/register";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { aliasHashToKey } from "./helpers/smt";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";

// The SMT leaf a registration inserts: Poseidon(aliasKey, Poseidon(pk, nkh, dataHash), 1).
// A claim's proof performs this insertion itself, and the pool requires the public signal to
// equal what the registry armed — so a claim built without it is rejected outright.
const pendingLeafFor = (r: any) =>
  ethers.toBeHex(poseidonHash([
    aliasHashToKey(r.aliasHash),
    poseidonHash([BigInt(r.spendingPubkey), BigInt(r.nullifierKeyHash), 0n]),
    1n,
  ]), 32);

// HaliasController — names, ownership, fees, and the claim path.
//
// The claim path is why this file exists. In the monolith, registering out of a pool note
// did `_mint(msg.sender, ...)`, which on a relayed claim is the *relayer* — so a relayer
// could take the alias it was paid to submit, rotate its keys, and redirect every future
// payment to that name. Claim.test.ts asserted the submitter as owner, encoding the bug as
// expected behaviour.
//
// Ownership now comes from `Registration.owner`, hashed into externalData and committed
// inside paramsHash. "a relayer submitting a claim does not receive the alias" below is the
// regression test for that.

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO_PROOF  = "0x" + "00".repeat(256);
const NO_RELAYER  = { relayer: ethers.ZeroAddress, amount: 0n };

const REG_TUPLE =
  "tuple(address owner,bytes32 aliasHash,bytes32 spendingPubkey,bytes32 nullifierKeyHash,bytes32 encryptionPubkey)";

const withdrawOf = (amount: bigint) => FIELD_PRIME - amount;
const rand32     = () => ethers.keccak256(ethers.randomBytes(32));

let nameSeq = 0;
/// A fresh alias name and the hash the contract derives from it.
///
/// Registrations used to pass a random hash with no name. The hash comes from the name now,
/// so a test wanting a particular hash has to start from a name.
const freshName = (): { name: string; h: string } => {
  const name = `t${nameSeq++}x${Math.floor(Math.random() * 1e9)}.hls`;
  return { name, h: ethers.keccak256(ethers.toUtf8Bytes(name)) };
};
// dataHash is a Poseidon leaf input, so it has to land inside the scalar field.
const randField  = () => ethers.toBeHex(BigInt(rand32()) % FIELD_PRIME, 32);

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
      spendingPubkey: PK, nullifierKeyHash: NKH, encryptionPubkey: ENC,
      ...overrides,
    };
  }

  async function claimParams(r: any, relayerFee = NO_RELAYER) {
    return {
      pendingLeaf:       pendingLeafFor(r),
      outputsEmpty:      false,
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
      registryRoot:      await registry.getRegistryRoot(),
      publicAmount:      withdrawOf(FEE + relayerFee.amount),
      tokenAddress:      ethers.ZeroAddress,
      inputNullifiers:   [rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient:         domainAddr,
      relayerFee,
      externalData:      ethers.keccak256(encodeRegistration(r)),
    };
  }

  // Puts ETH in the pool so a claim has something to withdraw against.
  async function fundPool(amount: bigint) {
    await (await pool.transact({
      poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
      registryRoot: await registry.getRegistryRoot(),
      publicAmount: amount, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32()],
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
      .deploy(verifier, await registry.getAddress());
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
      await expect(domain.connect(user).registerDirect(name, PK, NKH, ENC, user.address, { value: FEE }))
        .to.emit(domain, "NamePublished").withArgs(h, name);
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
    });

    it("charges the direct path the same fee, and refuses a name already taken", async function () {
      const { name } = freshName();
      await expect(domain.connect(user).registerDirect(name, PK, NKH, ENC, user.address, { value: FEE - 1n }))
        .to.be.revertedWithCustomError(domain, "WrongRegistrationFee");
      await (await domain.connect(user).registerDirect(name, PK, NKH, ENC, user.address, { value: FEE })).wait();
      // Both paths write through the same core, so taken-ness is enforced once, not twice.
      await expect(domain.connect(other).registerDirect(name, PK, NKH, ENC, user.address, { value: FEE }))
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

  describe("claim", function () {
    it("a relayer submitting a claim does not receive the alias", async function () {
      // THE REGRESSION TEST. The relayer submits, pays the gas, takes its fee — and the
      // alias belongs to the claimer named in the proof-bound registration.
      const relayerFee = ethers.parseEther("0.01");
      await fundPool(FEE + relayerFee);

      const r = registration();
      const p = await claimParams(r, { relayer: relayer.address, amount: relayerFee });
      const before = await ethers.provider.getBalance(relayer.address);

      await expect(domain.connect(relayer).claim(r, p, "0x", "0x", ZERO_PROOF, ""))
        .to.emit(domain, "AliasClaimed").withArgs(r.aliasHash, claimer.address, relayer.address);

      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(claimer.address);
      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.not.equal(relayer.address);

      // And the relayer was paid by the pool directly, not by this contract.
      const spent = before - await ethers.provider.getBalance(relayer.address);
      expect(spent).to.be.lessThan(relayerFee);   // fee exceeded the gas it cost to submit
      expect(await domain.accumulatedFees()).to.equal(FEE);
    });

    it("registers with no ETH of the claimer's own", async function () {
      await fundPool(FEE);
      const r = registration();
      const p = await claimParams(r);

      await (await domain.connect(user).claim(r, p, "0x", "0x", ZERO_PROOF, "")).wait();

      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(claimer.address);
      expect(await ethers.provider.getBalance(poolAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(domainAddr)).to.equal(FEE);
    });

    it("rejects a registration the proof did not authorise", async function () {
      await fundPool(FEE);
      const r = registration();
      const p = await claimParams(r);

      // Every field is bound. Swapping any one of them invalidates the claim.
      for (const tampered of [
        { ...r, owner: relayer.address },
        { ...r, aliasHash: rand32() },
        { ...r, spendingPubkey: ethers.toBeHex(99n, 32) },
        { ...r, nullifierKeyHash: ethers.toBeHex(99n, 32) },
        { ...r, encryptionPubkey: ethers.toBeHex(99n, 32) },
      ]) {
        await expect(domain.connect(relayer).claim(tampered, p, "0x", "0x", ZERO_PROOF, ""))
          .to.be.revertedWithCustomError(domain, "ClaimNotAuthorised");
      }
    });

    it("rejects a payout that is not exactly the registration fee", async function () {
      await fundPool(ethers.parseEther("1"));
      const r = registration();
      const p = { ...await claimParams(r), publicAmount: withdrawOf(FEE + 1n) };
      // externalData still matches, so this gets past authorisation and fails on the money.
      p.externalData = ethers.keccak256(encodeRegistration(r));

      await expect(domain.connect(relayer).claim(r, p, "0x", "0x", ZERO_PROOF, ""))
        .to.be.revertedWithCustomError(domain, "ClaimWrongPayout").withArgs(FEE, FEE + 1n);
    });

    it("rejects a claim whose payout goes somewhere else", async function () {
      await fundPool(FEE);
      const r = registration();
      const p = { ...await claimParams(r), recipient: relayer.address };
      p.externalData = ethers.keccak256(encodeRegistration(r));

      await expect(domain.connect(relayer).claim(r, p, "0x", "0x", ZERO_PROOF, ""))
        .to.be.revertedWithCustomError(domain, "ClaimWrongPayout").withArgs(FEE, 0n);
    });

    it("rejects a token-denominated claim", async function () {
      const r = registration();
      const p = { ...await claimParams(r), tokenAddress: await token.getAddress() };
      p.externalData = ethers.keccak256(encodeRegistration(r));

      await expect(domain.connect(relayer).claim(r, p, "0x", "0x", ZERO_PROOF, ""))
        .to.be.revertedWithCustomError(domain, "ClaimMustBeETH");
    });

    it("rejects a zero owner", async function () {
      await fundPool(FEE);
      const r = registration({ owner: ethers.ZeroAddress });
      await expect(domain.connect(relayer).claim(r, await claimParams(r), "0x", "0x", ZERO_PROOF, ""))
        .to.be.revertedWithCustomError(domain, "InvalidOwner");
    });
  });

  // ── Alias maintenance ───────────────────────────────────────────────────────

  // ── F1: the claim no longer predicts a root ─────────────────────────────────

  describe("pending registration", function () {
    // A claim's change note is a non-zero output, so it needs registry membership for an
    // alias that is not in the tree when the proof is built. That used to mean predicting
    // the post-registration root, and any other registry write landing in between killed
    // the claim — cheap to trigger deliberately, and worst on the onboarding path.
    //
    // The proof carries the insertion now, against a root that already exists. These are the
    // assertions that distinguish the two designs.

    it("survives registry writes landing between preparation and submission", async function () {
      await initPoseidon();
      await fundPool(FEE * 4n);
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
      await expect(domain.connect(relayer).claim(r, p, "0x", "0x", ZERO_PROOF, ""))
        .to.not.be.reverted;
      expect(await domain.ownerOf(BigInt(r.aliasHash))).to.equal(claimer.address);
    });

    it("refuses an ordinary transact that claims an insertion", async function () {
      // The whole reason pendingLeaf is a public signal the contract supplies. A prover who
      // could choose it would insert their own unregistered keys into a tree of their
      // choosing and pay themselves — which is precisely what the registry proof prevents.
      await expect(pool.connect(user).transact({
        poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
        registryRoot: await registry.getRegistryRoot(),
        publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
        inputNullifiers: [rand32(), rand32()],
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
      const r = registration();
      const p = { ...(await claimParams(r)), pendingLeaf: rand32() , outputsEmpty: false};
      await expect(domain.connect(relayer).claim(r, p, "0x", "0x", ZERO_PROOF, ""))
        .to.be.revertedWithCustomError(pool, "PendingLeafNotArmed");
    });

    it("does not leave the arming set for a later transaction", async function () {
      // Transient storage, so it cannot outlive the transaction that set it. If it were
      // persistent, the next ordinary transact would have to carry a stale leaf or revert.
      await initPoseidon();
      await fundPool(FEE * 4n);
      const r = registration();
      await (await domain.connect(relayer).claim(r, await claimParams(r), "0x", "0x", ZERO_PROOF, "")).wait();

      expect(await registry.pendingLeaf()).to.equal(ethers.ZeroHash);
      await expect(pool.connect(user).transact({
        poolRoot: [(await anchorOf(pool)).root, (await anchorOf(pool)).root], treeNumber: [(await anchorOf(pool)).tree, (await anchorOf(pool)).tree],
        registryRoot: await registry.getRegistryRoot(),
        publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
        inputNullifiers: [rand32(), rand32()],
        outputCommitments: [rand32(), rand32()],
        recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER,
        externalData: ethers.ZeroHash, pendingLeaf: ethers.ZeroHash,
      outputsEmpty:      false,
      }, "0x", "0x", ZERO_PROOF)).to.not.be.reverted;
    });

    it("only the controller may arm an insertion", async function () {
      const { name: hName, h } = freshName();
      await (await registerAlias(domain, user, hName, PK, NKH, ENC, FEE)).wait();
      await expect(registry.connect(user).armPendingLeaf(h))
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
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
      await expect(offerAliasAs(domain, other, h, other.address))
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
      await expect(cancelOfferAs(domain, other, h))
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
      await expect(updateAliasDataAs(domain, user, h, randField())).to.not.be.reverted;
    });

    it("refuses an action with no signature at all", async function () {
      await expect(domain.connect(user).offerAlias(h, other.address, 1n << 40n, "0x"))
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
    });

    it("an offer moves nothing until it is accepted", async function () {
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      // The seller still owns it and still receives to it — there is no in-transit state.
      expect(await domain.ownerOf(BigInt(h))).to.equal(user.address);
      expect((await registry.aliases(h)).spendingPubkey).to.equal(PK);
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
      expect((await registry.aliases(h)).spendingPubkey).to.equal(newPk);
      // The old owner can no longer act on it.
      await expect(updateAliasDataAs(domain, user, h, randField()))
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
    });

    it("a second offer replaces the first, which can no longer be taken", async function () {
      // The UI warns about this, so it had better be true. There is one pending owner, not a
      // queue: offering again overwrites, and the earlier recipient is left holding an offer
      // that names them and no longer exists.
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await (await offerAliasAs(domain, user, h, claimer.address)).wait();
      expect(await domain.pendingAliasOwner(h)).to.equal(claimer.address);

      await expect(acceptAliasAs(domain, other, h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(domain, "NotOfferedToSigner");
      // And the one it was replaced by still works.
      await (await acceptAliasAs(domain, claimer, h, PK, NKH, ENC)).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(claimer.address);
    });

    it("cannot be accepted by anyone but the address it was offered to", async function () {
      await (await offerAliasAs(domain, user, h, other.address)).wait();
      await expect(acceptAliasAs(domain, claimer, h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(domain, "NotOfferedToSigner");
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
      // never the spending pubkey, so the one compromise that loses funds was the one it
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
      expect((await registry.aliases(h)).spendingPubkey).to.equal(newPk);
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
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
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
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
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
        .to.be.revertedWithCustomError(domain, "NotSignedByOwner");
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
      await expect(domain.withdrawFees(admin.address, FEE)).to.not.be.reverted;
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
      await expect(registerAlias(domain, user, freshName().name, PK, NKH, ENC, newFee))
        .to.not.be.reverted;
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
      // and failing the reveal with CommitTooNew — repeatable indefinitely for gas.
      const [, victim, attacker] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = await domain.registrationCommitment(hName, PK, NKH, ENC, victim.address, salt);

      await (await domain.connect(victim).commitRegistration(c)).wait();
      await expect(domain.connect(attacker).commitRegistration(c))
        .to.be.revertedWithCustomError(domain, "CommitmentPending");

      // The victim's reveal still lands.
      await ethers.provider.send("evm_mine", []);
      await (await domain.connect(victim).register(hName, PK, NKH, ENC, victim.address, salt, { value: FEE })).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(victim.address);
    });

    it("rejects a reveal in the same block as its commitment", async function () {
      // Exactly the position a mempool front-runner is in: they learn the name only when the
      // reveal appears, so any commitment they make is this block's.
      const [, user] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = await domain.registrationCommitment(hName, PK, NKH, ENC, user.address, salt);

      await ethers.provider.send("evm_setAutomine", [false]);
      await domain.connect(user).commitRegistration(c);
      const reveal = await domain.connect(user).register(hName, PK, NKH, ENC, user.address, salt, { value: FEE });
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);

      await expect(reveal.wait()).to.be.rejected;
      await expect(domain.ownerOf(BigInt(h))).to.be.reverted;
    });

    it("lets an expired commitment be replaced", async function () {
      const [, user] = await ethers.getSigners();
      const { name: hName } = freshName();
      const salt = rand32();
      const c = await domain.registrationCommitment(hName, PK, NKH, ENC, user.address, salt);

      await (await domain.connect(user).commitRegistration(c)).wait();
      // Seconds, not blocks — MAX_COMMIT_AGE bounds a duration, so advance time rather than
      // mining 86,401 blocks to reach it sideways.
      await time.increase(Number(await domain.MAX_COMMIT_AGE()) + 1);

      await expect(domain.connect(user).commitRegistration(c)).to.not.be.reverted;
    });

    it("refuses a reveal whose commitment has expired", async function () {
      const [, user] = await ethers.getSigners();
      const { name: hName } = freshName();
      const salt = rand32();
      const c = await domain.registrationCommitment(hName, PK, NKH, ENC, user.address, salt);

      await (await domain.connect(user).commitRegistration(c)).wait();
      await time.increase(Number(await domain.MAX_COMMIT_AGE()) + 1);

      await expect(domain.connect(user).register(hName, PK, NKH, ENC, user.address, salt, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "CommitExpired");
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
      const c = await domain.registrationCommitment(hName, PK, NKH, ENC, victim.address, salt);

      // Attacker front-runs with the identical hash.
      await (await domain.connect(attacker).commitRegistration(c)).wait();

      // Victim's own commit now reverts — harmless, the commitment is already live.
      await expect(domain.connect(victim).commitRegistration(c))
        .to.be.revertedWithCustomError(domain, "CommitmentPending");

      // The attacker cannot turn it into a name of their own: the owner is inside the
      // commitment, so naming themselves hashes to something never committed.
      await ethers.provider.send("evm_mine", []);
      await expect(domain.connect(attacker).register(hName, PK, NKH, ENC, attacker.address, salt, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "NoCommitment");

      // The victim registers normally.
      await (await domain.connect(victim).register(hName, PK, NKH, ENC, victim.address, salt, { value: FEE })).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(victim.address);
    });

    it("binds the owner, so a copied reveal cannot mint to the copier", async function () {
      // The owner is a parameter now rather than msg.sender, so this is what stops a reveal
      // being copied out of the mempool and redirected. It is committed to, so changing it
      // changes the hash — an attacker can only reveal the registration the victim intended.
      const [, victim, attacker] = await ethers.getSigners();
      const { name: hName, h } = freshName();
      const salt = rand32();
      const c = await domain.registrationCommitment(hName, PK, NKH, ENC, victim.address, salt);
      await (await domain.connect(victim).commitRegistration(c)).wait();
      await ethers.provider.send("evm_mine", []);

      // Naming themselves: never committed.
      await expect(domain.connect(attacker).register(hName, PK, NKH, ENC, attacker.address, salt, { value: FEE }))
        .to.be.revertedWithCustomError(domain, "NoCommitment");

      // Copying it verbatim does work, and is worth nothing: the attacker pays the fee and
      // the victim gets the alias. Front-running a reveal is a donation, not a theft.
      await (await domain.connect(attacker).register(hName, PK, NKH, ENC, victim.address, salt, { value: FEE })).wait();
      expect(await domain.ownerOf(BigInt(h))).to.equal(victim.address);
    });
  });

});
