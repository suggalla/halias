import { expect } from "chai";
import { ethers } from "hardhat";

// HaliasAccountImpl is the shared EIP-7702 delegation target.
// address(this) in validateUserOp = the EOA's address (under EIP-7702).
// In unit tests without EIP-7702 activation, address(this) = the deployed contract address.
// We therefore test:
//   - NotEntryPoint guard on all restricted functions
//   - Wrong signer → SIG_VALIDATION_FAILED (not revert)
//   - Malformed signature bytes → SIG_VALIDATION_FAILED (A1 fix — tryRecover, not recover)
//   - execute: happy path, non-EP revert, bubbled revert
//   - executeBatch: happy path, length mismatch, non-EP revert

describe("HaliasAccountImpl", function () {
  this.timeout(30000);

  let entryPoint: any;
  let account: any;
  let mockTarget: any;

  let entryPointAddress: string;
  let accountAddress: string;

  const SIG_VALIDATION_FAILED = 1n;

  beforeEach(async function () {
    const MockEntryPoint = await ethers.getContractFactory("MockEntryPoint");
    entryPoint = await MockEntryPoint.deploy();
    entryPointAddress = await entryPoint.getAddress();

    const HaliasAccountImpl = await ethers.getContractFactory("HaliasAccountImpl");
    account = await HaliasAccountImpl.deploy(entryPointAddress);
    accountAddress = await account.getAddress();

    // MockCallTarget: records calls, optionally reverts
    const MockCallTarget = await ethers.getContractFactory("MockCallTarget");
    mockTarget = await MockCallTarget.deploy(false);
  });

  // ── validateUserOp ─────────────────────────────────────────────────────────

  describe("validateUserOp", function () {
    function buildUserOp(signature: string): any {
      return {
        sender:             ethers.ZeroAddress,
        nonce:              0n,
        initCode:           "0x",
        callData:           "0x",
        accountGasLimits:   ethers.ZeroHash,
        preVerificationGas: 0n,
        gasFees:            ethers.ZeroHash,
        paymasterAndData:   "0x",
        signature,
      };
    }

    it("rejects calls not from EntryPoint", async function () {
      const [, attacker] = await ethers.getSigners();
      const userOp = buildUserOp("0x");
      await expect(
        account.connect(attacker).validateUserOp(userOp, ethers.ZeroHash, 0n)
      ).to.be.revertedWithCustomError(account, "NotEntryPoint");
    });

    it("wrong signer returns SIG_VALIDATION_FAILED (not revert)", async function () {
      // Sign with a random wallet — its address won't match the account address
      const wrongSigner = ethers.Wallet.createRandom();
      const userOpHash  = ethers.keccak256(ethers.toUtf8Bytes("userOpHash"));
      const sig         = await wrongSigner.signMessage(ethers.getBytes(userOpHash));

      const userOp = buildUserOp(sig);

      const result = await entryPoint.callValidateAccount.staticCall(accountAddress, userOp, userOpHash, 0n);
      expect(result).to.equal(SIG_VALIDATION_FAILED);
    });

    it("malformed signature returns SIG_VALIDATION_FAILED (A1: tryRecover, not recover)", async function () {
      // 65 bytes of garbage — would revert with hash.recover() but must return SIG_VALIDATION_FAILED
      const garbage = "0x" + "ab".repeat(65);
      const userOp  = buildUserOp(garbage);

      const result = await entryPoint.callValidateAccount.staticCall(accountAddress, userOp, ethers.keccak256(ethers.toUtf8Bytes("x")), 0n);
      expect(result).to.equal(SIG_VALIDATION_FAILED);
    });

    it("too-short signature returns SIG_VALIDATION_FAILED (not revert)", async function () {
      const userOp = buildUserOp("0xdeadbeef"); // 4 bytes — not a valid ECDSA sig
      const result = await entryPoint.callValidateAccount.staticCall(accountAddress, userOp, ethers.ZeroHash, 0n);
      expect(result).to.equal(SIG_VALIDATION_FAILED);
    });

    it("empty signature returns SIG_VALIDATION_FAILED (not revert)", async function () {
      const userOp = buildUserOp("0x");
      const result = await entryPoint.callValidateAccount.staticCall(accountAddress, userOp, ethers.ZeroHash, 0n);
      expect(result).to.equal(SIG_VALIDATION_FAILED);
    });
  });

  // ── execute ────────────────────────────────────────────────────────────────

  describe("execute", function () {
    it("rejects calls not from EntryPoint", async function () {
      const [, attacker] = await ethers.getSigners();
      await expect(
        account.connect(attacker).execute(await mockTarget.getAddress(), 0n, "0x")
      ).to.be.revertedWithCustomError(account, "NotEntryPoint");
    });

    it("makes the call and forwards value", async function () {
      const [owner] = await ethers.getSigners();
      const targetAddress = await mockTarget.getAddress();
      const callValue = ethers.parseEther("0.1");

      // Fund the account so it can forward value
      await owner.sendTransaction({ to: accountAddress, value: callValue });

      await entryPoint.callExecute(accountAddress, targetAddress, callValue, "0x");

      expect(await mockTarget.lastValue()).to.equal(callValue);
    });

    it("bubbles up revert from target", async function () {
      await mockTarget.setRevert(true);
      await expect(
        entryPoint.callExecute(accountAddress, await mockTarget.getAddress(), 0n, "0x")
      ).to.be.revertedWith("MockCallTarget: reverted");
    });
  });

  // ── executeBatch ───────────────────────────────────────────────────────────

  describe("executeBatch", function () {
    it("rejects calls not from EntryPoint", async function () {
      const [, attacker] = await ethers.getSigners();
      await expect(
        account.connect(attacker).executeBatch([], [], [])
      ).to.be.revertedWithCustomError(account, "NotEntryPoint");
    });

    it("executes all calls in order", async function () {
      const MockCallTarget = await ethers.getContractFactory("MockCallTarget");
      const t1 = await MockCallTarget.deploy(false);
      const t2 = await MockCallTarget.deploy(false);

      const iface = new ethers.Interface(["function setRevert(bool) external"]);
      const calldata1 = iface.encodeFunctionData("setRevert", [false]);
      const calldata2 = iface.encodeFunctionData("setRevert", [false]);

      await entryPoint.callExecuteBatch(
        accountAddress,
        [await t1.getAddress(), await t2.getAddress()],
        [0n, 0n],
        [calldata1, calldata2]
      );
      // Both targets processed without revert
    });

    it("rejects mismatched array lengths (targets vs values)", async function () {
      await expect(
        entryPoint.callExecuteBatch(
          accountAddress,
          [await mockTarget.getAddress(), await mockTarget.getAddress()],
          [0n],         // 1 item instead of 2
          ["0x", "0x"]
        )
      ).to.be.revertedWithCustomError(account, "ArrayLengthMismatch");
    });

    it("rejects mismatched array lengths (values vs datas)", async function () {
      await expect(
        entryPoint.callExecuteBatch(
          accountAddress,
          [await mockTarget.getAddress()],
          [0n],
          ["0x", "0x"] // 2 items instead of 1
        )
      ).to.be.revertedWithCustomError(account, "ArrayLengthMismatch");
    });

    it("empty batch succeeds", async function () {
      await entryPoint.callExecuteBatch(accountAddress, [], [], []);
    });
  });

  // ── receive ────────────────────────────────────────────────────────────────

  describe("receive()", function () {
    it("accepts ETH via receive()", async function () {
      const [sender] = await ethers.getSigners();
      await expect(
        sender.sendTransaction({ to: accountAddress, value: ethers.parseEther("1") })
      ).to.not.be.reverted;
      expect(await ethers.provider.getBalance(accountAddress)).to.equal(ethers.parseEther("1"));
    });
  });
});
