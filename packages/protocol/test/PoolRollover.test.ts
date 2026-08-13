import { expect } from "chai";
import { ethers } from "hardhat";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ensurePoseidon } from "../scripts/poseidon";

// Tree rollover, and the two bugs it creates.
//
// The pool is a sequence of 16-level trees; a real one rolls over after 32,768 transactions,
// which is why none of this is reachable from the other suites. MockSmallTreePool moves only
// the boundary — four leaves instead of 65,536 — so depth, hashing, root derivation and the
// root/tree bookkeeping are all the production code.
//
// Two failures live here and nowhere else, and both are silent:
//
//   1. The nullifier keys on the note's GLOBAL position. Key on the leaf alone and leaf 1 of
//      tree 0 collides with leaf 1 of tree 1, so whichever note is spent second reads as
//      already spent and is permanently unspendable.
//
//   2. `treeNumber` is a public signal and must match the tree its root belongs to. Leave it
//      unbound and a holder re-spends one note under a different tree number, minting a fresh
//      nullifier every time — unlimited theft rather than a stuck note.
//
// A third property is structural: `filledSubtrees` is shared across trees and never reset, so
// a new tree must overwrite the previous one's values before reading them.

const ZERO_PROOF  = "0x" + "00".repeat(256);
const NO_RELAYER  = { relayer: ethers.ZeroAddress, amount: 0n };
const CAPACITY    = 4;   // MockSmallTreePool._treeCapacity()

describe("pool tree rollover", function () {
  this.timeout(180000);

  let pool: any, registry: any;

  const rand32 = () => ethers.keccak256(ethers.randomBytes(32));

  async function params(over: any = {}) {
    // currentAnchor, not getLastRoot + treeNumber: after a rollover those two disagree.
    const [root, tree] = await pool.currentAnchor();
    return {
      poolRoot: [root, root], treeNumber: [Number(tree), Number(tree)],
      registryRoot: await registry.getRegistryRoot(),
      publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
      inputNullifiers: [rand32(), rand32()],
      outputCommitments: [rand32(), rand32()],
      recipient: ethers.ZeroAddress, relayerFee: NO_RELAYER,
      externalData: ethers.ZeroHash, pendingLeaf: ethers.ZeroHash, outputsEmpty: false,
      ...over,
    };
  }

  /// One transact, returning where its outputs landed.
  async function insertPair(over: any = {}) {
    const p = await params(over);
    const rc = await (await pool.transact(p, "0x", "0x", ZERO_PROOF)).wait();
    const ev = rc!.logs
      .map((l: any) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "Transact");
    return {
      tree: Number(ev.args.outputTreeNumber),
      idx0: Number(ev.args.outputLeafIndex0),
      idx1: Number(ev.args.outputLeafIndex1),
      commitments: [p.outputCommitments[0], p.outputCommitments[1]],
      root: (await pool.currentAnchor())[0],
    };
  }

  before(async function () { await initPoseidon(); });

  async function deploySmallTreePool() {
    const [registrar] = await ethers.getSigners();
    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    const verifier = await (await (await ethers.getContractFactory("MockTransactVerifier")).deploy()).getAddress();
    const registry = await (await ethers.getContractFactory("HaliasRegistry", {
      libraries: { PoseidonT3: t3, PoseidonT4: t4 },
    })).deploy(registrar.address);
    const pool = await (await ethers.getContractFactory("MockSmallTreePool", {
      libraries: { PoseidonT3: t3 },
    })).deploy(verifier, await registry.getAddress());
    return { registry, pool };
  }

  beforeEach(async function () {
    ({ registry, pool } = await loadFixture(deploySmallTreePool));
  });

  // ── Mechanics ───────────────────────────────────────────────────────────────

  it("rolls over once a tree is full and restarts the leaf index", async function () {
    const a = await insertPair();
    expect([a.tree, a.idx0, a.idx1]).to.deep.equal([0, 0, 1]);

    const b = await insertPair();
    expect([b.tree, b.idx0, b.idx1]).to.deep.equal([0, 2, 3]);
    // Filling the tree exactly is what makes a pair unable to straddle a boundary.
    expect((await pool.position()).tree).to.equal(1n);
    expect((await pool.position()).leaf).to.equal(0n);

    const c = await insertPair();
    expect([c.tree, c.idx0, c.idx1]).to.deep.equal([1, 0, 1]);
  });

  it("a pair never straddles a boundary", async function () {
    // leafIndex is always even and capacity is even, so every pair lands wholly inside one
    // tree. If it could split, one output would be unaddressable by any single proof.
    for (let i = 0; i < 6; i++) {
      const r = await insertPair();
      expect(r.idx0 + 1, "outputs are not adjacent").to.equal(r.idx1);
      expect(Math.floor(r.idx0 / CAPACITY), "pair split across trees").to.equal(Math.floor(r.idx1 / CAPACITY));
    }
  });

  it("starts a new tree from empty rather than inheriting the previous one", async function () {
    // filledSubtrees is shared across trees and never reset. It is safe only because a tree
    // filling from zero writes at every level before reading — so the first tree's root and
    // the second's must match when they hold the same leaves. If stale values leaked in, the
    // second root would differ and no client could prove against it.
    const c0 = rand32(), c1 = rand32();
    const first = await insertPair({ outputCommitments: [c0, c1] });
    await insertPair();                                     // fills tree 0, rolls over
    expect((await pool.position()).tree).to.equal(1n);
    const second = await insertPair({ outputCommitments: [c0, c1] });

    expect(second.tree).to.equal(1);
    expect(second.root, "a fresh tree did not start empty").to.equal(first.root);
  });

  // ── The root/tree binding ───────────────────────────────────────────────────

  it("records which tree each root belongs to", async function () {
    const a = await insertPair();
    expect(await pool.poolRootTree(a.root)).to.deep.equal([true, BigInt(a.tree)]);
    await insertPair();
    const c = await insertPair();
    expect(c.tree).to.equal(1);
    expect(await pool.poolRootTree(c.root)).to.deep.equal([true, 1n]);
  });

  it("refuses a root paired with the wrong tree number", async function () {
    // The double spend this prevents. Roots never expire, so without the pairing a holder
    // could keep re-proving one note against its real root while claiming a different tree,
    // producing an unspent nullifier every time.
    const a = await insertPair();
    await expect(pool.transact(
      await params({ poolRoot: [a.root, a.root], treeNumber: [a.tree + 1, a.tree + 1] }),
      "0x", "0x", ZERO_PROOF,
    )).to.be.revertedWithCustomError(pool, "PoolRootWrongTree");
  });

  it("refuses a root it never published", async function () {
    await expect(pool.transact(
      await params({ poolRoot: [rand32(), rand32()] }), "0x", "0x", ZERO_PROOF,
    )).to.be.revertedWithCustomError(pool, "PoolRootUnknown");
  });

  it("keeps accepting a frozen tree's root after rollover", async function () {
    // Old trees are frozen, and their roots stay valid forever — which is what lets a proof
    // built before a rollover still land afterwards.
    const a = await insertPair();
    await insertPair();
    await insertPair();
    expect((await pool.position()).tree).to.equal(1n);
    await expect(pool.transact(
      await params({ poolRoot: [a.root, a.root], treeNumber: [a.tree, a.tree] }),
      "0x", "0x", ZERO_PROOF,
    )).to.not.be.reverted;
  });

  it("checks the pairing per input, so one transaction can span two trees", async function () {
    // The reason poolRoot and treeNumber are arrays. Two notes may legitimately live in
    // different trees, and requiring them to share one would mean a holder could not spend
    // across a rollover they had no part in.
    const a = await insertPair();
    await insertPair();
    const c = await insertPair();
    expect([a.tree, c.tree]).to.deep.equal([0, 1]);

    await expect(pool.transact(
      await params({ poolRoot: [a.root, c.root], treeNumber: [a.tree, c.tree] }),
      "0x", "0x", ZERO_PROOF,
    )).to.not.be.reverted;

    // …and mismatching either half still fails.
    await expect(pool.transact(
      await params({ poolRoot: [a.root, c.root], treeNumber: [a.tree, a.tree] }),
      "0x", "0x", ZERO_PROOF,
    )).to.be.revertedWithCustomError(pool, "PoolRootWrongTree");
  });

  // ── The nullifier ───────────────────────────────────────────────────────────

  // Where the nullifier derivation itself is tested: Alignment's "the circuit folds the tree
  // number into the nullifier", which proves against the real circuit. Asserting it here
  // would only restate arithmetic written in this file — it would pass even if the circuit
  // and the SDK both dropped the tree number. What this file adds is the flow below.

  it("spends two notes that share a leaf index in different trees", async function () {
    // End to end: the same leaf index in two trees, spent in one transaction. Under a
    // leaf-only nullifier these two would be the same value and the pool would reject the
    // second as already spent.
    const POOL_LEVELS = Number(await pool.LEVELS());
    const key = poseidonHash([7n]);
    const nul = (tree: number, leaf: number) => ethers.toBeHex(
      poseidonHash([key, (BigInt(tree) << BigInt(POOL_LEVELS)) + BigInt(leaf), 1314148940n]), 32);

    const a = await insertPair();       // tree 0, leaves 0 and 1
    await insertPair();                 // fills tree 0
    const c = await insertPair();       // tree 1, leaves 0 and 1
    expect([a.tree, a.idx0, c.tree, c.idx0]).to.deep.equal([0, 0, 1, 0]);

    await expect(pool.transact(await params({
      poolRoot: [a.root, c.root], treeNumber: [a.tree, c.tree],
      inputNullifiers: [nul(a.tree, a.idx0), nul(c.tree, c.idx0)],
    }), "0x", "0x", ZERO_PROOF)).to.not.be.reverted;

    expect(await pool.spentNullifiers(nul(a.tree, a.idx0))).to.equal(true);
    expect(await pool.spentNullifiers(nul(c.tree, c.idx0))).to.equal(true);
  });

  // ── Capacity ────────────────────────────────────────────────────────────────

  it("caps the tree count at what the circuit can address", async function () {
    // MAX_TREES must equal 2^(32 - LEVELS), because the nullifier's global index is 32 bits
    // and NoteNullifier range-checks the tree number to exactly that. A larger cap would let
    // notes be inserted into trees no witness can ever prove against — present on chain and
    // permanently unspendable.
    const levels = Number(await pool.LEVELS());
    expect(await pool.MAX_TREES()).to.equal(2n ** BigInt(32 - levels));
  });
});
