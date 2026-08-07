import { expect } from "chai";
import { ethers } from "hardhat";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Rejection paths that had no coverage.
//
// Every one of these is a guard against something that cannot be undone: funds burned
// with no rescue path, a name permanently blocked, a relayer paid more than the
// withdrawal it came from, a note spent twice. A guard nobody has watched fire is an
// assumption, not a protection — and today's tally was five real bugs, all in untested
// code, so the assumption is not one worth making.
describe("Guards", function () {
  this.timeout(180000);

  let halias: any;
  let haliasAddress: string;
  let deployer: any, other: any, relayer: any;
  let mockVerifier: string;
  let libs: { PoseidonT3: string; PoseidonT4: string };

  const rand32 = () => ethers.keccak256(ethers.randomBytes(32));
  const GOOD_PROOF = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);

  function packRelayerFee(addr: string, fee: bigint): string {
    return ethers.toBeHex((BigInt(addr) << 96n) | fee, 32);
  }

  async function baseParams(overrides: any = {}) {
    return {
      poolRoot: await halias.getLastRoot(),
      registryRoot: await halias.getRegistryRoot(),
      publicAmount: 0n,
      tokenAddress: 0n,
      inputNullifiers: [rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress,
      externalData: ethers.ZeroHash,
      ...overrides,
    };
  }

  beforeEach(async function () {
    [deployer, other, relayer] = await ethers.getSigners();
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    libs = { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() };
    mockVerifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();
    halias = await (await ethers.getContractFactory("Halias", { libraries: libs }))
      .deploy(mockVerifier, deployer.address);
    haliasAddress = await halias.getAddress();
  });

  // ── Construction ──────────────────────────────────────────────────

  it("rejects a zero verifier", async function () {
    const F = await ethers.getContractFactory("Halias", { libraries: libs });
    await expect(F.deploy(ethers.ZeroAddress, deployer.address))
      .to.be.revertedWithCustomError(F, "InvalidVerifier");
  });

  // ── Retaining ETH inside the pool ─────────────────────────────────

  it("refuses a plain transact() that withdraws to the pool itself", async function () {
    // This path leaves the ETH in the contract while spending the note. accumulatedFees
    // is untouched and there is no ETH rescue function, so the funds would be
    // unrecoverable. Only registerWithPoolNote may legitimately retain, because it books
    // what it keeps as revenue.
    await expect(halias.transact(
      await baseParams({ publicAmount: FIELD_PRIME - ethers.parseEther("1"), recipient: haliasAddress }),
      "0x", "0x", GOOD_PROOF,
    )).to.be.revertedWithCustomError(halias, "RetainRequiresRegistration");
  });

  it("still refuses it on a deposit, where retaining makes no sense either", async function () {
    await expect(halias.transact(
      await baseParams({ publicAmount: ethers.parseEther("1"), recipient: haliasAddress }),
      "0x", "0x", GOOD_PROOF, { value: ethers.parseEther("1") },
    )).to.be.revertedWithCustomError(halias, "RetainRequiresRegistration");
  });

  // ── Relayer fee bounds ────────────────────────────────────────────

  describe("relayer fee", function () {
    it("rejects a fee larger than the withdrawal it is paid from", async function () {
      // Without this bound, payout = absAmount - fee underflows. Solidity 0.8 would
      // revert on the subtraction, but late and without naming the cause; more
      // importantly the bound is what makes fee + payout == absAmount an invariant.
      const withdraw = ethers.parseEther("1");
      await expect(halias.transact(
        await baseParams({
          publicAmount: FIELD_PRIME - withdraw,
          recipient: other.address,
          externalData: packRelayerFee(relayer.address, withdraw + 1n),
        }), "0x", "0x", GOOD_PROOF,
      )).to.be.revertedWithCustomError(halias, "RelayerFeeExceedsWithdrawal");
    });

    it("allows a fee exactly equal to the withdrawal", async function () {
      // The claimer's securing transaction has this shape: the whole outflow pays the
      // relayer and the balance stays shielded in the change note.
      const deposit = ethers.parseEther("2");
      await (await halias.transact(await baseParams({ publicAmount: deposit }),
        "0x", "0x", GOOD_PROOF, { value: deposit })).wait();

      const withdraw = ethers.parseEther("1");
      const before = await ethers.provider.getBalance(relayer.address);
      await (await halias.transact(await baseParams({
        publicAmount: FIELD_PRIME - withdraw,
        recipient: other.address,
        externalData: packRelayerFee(relayer.address, withdraw),
      }), "0x", "0x", GOOD_PROOF)).wait();

      expect(await ethers.provider.getBalance(relayer.address) - before).to.equal(withdraw);
    });

    it("rejects a fee on a transfer, which has no outflow to pay from", async function () {
      await expect(halias.transact(
        await baseParams({ publicAmount: 0n, externalData: packRelayerFee(relayer.address, 1n) }),
        "0x", "0x", GOOD_PROOF,
      )).to.be.revertedWithCustomError(halias, "RelayerFeeOnNonWithdrawal");
    });

    it("rejects a fee on a deposit", async function () {
      const amount = ethers.parseEther("1");
      await expect(halias.transact(
        await baseParams({ publicAmount: amount, externalData: packRelayerFee(relayer.address, 1n) }),
        "0x", "0x", GOOD_PROOF, { value: amount },
      )).to.be.revertedWithCustomError(halias, "RelayerFeeOnNonWithdrawal");
    });

    it("rejects a fee on an ERC-20 withdrawal, since a relayer needs ETH", async function () {
      await expect(halias.transact(
        await baseParams({
          publicAmount: FIELD_PRIME - 1000n,
          tokenAddress: BigInt(haliasAddress), // any non-zero token
          recipient: other.address,
          externalData: packRelayerFee(relayer.address, 1n),
        }), "0x", "0x", GOOD_PROOF,
      )).to.be.revertedWithCustomError(halias, "RelayerFeeOnNonWithdrawal");
    });
  });

  // ── Double spend on the second input ──────────────────────────────

  it("rejects reuse of the SECOND input's nullifier", async function () {
    // Input0AlreadySpent is checked first, so reaching this branch needs a fresh
    // nullifier in slot 0 and a spent one in slot 1 — a genuinely separate code path
    // that the existing double-spend test never touches.
    const deposit = ethers.parseEther("1");
    const n0 = rand32(), n1 = rand32();
    await (await halias.transact(
      await baseParams({ publicAmount: deposit, inputNullifiers: [n0, n1] }),
      "0x", "0x", GOOD_PROOF, { value: deposit })).wait();

    await expect(halias.transact(
      await baseParams({ publicAmount: 0n, inputNullifiers: [rand32(), n1] }),
      "0x", "0x", GOOD_PROOF,
    )).to.be.revertedWithCustomError(halias, "Input1AlreadySpent");
  });

  // ── Registry slot collision ───────────────────────────────────────

  it("rejects a second alias landing on an occupied SMT slot", async function () {
    // The tree path uses the low REGISTRY_LEVELS bits of aliasHash % p, so two distinct
    // aliases can want the same slot. The contract refuses rather than overwriting,
    // which is what stops a collision from silently replacing someone's keys — and is
    // the guarantee the 64-level depth exists to make expensive to attack.
    const levels = BigInt(await halias.REGISTRY_LEVELS());
    const a = BigInt(rand32()) % (1n << 200n);       // comfortably < p
    const b = a + (1n << levels);                     // identical low `levels` bits
    expect(a & ((1n << levels) - 1n)).to.equal(b & ((1n << levels) - 1n));
    expect(a).to.not.equal(b);

    const fee = await halias.registrationFee();
    const pk = ethers.toBeHex(1n, 32), nk = ethers.toBeHex(2n, 32);
    await (await halias.register(ethers.toBeHex(a, 32), pk, nk, rand32(), { value: fee })).wait();

    await expect(halias.register(ethers.toBeHex(b, 32), pk, nk, rand32(), { value: fee }))
      .to.be.revertedWithCustomError(halias, "SMTCollision");
  });

  it("lets the same alias update in place without tripping the collision guard", async function () {
    // The guard keys on aliasHash, so re-registering the same alias via updateKeys must
    // still work — otherwise key rotation would break for everyone.
    const aliasHash = rand32();
    const fee = await halias.registrationFee();
    await (await halias.register(aliasHash, ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32),
      rand32(), { value: fee })).wait();
    await expect(halias.updateKeys(aliasHash, ethers.toBeHex(3n, 32), rand32())).to.not.be.reverted;
  });
});
