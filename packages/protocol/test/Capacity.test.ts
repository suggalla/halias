import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { initPoseidon } from "./helpers/poseidon";
import { ensurePoseidon } from "../scripts/poseidon";
import { randField } from "./helpers/field";
import { ZERO_PROOF, NO_RELAYER, rand32 } from "./helpers/tx";

// What happens when the system runs out of room.
//
// Both structures have a hard ceiling and both refuse to cross it, and until now neither
// refusal was reachable from a test: the pool addresses 2^32 trees and the registry 2^32
// aliases, so hitting either honestly is not something a suite can do. Mocks move only the
// ceiling — depth, hashing, zeros and root derivation stay exactly as in production — which
// is the same arrangement MockSmallTreePool already uses for rollover.
//
// These are worth reaching because both failures are otherwise silent and permanent:
//
//   1. A note inserted past the circuit's 32-bit `treeNumber` bound sits on chain looking
//      exactly like a successful deposit, and is unprovable forever. Its owner finds out when
//      they try to spend.
//
//   2. The registry has no rollover. Depth IS its capacity, so filling it cannot be recovered
//      from — a new registry means a new pool, controller and verifier, taking every
//      registered alias with it.
//
// In both cases refusing the write is the whole mitigation, so "does it actually refuse" is
// the question, and an unreachable revert is an untested one.


describe("capacity limits", function () {
  this.timeout(180000);

  // Keys are Poseidon field elements. A raw keccak exceeds the BN254 prime about 19% of the
  // time, which _checkKeys rejects — so a test using one fails for the wrong reason,
  // intermittently.

  before(async function () { await initPoseidon(); });

  // ── the pool's last tree ────────────────────────────────────────────────────

  describe("pool", function () {
    let pool: any, registry: any;

    async function deployFullTreePool() {
      const [registrar] = await ethers.getSigners();
      const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
      const verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();
      const registry = await (await ethers.getContractFactory("HaliasRegistry", {
        libraries: { PoseidonT3: t3, PoseidonT4: t4 },
      })).deploy(registrar.address);
      // Four leaves per tree, and tree 1 is the last: eight leaves in total.
      const pool = await (await ethers.getContractFactory("MockFullTreePool", {
        libraries: { PoseidonT3: t3 },
      })).deploy(verifier, verifier, await registry.getAddress());
      return { registry, pool };
    }

    beforeEach(async function () {
      ({ registry, pool } = await loadFixture(deployFullTreePool));
    });

    async function insertPair() {
      const [root, tree] = await pool.currentAnchor();
      return pool.transact({
        poolRoot: [root, root, root, root], treeNumber: [Number(tree), Number(tree), Number(tree), Number(tree)],
        registryRoot: await registry.getRegistryRoot(),
        publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
        inputNullifiers: [rand32(), rand32(), rand32(), rand32()],
        outputCommitments: [rand32(), rand32()],
        recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER,
        externalData: ethers.ZeroHash, pendingLeaf: ethers.ZeroHash, outputsEmpty: false,
      }, "0x", "0x", ZERO_PROOF);
    }

    /// Fill until the pool refuses, returning how many pairs landed.
    ///
    /// Discovered rather than hardcoded, because the boundary is not where counting leaves
    /// suggests: `_insertPair` advances leafIndex and *then* rolls over, so the pair that
    /// exhausts the last tree is refused rather than being the last to succeed.
    async function fillToCapacity(): Promise<number> {
      let landed = 0;
      for (let i = 0; i < 16; i++) {
        try {
          await (await insertPair()).wait();
          landed++;
        } catch {
          return landed;
        }
      }
      throw new Error("the pool never refused — the ceiling is not being enforced");
    }

    it("accepts pairs until the last tree is full, then refuses", async function () {
      const landed = await fillToCapacity();
      // A bound that triggers immediately is as wrong as one that never triggers.
      expect(landed, "refused before filling anything").to.be.greaterThan(0);
      await expect(insertPair()).to.be.revertedWithCustomError(pool, "TreeSpaceExhausted");
    });

    it("reaches the last tree before refusing", async function () {
      await fillToCapacity();
      const [, tree] = await pool.currentAnchor();
      expect(tree, "refused before reaching the last tree").to.equal(1n);
    });

    it("leaves nothing behind when it refuses", async function () {
      // The point of reverting rather than wrapping: the pool stops accepting deposits
      // instead of accepting one it can never let anyone spend. So the refusal must move
      // nothing — a partial insert here is worse than the failure it was avoiding.
      await fillToCapacity();

      const [rootBefore, treeBefore] = await pool.currentAnchor();
      const posBefore = await pool.position();
      await expect(insertPair()).to.be.revertedWithCustomError(pool, "TreeSpaceExhausted");

      const [rootAfter, treeAfter] = await pool.currentAnchor();
      expect(rootAfter, "the root moved on a refused insert").to.equal(rootBefore);
      expect(treeAfter).to.equal(treeBefore);
      expect((await pool.position()).leaf).to.equal(posBefore.leaf);
    });

    it("keeps refusing, rather than failing once and then wrapping", async function () {
      await fillToCapacity();
      for (let i = 0; i < 3; i++) {
        await expect(insertPair(), `attempt ${i} slipped through`)
          .to.be.revertedWithCustomError(pool, "TreeSpaceExhausted");
      }
    });
  });

  // ── the registry's last slot ────────────────────────────────────────────────

  describe("registry", function () {
    let registry: any;

    async function deploySmallRegistry() {
      const [reg] = await ethers.getSigners();
      const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
      // Capacity four, real depth 32.
      const registry = await (await ethers.getContractFactory("MockSmallRegistry", {
        libraries: { PoseidonT3: t3, PoseidonT4: t4 },
      })).deploy(reg.address);
      return { registry, registrar: reg };
    }

    beforeEach(async function () {
      ({ registry } = await loadFixture(deploySmallRegistry));
    });

    const keys = () => [randField(), randField(), randField()] as const;

    it("fills every slot before refusing", async function () {
      for (let i = 0; i < 4; i++) {
        await expect(registry.register(randField(), ...keys()), `slot ${i} was refused`)
          .to.emit(registry, "AliasRegistered");
      }
      expect(await registry.nextAliasSlot()).to.equal(4n);
    });

    it("refuses the registration past the last slot", async function () {
      for (let i = 0; i < 4; i++) await (await registry.register(randField(), ...keys())).wait();
      await expect(registry.register(randField(), ...keys()))
        .to.be.revertedWithCustomError(registry, "RegistryFull");
    });

    it("leaves the tree untouched when it refuses", async function () {
      // A half-written registration would be worse than the refusal: the root would move for
      // an alias that has no slot, and every proof built against the previous root would
      // still verify while the registry disagreed about what it contains.
      for (let i = 0; i < 4; i++) await (await registry.register(randField(), ...keys())).wait();

      const rootBefore = await registry.getRegistryRoot();
      const slotBefore = await registry.nextAliasSlot();
      const rejected = randField();
      await expect(registry.register(rejected, ...keys()))
        .to.be.revertedWithCustomError(registry, "RegistryFull");

      expect(await registry.getRegistryRoot(), "the root moved").to.equal(rootBefore);
      expect(await registry.nextAliasSlot(), "a slot was consumed").to.equal(slotBefore);
      expect(await registry.isRegistered(rejected), "the alias was recorded anyway")
        .to.equal(false);
    });

    it("still serves the aliases it already holds", async function () {
      // Full is not broken. Everything registered before the ceiling must keep resolving, and
      // keep being updatable — otherwise hitting capacity would strand its own users rather
      // than merely refusing new ones.
      const held: string[] = [];
      for (let i = 0; i < 4; i++) {
        const h = randField();
        held.push(h);
        await (await registry.register(h, ...keys())).wait();
      }
      await expect(registry.register(randField(), ...keys()))
        .to.be.revertedWithCustomError(registry, "RegistryFull");

      for (const h of held) {
        expect(await registry.isRegistered(h), `${h} stopped resolving`).to.equal(true);
      }
      // And an in-place update still works, which is the operation that does not need a slot.
      await expect(registry.setDataHash(held[0], ethers.toBeHex(7n, 32)))
        .to.emit(registry, "AliasDataUpdated");
    });

    it("a reassignment needs no new slot, so it works at capacity", async function () {
      // Reassign writes in place. If it went through the slot allocator it would fail here,
      // which would mean a full registry could not hand over or rotate keys — locking every
      // holder out of the two operations they are most likely to need.
      const h = randField();
      await (await registry.register(h, ...keys())).wait();
      for (let i = 0; i < 3; i++) await (await registry.register(randField(), ...keys())).wait();
      await expect(registry.register(randField(), ...keys()))
        .to.be.revertedWithCustomError(registry, "RegistryFull");

      await expect(registry.reassign(h, ...keys())).to.emit(registry, "AliasReassigned");
      expect(await registry.nextAliasSlot(), "reassign consumed a slot").to.equal(4n);
    });
  });
});
