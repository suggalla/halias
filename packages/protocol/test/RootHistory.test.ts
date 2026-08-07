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
      randRoot(), ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), randRoot(), "",
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

// Pairwise insertion must produce a byte-identical tree to inserting the two leaves one
// at a time — that equivalence is the entire licence for halving the hash count, and it
// is the difference between an optimisation and a silent consensus change. Compared here
// against a preserved copy of the original implementation rather than argued in a comment.
describe("Pairwise insertion equivalence", function () {
  this.timeout(300000);

  let halias: any, seq: any;

  const rand = () => ethers.keccak256(ethers.randomBytes(32));
  const proof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"], [[0, 0], [[0, 0], [0, 0]], [0, 0]]);

  beforeEach(async function () {
    const [deployer] = await ethers.getSigners();
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const mv = await (await ethers.getContractFactory("MockTransactVerifier")).deploy();
    halias = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await mv.getAddress(), deployer.address);
    seq = await (await ethers.getContractFactory("MockTreeSequential", {
      libraries: { PoseidonT3: await t3.getAddress() },
    })).deploy();
  });

  async function transactWith(c0: string, c1: string) {
    const amt = ethers.parseEther("0.01");
    await (await halias.transact({
      poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
      publicAmount: amt, tokenAddress: 0n,
      inputNullifiers: [rand(), rand()], outputCommitments: [c0, c1],
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
    }, "0x", "0x", proof, { value: amt })).wait();
  }

  it("starts from the same empty root", async function () {
    expect(await halias.getLastRoot()).to.equal(await seq.lastRoot());
  });

  it("matches after one pair", async function () {
    const c0 = rand(), c1 = rand();
    await transactWith(c0, c1);
    await (await seq.insertPairSequentially(c0, c1)).wait();
    expect(await halias.getLastRoot()).to.equal(await seq.lastRoot());
    expect(await halias.nextIndex()).to.equal(await seq.nextIndex());
  });

  it("matches across many pairs, exercising both parity branches at levels 1-5", async function () {
    // A pair's parent sits at level-1 index nextIndex/2, so N pairs exercise the even/odd
    // branch up to level log2(N). Thirty-two pairs reaches level 5; beyond that the loop
    // body is identical for every i, differing only in which filledSubtrees/poolZeros
    // slot it touches, so the remaining levels are covered by construction.
    // The invariant that makes the whole optimisation valid is also checked each round:
    // nextIndex must stay even, or nextIndex >> 1 would collide two pairs onto one slot.
    for (let i = 0; i < 32; i++) {
      const c0 = rand(), c1 = rand();
      await transactWith(c0, c1);
      await (await seq.insertPairSequentially(c0, c1)).wait();
      expect(await halias.getLastRoot(), `divergence after pair ${i + 1}`)
        .to.equal(await seq.lastRoot());
      expect((await halias.nextIndex()) % 2n, `nextIndex went odd at pair ${i + 1}`).to.equal(0n);
    }
    expect(await halias.nextIndex()).to.equal(64n);
  });

  it("advances nextIndex only in steps of two", async function () {
    // Pins the invariant on its own, so a future version that reintroduces single-leaf
    // insertion fails here rather than corrupting the tree in a way only a diverging
    // root would reveal. The deployed contract is immutable, so this guards the next
    // version, not this one.
    let prev = await halias.nextIndex();
    expect(prev).to.equal(0n);
    for (let i = 0; i < 3; i++) {
      await transactWith(rand(), rand());
      const now = await halias.nextIndex();
      expect(now - prev).to.equal(2n);
      prev = now;
    }
  });

  it("assigns the same leaf indices the sequential version would", async function () {
    const c0 = rand(), c1 = rand();
    const amt = ethers.parseEther("0.01");
    const receipt = await (await halias.transact({
      poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
      publicAmount: amt, tokenAddress: 0n,
      inputNullifiers: [rand(), rand()], outputCommitments: [c0, c1],
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
    }, "0x", "0x", proof, { value: amt })).wait();

    // Indices feed the nullifier, so shifting them would invalidate every proof.
    const ev = receipt!.logs
      .map((l: any) => { try { return halias.interface.parseLog(l); } catch { return null; } })
      .find((p: any) => p?.name === "Transact");
    expect(ev!.args.outputLeafIndex0).to.equal(0n);
    expect(ev!.args.outputLeafIndex1).to.equal(1n);
  });

  it("still rejects a zero commitment in either slot", async function () {
    const amt = ethers.parseEther("0.01");
    const base = async (c0: string, c1: string) => ({
      poolRoot: await halias.getLastRoot(), registryRoot: await halias.getRegistryRoot(),
      publicAmount: amt, tokenAddress: 0n,
      inputNullifiers: [rand(), rand()], outputCommitments: [c0, c1],
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
    });
    await expect(halias.transact(await base(ethers.ZeroHash, rand()), "0x", "0x", proof, { value: amt }))
      .to.be.revertedWithCustomError(halias, "ZeroCommitment");
    await expect(halias.transact(await base(rand(), ethers.ZeroHash), "0x", "0x", proof, { value: amt }))
      .to.be.revertedWithCustomError(halias, "ZeroCommitment");
  });
});
