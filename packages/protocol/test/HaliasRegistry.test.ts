import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { SMT, aliasHashToKey } from "./helpers/smt";

// The registry stores nullifierKeyHash already hashed, so the leaf is a direct Poseidon of
// the three stored fields. registryLeaf() in the helpers takes a raw nullifier key and
// hashes it first, which is the wrong shape here.
const leafOf = (pubkey: string, nullifierKeyHash: string, dataHash: string) =>
  poseidonHash([BigInt(pubkey), BigInt(nullifierKeyHash), BigInt(dataHash)]);

// HaliasRegistry — the standalone registry extracted from the SMTRegistry base.
//
// Registry.test.ts already covers the tree mechanics through the monolith. What is new
// here, and therefore what this file is about, is the surface the split created: a single
// immutable writer, and validation that lives in the registry rather than in whoever calls
// it. The tree must hold its invariants because this contract enforces them, not because
// the current controller happens to be well behaved — so every write is also driven from a
// non-controller to confirm it is refused.
//
// The off-chain SMT is rebuilt alongside the contract's and compared. That is the property
// the circuit depends on: if these two ever disagree, every proof stops verifying.

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("HaliasRegistry", function () {
  this.timeout(120000);

  let registry: any;
  let controller: any, stranger: any;

  const rand32 = () => ethers.keccak256(ethers.randomBytes(32));
  // A dataHash is committed into the Poseidon leaf, so it must be a field element. A raw
  // keccak exceeds p about 81% of the time.
  const randField = () => ethers.toBeHex(BigInt(rand32()) % FIELD_PRIME, 32);
  const PK  = ethers.toBeHex(11n, 32);
  const NKH = ethers.toBeHex(22n, 32);
  const ENC = ethers.toBeHex(33n, 32);

  before(async function () {
    await initPoseidon();
  });

  beforeEach(async function () {
    [controller, stranger] = await ethers.getSigners();
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    registry = await (await ethers.getContractFactory("HaliasRegistry", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(controller.address);
  });

  // ── Construction ────────────────────────────────────────────────────────────

  describe("construction", function () {
    it("rejects a zero controller", async function () {
      const F = await ethers.getContractFactory("HaliasRegistry", {
        libraries: {
          PoseidonT3: await (await (await ethers.getContractFactory("PoseidonT3")).deploy()).getAddress(),
          PoseidonT4: await (await (await ethers.getContractFactory("PoseidonT4")).deploy()).getAddress(),
        },
      });
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroController");
    });

    it("publishes a genesis root and has no admin surface", async function () {
      expect(await registry.getRegistryRoot()).to.not.equal(ethers.ZeroHash);
      expect(await registry.isKnownRegistryRoot(await registry.getRegistryRoot())).to.equal(true);

      const mutating = registry.interface.fragments.filter(
        (f: any) => f.type === "function" && !["view", "pure"].includes(f.stateMutability),
      ).map((f: any) => f.name).sort();
      expect(mutating).to.deep.equal(
        ["armPendingLeaf", "clearPendingLeaf", "reassign", "register", "setDataHash"]);
    });

    it("matches the off-chain empty root", async function () {
      expect(BigInt(await registry.getRegistryRoot())).to.equal(new SMT().root);
    });
  });

  // ── Authorisation ───────────────────────────────────────────────────────────

  it("refuses every write from anyone but the controller", async function () {
    const h = rand32();
    await (await registry.register(h, PK, NKH, ENC)).wait();

    const r = registry.connect(stranger);
    await expect(r.register(rand32(), PK, NKH, ENC)).to.be.revertedWithCustomError(registry, "NotController");
    await expect(r.setDataHash(h, randField())).to.be.revertedWithCustomError(registry, "NotController");
    await expect(r.reassign(h, PK, NKH, ENC)).to.be.revertedWithCustomError(registry, "NotController");
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe("register", function () {
    it("assigns slots in order and never reuses one", async function () {
      for (let i = 1; i <= 4; i++) {
        const h = rand32();
        await (await registry.register(h, PK, NKH, ENC)).wait();
        expect(await registry.aliasSlot(h)).to.equal(BigInt(i));
      }
      expect(await registry.nextAliasSlot()).to.equal(4n);
    });

    it("refuses a second registration of the same alias", async function () {
      const h = rand32();
      await (await registry.register(h, PK, NKH, ENC)).wait();
      await expect(registry.register(h, PK, NKH, ENC))
        .to.be.revertedWithCustomError(registry, "AliasTaken");
    });

    it("stores the record and emits the leaf it committed", async function () {
      const h = rand32();
      const expectedLeaf = ethers.toBeHex(leafOf(PK, NKH, ethers.ZeroHash), 32);

      await expect(registry.register(h, PK, NKH, ENC))
        .to.emit(registry, "AliasRegistered")
        .withArgs(h, PK, expectedLeaf, ENC, 1n);

      expect(await registry.leafOf(h)).to.equal(expectedLeaf);

      const rec = await registry.aliases(h);
      expect(rec.spendingPubkey).to.equal(PK);
      expect(rec.nullifierKeyHash).to.equal(NKH);
      expect(rec.encryptionPubkey).to.equal(ENC);
      expect(rec.dataHash).to.equal(ethers.ZeroHash);
      expect(rec.registeredAt).to.be.greaterThan(0n);
      expect(await registry.isRegistered(h)).to.equal(true);
    });

    it("rejects a zero alias hash and any zero or out-of-field key", async function () {
      await expect(registry.register(ethers.ZeroHash, PK, NKH, ENC))
        .to.be.revertedWithCustomError(registry, "InvalidAliasHash");
      await expect(registry.register(rand32(), ethers.ZeroHash, NKH, ENC))
        .to.be.revertedWithCustomError(registry, "InvalidSpendingPubkey");
      await expect(registry.register(rand32(), PK, ethers.ZeroHash, ENC))
        .to.be.revertedWithCustomError(registry, "InvalidNullifierKeyHash");
      await expect(registry.register(rand32(), PK, NKH, ethers.ZeroHash))
        .to.be.revertedWithCustomError(registry, "InvalidEncryptionPubkey");

      // A key at or above the prime is not representable as a circuit signal, so a note
      // addressed to it could never be spent.
      const overField = ethers.toBeHex(FIELD_PRIME, 32);
      await expect(registry.register(rand32(), overField, NKH, ENC))
        .to.be.revertedWithCustomError(registry, "PubkeyOutOfField");
      await expect(registry.register(rand32(), PK, overField, ENC))
        .to.be.revertedWithCustomError(registry, "NullifierKeyHashOutOfField");
    });
  });

  // ── Updates ─────────────────────────────────────────────────────────────────

  describe("updates", function () {
    let h: string;

    beforeEach(async function () {
      h = rand32();
      await (await registry.register(h, PK, NKH, ENC)).wait();
    });

    it("keeps the slot across a data change and a reassignment", async function () {
      // The point of an SMT over an append-only tree: a sender holding a proof against
      // this alias's position stays valid after the holder rotates keys, and rotation is
      // now a reassignment to the same owner.
      const slot = await registry.aliasSlot(h);
      await (await registry.setDataHash(h, randField())).wait();
      expect(await registry.aliasSlot(h)).to.equal(slot);
      await (await registry.reassign(h, ethers.toBeHex(66n, 32), ethers.toBeHex(77n, 32), ethers.toBeHex(88n, 32))).wait();
      expect(await registry.aliasSlot(h)).to.equal(slot);
    });

    it("moves the root on every write", async function () {
      let prev = await registry.getRegistryRoot();
      for (const write of [
        () => registry.setDataHash(h, randField()),
        () => registry.reassign(h, ethers.toBeHex(66n, 32), ethers.toBeHex(77n, 32), ethers.toBeHex(88n, 32)),
      ]) {
        await (await write()).wait();
        const next = await registry.getRegistryRoot();
        expect(next).to.not.equal(prev);
        expect(await registry.isKnownRegistryRoot(prev)).to.equal(true);   // still inside the window
        prev = next;
      }
    });

    it("clears dataHash on reassignment", async function () {
      // Reputation accrued against a name does not travel with it. Rotation goes through
      // the same path, so it costs the holder their dataHash too — acceptable only while
      // that field is unused, and the reason the distinction belongs here rather than in a
      // separate function once proof-of-innocence gives it a value.
      const data = randField();
      await (await registry.setDataHash(h, data)).wait();

      await (await registry.reassign(h, ethers.toBeHex(66n, 32), ethers.toBeHex(77n, 32), ethers.toBeHex(88n, 32))).wait();
      expect((await registry.aliases(h)).dataHash).to.equal(ethers.ZeroHash);
    });

    it("reassignment replaces the spending pubkey", async function () {
      // The whole reason there is no `rotateKeys`: it wrote the other two keys and left
      // this one, so the only compromise that loses funds was the one it could not answer.
      expect((await registry.aliases(h)).spendingPubkey).to.equal(PK);
      await (await registry.reassign(h, ethers.toBeHex(66n, 32), ethers.toBeHex(77n, 32), ethers.toBeHex(88n, 32))).wait();
      expect((await registry.aliases(h)).spendingPubkey).to.equal(ethers.toBeHex(66n, 32));
    });

    it("refuses a dataHash outside the field", async function () {
      // Poseidon reduces out-of-field inputs silently instead of reverting, so without this
      // guard `p + x` and `x` commit the same leaf while the record stores different
      // values. Registration writes a zero dataHash, so the update path is the only way in
      // — the same shape as the missing newLeaf check Veridise found in Semaphore's
      // update(), where the original leaf was validated and the replacement was not.
      await expect(registry.setDataHash(h, ethers.toBeHex(FIELD_PRIME, 32)))
        .to.be.revertedWithCustomError(registry, "DataHashOutOfField");
      await expect(registry.setDataHash(h, ethers.toBeHex(FIELD_PRIME + 5n, 32)))
        .to.be.revertedWithCustomError(registry, "DataHashOutOfField");
      await expect(registry.setDataHash(h, ethers.toBeHex(FIELD_PRIME - 1n, 32))).to.not.be.reverted;
    });

    it("refuses to touch an alias that was never registered", async function () {
      const missing = rand32();
      await expect(registry.setDataHash(missing, randField()))
        .to.be.revertedWithCustomError(registry, "AliasNotRegistered");
      await expect(registry.reassign(missing, PK, NKH, ENC))
        .to.be.revertedWithCustomError(registry, "AliasNotRegistered");
    });

    it("validates keys on reassignment too", async function () {
      await expect(registry.reassign(h, PK, ethers.ZeroHash, ENC))
        .to.be.revertedWithCustomError(registry, "InvalidNullifierKeyHash");
      await expect(registry.reassign(h, PK, NKH, ethers.ZeroHash))
        .to.be.revertedWithCustomError(registry, "InvalidEncryptionPubkey");
      await expect(registry.reassign(h, PK, ethers.toBeHex(FIELD_PRIME, 32), ENC))
        .to.be.revertedWithCustomError(registry, "NullifierKeyHashOutOfField");
      await expect(registry.reassign(h, ethers.ZeroHash, NKH, ENC))
        .to.be.revertedWithCustomError(registry, "InvalidSpendingPubkey");
    });
  });

  it("refuses a second alias congruent to one already registered", async function () {
    // The SMT key is `aliasHash % FIELD_PRIME`, but AliasTaken is checked on the full
    // bytes32. FIELD_PRIME is ~0.189 of 2^256, so most keccak outputs already reduce, and
    // `h` and `h + p` are distinct aliases that produce the SAME circuit-visible key.
    //
    // Unreachable by choosing a name — that would take ~2^254 work — and harmless if it
    // happened, since the note commitment binds the spending pubkey. Enforced anyway so
    // that "one alias, one key" is a property of this contract rather than an assumption
    // every consumer of the circuit's aliasHash signal has to re-derive for itself.
    const h = BigInt(rand32()) % (1n << 250n);          // comfortably below 2^256 - p
    const hPrime = h + FIELD_PRIME;
    expect(hPrime).to.be.lessThan(1n << 256n);
    expect(h % FIELD_PRIME).to.equal(hPrime % FIELD_PRIME);

    // The two reduce to one key, and only the first may hold it.
    expect(aliasHashToKey(ethers.toBeHex(h, 32))).to.equal(aliasHashToKey(ethers.toBeHex(hPrime, 32)));

    await (await registry.register(ethers.toBeHex(h, 32), PK, NKH, ENC)).wait();
    await expect(registry.register(ethers.toBeHex(hPrime, 32), PK, NKH, ENC))
      .to.be.revertedWithCustomError(registry, "AliasKeyTaken");

    expect(await registry.aliasByKey(h % FIELD_PRIME)).to.equal(ethers.toBeHex(h, 32));
    expect(await registry.isRegistered(ethers.toBeHex(hPrime, 32))).to.equal(false);

    // An unrelated alias is unaffected — the guard is on the key, not on registration.
    await expect(registry.register(rand32(), PK, NKH, ENC)).to.not.be.reverted;
  });

  // ── Agreement with the off-chain tree ───────────────────────────────────────

  it("tracks an independently built SMT through a full history", async function () {
    // This is the assertion the circuit's correctness rests on. Anything that changes the
    // leaf layout or the update path breaks here before it breaks a proof.
    const offchain = new SMT();
    const hashes: string[] = [];

    for (let i = 0; i < 3; i++) {
      const h = rand32();
      hashes.push(h);
      await (await registry.register(h, PK, NKH, ENC)).wait();
      offchain.update(i, aliasHashToKey(h), leafOf(PK, NKH, ethers.ZeroHash));
      expect(BigInt(await registry.getRegistryRoot())).to.equal(offchain.root);
    }

    // In-place update at an existing slot, not an append.
    const newNkh = ethers.toBeHex(44n, 32);
    await (await registry.reassign(hashes[1], PK, newNkh, ENC)).wait();
    offchain.update(1, aliasHashToKey(hashes[1]), leafOf(PK, newNkh, ethers.ZeroHash));
    expect(BigInt(await registry.getRegistryRoot())).to.equal(offchain.root);

    // And a dataHash write, which moves the third leaf input.
    const data = randField();
    await (await registry.setDataHash(hashes[2], data)).wait();
    offchain.update(2, aliasHashToKey(hashes[2]), leafOf(PK, NKH, data));
    expect(BigInt(await registry.getRegistryRoot())).to.equal(offchain.root);
  });

  it("leafOf agrees with what the tree committed", async function () {
    const h = rand32();
    await (await registry.register(h, PK, NKH, ENC)).wait();
    const offchain = new SMT();
    offchain.update(0, aliasHashToKey(h), BigInt(await registry.leafOf(h)));
    expect(BigInt(await registry.getRegistryRoot())).to.equal(offchain.root);
  });
});
