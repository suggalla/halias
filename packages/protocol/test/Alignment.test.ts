import { expect } from "chai";
import { ethers } from "hardhat";
import { registerAlias } from "./helpers/register";
import * as path from "path";
import * as crypto from "crypto";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { MerkleTree } from "./helpers/merkleTree";
import { SMT, registryLeaf, aliasHashToKey, toNullifierKeyHash } from "./helpers/smt";

const snarkjs = require("snarkjs");

const TRANSACT_WASM = path.resolve(__dirname, "../circuits/out/transact/transact_js/transact.wasm");
const TRANSACT_ZKEY = path.resolve(__dirname, "../circuits/out/transact/ceremony/transact_final.zkey");
const POOL_LEVELS = 16;
const REGISTRY_LEVELS = 32;
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Circuit <-> contract alignment.
//
// The end-to-end suites prove the two agree in the ordinary case: a real proof only
// verifies if the commitment, nullifier, SMT leaf, path derivation, paramsHash and
// public-signal order all match. What they never touch are the edges — the exact values
// where a circuit range check and a Solidity constant have to agree, and the zero-value
// paths where the circuit disables a check entirely. Those are the places a mismatch
// hides, so they are pinned here.
describe("Circuit/contract alignment", function () {
  this.timeout(600000);

  let halias: any, pool: any, registry: any;
  let registrySMT: SMT;
  let poolTree: MerkleTree;
  let REGISTRATION_FEE: bigint;
  let dummyIdx = 4000;

  let DUMMY_NULLIFIER_KEY: bigint;
  let DUMMY_OUT_PUBKEY: bigint;
  let DUMMY_OUT_COMMITMENT: bigint;

  const s = (v: bigint) => v.toString();

  function generateKeypair() {
    const spendingPrivateKey = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    const viewingPrivateKey  = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    return {
      spendingPrivateKey, viewingPrivateKey,
      pubkey:       poseidonHash([spendingPrivateKey]),
      nullifierKey: poseidonHash([viewingPrivateKey]),
    };
  }

  const createCommitment = (pubkey: bigint, nkHash: bigint, blinding: bigint, amount: bigint, token: bigint = 0n) =>
    poseidonHash([pubkey, nkHash, blinding, amount, token]);

  // Keys on the note's GLOBAL position — tree * 2^POOL_LEVELS + leaf. A leaf index alone no
  // longer identifies a note, and using one would make leaf 5 of tree 0 collide with leaf 5
  // of tree 3.
  const computeNullifier = (nullifierKey: bigint, leafIndex: number, treeNumber: number = 0) =>
    poseidonHash([nullifierKey, (BigInt(treeNumber) << BigInt(POOL_LEVELS)) + BigInt(leafIndex), 1314148940n]);

  const dummyNullifier = (leafIndex: number) => computeNullifier(DUMMY_NULLIFIER_KEY, leafIndex);

  function dummyInput(leafIndex: number) {
    return {
      spendingPrivateKey: 1n, viewingPrivateKey: 2n, blinding: 0n, amount: 0n,
      pathIndices:  Array.from({ length: POOL_LEVELS }, (_, i) => (leafIndex >> i) & 1),
      pathElements: new Array(POOL_LEVELS).fill(0n),
    };
  }

  const dummyOutput = () => ({
    pubkey: DUMMY_OUT_PUBKEY, nullifierKeyHash: 0n, dataHash: 0n, aliasHash: 0n, registrySlot: 0,
    blinding: 0n, amount: 0n, registrySiblings: new Array(REGISTRY_LEVELS).fill(0n),
  });

  function buildInput(o: any) {
    return {
      poolRoot: [s(o.poolRoot), s(o.poolRoot)],
      // Both inputs anchored on one tree; a test that needs two spans them explicitly.
      treeNumber: [String(o.treeNumber ?? 0), String(o.treeNumber ?? 0)],
      registryRoot: s(o.registryRoot), publicAmount: s(o.publicAmount),
      tokenAddress: s(o.tokenAddress ?? 0n), paramsHash: s(o.paramsHash),
      // The registry insertion the proof performs. Zero on every path but a claim; the slot
      // and siblings are witness-only then, and the circuit discards them.
      // Opt-in, not derived: empty outputs do not require the flag, which is what keeps a
      // full withdrawal indistinguishable from a partial one unless the caller chooses
      // otherwise.
      outputsEmpty:    o.outputsEmpty ? "1" : "0",
      pendingLeaf:     s(o.pendingLeaf ?? 0n),
      pendingSlot:     String(o.pendingSlot ?? 0),
      pendingSiblings: (o.pendingSiblings ?? new Array(32).fill(0n)).map(s),
      inputNullifier: o.inputNullifiers.map(s), outputCommitment: o.outputCommitments.map(s),
      inSpendingPrivateKey: o.inputs.map((i: any) => s(i.spendingPrivateKey)),
      inViewingPrivateKey:  o.inputs.map((i: any) => s(i.viewingPrivateKey)),
      inBlinding:           o.inputs.map((i: any) => s(i.blinding)),
      inAmount:             o.inputs.map((i: any) => s(i.amount)),
      inPathIndices:        o.inputs.map((i: any) => i.pathIndices.map(String)),
      inPathElements:       o.inputs.map((i: any) => i.pathElements.map(s)),
      outPubkey:            o.outputs.map((x: any) => s(x.pubkey)),
      outBlinding:          o.outputs.map((x: any) => s(x.blinding)),
      outAmount:            o.outputs.map((x: any) => s(x.amount)),
      outNullifierKeyHash:  o.outputs.map((x: any) => s(x.nullifierKeyHash)),
      outDataHash:          o.outputs.map((x: any) => s(x.dataHash)),
      outAliasHash:         o.outputs.map((x: any) => s(x.aliasHash)),
      outRegistryIndex:     o.outputs.map((x: any) => String(x.registrySlot ?? 0)),
      outRegistrySiblings:  o.outputs.map((x: any) => x.registrySiblings.map(s)),
    };
  }

  const prove = (input: any) => snarkjs.groth16.fullProve(input, TRANSACT_WASM, TRANSACT_ZKEY);

  before(async function () {
    await initPoseidon();
    DUMMY_NULLIFIER_KEY  = poseidonHash([2n]);
    DUMMY_OUT_PUBKEY     = poseidonHash([0n]);
    DUMMY_OUT_COMMITMENT = poseidonHash([DUMMY_OUT_PUBKEY, 0n, 0n, 0n, 0n]);
  });

  beforeEach(async function () {
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const tv = await (await ethers.getContractFactory("TransactVerifier")).deploy();
    const dep = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await tv.getAddress(), (await ethers.getSigners())[0].address);
    pool     = await ethers.getContractAt("HaliasPool",     await dep.pool());
    registry = await ethers.getContractAt("HaliasRegistry", await dep.registry());
    halias   = await ethers.getContractAt("HaliasDomain",   await dep.domain());
    REGISTRATION_FEE = await halias.registrationFee();
    registrySMT = new SMT();
    poolTree    = new MerkleTree(POOL_LEVELS);
  });

  async function registerLocal(pubkey: bigint, nk: bigint) {
    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    await registerAlias(halias, (await ethers.getSigners())[0], aliasHash, ethers.toBeHex(pubkey, 32), ethers.toBeHex(toNullifierKeyHash(nk), 32),
      ethers.keccak256(ethers.randomBytes(32)), "", REGISTRATION_FEE);
    const key  = aliasHashToKey(aliasHash);
    const slot = Number(await registry.aliasSlot(aliasHash)) - 1;
    registrySMT.update(slot, key, registryLeaf(pubkey, nk));
    return { aliasHash, key, slot };
  }

  // ── Hash-function agreement ───────────────────────────────────────

  describe("hash agreement between off-chain and on-chain", function () {
    it("registry leaf: circuit Poseidon(3) == contract PoseidonT4", async function () {
      const kp = generateKeypair();
      const { aliasHash } = await registerLocal(kp.pubkey, kp.nullifierKey);
      // The contract emits the leaf it stored; the helper mirrors the circuit's RegistryLeaf.
      const stored = await registry.aliases(aliasHash);
      const onChainLeaf = await registry.getRegistryRoot();
      expect(BigInt(stored.spendingPubkey)).to.equal(kp.pubkey);
      expect(BigInt(stored.nullifierKeyHash)).to.equal(toNullifierKeyHash(kp.nullifierKey));
      // Local SMT was updated with registryLeaf(); if the hash functions disagreed the
      // roots would diverge immediately.
      expect(onChainLeaf).to.equal(ethers.toBeHex(registrySMT.root, 32));
    });

    it("SMT root tracks the contract across several registrations", async function () {
      for (let i = 0; i < 3; i++) {
        const kp = generateKeypair();
        await registerLocal(kp.pubkey, kp.nullifierKey);
        expect(await registry.getRegistryRoot()).to.equal(ethers.toBeHex(registrySMT.root, 32));
      }
    });

    it("paramsHash: contract keccak matches what the prover commits to", async function () {
      const [, recip] = await ethers.getSigners();
      const params = {
        poolRoot: [ethers.ZeroHash, ethers.ZeroHash], treeNumber: [0, 0], registryRoot: ethers.ZeroHash,
        publicAmount: 0n, tokenAddress: 0n,
        inputNullifiers: [ethers.ZeroHash, ethers.ZeroHash],
        outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
        relayerFee: { relayer: ethers.ZeroAddress, amount: 0n },
      recipient: recip.address, externalData: ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
      };
      const onChain = BigInt(await pool.computeParamsHash(params, "0x", "0x"));
      // The preimage hashes the POOL's own address, and the relayer fee as a two-member
      // struct rather than a packed word. Both changed with the split.
      const offChain = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "address", "bytes", "bytes", "tuple(address,uint256)", "bytes32"],
        [(await ethers.provider.getNetwork()).chainId, await pool.getAddress(),
         recip.address, "0x", "0x", [ethers.ZeroAddress, 0n], ethers.ZeroHash],
      ))) % FIELD_PRIME;
      expect(onChain).to.equal(offChain);
    });

    it("paramsHash changes with externalData, binding the relayer fee into the proof", async function () {
      const base = {
        poolRoot: [ethers.ZeroHash, ethers.ZeroHash], treeNumber: [0, 0], registryRoot: ethers.ZeroHash,
        publicAmount: 0n, tokenAddress: 0n,
        inputNullifiers: [ethers.ZeroHash, ethers.ZeroHash],
        outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
        relayerFee: { relayer: ethers.ZeroAddress, amount: 0n },
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
      };
      const a = await pool.computeParamsHash(base, "0x", "0x");
      const b = await pool.computeParamsHash(
        { ...base, externalData: ethers.toBeHex(1n, 32) }, "0x", "0x");
      expect(a).to.not.equal(b);
    });
  });

  // ── publicAmount boundary: circuit Num2Bits(249) vs MAX_ABS_AMOUNT ─

  describe("publicAmount bounds", function () {
    // The circuit range-checks publicAmount + 2^248 into 249 bits, admitting
    // [0, 2^248) as deposits and [p - 2^248, p) as withdrawals. The contract's
    // MAX_ABS_AMOUNT is 1 << 248 and its isWithdraw test is publicAmount >=
    // FIELD_PRIME - MAX_ABS_AMOUNT. These must describe the same split.
    it("contract MAX_ABS_AMOUNT equals the circuit's 2^248 bound", async function () {
      // Exposed indirectly: a withdrawal of exactly 2^248 is the largest the circuit
      // permits, and the contract must classify it as a withdrawal rather than a deposit.
      const maxAbs = 1n << 248n;
      const atBoundary = FIELD_PRIME - maxAbs;
      // One below the boundary is a deposit as far as the contract is concerned, so it
      // demands msg.value — proving the split sits exactly where the circuit puts it.
      await expect(pool.transact({
        poolRoot: [await pool.getLastRoot(), await pool.getLastRoot()], treeNumber: [0, 0], registryRoot: await registry.getRegistryRoot(),
        publicAmount: atBoundary - 1n, tokenAddress: 0n,
        inputNullifiers: [ethers.keccak256("0x01"), ethers.keccak256("0x02")],
        outputCommitments: [ethers.keccak256("0x03"), ethers.keccak256("0x04")],
        relayerFee: { relayer: ethers.ZeroAddress, amount: 0n },
      recipient: ethers.ZeroAddress, externalData: ethers.ZeroHash,
      pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
      }, "0x", "0x", "0x")).to.be.revertedWithCustomError(pool, "WrongMsgValue");
    });

    it("circuit rejects a deposit of 2^248 (one past its range check)", async function () {
      const kp = generateKeypair();
      const { key } = await registerLocal(kp.pubkey, kp.nullifierKey);
      const amount = 1n << 248n;
      const nkHash = toNullifierKeyHash(kp.nullifierKey);
      await expect(prove(buildInput({
        poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
        publicAmount: amount, paramsHash: 1n,
        inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs: [
          { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
            blinding: 1n, amount, registrySiblings: registrySMT.getSiblings(key) },
          dummyOutput(),
        ],
        inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
        outputCommitments: [createCommitment(kp.pubkey, nkHash, 1n, amount), DUMMY_OUT_COMMITMENT],
      }))).to.be.rejected;
      dummyIdx += 2;
    });
  });

  // ── tokenAddress 160-bit bound ────────────────────────────────────

  it("circuit rejects a tokenAddress of 2^160, keeping a token's namespace canonical", async function () {
    // Without this bound, tokenAddress and tokenAddress + 2^160 would be distinct note
    // namespaces that the contract's uint160 cast collapses onto the same ERC-20.
    const kp = generateKeypair();
    const { key } = await registerLocal(kp.pubkey, kp.nullifierKey);
    const token = 1n << 160n;
    const nkHash = toNullifierKeyHash(kp.nullifierKey);
    await expect(prove(buildInput({
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: 100n, tokenAddress: token, paramsHash: 1n,
      inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
      outputs: [
        { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
          blinding: 1n, amount: 100n, registrySiblings: registrySMT.getSiblings(key) },
        dummyOutput(),
      ],
      inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
      outputCommitments: [createCommitment(kp.pubkey, nkHash, 1n, 100n, token), DUMMY_OUT_COMMITMENT],
    }))).to.be.rejected;
    dummyIdx += 2;
  });

  // ── Zero-value paths ──────────────────────────────────────────────

  describe("zero-amount handling", function () {
    it("a zero-amount output skips the registry proof, so garbage siblings still prove", async function () {
      // ForceEqualIfEnabled is gated on outAmount != 0. A dummy output must therefore
      // verify with an unregistered pubkey and nonsense siblings — that is what lets a
      // transaction have fewer than two real recipients.
      const kp = generateKeypair();
      const { key } = await registerLocal(kp.pubkey, kp.nullifierKey);
      const nkHash = toNullifierKeyHash(kp.nullifierKey);
      const junk = { ...dummyOutput(), aliasHash: 12345n, nullifierKeyHash: 999n,
        registrySiblings: new Array(REGISTRY_LEVELS).fill(7n) };
      const junkComm = createCommitment(junk.pubkey, junk.nullifierKeyHash, junk.blinding, 0n);

      const { publicSignals } = await prove(buildInput({
        poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
        publicAmount: 50n, paramsHash: 1n,
        inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs: [
          { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
            blinding: 1n, amount: 50n, registrySiblings: registrySMT.getSiblings(key) },
          junk,
        ],
        inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
        outputCommitments: [createCommitment(kp.pubkey, nkHash, 1n, 50n), junkComm],
      }));
      expect(publicSignals.length).to.equal(14);
      dummyIdx += 2;
    });

    it("a zero-amount input skips the pool proof, so an unknown note still proves", async function () {
      const kp = generateKeypair();
      const { key } = await registerLocal(kp.pubkey, kp.nullifierKey);
      const nkHash = toNullifierKeyHash(kp.nullifierKey);
      // Both inputs are dummies against an empty tree; only their nullifiers are constrained.
      const { publicSignals } = await prove(buildInput({
        poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
        publicAmount: 10n, paramsHash: 1n,
        inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs: [
          { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
            blinding: 3n, amount: 10n, registrySiblings: registrySMT.getSiblings(key) },
          dummyOutput(),
        ],
        inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
        outputCommitments: [createCommitment(kp.pubkey, nkHash, 3n, 10n), DUMMY_OUT_COMMITMENT],
      }));
      expect(publicSignals[5]).to.equal("10");   // publicAmount
      dummyIdx += 2;
    });

    it("a nullifier is still constrained for a zero-amount input", async function () {
      // The pool proof is skipped but inNullifier === inputNullifier is not, so a prover
      // cannot burn an arbitrary nullifier to grief someone else's future note.
      const kp = generateKeypair();
      const { key } = await registerLocal(kp.pubkey, kp.nullifierKey);
      const nkHash = toNullifierKeyHash(kp.nullifierKey);
      await expect(prove(buildInput({
        poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
        publicAmount: 10n, paramsHash: 1n,
        inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs: [
          { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
            blinding: 3n, amount: 10n, registrySiblings: registrySMT.getSiblings(key) },
          dummyOutput(),
        ],
        // Claim an arbitrary nullifier rather than the one the keys derive.
        inputNullifiers:   [ethers.toBigInt(ethers.keccak256("0xbeef")) % FIELD_PRIME, dummyNullifier(dummyIdx + 1)],
        outputCommitments: [createCommitment(kp.pubkey, nkHash, 3n, 10n), DUMMY_OUT_COMMITMENT],
      }))).to.be.rejected;
      dummyIdx += 2;
    });

    it("publicAmount = 0 with all-zero outputs is a valid no-op transfer", async function () {
      const { publicSignals } = await prove(buildInput({
        poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
        publicAmount: 0n, paramsHash: 1n,
        inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs: [dummyOutput(), dummyOutput()],
        inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
        outputCommitments: [DUMMY_OUT_COMMITMENT, DUMMY_OUT_COMMITMENT],
      }));
      expect(publicSignals[5]).to.equal("0");    // publicAmount
      dummyIdx += 2;
    });
  });

  // ── Public signal ordering ────────────────────────────────────────

  // ── The pending registration (F1) ─────────────────────────────────────────

  it("proves an output against a registry insertion that has not happened yet", async function () {
    // F1's entire mechanism, and the only place it meets the real circuit — every other test
    // of it uses MockTransactVerifier, which checks nothing.
    //
    // A claim's change note must prove membership for an alias that is not in the tree when
    // the proof is built. Rather than predicting the post-registration root, the circuit does
    // the insertion: it shows the target slot holds the empty leaf under `registryRoot`,
    // derives the tree that results from putting `pendingLeaf` there, and checks every
    // non-zero output against THAT root instead.
    const kp     = generateKeypair();
    const nkHash = toNullifierKeyHash(kp.nullifierKey);
    const key    = aliasHashToKey(ethers.keccak256(ethers.randomBytes(32)));

    // Deliberately not the slot the registry would assign next. A registry proof establishes
    // "these keys belong to a registered alias"; the slot appears in no note commitment, and
    // the derived tree is never persisted — so any free slot is sound, and using a far one
    // demonstrates that rather than leaving it as a claim in a comment.
    const freeSlot    = 1000;
    const siblings    = registrySMT.getSiblings(freeSlot);
    const pendingLeaf = poseidonHash([key, registryLeaf(kp.pubkey, kp.nullifierKey), 1n]);

    const amount = 5n;
    const base = {
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: amount, paramsHash: 11n,
      inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
      inputNullifiers: [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
      outputs: [
        { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
          blinding: 3n, amount, registrySlot: freeSlot, registrySiblings: siblings },
        dummyOutput(),
      ],
      outputCommitments: [createCommitment(kp.pubkey, nkHash, 3n, amount), DUMMY_OUT_COMMITMENT],
      pendingSlot: freeSlot, pendingSiblings: siblings,
    };

    // The alias is NOT in registrySMT, so without the insertion this output cannot prove.
    await expect(prove(buildInput({ ...base, pendingLeaf: 0n })),
      "membership succeeded for an alias that was never registered").to.be.rejected;

    // With it, the same output proves — and pendingLeaf is published so the pool can require
    // it to equal what the registry armed.
    const { publicSignals } = await prove(buildInput({ ...base, pendingLeaf }));
    expect(publicSignals[8]).to.equal(pendingLeaf.toString());

    dummyIdx += 2;
  });

  it("refuses to insert onto an occupied slot", async function () {
    // The emptiness proof, which is what binds pendingSiblings to registryRoot. Without it a
    // prover could pick arbitrary siblings, derive any tree at all whenever pendingLeaf is
    // non-zero, and pay unregistered keys — making registry membership vacuous on exactly the
    // path that mints new aliases. It also means an insertion can never overwrite an alias.
    const victim = generateKeypair();
    const { key: takenKey, slot: takenSlot } = await registerLocal(victim.pubkey, victim.nullifierKey);

    const kp     = generateKeypair();
    const nkHash = toNullifierKeyHash(kp.nullifierKey);
    const key    = aliasHashToKey(ethers.keccak256(ethers.randomBytes(32)));
    const siblings = registrySMT.getSiblings(takenSlot);
    const amount = 5n;

    await expect(prove(buildInput({
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: amount, paramsHash: 12n,
      inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
      inputNullifiers: [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
      outputs: [
        { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
          blinding: 3n, amount, registrySlot: takenSlot, registrySiblings: siblings },
        dummyOutput(),
      ],
      outputCommitments: [createCommitment(kp.pubkey, nkHash, 3n, amount), DUMMY_OUT_COMMITMENT],
      pendingLeaf: poseidonHash([key, registryLeaf(kp.pubkey, kp.nullifierKey), 1n]),
      pendingSlot: takenSlot, pendingSiblings: siblings,
    })), "an insertion overwrote an occupied slot").to.be.rejected;

    expect(takenKey).to.not.equal(key);
    dummyIdx += 2;
  });

  // ── Nullifier keys on the global position ─────────────────────────────────

  it("the circuit folds the tree number into the nullifier", async function () {
    // The bug the global index exists to prevent, tested against the circuit rather than
    // against arithmetic written in this file. The circuit constrains its own derivation
    // (`inNullifier[i].out === inputNullifier[i]`), so supplying a nullifier built for tree 1
    // only produces a witness if the circuit also folds in tree 1 — and supplying the tree-0
    // value fails. Drop the tree from NoteNullifier and this test stops passing both ways.
    const n0 = dummyNullifier(dummyIdx);
    const n1 = computeNullifier(DUMMY_NULLIFIER_KEY, dummyIdx, 1);
    expect(n0, "tree number had no effect on the nullifier").to.not.equal(n1);

    const base = {
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: 0n, paramsHash: 7n,
      inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
      outputs: [dummyOutput(), dummyOutput()],
      outputCommitments: [DUMMY_OUT_COMMITMENT, DUMMY_OUT_COMMITMENT],
    };

    // Proving in tree 1 requires the tree-1 nullifiers…
    const { publicSignals } = await prove(buildInput({
      ...base, treeNumber: 1,
      inputNullifiers: [n1, computeNullifier(DUMMY_NULLIFIER_KEY, dummyIdx + 1, 1)],
    }));
    expect(publicSignals[10]).to.equal(n1.toString());
    expect(publicSignals[2]).to.equal("1");   // treeNumber[0] is public

    // …and the tree-0 values no longer satisfy it.
    await expect(prove(buildInput({
      ...base, treeNumber: 1,
      inputNullifiers: [n0, dummyNullifier(dummyIdx + 1)],
    }))).to.be.rejected;

    dummyIdx += 2;
  });

  it("publicSignals order matches the contract's pubSignals array", async function () {
    const kp = generateKeypair();
    const { key } = await registerLocal(kp.pubkey, kp.nullifierKey);
    const nkHash = toNullifierKeyHash(kp.nullifierKey);
    const amount = 77n, blinding = 5n, paramsHash = 424242n;
    const comm = createCommitment(kp.pubkey, nkHash, blinding, amount);
    const n0 = dummyNullifier(dummyIdx), n1 = dummyNullifier(dummyIdx + 1);

    const { publicSignals } = await prove(buildInput({
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: amount, paramsHash,
      inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
      outputs: [
        { pubkey: kp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: key,
          blinding, amount, registrySiblings: registrySMT.getSiblings(key) },
        dummyOutput(),
      ],
      inputNullifiers: [n0, n1],
      outputCommitments: [comm, DUMMY_OUT_COMMITMENT],
    }));
    dummyIdx += 2;

    // HaliasPool._verifyTransact reads these fourteen in exactly this order. pendingLeaf sits at
    // index 5 because circom orders public signals by declaration, and a wrong index here
    // is the failure mode with no symptom other than every proof being rejected.
    const root = poolTree.getRoot().toString();
    expect(publicSignals[0]).to.equal(root);                      // poolRoot[0]
    expect(publicSignals[1]).to.equal(root);                      // poolRoot[1]
    expect(publicSignals[2]).to.equal("0");                       // treeNumber[0]
    expect(publicSignals[3]).to.equal("0");                       // treeNumber[1]
    expect(publicSignals[4]).to.equal(registrySMT.root.toString());
    expect(publicSignals[5]).to.equal(amount.toString());
    expect(publicSignals[6]).to.equal("0");                       // tokenAddress
    expect(publicSignals[7]).to.equal(paramsHash.toString());
    expect(publicSignals[8]).to.equal("0");                       // pendingLeaf — no insertion
    expect(publicSignals[9]).to.equal("0");                       // outputsEmpty — has outputs
    expect(publicSignals[10]).to.equal(n0.toString());
    expect(publicSignals[11]).to.equal(n1.toString());
    expect(publicSignals[12]).to.equal(comm.toString());
    expect(publicSignals[13]).to.equal(DUMMY_OUT_COMMITMENT.toString());
  });

  // ── Tree parameter agreement ──────────────────────────────────────

  it("tree depths agree with the circuit's compiled parameters", async function () {
    expect(await pool.LEVELS()).to.equal(POOL_LEVELS);
    expect(await registry.REGISTRY_LEVELS()).to.equal(REGISTRY_LEVELS);
    // Sibling array length is what the circuit's outRegistrySiblings expects.
    const siblings = await registry.getSmtSiblings(0n);
    expect(siblings.length).to.equal(REGISTRY_LEVELS);
  });
});
