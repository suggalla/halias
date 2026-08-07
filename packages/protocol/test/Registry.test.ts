import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { SMT, registryLeaf, aliasHashToKey, toNullifierKeyHash } from "./helpers/smt";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("Registry", function () {
  async function deployHalias() {
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    const PoseidonT4 = await ethers.getContractFactory("PoseidonT4");
    const poseidonT4 = await PoseidonT4.deploy();
    const TransactVerifier = await ethers.getContractFactory("TransactVerifier");
    const transactVerifier = await TransactVerifier.deploy();
    const Halias = await ethers.getContractFactory("Halias", {
      libraries: {
        PoseidonT3: await poseidonT3.getAddress(),
        PoseidonT4: await poseidonT4.getAddress(),
      },
    });
    const halias = await Halias.deploy(await transactVerifier.getAddress(), (await ethers.getSigners())[0].address);
    return { halias };
  }

  // Valid field-element keys (pubkey = Poseidon(spendingPrivKey), but we use
  // small constants here since registration only checks < FIELD_PRIME).
  const spendingPubkey   = ethers.toBeHex(0x1234n, 32);
  const nullifierKey     = ethers.toBeHex(0x5678n, 32);
  const encryptionPubkey = ethers.keccak256(ethers.toUtf8Bytes("encryption"));
  const REGISTRATION_FEE = ethers.parseEther("0.002");
  // Contract accepts nullifierKeyHash = Poseidon(nullifierKey, 1). Computed in before().
  let nullifierKeyHash: string;

  before(async () => {
    await initPoseidon();
    nullifierKeyHash = ethers.toBeHex(toNullifierKeyHash(0x5678n), 32);
  });

  describe(".hls registration", function () {
    it("should register an alias and read it back", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });

      const data = await halias.aliases(aliasHash);
      expect(data.spendingPubkey).to.equal(spendingPubkey);
      expect(data.nullifierKeyHash).to.equal(nullifierKeyHash);
      expect(data.encryptionPubkey).to.equal(encryptionPubkey);
    });

    it("should mint an ERC-721 token to the registrant", async function () {
      const { halias } = await deployHalias();
      const [owner] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });

      expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(owner.address);
    });

    it("should emit AliasRegistered event", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("bob.hls"));
      const expectedLeaf = ethers.toBeHex(registryLeaf(BigInt(spendingPubkey), BigInt(nullifierKey)), 32);

      await expect(halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE }))
        .to.emit(halias, "AliasRegistered")
        .withArgs(aliasHash, spendingPubkey, expectedLeaf, encryptionPubkey, 1); // slot 1 = first alias, stored offset by one
    });

    it("should reject wrong fee", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("bob.hls"));

      await expect(
        halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: ethers.parseEther("0.001") })
      ).to.be.revertedWithCustomError(halias, "WrongRegistrationFee");
    });

    it("should reject pubkey outside the BN254 scalar field", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("eve.hls"));
      const oversized = ethers.toBeHex(FIELD_PRIME, 32);

      await expect(
        halias.register(aliasHash, oversized, nullifierKey, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "PubkeyOutOfField");
    });

    it("should allow admin to update registration fee", async function () {
      const { halias } = await deployHalias();
      const newFee = ethers.parseEther("0.005");

      await expect(halias.setRegistrationFee(newFee))
        .to.emit(halias, "FeeUpdated")
        .withArgs(REGISTRATION_FEE, newFee);

      expect(await halias.registrationFee()).to.equal(newFee);

      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("charlie.hls"));
      await expect(
        halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "WrongRegistrationFee");

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: newFee });
    });

    it("should reject fee update from non-admin", async function () {
      const { halias } = await deployHalias();
      const [, other] = await ethers.getSigners();

      await expect(
        halias.connect(other).setRegistrationFee(ethers.parseEther("0.005"))
      ).to.be.revertedWithCustomError(halias, "NotAdmin");
    });

    it("should reject duplicate registration", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "AliasTaken");
    });
  });

  describe("updateKeys", function () {
    const newNullifierKey     = ethers.toBeHex(0x9999n, 32);
    const newEncryptionPubkey = ethers.toBeHex(0xaaaan, 32);
    let newNullifierKeyHash: string;
    before(async () => { newNullifierKeyHash = ethers.toBeHex(toNullifierKeyHash(0x9999n), 32); });

    it("should allow owner to rotate nullifierKey and encryptionPubkey", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await halias.updateKeys(aliasHash, newNullifierKeyHash, newEncryptionPubkey);

      const data = await halias.aliases(aliasHash);
      expect(data.nullifierKeyHash).to.equal(newNullifierKeyHash);
      expect(data.encryptionPubkey).to.equal(newEncryptionPubkey);
      expect(data.spendingPubkey).to.equal(spendingPubkey);
    });

    it("should emit KeysUpdated event", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const expectedLeaf = ethers.toBeHex(registryLeaf(BigInt(spendingPubkey), BigInt(newNullifierKey)), 32);
      await expect(halias.updateKeys(aliasHash, newNullifierKeyHash, newEncryptionPubkey))
        .to.emit(halias, "KeysUpdated")
        .withArgs(aliasHash, spendingPubkey, expectedLeaf, newEncryptionPubkey);
    });

    it("should update smtRoot to match local SMT after key rotation", async function () {
      const { halias } = await deployHalias();
      const smt = new SMT();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      const key = aliasHashToKey(aliasHash);

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const slot = Number(await halias.aliasSlot(aliasHash)) - 1;
      smt.update(slot, key, registryLeaf(BigInt(spendingPubkey), BigInt(nullifierKey)));

      expect(await halias.getRegistryRoot()).to.equal(ethers.toBeHex(smt.root, 32), "root mismatch after registration");

      await halias.updateKeys(aliasHash, newNullifierKeyHash, newEncryptionPubkey);
      // Rotation reuses the same slot — that is what keeps the update in place.
      smt.update(slot, key, registryLeaf(BigInt(spendingPubkey), BigInt(newNullifierKey)));

      expect(await halias.getRegistryRoot()).to.equal(ethers.toBeHex(smt.root, 32), "root mismatch after updateKeys");
    });

    it("should reject updateKeys from non-owner", async function () {
      const { halias } = await deployHalias();
      const [, other] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias.connect(other).updateKeys(aliasHash, newNullifierKeyHash, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "NotAliasOwner");
    });

    it("should reject nullifierKey outside the BN254 scalar field", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      const oversized = ethers.toBeHex(FIELD_PRIME, 32);

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias.updateKeys(aliasHash, oversized, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "NullifierKeyHashOutOfField");
    });

    it("should reject zero encryptionPubkey", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias.updateKeys(aliasHash, newNullifierKeyHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(halias, "InvalidEncryptionPubkey");
    });
  });

  describe("transferAliasWithKeys", function () {
    const newSpendingPubkey   = ethers.toBeHex(0xbbbn, 32);
    const newNullifierKey     = ethers.toBeHex(0xcccn, 32);
    const newEncryptionPubkey = ethers.toBeHex(0xdddn, 32);
    let newNullifierKeyHash: string;
    before(async () => { newNullifierKeyHash = ethers.toBeHex(toNullifierKeyHash(0xcccn), 32); });

    it("should transfer alias and update all keys", async function () {
      const { halias } = await deployHalias();
      const [owner, newOwner] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });

      const expectedLeaf = ethers.toBeHex(registryLeaf(BigInt(newSpendingPubkey), BigInt(newNullifierKey)), 32);
      await expect(
        halias.transferAliasWithKeys(aliasHash, newOwner.address, newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey)
      )
        .to.emit(halias, "AliasTransferred")
        .withArgs(aliasHash, owner.address, newOwner.address, newSpendingPubkey, expectedLeaf, newEncryptionPubkey);

      expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(newOwner.address);
      const data = await halias.aliases(aliasHash);
      expect(data.spendingPubkey).to.equal(newSpendingPubkey);
      expect(data.nullifierKeyHash).to.equal(newNullifierKeyHash);
      expect(data.encryptionPubkey).to.equal(newEncryptionPubkey);
    });

    it("should update smtRoot for the new identity (in-place update, same key)", async function () {
      const { halias } = await deployHalias();
      const smt = new SMT();
      const [, newOwner] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      const key = aliasHashToKey(aliasHash);

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const slot = Number(await halias.aliasSlot(aliasHash)) - 1;
      smt.update(slot, key, registryLeaf(BigInt(spendingPubkey), BigInt(nullifierKey)));

      await halias.transferAliasWithKeys(aliasHash, newOwner.address, newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey);
      // Transfer keeps the slot too: the alias moves owner, not position.
      smt.update(slot, key, registryLeaf(BigInt(newSpendingPubkey), BigInt(newNullifierKey)));

      expect(await halias.getRegistryRoot()).to.equal(ethers.toBeHex(smt.root, 32));
    });

    it("should reject transferAliasWithKeys from non-owner", async function () {
      const { halias } = await deployHalias();
      const [, other] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias.connect(other).transferAliasWithKeys(aliasHash, other.address, newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "NotAliasOwner");
    });

    it("should reject transfer to zero address", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias.transferAliasWithKeys(aliasHash, ethers.ZeroAddress, newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "InvalidOwner");
    });

    it("new owner can updateKeys after transfer", async function () {
      const { halias } = await deployHalias();
      const [, newOwner] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      const rotatedNullifierHash = ethers.toBeHex(toNullifierKeyHash(0xeeen), 32);
      const rotatedEncPubkey     = ethers.toBeHex(0xfffn, 32);

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await halias.transferAliasWithKeys(aliasHash, newOwner.address, newSpendingPubkey, newNullifierKeyHash, newEncryptionPubkey);

      await expect(
        halias.updateKeys(aliasHash, rotatedNullifierHash, rotatedEncPubkey)
      ).to.be.revertedWithCustomError(halias, "NotAliasOwner");

      await halias.connect(newOwner).updateKeys(aliasHash, rotatedNullifierHash, rotatedEncPubkey);
      expect((await halias.aliases(aliasHash)).nullifierKeyHash).to.equal(rotatedNullifierHash);
    });

    it("ERC-721 safeTransferFrom is blocked — use transferAliasWithKeys", async function () {
      const { halias } = await deployHalias();
      const [owner, other] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      await expect(
        halias["safeTransferFrom(address,address,uint256)"](owner.address, other.address, BigInt(aliasHash))
      ).to.be.revertedWithCustomError(halias, "UseTransferAliasWithKeys");
    });
  });

  describe("Registry SMT", function () {
    it("starts with the empty-tree root", async function () {
      const { halias } = await deployHalias();
      const smt = new SMT();
      expect(await halias.getRegistryRoot()).to.equal(ethers.toBeHex(smt.root, 32));
    });

    it("updates smtRoot after each registration", async function () {
      const { halias } = await deployHalias();
      const smt = new SMT();

      const aliases = [
        { name: "alice.hls", pubkey: 0x1111n, nk: 0x1112n },
        { name: "bob.hls",   pubkey: 0x2222n, nk: 0x2223n },
        { name: "carol.hls", pubkey: 0x3333n, nk: 0x3334n },
      ];

      for (const a of aliases) {
        const aliasHash = ethers.keccak256(ethers.toUtf8Bytes(a.name));
        await halias.register(
          aliasHash,
          ethers.toBeHex(a.pubkey, 32),
          ethers.toBeHex(toNullifierKeyHash(a.nk), 32),
          encryptionPubkey, "",
          { value: REGISTRATION_FEE }
        );
        // Slots are handed out in registration order, so the local mirror follows the
        // same sequence the contract used rather than deriving a position from the name.
        const slot = Number(await halias.aliasSlot(aliasHash)) - 1;
        smt.update(slot, aliasHashToKey(aliasHash), registryLeaf(a.pubkey, a.nk));

        expect(await halias.getRegistryRoot()).to.equal(
          ethers.toBeHex(smt.root, 32),
          `root mismatch after registering ${a.name}`
        );
      }
    });

    it("getSmtSiblings returns siblings matching local SMT", async function () {
      const { halias } = await deployHalias();
      const smt = new SMT();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      const key = aliasHashToKey(aliasHash);

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const slot = Number(await halias.aliasSlot(aliasHash)) - 1;
      smt.update(slot, key, registryLeaf(BigInt(spendingPubkey), BigInt(nullifierKey)));

      // getSmtSiblings takes the slot now, not the alias key.
      const contractSiblings = await halias.getSmtSiblings(slot);
      const localSiblings    = smt.getSiblings(slot);
      for (let i = 0; i < 32; i++) {
        expect(contractSiblings[i]).to.equal(ethers.toBeHex(localSiblings[i], 32));
      }
    });

    it("smtRoot changes after key rotation but alias count stays the same", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const rootAfterRegister = await halias.getRegistryRoot();

      await halias.updateKeys(aliasHash, ethers.toBeHex(0x9999n, 32), ethers.toBeHex(0xaaaan, 32));
      const rootAfterUpdate = await halias.getRegistryRoot();

      expect(rootAfterRegister).to.not.equal(rootAfterUpdate);
    });
  });

  // ── Registration input validation (zero / invalid fields) ──────────────────

  describe("registration input validation", function () {
    it("rejects zero aliasHash", async function () {
      const { halias } = await deployHalias();
      await expect(
        halias.register(ethers.ZeroHash, spendingPubkey, nullifierKey, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "InvalidAliasHash");
    });

    it("rejects zero spendingPubkey", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      await expect(
        halias.register(aliasHash, ethers.ZeroHash, nullifierKey, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "InvalidSpendingPubkey");
    });

    it("rejects zero nullifierKey", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      await expect(
        halias.register(aliasHash, spendingPubkey, ethers.ZeroHash, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "InvalidNullifierKeyHash");
    });

    it("rejects zero encryptionPubkey", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      await expect(
        halias.register(aliasHash, spendingPubkey, nullifierKey, ethers.ZeroHash, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "InvalidEncryptionPubkey");
    });

    it("rejects nullifierKey >= FIELD_PRIME", async function () {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      const oversized = ethers.toBeHex(FIELD_PRIME, 32);
      await expect(
        halias.register(aliasHash, spendingPubkey, oversized, encryptionPubkey, "", { value: REGISTRATION_FEE })
      ).to.be.revertedWithCustomError(halias, "NullifierKeyHashOutOfField");
    });
  });

  // ── transferAliasWithKeys — input validation ────────────────────────────────

  describe("transferAliasWithKeys — input validation", function () {
    const newSpendingPubkey   = ethers.toBeHex(0xbbbn, 32);
    const newNullifierKey     = ethers.toBeHex(0xcccn, 32);
    const newEncryptionPubkey = ethers.toBeHex(0xdddn, 32);
    let newNullifierKeyHash: string;
    before(async () => { newNullifierKeyHash = ethers.toBeHex(toNullifierKeyHash(0xcccn), 32); });

    async function registerAlice() {
      const { halias } = await deployHalias();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      return { halias, aliasHash };
    }

    it("rejects zero newSpendingPubkey", async function () {
      const { halias, aliasHash } = await registerAlice();
      const [, newOwner] = await ethers.getSigners();
      await expect(
        halias.transferAliasWithKeys(aliasHash, newOwner.address, ethers.ZeroHash, newNullifierKeyHash, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "InvalidSpendingPubkey");
    });

    it("rejects zero newNullifierKey", async function () {
      const { halias, aliasHash } = await registerAlice();
      const [, newOwner] = await ethers.getSigners();
      await expect(
        halias.transferAliasWithKeys(aliasHash, newOwner.address, newSpendingPubkey, ethers.ZeroHash, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "InvalidNullifierKeyHash");
    });

    it("rejects zero newEncryptionPubkey", async function () {
      const { halias, aliasHash } = await registerAlice();
      const [, newOwner] = await ethers.getSigners();
      await expect(
        halias.transferAliasWithKeys(aliasHash, newOwner.address, newSpendingPubkey, newNullifierKeyHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(halias, "InvalidEncryptionPubkey");
    });

    it("rejects newSpendingPubkey >= FIELD_PRIME", async function () {
      const { halias, aliasHash } = await registerAlice();
      const [, newOwner] = await ethers.getSigners();
      await expect(
        halias.transferAliasWithKeys(aliasHash, newOwner.address, ethers.toBeHex(FIELD_PRIME, 32), newNullifierKeyHash, newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "PubkeyOutOfField");
    });

    it("rejects newNullifierKey >= FIELD_PRIME", async function () {
      const { halias, aliasHash } = await registerAlice();
      const [, newOwner] = await ethers.getSigners();
      await expect(
        halias.transferAliasWithKeys(aliasHash, newOwner.address, newSpendingPubkey, ethers.toBeHex(FIELD_PRIME, 32), newEncryptionPubkey)
      ).to.be.revertedWithCustomError(halias, "NullifierKeyHashOutOfField");
    });

    it("ERC-721 transferFrom is blocked — use transferAliasWithKeys", async function () {
      const { halias, aliasHash } = await registerAlice();
      const [owner, other] = await ethers.getSigners();
      await expect(
        halias["transferFrom(address,address,uint256)"](owner.address, other.address, BigInt(aliasHash))
      ).to.be.revertedWithCustomError(halias, "UseTransferAliasWithKeys");
    });
  });

  // ── Admin operations ────────────────────────────────────────────────────────

  describe("Admin operations", function () {
    it("two-step admin transfer: transferAdmin + acceptAdmin", async function () {
      const { halias } = await deployHalias();
      const [owner, newAdmin] = await ethers.getSigners();

      await halias.transferAdmin(newAdmin.address);
      expect(await halias.pendingAdmin()).to.equal(newAdmin.address);
      expect(await halias.admin()).to.equal(owner.address);

      await halias.connect(newAdmin).acceptAdmin();
      expect(await halias.admin()).to.equal(newAdmin.address);
      expect(await halias.pendingAdmin()).to.equal(ethers.ZeroAddress);
    });

    it("transferAdmin emits AdminTransferred only after acceptance", async function () {
      const { halias } = await deployHalias();
      const [owner, newAdmin] = await ethers.getSigners();
      await halias.transferAdmin(newAdmin.address);
      await expect(halias.connect(newAdmin).acceptAdmin())
        .to.emit(halias, "AdminTransferred")
        .withArgs(owner.address, newAdmin.address);
    });

    it("rejects transferAdmin to zero address", async function () {
      const { halias } = await deployHalias();
      await expect(halias.transferAdmin(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(halias, "InvalidAdmin");
    });

    it("rejects acceptAdmin from non-pending admin", async function () {
      const { halias } = await deployHalias();
      const [, newAdmin, stranger] = await ethers.getSigners();
      await halias.transferAdmin(newAdmin.address);
      await expect(halias.connect(stranger).acceptAdmin())
        .to.be.revertedWithCustomError(halias, "NotPendingAdmin");
    });

    it("only current admin can call transferAdmin", async function () {
      const { halias } = await deployHalias();
      const [, other] = await ethers.getSigners();
      await expect(halias.connect(other).transferAdmin(other.address))
        .to.be.revertedWithCustomError(halias, "NotAdmin");
    });

    it("withdrawFees sends accumulated fees to recipient", async function () {
      const { halias } = await deployHalias();
      const [owner, recipient] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));

      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const accumulated = await halias.accumulatedFees();
      expect(accumulated).to.be.gt(0n);

      const balBefore = await ethers.provider.getBalance(recipient.address);
      await halias.withdrawFees(recipient.address, accumulated);
      expect(await ethers.provider.getBalance(recipient.address) - balBefore).to.equal(accumulated);
      expect(await halias.accumulatedFees()).to.equal(0n);
    });

    it("emits FeesWithdrawn", async function () {
      const { halias } = await deployHalias();
      const [owner, recipient] = await ethers.getSigners();
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const accumulated = await halias.accumulatedFees();
      await expect(halias.withdrawFees(recipient.address, accumulated))
        .to.emit(halias, "FeesWithdrawn")
        .withArgs(recipient.address, accumulated);
    });

    it("rejects withdrawFees above accumulated amount", async function () {
      const { halias } = await deployHalias();
      await expect(halias.withdrawFees(ethers.Wallet.createRandom().address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(halias, "NoFeesToWithdraw");
    });

    it("setBaseTokenURI stores the URI", async function () {
      const { halias } = await deployHalias();
      await halias.setBaseTokenURI("https://halias.xyz/nft/");
      // Mint a token so tokenURI is callable
      const aliasHash = ethers.keccak256(ethers.toUtf8Bytes("alice.hls"));
      await halias.register(aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey, "", { value: REGISTRATION_FEE });
      const tokenId = BigInt(aliasHash);
      expect(await halias.tokenURI(tokenId)).to.equal("https://halias.xyz/nft/" + tokenId.toString());
    });
  });

  // ── receive() — ETH push guard ─────────────────────────────────────────────

  describe("receive()", function () {
    it("rejects direct ETH transfers", async function () {
      const { halias } = await deployHalias();
      const [sender] = await ethers.getSigners();
      await expect(
        sender.sendTransaction({ to: await halias.getAddress(), value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(halias, "DirectETHNotAllowed");
    });
  });
});
