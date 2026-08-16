import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon } from "./helpers/poseidon";

// ── ABI fragments ──────────────────────────────────────────────────────────────

const EXECUTE_ABI = [
  "function execute(address target, uint256 value, bytes calldata data)",
];
const TRANSACT_ABI = [
  "function transact((bytes32 poolRoot, bytes32 registryRoot, uint256 publicAmount, uint256 tokenAddress, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, address recipient, bytes32 externalData) p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof) external payable",
];
const REGISTER_ABI = [
  "function registerWithPoolNote((bytes32 poolRoot, bytes32 registryRoot, uint256 publicAmount, uint256 tokenAddress, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, address recipient, bytes32 externalData) p, bytes encryptedOutput0, bytes encryptedOutput1, bytes proof, bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey)",
];
function wrapExecute(target: string, innerCalldata: string): string {
  return new ethers.Interface(EXECUTE_ABI).encodeFunctionData("execute", [target, 0, innerCalldata]);
}

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function withdrawPublicAmount(absAmount: bigint): bigint {
  return FIELD_PRIME - absAmount;
}

// paymasterAndData layout (ERC-4337 v0.7):
//   [0:20]  paymaster address
//   [20:36] paymasterVerificationGasLimit (uint128, zero in tests)
//   [36:52] postOpGasLimit               (uint128, zero in tests)
//   [52]    path type (0x00 = ETH pool note | 0x01 = ERC-20 pool note)
function pmDataPoolNote(paymasterAddress: string): string {
  return paymasterAddress + "00".repeat(32) + "00"; // 53 bytes, path = 0x00
}

function pmDataERC20Note(paymasterAddress: string): string {
  return paymasterAddress + "00".repeat(32) + "01"; // 53 bytes, path = 0x01
}

function buildTransactCallData(haliasAddress: string, recipient: string, publicAmount: bigint, tokenAddress = 0n): string {
  const inner = new ethers.Interface(TRANSACT_ABI).encodeFunctionData("transact", [
    { poolRoot: ethers.ZeroHash, registryRoot: ethers.ZeroHash, publicAmount, tokenAddress, inputNullifiers: [ethers.ZeroHash, ethers.ZeroHash], outputCommitments: [ethers.ZeroHash, ethers.ZeroHash], recipient, externalData: ethers.ZeroHash },
    "0x", "0x", "0x",
  ]);
  return wrapExecute(haliasAddress, inner);
}

function buildRegisterCallData(haliasAddress: string, recipient: string, publicAmount: bigint): string {
  const inner = new ethers.Interface(REGISTER_ABI).encodeFunctionData("registerWithPoolNote", [
    { poolRoot: ethers.ZeroHash, registryRoot: ethers.ZeroHash, publicAmount, tokenAddress: 0n, inputNullifiers: [ethers.ZeroHash, ethers.ZeroHash], outputCommitments: [ethers.ZeroHash, ethers.ZeroHash], recipient, externalData: ethers.ZeroHash },
    "0x", "0x", "0x",
    ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash,
  ]);
  return wrapExecute(haliasAddress, inner);
}

function pmDataRegisterNote(paymasterAddress: string): string {
  return paymasterAddress + "00".repeat(32) + "02"; // path = 0x02
}

function buildUserOp(callData: string, paymasterAndData: string, sender = ethers.ZeroAddress): any {
  return {
    sender,
    nonce: 0n,
    initCode: "0x",
    callData,
    accountGasLimits: ethers.ZeroHash,
    preVerificationGas: 0n,
    gasFees: ethers.ZeroHash,
    paymasterAndData,
    signature: "0x",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("HaliasPaymaster", function () {
  this.timeout(30000);

  let entryPoint: any;
  let halias: any;
  let paymaster: any;
  let haliasAddress: string;
  let paymasterAddress: string;

  before(async function () {
    await initPoseidon();
  });

  beforeEach(async function () {
    const [owner] = await ethers.getSigners();

    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const mv = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
    entryPoint = await (await ethers.getContractFactory("MockEntryPoint")).deploy();

    halias = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await mv.getAddress(), await entryPoint.getAddress());
    haliasAddress = await halias.getAddress();

    paymaster = await (await ethers.getContractFactory("HaliasPaymaster")).deploy(
      await entryPoint.getAddress(),
      haliasAddress,
    );
    paymasterAddress = await paymaster.getAddress();

    await entryPoint.depositTo(paymasterAddress, { value: ethers.parseEther("1") });
  });

  // ── General guards ────────────────────────────────────────────────────────

  describe("validatePaymasterUserOp — general guards", function () {
    it("rejects calls not from EntryPoint", async function () {
      const [, attacker] = await ethers.getSigners();
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.01"))),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        paymaster.connect(attacker).validatePaymasterUserOp(userOp, ethers.ZeroHash, 0n)
      ).to.be.revertedWithCustomError(paymaster, "NotEntryPoint");
    });

    it("rejects paymasterAndData shorter than 53 bytes", async function () {
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.01"))),
        paymasterAddress, // only 20 bytes
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, 0n)
      ).to.be.revertedWithCustomError(paymaster, "PaymasterDataTooShort");
    });

    it("rejects unknown path type", async function () {
      // 53-byte paymasterAndData with path = 0xff
      const badPmData = paymasterAddress + "00".repeat(32) + "ff";
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.01"))),
        badPmData,
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, 0n)
      ).to.be.revertedWithCustomError(paymaster, "UnknownPathType");
    });
  });

  // ── PATH_POOL_NOTE ─────────────────────────────────────────────────────────

  describe("validatePaymasterUserOp — PATH_POOL_NOTE", function () {
    it("accepts valid pool-note withdraw, returns validationData = 0", async function () {
      const gasEstimate = ethers.parseEther("0.005");
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(gasEstimate)),
        pmDataPoolNote(paymasterAddress),
      );
      const [context, result] = await entryPoint.callValidatePaymaster.staticCall(
        paymasterAddress, userOp, ethers.ZeroHash, gasEstimate
      );
      expect(result).to.equal(0n); // no validUntil — pool notes don't expire
      expect(context).to.not.equal("0x");
    });

    it("rejects callData shorter than 456 bytes", async function () {
      const userOp = buildUserOp("0x" + "00".repeat(100), pmDataPoolNote(paymasterAddress));
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, 0n)
      ).to.be.revertedWithCustomError(paymaster, "CalldataTooShort");
    });

    it("rejects when execute() targets a non-halias address", async function () {
      const attacker = ethers.Wallet.createRandom().address;
      const userOp = buildUserOp(
        buildTransactCallData(attacker, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.01"))),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, ethers.parseEther("0.001"))
      ).to.be.revertedWithCustomError(paymaster, "InvalidExecuteTarget");
    });

    it("rejects a mismatched inner selector (register-shaped call on pool-note path)", async function () {
      // Inner call is registerWithPoolNote(...) but routed through PATH_POOL_NOTE (0x00).
      // Params decode to a passing withdrawal-to-paymaster, so only the inner-selector
      // check stands between this and postOp depositing unbacked ETH.
      const userOp = buildUserOp(
        buildRegisterCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.01"))),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, ethers.parseEther("0.001"))
      ).to.be.revertedWithCustomError(paymaster, "InvalidInnerSelector");
    });

    it("rejects when recipient is not paymaster", async function () {
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, ethers.Wallet.createRandom().address, withdrawPublicAmount(ethers.parseEther("0.01"))),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, ethers.parseEther("0.001"))
      ).to.be.revertedWithCustomError(paymaster, "GasTransactRecipientNotPaymaster");
    });

    it("rejects ERC-20 tokenAddress (non-zero)", async function () {
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.01")), 1n),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, ethers.parseEther("0.001"))
      ).to.be.revertedWithCustomError(paymaster, "ERC20CannotPayGas");
    });

    it("rejects deposit (non-withdraw publicAmount)", async function () {
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, ethers.parseEther("1")),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, ethers.parseEther("0.001"))
      ).to.be.revertedWithCustomError(paymaster, "MustWithdrawToPayGas");
    });

    it("rejects when absAmount < maxCost", async function () {
      const userOp = buildUserOp(
        buildTransactCallData(haliasAddress, paymasterAddress, withdrawPublicAmount(ethers.parseEther("0.001"))),
        pmDataPoolNote(paymasterAddress),
      );
      await expect(
        entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, ethers.parseEther("0.01"))
      ).to.be.revertedWithCustomError(paymaster, "GasBudgetTooSmall");
    });
  });

  // ── postOp ────────────────────────────────────────────────────────────────

  describe("postOp — PATH_POOL_NOTE", function () {
    function poolNoteContext(absAmount: bigint): string {
      return ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes32"], [0, ethers.toBeHex(absAmount, 32)]);
    }

    it("opSucceeded: deposits absAmount to EntryPoint (builds revolving reserve)", async function () {
      const absAmount = ethers.parseEther("0.01");
      await (await ethers.getSigners())[0].sendTransaction({ to: paymasterAddress, value: absAmount });

      const balBefore = await entryPoint.balanceOf(paymasterAddress);
      await entryPoint.callPostOp(paymasterAddress, 0, poolNoteContext(absAmount), ethers.parseEther("0.005"));
      expect(await entryPoint.balanceOf(paymasterAddress) - balBefore).to.equal(absAmount);
    });

    it("opReverted: does NOT deposit (pool note not spent — pool collateral preserved)", async function () {
      const balBefore = await entryPoint.balanceOf(paymasterAddress);
      await entryPoint.callPostOp(paymasterAddress, 1, poolNoteContext(ethers.parseEther("0.01")), ethers.parseEther("0.005"));
      expect(await entryPoint.balanceOf(paymasterAddress)).to.equal(balBefore);
    });

    it("opSucceeded with absAmount=0: no deposit attempted", async function () {
      const balBefore = await entryPoint.balanceOf(paymasterAddress);
      await entryPoint.callPostOp(paymasterAddress, 0, poolNoteContext(0n), 0n);
      expect(await entryPoint.balanceOf(paymasterAddress)).to.equal(balBefore);
    });
  });

  describe("postOp — access control", function () {
    it("rejects postOp from non-EntryPoint", async function () {
      const [, attacker] = await ethers.getSigners();
      const context = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes32"], [1, ethers.ZeroHash]);
      await expect(
        paymaster.connect(attacker).postOp(0, context, 0n, 0n)
      ).to.be.revertedWithCustomError(paymaster, "NotEntryPoint");
    });
  });

  // ── Admin ──────────────────────────────────────────────────────────────────

  describe("Admin", function () {
    it("owner can withdraw EP deposit", async function () {
      const [owner] = await ethers.getSigners();
      const amount = ethers.parseEther("0.1");
      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await paymaster.withdrawEntryPointDeposit(owner.address, amount);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed * receipt.gasPrice;
      expect(await ethers.provider.getBalance(owner.address) - balBefore + gas).to.equal(amount);
    });

    it("rejects setHalias with zero address", async function () {
      await expect(paymaster.setHalias(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(paymaster, "ZeroAddress");
    });

    it("owner can update halias address", async function () {
      const newAddr = ethers.Wallet.createRandom().address;
      await paymaster.setHalias(newAddr);
      expect(await paymaster.halias()).to.equal(newAddr);
    });

    it("non-owner cannot update halias", async function () {
      const [, attacker] = await ethers.getSigners();
      await expect(
        paymaster.connect(attacker).setHalias(ethers.Wallet.createRandom().address)
      ).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });

    it("owner can withdraw contract ETH balance", async function () {
      const [owner, recipient] = await ethers.getSigners();
      const amount = ethers.parseEther("0.5");
      await owner.sendTransaction({ to: paymasterAddress, value: amount });

      const balBefore = await ethers.provider.getBalance(recipient.address);
      await paymaster.withdrawBalance(recipient.address);
      expect(await ethers.provider.getBalance(recipient.address) - balBefore).to.equal(amount);
      expect(await ethers.provider.getBalance(paymasterAddress)).to.equal(0n);
    });

    it("non-owner cannot withdraw balance", async function () {
      const [, attacker] = await ethers.getSigners();
      await expect(
        paymaster.connect(attacker).withdrawBalance(attacker.address)
      ).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });
  });

  // ── PATH_REGISTER ─────────────────────────────────────────────────────────

  describe("validatePaymasterUserOp — PATH_REGISTER", function () {
    const MAX_COST = ethers.parseEther("0.001");
    let REGISTRATION_FEE: bigint;

    beforeEach(async function () {
      REGISTRATION_FEE = await halias.registrationFee();
    });

    const cases = [
      {
        name:      "accepts valid register note covering fee + gas",
        recipient: (h: string) => h,
        amount:    (fee: bigint) => fee + MAX_COST,
        error:     null,
      },
      {
        name:      "rejects when recipient is not halias",
        recipient: (_h: string) => ethers.Wallet.createRandom().address,
        amount:    (fee: bigint) => fee + MAX_COST,
        error:     "RegisterRecipientNotHalias",
      },
      {
        name:      "rejects deposit (non-withdrawal publicAmount)",
        recipient: (h: string) => h,
        amount:    (_fee: bigint) => -1n, // signals deposit
        error:     "MustWithdrawToPayGas",
      },
      {
        name:      "rejects when absAmount < fee + maxCost",
        recipient: (h: string) => h,
        amount:    (fee: bigint) => fee + MAX_COST - 1n,
        error:     "RegisterNoteTooSmall",
      },
    ];

    for (const c of cases) {
      it(c.name, async function () {
        const recipient   = c.recipient(haliasAddress);
        const absAmount   = c.amount(REGISTRATION_FEE);
        const publicAmount = absAmount < 0n ? 100n : withdrawPublicAmount(absAmount);
        const userOp = buildUserOp(
          buildRegisterCallData(haliasAddress, recipient, publicAmount),
          pmDataRegisterNote(paymasterAddress),
        );
        if (c.error) {
          await expect(
            entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, MAX_COST),
          ).to.be.revertedWithCustomError(paymaster, c.error);
        } else {
          const [, result] = await entryPoint.callValidatePaymaster.staticCall(
            paymasterAddress, userOp, ethers.ZeroHash, MAX_COST,
          );
          expect(result).to.equal(0n);
        }
      });
    }

    it("postOp PATH_REGISTER does nothing (Halias handles accounting)", async function () {
      const balBefore = await entryPoint.balanceOf(paymasterAddress);
      const context   = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes32"], [2, ethers.ZeroHash]);
      await entryPoint.callPostOp(paymasterAddress, 0, context, 0n);
      expect(await entryPoint.balanceOf(paymasterAddress)).to.equal(balBefore);
    });
  });

  // ── PATH_ERC20_NOTE ───────────────────────────────────────────────────────

  describe("validatePaymasterUserOp — PATH_ERC20_NOTE", function () {
    let token: any;
    let tokenAddress: string;
    let unknownToken: string;

    const RATE = 3000n * 10n ** 6n;          // 3000 USDC (6 dec) per ETH
    const RATE_PADDING_BPS = 2000n;           // must match contract constant
    const MAX_COST = ethers.parseEther("0.005");

    function requiredTokens(maxCost: bigint): bigint {
      return maxCost * RATE * (10000n + RATE_PADDING_BPS) / (10n ** 18n * 10000n) + 1n;
    }

    beforeEach(async function () {
      token        = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
      tokenAddress = await token.getAddress();
      unknownToken = ethers.Wallet.createRandom().address;
      await paymaster.setTokenRate(tokenAddress, RATE);
    });

    // ── Validation table ──────────────────────────────────────────────────

    const validationCases = [
      {
        name:      "accepts valid ERC-20 pool note, returns validationData = 0",
        recipient: () => paymasterAddress,
        token:     () => tokenAddress,
        amount:    () => requiredTokens(MAX_COST),
        error:     null,
      },
      {
        name:      "rejects when token rate not set",
        recipient: () => paymasterAddress,
        token:     () => unknownToken,
        amount:    () => requiredTokens(MAX_COST),
        error:     "TokenRateNotSet",
      },
      {
        name:      "rejects when token amount below padded requirement",
        recipient: () => paymasterAddress,
        token:     () => tokenAddress,
        amount:    () => requiredTokens(MAX_COST) - 2n,
        error:     "TokenGasBudgetTooSmall",
      },
      {
        name:      "rejects non-withdrawal publicAmount",
        recipient: () => paymasterAddress,
        token:     () => tokenAddress,
        amount:    null, // triggers deposit publicAmount
        error:     "MustWithdrawToPayGas",
      },
      {
        name:      "rejects when recipient is not paymaster",
        recipient: () => ethers.Wallet.createRandom().address,
        token:     () => tokenAddress,
        amount:    () => requiredTokens(MAX_COST),
        error:     "GasTransactRecipientNotPaymaster",
      },
    ];

    for (const c of validationCases) {
      it(c.name, async function () {
        const recipient  = c.recipient();
        const tok        = c.token();
        const pubAmount  = c.amount ? withdrawPublicAmount(c.amount()) : 100n;
        const userOp = buildUserOp(
          buildTransactCallData(haliasAddress, recipient, pubAmount, BigInt(tok)),
          pmDataERC20Note(paymasterAddress),
        );
        if (c.error) {
          await expect(
            entryPoint.callValidatePaymaster(paymasterAddress, userOp, ethers.ZeroHash, MAX_COST),
          ).to.be.revertedWithCustomError(paymaster, c.error);
        } else {
          const [, result] = await entryPoint.callValidatePaymaster.staticCall(
            paymasterAddress, userOp, ethers.ZeroHash, MAX_COST,
          );
          expect(result).to.equal(0n);
        }
      });
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    it("emits TokenRateSet on setTokenRate", async function () {
      await expect(paymaster.setTokenRate(tokenAddress, RATE))
        .to.emit(paymaster, "TokenRateSet").withArgs(tokenAddress, RATE);
    });

    it("rate = 0 disables token", async function () {
      await paymaster.setTokenRate(tokenAddress, 0n);
      expect(await paymaster.tokenRate(tokenAddress)).to.equal(0n);
    });

    it("non-owner cannot set token rate", async function () {
      const [, attacker] = await ethers.getSigners();
      await expect(
        paymaster.connect(attacker).setTokenRate(tokenAddress, RATE),
      ).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });

    it("owner can sweep accumulated tokens", async function () {
      const [owner] = await ethers.getSigners();
      const amount = 1000n * 10n ** 6n;
      await token.mint(paymasterAddress, amount);
      const balBefore = await token.balanceOf(owner.address);
      await paymaster.sweepToken(tokenAddress, owner.address);
      expect(await token.balanceOf(owner.address) - balBefore).to.equal(amount);
      expect(await token.balanceOf(paymasterAddress)).to.equal(0n);
    });

    it("postOp ERC-20 path does nothing regardless of mode", async function () {
      const balBefore = await entryPoint.balanceOf(paymasterAddress);
      const context   = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes32"], [1, ethers.ZeroHash]);
      await entryPoint.callPostOp(paymasterAddress, 0, context, 0n);
      await entryPoint.callPostOp(paymasterAddress, 1, context, 0n);
      expect(await entryPoint.balanceOf(paymasterAddress)).to.equal(balBefore);
    });
  });
});
