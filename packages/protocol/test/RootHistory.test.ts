import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

// Root acceptance rules. Pool roots and registry roots deliberately differ:
// a stale pool root is harmless because nullifiers stop double spends, but a stale
// registry root would let a sender pay keys the recipient has already rotated away from.
describe("Root history", function () {
  this.timeout(180000);

  let halias: any;
  let MAX_AGE: bigint;

  const randRoot = () => ethers.keccak256(ethers.randomBytes(32));

  async function registerSomething() {
    await halias.register(
      randRoot(), ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), randRoot(),
      { value: await halias.registrationFee() },
    );
  }

  beforeEach(async function () {
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const mv = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
    halias = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await mv.getAddress(), (await ethers.getSigners())[0].address);
    MAX_AGE = await halias.REGISTRY_ROOT_MAX_AGE();
  });

  describe("pool roots", function () {
    it("accepts the genesis root", async function () {
      expect(await halias.isKnownPoolRoot(await halias.getLastRoot())).to.equal(true);
    });

    it("rejects the zero root", async function () {
      expect(await halias.isKnownPoolRoot(ethers.ZeroHash)).to.equal(false);
    });

    it("rejects an unknown root", async function () {
      expect(await halias.isKnownPoolRoot(randRoot())).to.equal(false);
    });

    it("never expires a known root, however many blocks pass", async function () {
      const genesis = await halias.getLastRoot();
      await mine(Number(MAX_AGE) + 100);
      expect(await halias.isKnownPoolRoot(genesis)).to.equal(true);
    });

    it("keeps an old root valid after the tree advances", async function () {
      const before = await halias.getLastRoot();
      const amt = ethers.parseEther("1");
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);
      await halias.transact({
        poolRoot: before, registryRoot: await halias.getRegistryRoot(),
        publicAmount: amt, tokenAddress: 0n,
        inputNullifiers: [randRoot(), randRoot()],
        outputCommitments: [randRoot(), randRoot()],
        recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
      }, "0x", "0x", proof, { value: amt });

      const after = await halias.getLastRoot();
      expect(after).to.not.equal(before);
      expect(await halias.isKnownPoolRoot(before)).to.equal(true);
      expect(await halias.isKnownPoolRoot(after)).to.equal(true);
    });

    it("does not publish the intermediate root between the two inserts", async function () {
      // A transact inserts twice. Only the final root is committed — the root that
      // existed between the two inserts is never provable against.
      const amt = ethers.parseEther("1");
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);
      const c0 = randRoot(), c1 = randRoot();
      await halias.transact({
        poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
        publicAmount: amt, tokenAddress: 0n,
        inputNullifiers: [randRoot(), randRoot()],
        outputCommitments: [c0, c1],
        recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
      }, "0x", "0x", proof, { value: amt });

      expect(await halias.isKnownPoolRoot(await halias.getLastRoot())).to.equal(true);
      expect(await halias.nextIndex()).to.equal(2n);
    });
  });

  describe("registry roots", function () {
    it("accepts the current root indefinitely while the registry is idle", async function () {
      const root = await halias.getRegistryRoot();
      await mine(Number(MAX_AGE) + 100);
      // Unchanged is not the same as stale — nobody has rotated a key.
      expect(await halias.isKnownRegistryRoot(root)).to.equal(true);
    });

    it("accepts a superseded root inside the window", async function () {
      const old = await halias.getRegistryRoot();
      await registerSomething();
      expect(await halias.getRegistryRoot()).to.not.equal(old);
      expect(await halias.isKnownRegistryRoot(old)).to.equal(true);
    });

    it("rejects a superseded root once the window passes", async function () {
      const old = await halias.getRegistryRoot();
      await registerSomething();
      await mine(Number(MAX_AGE) + 1);
      expect(await halias.isKnownRegistryRoot(old)).to.equal(false);
      // …while the new current root stays valid.
      expect(await halias.isKnownRegistryRoot(await halias.getRegistryRoot())).to.equal(true);
    });

    it("accepts a superseded root at exactly the window boundary", async function () {
      const old = await halias.getRegistryRoot();
      const seen = await halias.registryRootBlock(old);
      await registerSomething();
      const now = BigInt(await ethers.provider.getBlockNumber());
      await mine(Number(seen + MAX_AGE - now));
      expect(BigInt(await ethers.provider.getBlockNumber()) - seen).to.equal(MAX_AGE);
      expect(await halias.isKnownRegistryRoot(old)).to.equal(true);
    });

    it("rejects the zero root and unknown roots", async function () {
      expect(await halias.isKnownRegistryRoot(ethers.ZeroHash)).to.equal(false);
      expect(await halias.isKnownRegistryRoot(randRoot())).to.equal(false);
    });

    it("does not refresh the window when a root reappears", async function () {
      // Registry state can return to an earlier root (rotate, then rotate back).
      // Re-stamping the block would silently extend that root's freshness window,
      // which is exactly the staleness the window exists to bound.
      const genesis = await halias.getRegistryRoot();
      const stamped = await halias.registryRootBlock(genesis);
      await registerSomething();
      await registerSomething();
      expect(await halias.registryRootBlock(genesis)).to.equal(stamped);
    });
  });
});
