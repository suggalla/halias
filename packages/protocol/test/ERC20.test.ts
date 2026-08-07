import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon } from "./helpers/poseidon";
import { SMT, registryLeaf, aliasHashToKey, toNullifierKeyHash } from "./helpers/smt";

// MockTransactVerifier always returns true, so we don't need real ZK proofs here.
// All tests exercise the Solidity payment routing logic in isolation.
// _verifyTransact still ABI-decodes the proof before calling the verifier, so we
// must supply 256 zero bytes (the minimal valid encoding of (uint[2], uint[2][2], uint[2])).

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const POOL_LEVELS = 32;

const ZERO_PROOF = "0x" + "00".repeat(256);

function withdrawPublicAmount(absAmount: bigint): bigint {
  return FIELD_PRIME - absAmount;
}

const ZERO_PARAMS = {
  poolRoot:          ethers.ZeroHash, // filled in per-call by callTransact
  registryRoot:      ethers.ZeroHash, // filled in per-call by callTransact
  publicAmount:      0n,
  tokenAddress:      0n,
  inputNullifiers:   [ethers.ZeroHash, ethers.ZeroHash],
  outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
  recipient:         ethers.ZeroAddress,
  externalData:      ethers.ZeroHash,
};

describe("ERC-20", function () {
  this.timeout(30000);

  let halias: any;
  let mockToken: any;
  let mockFeeToken: any;
  let registrySMT: SMT;

  let haliasAddress: string;
  let REGISTRATION_FEE: bigint;

  let owner: any;
  let user: any;
  let recipient: any;

  before(async function () {
    await initPoseidon();
    [owner, user, recipient] = await ethers.getSigners();
  });

  beforeEach(async function () {
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const t3 = await PoseidonT3.deploy();
    const PoseidonT4 = await ethers.getContractFactory("PoseidonT4");
    const t4 = await PoseidonT4.deploy();
    const MockVerifier = await ethers.getContractFactory("MockTransactVerifier");
    const mv = await MockVerifier.deploy();
    const Halias = await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    });
    halias = await Halias.deploy(await mv.getAddress(), (await ethers.getSigners())[0].address);
    haliasAddress = await halias.getAddress();
    REGISTRATION_FEE = await halias.registrationFee();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MCK", 18);

    const MockFeeToken = await ethers.getContractFactory("MockFeeToken");
    mockFeeToken = await MockFeeToken.deploy();

    registrySMT = new SMT();

    // Register one alias so SMT root is non-trivial (avoids stale-root rejections)
    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    await halias.register(
      aliasHash,
      ethers.toBeHex(3n, 32),
      ethers.toBeHex(toNullifierKeyHash(5n), 32),
      ethers.keccak256(ethers.randomBytes(32)),
      { value: REGISTRATION_FEE }
    );
    const key  = aliasHashToKey(aliasHash);
    const slot = Number(await halias.aliasSlot(aliasHash)) - 1;
    registrySMT.update(slot, key, registryLeaf(3n, 5n));
  });

  async function poolRoot(): Promise<string> {
    return await halias.getLastRoot();
  }

  function registryRoot(): string {
    return ethers.toBeHex(registrySMT.root, 32);
  }

  async function callTransact(
    publicAmount: bigint,
    tokenAddress: bigint,
    params: any,
    value: bigint = 0n,
  ) {
    // Non-zero commitments: ZeroHash is indistinguishable from an empty tree slot
    // (poolZeros[0] = 0) and is now rejected by _insert.
    const p = {
      ...params,
      poolRoot:          await poolRoot(),
      registryRoot:      registryRoot(),
      publicAmount,
      tokenAddress,
      inputNullifiers:   [ethers.keccak256(ethers.randomBytes(32)), ethers.keccak256(ethers.randomBytes(32))],
      outputCommitments: [ethers.keccak256(ethers.randomBytes(32)), ethers.keccak256(ethers.randomBytes(32))],
    };
    return halias.connect(user).transact(p, "0x", "0x", ZERO_PROOF, { value });
  }

  // ── ERC-20 Deposit ─────────────────────────────────────────────────────────

  describe("ERC-20 deposit", function () {
    it("transfers tokens from sender to Halias on deposit", async function () {
      const amount = ethers.parseUnits("100", 18);
      await mockToken.mint(user.address, amount);
      await mockToken.connect(user).approve(haliasAddress, amount);

      const tokenAddress = BigInt(await mockToken.getAddress());
      const balBefore = await mockToken.balanceOf(haliasAddress);
      await callTransact(amount, tokenAddress, ZERO_PARAMS, 0n);
      const balAfter = await mockToken.balanceOf(haliasAddress);

      expect(balAfter - balBefore).to.equal(amount);
    });

    it("rejects ERC-20 deposit with ETH attached", async function () {
      const amount = ethers.parseUnits("100", 18);
      await mockToken.mint(user.address, amount);
      await mockToken.connect(user).approve(haliasAddress, amount);
      const tokenAddress = BigInt(await mockToken.getAddress());

      await expect(
        callTransact(amount, tokenAddress, ZERO_PARAMS, 1n)
      ).to.be.revertedWithCustomError(halias, "ERC20CannotHaveETH");
    });

    it("rejects fee-on-transfer token", async function () {
      const amount = ethers.parseUnits("100", 18);
      await mockFeeToken.mint(user.address, amount);
      await mockFeeToken.connect(user).approve(haliasAddress, amount);
      const tokenAddress = BigInt(await mockFeeToken.getAddress());

      await expect(
        callTransact(amount, tokenAddress, ZERO_PARAMS, 0n)
      ).to.be.revertedWithCustomError(halias, "FeeOnTransferToken");
    });
  });

  // ── ERC-20 Withdraw ────────────────────────────────────────────────────────

  describe("ERC-20 withdrawal", function () {
    async function seedHaliasWithTokens(amount: bigint) {
      // Deposit first so Halias holds the tokens
      await mockToken.mint(user.address, amount);
      await mockToken.connect(user).approve(haliasAddress, amount);
      const tokenAddress = BigInt(await mockToken.getAddress());
      await callTransact(amount, tokenAddress, ZERO_PARAMS, 0n);
    }

    it("sends tokens to recipient on withdrawal", async function () {
      const amount = ethers.parseUnits("50", 18);
      await seedHaliasWithTokens(amount);

      const tokenAddress = BigInt(await mockToken.getAddress());
      const params = { ...ZERO_PARAMS, recipient: recipient.address };

      const balBefore = await mockToken.balanceOf(recipient.address);
      await callTransact(withdrawPublicAmount(amount), tokenAddress, params, 0n);
      const balAfter = await mockToken.balanceOf(recipient.address);

      expect(balAfter - balBefore).to.equal(amount);
    });

    it("emits Withdrawal event with tokenAddress", async function () {
      const amount = ethers.parseUnits("20", 18);
      await seedHaliasWithTokens(amount);

      const tokenAddress = BigInt(await mockToken.getAddress());
      const params = { ...ZERO_PARAMS, recipient: recipient.address };

      await expect(
        callTransact(withdrawPublicAmount(amount), tokenAddress, params, 0n)
      ).to.emit(halias, "Withdrawal").withArgs(recipient.address, amount, tokenAddress);
    });

    it("rejects withdrawal with no destination", async function () {
      const amount = ethers.parseUnits("10", 18);
      await seedHaliasWithTokens(amount);
      const tokenAddress = BigInt(await mockToken.getAddress());

      await expect(
        callTransact(withdrawPublicAmount(amount), tokenAddress, ZERO_PARAMS, 0n)
      ).to.be.revertedWithCustomError(halias, "NoDestination");
    });


  });

  // ── Pool integrity ─────────────────────────────────────────────────────────

  describe("Pool commitment integrity", function () {
    it("rejects zero output commitment (I2: indistinguishable from empty tree slot)", async function () {
      const nullifiers: [string, string] = [
        ethers.keccak256(ethers.randomBytes(32)),
        ethers.keccak256(ethers.randomBytes(32)),
      ];
      await expect(
        halias.connect(user).transact(
          { ...ZERO_PARAMS, poolRoot: await poolRoot(), registryRoot: registryRoot(), inputNullifiers: nullifiers, outputCommitments: [ethers.ZeroHash, ethers.ZeroHash] },
          "0x", "0x", "0x" + "00".repeat(256),
          { value: 0n }
        )
      ).to.be.revertedWithCustomError(halias, "ZeroCommitment");
    });
  });

  // ── ETH plain deposit/withdraw roundtrip ───────────────────────────────────

  describe("ETH deposit → withdraw roundtrip", function () {
    it("Halias balance increases on deposit and decreases on withdrawal", async function () {
      const amount = ethers.parseEther("1");

      const balBefore = await ethers.provider.getBalance(haliasAddress);
      await callTransact(amount, 0n, ZERO_PARAMS, amount);
      expect(await ethers.provider.getBalance(haliasAddress) - balBefore).to.equal(amount);

      const params = { ...ZERO_PARAMS, recipient: recipient.address };
      const recipientBefore = await ethers.provider.getBalance(recipient.address);
      await callTransact(withdrawPublicAmount(amount), 0n, params, 0n);
      expect(await ethers.provider.getBalance(recipient.address) - recipientBefore).to.equal(amount);
      expect(await ethers.provider.getBalance(haliasAddress)).to.equal(balBefore);
    });
  });

  // ── ETH withdrawal with msg.value ──────────────────────────────────────────

  describe("ETH withdrawal edge cases", function () {
    it("rejects ETH withdrawal with msg.value attached (WithdrawCannotHaveValue)", async function () {
      // Seed contract with ETH first
      const amount = ethers.parseEther("0.5");
      await callTransact(amount, 0n, ZERO_PARAMS, amount);

      const params = { ...ZERO_PARAMS, recipient: recipient.address };
      await expect(
        callTransact(withdrawPublicAmount(amount), 0n, params, 1n)
      ).to.be.revertedWithCustomError(halias, "WithdrawCannotHaveValue");
    });
  });

  // ── InvalidTokenAddress ────────────────────────────────────────────────────

  describe("InvalidTokenAddress", function () {
    it("rejects deposit using an EOA address as token (no contract code)", async function () {
      const eoaAsToken = BigInt(user.address); // EOA has no code
      await expect(
        callTransact(ethers.parseUnits("1", 18), eoaAsToken, ZERO_PARAMS, 0n)
      ).to.be.revertedWithCustomError(halias, "InvalidTokenAddress");
    });
  });

  // ── rescueToken ────────────────────────────────────────────────────────────

  describe("rescueToken", function () {
    it("rescues tokens sent directly (not via transact)", async function () {
      const directAmount = ethers.parseUnits("50", 18);
      // Send tokens directly to Halias — bypasses transact(), so poolTokenBalance stays 0
      await mockToken.mint(owner.address, directAmount);
      await mockToken.connect(owner).transfer(haliasAddress, directAmount);

      const balBefore = await mockToken.balanceOf(recipient.address);
      await halias.rescueToken(await mockToken.getAddress(), recipient.address, directAmount);
      expect(await mockToken.balanceOf(recipient.address) - balBefore).to.equal(directAmount);
    });

    it("only rescues surplus above pool collateral", async function () {
      const poolAmount   = ethers.parseUnits("100", 18);
      const directAmount = ethers.parseUnits("30", 18);
      const tokenAddress = BigInt(await mockToken.getAddress());

      // Deposit via transact — this increments poolTokenBalance
      await mockToken.mint(user.address, poolAmount);
      await mockToken.connect(user).approve(haliasAddress, poolAmount);
      await callTransact(poolAmount, tokenAddress, ZERO_PARAMS, 0n);

      // Also send tokens directly — only this surplus should be rescuable
      await mockToken.mint(owner.address, directAmount);
      await mockToken.connect(owner).transfer(haliasAddress, directAmount);

      // Rescue only the direct amount
      const balBefore = await mockToken.balanceOf(recipient.address);
      await halias.rescueToken(await mockToken.getAddress(), recipient.address, directAmount);
      expect(await mockToken.balanceOf(recipient.address) - balBefore).to.equal(directAmount);
    });

    it("rejects rescue exceeding available surplus", async function () {
      const directAmount = ethers.parseUnits("10", 18);
      await mockToken.mint(owner.address, directAmount);
      await mockToken.connect(owner).transfer(haliasAddress, directAmount);

      await expect(
        halias.rescueToken(await mockToken.getAddress(), recipient.address, directAmount + 1n)
      ).to.be.revertedWithCustomError(halias, "RescueExceedsAvailable");
    });

    it("rejects rescue from non-admin", async function () {
      await expect(
        halias.connect(user).rescueToken(await mockToken.getAddress(), user.address, 1n)
      ).to.be.revertedWithCustomError(halias, "NotAdmin");
    });
  });
});
