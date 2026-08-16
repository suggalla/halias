import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon } from "./helpers/poseidon";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO_PROOF = "0x" + "00".repeat(256);

function withdrawPublicAmount(absAmount: bigint): bigint {
  return FIELD_PRIME - absAmount;
}

describe("Voucher system (pool-note model)", function () {
  this.timeout(30000);

  let halias: any;
  let ep: any;
  let haliasAddress: string;
  let REGISTRATION_FEE: bigint;
  let MAX_VOUCHER_GAS_BUDGET: bigint;

  let owner: any;
  let sponsor: any;
  let user: any;

  async function deployStack() {
    const t3  = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4  = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const mv  = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
    const ep_ = await (await ethers.getContractFactory("MockEntryPoint")).deploy();
    const h   = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await mv.getAddress(), await ep_.getAddress());
    return { halias: h, ep: ep_ };
  }

  function randBytes32(): string {
    return ethers.keccak256(ethers.randomBytes(32));
  }

  before(async function () {
    await initPoseidon();
    [owner, sponsor, user] = await ethers.getSigners();
  });

  beforeEach(async function () {
    ({ halias, ep } = await deployStack());
    haliasAddress = await halias.getAddress();
    REGISTRATION_FEE = await halias.registrationFee();
    MAX_VOUCHER_GAS_BUDGET = await halias.MAX_VOUCHER_GAS_BUDGET();
  });

  // Deposits a voucher via transact() (circuit-enforced amount), then atomically
  // spends it + registers an alias via registerWithPoolNote().
  async function depositAndRegister(opts: {
    gasBudget?:        bigint;
    aliasHash?:        string;
    spendingPubkey?:   string;
    nullifierKeyHash?: string;
    encryptionPubkey?: string;
  } = {}) {
    const gasBudget = opts.gasBudget ?? ethers.parseEther("0.001");
    const total     = REGISTRATION_FEE + gasBudget;

    // Alice deposits via transact() — circuit enforces output note amount == msg.value.
    const depositPoolRoot     = await halias.getLastRoot();
    const depositRegistryRoot = await halias.getRegistryRoot();
    await halias.connect(sponsor).transact(
      { poolRoot: depositPoolRoot, registryRoot: depositRegistryRoot, publicAmount: total, tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash },
      "0x", "0x", ZERO_PROOF,
      { value: total },
    );

    const poolRoot     = await halias.getLastRoot();
    const registryRoot = await halias.getRegistryRoot();
    const publicAmount = withdrawPublicAmount(total);

    const aliasHash        = opts.aliasHash        ?? randBytes32();
    const spendingPubkey   = opts.spendingPubkey   ?? ethers.toBeHex(3n, 32);
    const nullifierKeyHash = opts.nullifierKeyHash ?? ethers.toBeHex(5n, 32);
    const encryptionPubkey = opts.encryptionPubkey ?? randBytes32();

    const null0 = randBytes32();
    const null1 = randBytes32();

    const tx = await halias.connect(user).registerWithPoolNote(
      { poolRoot, registryRoot, publicAmount, tokenAddress: 0n, inputNullifiers: [null0, null1], outputCommitments: [randBytes32(), randBytes32()], recipient: haliasAddress, externalData: ethers.ZeroHash },
      "0x", "0x", ZERO_PROOF,
      aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey,
    );

    return { tx, aliasHash, gasBudget, total, null0, null1 };
  }

  // ── registerWithPoolNote ───────────────────────────────────────────────────

  describe("registerWithPoolNote", function () {
    it("registers alias and mints ERC-721 to caller", async function () {
      const { aliasHash } = await depositAndRegister();
      expect(await halias.ownerOf(ethers.toBigInt(aliasHash))).to.equal(user.address);
    });

    it("stores alias keys correctly", async function () {
      const aliasHash        = randBytes32();
      const spendingPubkey   = ethers.toBeHex(3n, 32);
      const nullifierKeyHash = ethers.toBeHex(5n, 32);
      const encryptionPubkey = randBytes32();
      await depositAndRegister({ aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey });
      const alias = await halias.aliases(aliasHash);
      expect(alias.spendingPubkey).to.equal(spendingPubkey);
      expect(alias.nullifierKeyHash).to.equal(nullifierKeyHash);
      expect(alias.encryptionPubkey).to.equal(encryptionPubkey);
    });

    it("adds full absAmount (fee + gas budget) to accumulatedFees", async function () {
      const gasBudget  = ethers.parseEther("0.001");
      const feesBefore = await halias.accumulatedFees();
      const { total }  = await depositAndRegister({ gasBudget });
      expect(await halias.accumulatedFees() - feesBefore).to.equal(total);
    });

    it("does not deposit to EntryPoint (all goes to accumulatedFees)", async function () {
      const epContract = await ethers.getContractAt("MockEntryPoint", await halias.entryPoint());
      const balBefore  = await epContract.balanceOf(haliasAddress);
      await depositAndRegister({ gasBudget: ethers.parseEther("0.001") });
      expect(await epContract.balanceOf(haliasAddress)).to.equal(balBefore);
    });

    it("marks both nullifiers as spent", async function () {
      const { null0, null1 } = await depositAndRegister();
      expect(await halias.spentNullifiers(null0)).to.be.true;
      expect(await halias.spentNullifiers(null1)).to.be.true;
    });

    it("works with zero gas budget — only registrationFee to accumulatedFees", async function () {
      const feesBefore = await halias.accumulatedFees();
      await depositAndRegister({ gasBudget: 0n });
      expect(await halias.accumulatedFees() - feesBefore).to.equal(REGISTRATION_FEE);
    });

    it("emits AliasRegistered event", async function () {
      const aliasHash = randBytes32();
      const { tx }    = await depositAndRegister({ aliasHash });
      await expect(tx).to.emit(halias, "AliasRegistered");
    });

    it("accepts absAmount exactly at the cap", async function () {
      await depositAndRegister({ gasBudget: MAX_VOUCHER_GAS_BUDGET });
      // passes without revert
    });

    it("rejects deposit (non-withdrawal) publicAmount", async function () {
      const poolRoot     = await halias.getLastRoot();
      const registryRoot = await halias.getRegistryRoot();
      await expect(
        halias.connect(user).registerWithPoolNote(
          { poolRoot, registryRoot, publicAmount: REGISTRATION_FEE, tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: haliasAddress, externalData: ethers.ZeroHash },
          "0x", "0x", ZERO_PROOF,
          randBytes32(), ethers.toBeHex(3n, 32), ethers.toBeHex(5n, 32), randBytes32(),
        )
      ).to.be.revertedWithCustomError(halias, "NotAWithdrawal");
    });

    it("rejects when absAmount < registrationFee", async function () {
      const poolRoot     = await halias.getLastRoot();
      const registryRoot = await halias.getRegistryRoot();
      await expect(
        halias.connect(user).registerWithPoolNote(
          { poolRoot, registryRoot, publicAmount: withdrawPublicAmount(REGISTRATION_FEE - 1n), tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: haliasAddress, externalData: ethers.ZeroHash },
          "0x", "0x", ZERO_PROOF,
          randBytes32(), ethers.toBeHex(3n, 32), ethers.toBeHex(5n, 32), randBytes32(),
        )
      ).to.be.revertedWithCustomError(halias, "VoucherInsufficientForFee");
    });

    it("rejects when absAmount exceeds registrationFee + MAX_VOUCHER_GAS_BUDGET", async function () {
      const oversized    = REGISTRATION_FEE + MAX_VOUCHER_GAS_BUDGET + 1n;
      const poolRoot     = await halias.getLastRoot();
      const registryRoot = await halias.getRegistryRoot();
      await expect(
        halias.connect(user).registerWithPoolNote(
          { poolRoot, registryRoot, publicAmount: withdrawPublicAmount(oversized), tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: haliasAddress, externalData: ethers.ZeroHash },
          "0x", "0x", ZERO_PROOF,
          randBytes32(), ethers.toBeHex(3n, 32), ethers.toBeHex(5n, 32), randBytes32(),
        )
      ).to.be.revertedWithCustomError(halias, "VoucherTooLarge");
    });

    it("rejects when recipient is not address(this)", async function () {
      const poolRoot     = await halias.getLastRoot();
      const registryRoot = await halias.getRegistryRoot();
      await expect(
        halias.connect(user).registerWithPoolNote(
          { poolRoot, registryRoot, publicAmount: withdrawPublicAmount(REGISTRATION_FEE), tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: user.address, externalData: ethers.ZeroHash },
          "0x", "0x", ZERO_PROOF,
          randBytes32(), ethers.toBeHex(3n, 32), ethers.toBeHex(5n, 32), randBytes32(),
        )
      ).to.be.revertedWithCustomError(halias, "MustWithdrawToSelf");
    });

    it("rejects unknown pool root", async function () {
      const registryRoot = await halias.getRegistryRoot();
      await expect(
        halias.connect(user).registerWithPoolNote(
          { poolRoot: randBytes32(), registryRoot, publicAmount: withdrawPublicAmount(REGISTRATION_FEE), tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: haliasAddress, externalData: ethers.ZeroHash },
          "0x", "0x", ZERO_PROOF,
          randBytes32(), ethers.toBeHex(3n, 32), ethers.toBeHex(5n, 32), randBytes32(),
        )
      ).to.be.revertedWithCustomError(halias, "PoolRootUnknown");
    });

    it("rejects double-spend of a nullifier", async function () {
      const { null0 } = await depositAndRegister();

      // Fund a second registration
      const total2               = REGISTRATION_FEE + ethers.parseEther("0.001");
      const depositPoolRoot2     = await halias.getLastRoot();
      const depositRegistryRoot2 = await halias.getRegistryRoot();
      await halias.connect(sponsor).transact(
        { poolRoot: depositPoolRoot2, registryRoot: depositRegistryRoot2, publicAmount: total2, tokenAddress: 0n, inputNullifiers: [randBytes32(), randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash },
        "0x", "0x", ZERO_PROOF,
        { value: total2 },
      );

      const poolRoot2     = await halias.getLastRoot();
      const registryRoot2 = await halias.getRegistryRoot();
      await expect(
        halias.connect(user).registerWithPoolNote(
          { poolRoot: poolRoot2, registryRoot: registryRoot2, publicAmount: withdrawPublicAmount(total2), tokenAddress: 0n, inputNullifiers: [null0, randBytes32()], outputCommitments: [randBytes32(), randBytes32()], recipient: haliasAddress, externalData: ethers.ZeroHash },
          "0x", "0x", ZERO_PROOF,
          randBytes32(), ethers.toBeHex(3n, 32), ethers.toBeHex(5n, 32), randBytes32(),
        )
      ).to.be.revertedWithCustomError(halias, "Input0AlreadySpent");
    });
  });
});
