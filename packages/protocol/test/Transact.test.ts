import { expect } from "chai";
import { ethers } from "hardhat";
import * as path from "path";
import * as crypto from "crypto";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { MerkleTree } from "./helpers/merkleTree";
import { SMT, registryLeaf, aliasHashToKey, toNullifierKeyHash } from "./helpers/smt";

const snarkjs = require("snarkjs");

const TRANSACT_WASM = path.resolve(__dirname, "../circuits/out/transact/transact_js/transact.wasm");
const TRANSACT_ZKEY = path.resolve(__dirname, "../circuits/out/transact/ceremony/transact_final.zkey");
const TRANSACT_VKEY = path.resolve(__dirname, "../circuits/out/transact/ceremony/verification_key.json");

const POOL_LEVELS = 32;
const REGISTRY_LEVELS = 32;
const ETH_TOKEN = 0n;
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("Transact Circuit", function () {
  this.timeout(300000);

  let registrySMT: SMT;

  let DUMMY_NULLIFIER_KEY!: bigint;
  let DUMMY_OUT_PUBKEY!: bigint;
  let DUMMY_OUT_COMMITMENT!: bigint;

  before(async function () {
    await initPoseidon();
    registrySMT = new SMT();
    DUMMY_NULLIFIER_KEY = poseidonHash([2n]); // Poseidon(viewingPrivKey=2n)
    DUMMY_OUT_PUBKEY = poseidonHash([0n]);
    DUMMY_OUT_COMMITMENT = createCommitment(DUMMY_OUT_PUBKEY, 0n, 0n, 0n);
  });

  function generateKeypair() {
    const spendingPrivateKey = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    const viewingPrivateKey  = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    const pubkey       = poseidonHash([spendingPrivateKey]);
    const nullifierKey = poseidonHash([viewingPrivateKey]);
    return { spendingPrivateKey, viewingPrivateKey, pubkey, nullifierKey };
  }

  function createCommitment(pubkey: bigint, nullifierKeyHash: bigint, blinding: bigint, amount: bigint, token = ETH_TOKEN): bigint {
    return poseidonHash([pubkey, nullifierKeyHash, blinding, amount, token]);
  }

  function computeNullifier(nullifierKey: bigint, leafIndex: number): bigint {
    return poseidonHash([nullifierKey, BigInt(leafIndex), 1314148940n]); // NULLIFIER_DOMAIN ("NULL")
  }

  // Register a keypair into the local SMT (mirroring what the contract does).
  // Slots are handed out in registration order exactly as _smtUpdate does, so a
  // circuit-only test still sees the positions a real deployment would produce.
  let nextSlot = 0;
  function registerInSMT(pubkey: bigint, nullifierKey: bigint): { key: bigint; aliasHash: bigint; slot: number } {
    // Use a deterministic alias derived from pubkey for repeatability in tests.
    const aliasHash = BigInt(ethers.keccak256(ethers.concat([
      ethers.toBeHex(pubkey, 32), ethers.toBeHex(nullifierKey, 32)
    ])));
    const key  = aliasHashToKey(ethers.toBeHex(aliasHash, 32));
    const slot = nextSlot++;
    registrySMT.update(slot, key, registryLeaf(pubkey, nullifierKey));
    return { key, aliasHash, slot };
  }

  // paramsHash for circuit: any field-prime-reduced hash (circuit just squares it for wire inclusion).
  function dummyParamsHash(): bigint {
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes("test"))) % FIELD_PRIME;
  }

  // Build dummy (zero-amount) input: circuit skips pool proof for amount=0.
  function dummyInput(leafIndex = 0) {
    const pathIndices = Array.from({ length: POOL_LEVELS }, (_, i) => (leafIndex >> i) & 1);
    return {
      spendingPrivateKey: 1n,  // deterministic for test dummies; security: randomized in prod
      viewingPrivateKey:  2n,
      blinding:           0n,
      amount:             0n,
      pathIndices,
      pathElements:       new Array(POOL_LEVELS).fill(0n),
    };
  }

  function dummyNullifier(leafIndex = 0): bigint {
    return computeNullifier(DUMMY_NULLIFIER_KEY, leafIndex);
  }

  // Zero-amount dummy output: circuit skips SMT proof for amount=0.
  function dummyOutput() {
    return {
      pubkey:            DUMMY_OUT_PUBKEY,
      nullifierKeyHash:  0n,
      dataHash:          0n,
      aliasHash:         0n,
      blinding:          0n,
      amount:            0n,
      registrySiblings:  new Array(REGISTRY_LEVELS).fill(0n),
    };
  }

  function buildCircuitInput(opts: {
    poolRoot: bigint;
    registryRoot: bigint;
    publicAmount: bigint;
    tokenAddress: bigint;
    paramsHash: bigint;
    inputs: Array<{
      spendingPrivateKey: bigint;
      viewingPrivateKey: bigint;
      blinding: bigint;
      amount: bigint;
      pathIndices: number[];
      pathElements: bigint[];
    }>;
    outputs: Array<{
      pubkey: bigint;
      nullifierKeyHash: bigint;
      dataHash: bigint;
      aliasHash: bigint;
      blinding: bigint;
      amount: bigint;
      registrySiblings: bigint[];
    }>;
    inputNullifiers: bigint[];
    outputCommitments: bigint[];
  }) {
    const s = (v: bigint) => v.toString();
    return {
      poolRoot:               s(opts.poolRoot),
      registryRoot:           s(opts.registryRoot),
      publicAmount:           s(opts.publicAmount),
      tokenAddress:           s(opts.tokenAddress),
      paramsHash:             s(opts.paramsHash),
      inputNullifier:         opts.inputNullifiers.map(s),
      outputCommitment:       opts.outputCommitments.map(s),
      inSpendingPrivateKey:   opts.inputs.map(i => s(i.spendingPrivateKey)),
      inViewingPrivateKey:    opts.inputs.map(i => s(i.viewingPrivateKey)),
      inBlinding:             opts.inputs.map(i => s(i.blinding)),
      inAmount:               opts.inputs.map(i => s(i.amount)),
      inPathIndices:          opts.inputs.map(i => i.pathIndices.map(String)),
      inPathElements:         opts.inputs.map(i => i.pathElements.map(s)),
      outPubkey:              opts.outputs.map(o => s(o.pubkey)),
      outBlinding:            opts.outputs.map(o => s(o.blinding)),
      outAmount:              opts.outputs.map(o => s(o.amount)),
      outNullifierKeyHash:    opts.outputs.map(o => s(o.nullifierKeyHash)),
      outDataHash:            opts.outputs.map(o => s(o.dataHash)),
      outAliasHash:           opts.outputs.map(o => s(o.aliasHash)),
      outRegistryIndex:             opts.outputs.map((o: any) => String(o.registrySlot ?? 0)),
      outRegistrySiblings:    opts.outputs.map(o => o.registrySiblings.map(s)),
    };
  }

  async function prove(input: any) {
    return snarkjs.groth16.fullProve(input, TRANSACT_WASM, TRANSACT_ZKEY);
  }

  async function verifyProof(proof: any, publicSignals: any): Promise<boolean> {
    const vkey = require(TRANSACT_VKEY);
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
  }

  // ── Deposit ─────────────────────────────────────────────────────────────────

  describe("Deposit (publicAmount > 0)", function () {
    it("should accept a valid deposit with dummy inputs", async function () {
      const alice = generateKeypair();
      const { key: aliceKey, aliasHash: aliceAliasHash, slot: aliceSlot } = registerInSMT(alice.pubkey, alice.nullifierKey);

      const amount  = ethers.parseEther("1");
      const blinding = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const aliceNKHash = toNullifierKeyHash(alice.nullifierKey);
      const commitment = createCommitment(alice.pubkey, aliceNKHash, blinding, amount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      const paramsHash = dummyParamsHash();

      const input = buildCircuitInput({
        poolRoot:         poolTree.getRoot(),
        registryRoot:     registrySMT.root,
        publicAmount:     amount,
        tokenAddress:     ETH_TOKEN,
        paramsHash,
        inputs: [dummyInput(0), dummyInput(1)],
        outputs: [
          {
            pubkey:           alice.pubkey,
            nullifierKeyHash: aliceNKHash,
            dataHash:         0n,
            aliasHash:        aliceKey,
            blinding,
            amount,
            registrySiblings: registrySMT.getSiblings(aliceSlot),
          },
          dummyOutput(),
        ],
        inputNullifiers:   [dummyNullifier(0), dummyNullifier(1)],
        outputCommitments: [commitment, DUMMY_OUT_COMMITMENT],
      });

      const { proof, publicSignals } = await prove(input);
      expect(await verifyProof(proof, publicSignals)).to.be.true;
    });
  });

  // ── Transfer ─────────────────────────────────────────────────────────────────

  describe("Transfer (publicAmount = 0)", function () {
    it("should transfer between two registered aliases", async function () {
      const alice = generateKeypair();
      const bob   = generateKeypair();
      registerInSMT(alice.pubkey, alice.nullifierKey);
      const { key: bobKey, slot: bobSlot } = registerInSMT(bob.pubkey, bob.nullifierKey);

      const amount = ethers.parseEther("1");
      const aliceBlinding  = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const aliceNKHash    = toNullifierKeyHash(alice.nullifierKey);
      const aliceCommitment = createCommitment(alice.pubkey, aliceNKHash, aliceBlinding, amount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(aliceCommitment);
      const alicePoolProof = poolTree.getProof(0);
      const aliceNullifier = computeNullifier(alice.nullifierKey, 0);

      const bobBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const bobNKHash      = toNullifierKeyHash(bob.nullifierKey);
      const bobCommitment  = createCommitment(bob.pubkey, bobNKHash, bobBlinding, amount);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: 0n,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding: aliceBlinding, amount, pathIndices: alicePoolProof.pathIndices, pathElements: alicePoolProof.pathElements },
          dummyInput(),
        ],
        outputs: [
          { pubkey: bob.pubkey, nullifierKeyHash: bobNKHash, dataHash: 0n, aliasHash: bobKey, registrySlot: bobSlot, blinding: bobBlinding, amount, registrySiblings: registrySMT.getSiblings(bobSlot) },
          dummyOutput(),
        ],
        inputNullifiers:   [aliceNullifier, dummyNullifier()],
        outputCommitments: [bobCommitment, DUMMY_OUT_COMMITMENT],
      });

      const { proof, publicSignals } = await prove(input);
      expect(await verifyProof(proof, publicSignals)).to.be.true;
    });

    it("should transfer with change output (two real outputs)", async function () {
      const alice = generateKeypair();
      const bob   = generateKeypair();
      const { key: aliceKey, slot: aliceSlot } = registerInSMT(alice.pubkey, alice.nullifierKey);
      const { key: bobKey, slot: bobSlot } = registerInSMT(bob.pubkey, bob.nullifierKey);

      const depositAmount = ethers.parseEther("1");
      const sendAmount    = ethers.parseEther("0.3");
      const changeAmount  = ethers.parseEther("0.7");

      const aliceBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const aliceNKHash2     = toNullifierKeyHash(alice.nullifierKey);
      const aliceCommitment  = createCommitment(alice.pubkey, aliceNKHash2, aliceBlinding, depositAmount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(aliceCommitment);
      const alicePoolProof = poolTree.getProof(0);
      const aliceNullifier = computeNullifier(alice.nullifierKey, 0);

      const bobBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const bobNKHash2     = toNullifierKeyHash(bob.nullifierKey);
      const bobCommitment  = createCommitment(bob.pubkey, bobNKHash2, bobBlinding, sendAmount);
      const changeBlinding = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const changeCommitment = createCommitment(alice.pubkey, aliceNKHash2, changeBlinding, changeAmount);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: 0n,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding: aliceBlinding, amount: depositAmount, pathIndices: alicePoolProof.pathIndices, pathElements: alicePoolProof.pathElements },
          dummyInput(),
        ],
        outputs: [
          { pubkey: bob.pubkey,   nullifierKeyHash: bobNKHash2,   dataHash: 0n, aliasHash: bobKey, registrySlot: bobSlot,   blinding: bobBlinding,    amount: sendAmount,   registrySiblings: registrySMT.getSiblings(bobSlot) },
          { pubkey: alice.pubkey, nullifierKeyHash: aliceNKHash2, dataHash: 0n, aliasHash: aliceKey, registrySlot: aliceSlot, blinding: changeBlinding, amount: changeAmount, registrySiblings: registrySMT.getSiblings(aliceSlot) },
        ],
        inputNullifiers:   [aliceNullifier, dummyNullifier()],
        outputCommitments: [bobCommitment, changeCommitment],
      });

      const { proof, publicSignals } = await prove(input);
      expect(await verifyProof(proof, publicSignals)).to.be.true;
    });

    it("should merge two notes into one", async function () {
      const alice = generateKeypair();
      const { key: aliceKey, slot: aliceSlot } = registerInSMT(alice.pubkey, alice.nullifierKey);

      const amount1      = ethers.parseEther("0.5");
      const amount2      = ethers.parseEther("0.3");
      const totalAmount  = ethers.parseEther("0.8");
      const aliceNKHash3  = toNullifierKeyHash(alice.nullifierKey);
      const blinding1    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const blinding2    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const commitment1  = createCommitment(alice.pubkey, aliceNKHash3, blinding1, amount1);
      const commitment2  = createCommitment(alice.pubkey, aliceNKHash3, blinding2, amount2);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(commitment1);
      poolTree.insert(commitment2);

      const mergedBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const mergedCommitment  = createCommitment(alice.pubkey, aliceNKHash3, mergedBlinding, totalAmount);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: 0n,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding: blinding1, amount: amount1, pathIndices: poolTree.getProof(0).pathIndices, pathElements: poolTree.getProof(0).pathElements },
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding: blinding2, amount: amount2, pathIndices: poolTree.getProof(1).pathIndices, pathElements: poolTree.getProof(1).pathElements },
        ],
        outputs: [
          { pubkey: alice.pubkey, nullifierKeyHash: aliceNKHash3, dataHash: 0n, aliasHash: aliceKey, registrySlot: aliceSlot, blinding: mergedBlinding, amount: totalAmount, registrySiblings: registrySMT.getSiblings(aliceSlot) },
          dummyOutput(),
        ],
        inputNullifiers:   [computeNullifier(alice.nullifierKey, 0), computeNullifier(alice.nullifierKey, 1)],
        outputCommitments: [mergedCommitment, DUMMY_OUT_COMMITMENT],
      });

      const { proof, publicSignals } = await prove(input);
      expect(await verifyProof(proof, publicSignals)).to.be.true;
    });
  });

  // ── Withdraw ─────────────────────────────────────────────────────────────────

  describe("Withdraw (publicAmount < 0)", function () {
    it("should withdraw to an external address", async function () {
      const alice = generateKeypair();
      registerInSMT(alice.pubkey, alice.nullifierKey);

      const amount  = ethers.parseEther("1");
      const blinding = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const commitment = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), blinding, amount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(commitment);
      const poolProof  = poolTree.getProof(0);
      const nullifier  = computeNullifier(alice.nullifierKey, 0);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: FIELD_PRIME - amount, // field negation = withdraw
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding, amount, pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
          dummyInput(),
        ],
        outputs: [dummyOutput(), dummyOutput()],
        inputNullifiers:   [nullifier, dummyNullifier()],
        outputCommitments: [DUMMY_OUT_COMMITMENT, DUMMY_OUT_COMMITMENT],
      });

      const { proof, publicSignals } = await prove(input);
      expect(await verifyProof(proof, publicSignals)).to.be.true;
    });

    it("should allow partial withdrawal with change output", async function () {
      const alice = generateKeypair();
      const { key: aliceKey, slot: aliceSlot } = registerInSMT(alice.pubkey, alice.nullifierKey);

      const depositAmount  = ethers.parseEther("1");
      const withdrawAmount = ethers.parseEther("0.6");
      const changeAmount   = ethers.parseEther("0.4");

      const blinding = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const commitment = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), blinding, depositAmount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(commitment);
      const poolProof = poolTree.getProof(0);
      const nullifier = computeNullifier(alice.nullifierKey, 0);

      const changeBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const changeCommitment  = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), changeBlinding, changeAmount);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: FIELD_PRIME - withdrawAmount,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding, amount: depositAmount, pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
          dummyInput(),
        ],
        outputs: [
          { pubkey: alice.pubkey, nullifierKeyHash: toNullifierKeyHash(alice.nullifierKey), dataHash: 0n, aliasHash: aliceKey, registrySlot: aliceSlot, blinding: changeBlinding, amount: changeAmount, registrySiblings: registrySMT.getSiblings(aliceSlot) },
          dummyOutput(),
        ],
        inputNullifiers:   [nullifier, dummyNullifier()],
        outputCommitments: [changeCommitment, DUMMY_OUT_COMMITMENT],
      });

      const { proof, publicSignals } = await prove(input);
      expect(await verifyProof(proof, publicSignals)).to.be.true;
    });
  });

  // ── Security ─────────────────────────────────────────────────────────────────

  describe("Security: amount conservation", function () {
    it("should reject when outputs exceed inputs + publicAmount", async function () {
      const alice = generateKeypair();
      const { key: aliceKey, slot: aliceSlot } = registerInSMT(alice.pubkey, alice.nullifierKey);

      const depositAmount  = ethers.parseEther("1");
      const inflatedAmount = ethers.parseEther("2");
      const blinding       = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const commitment     = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), blinding, depositAmount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(commitment);
      const nullifier = computeNullifier(alice.nullifierKey, 0);

      const inflatedBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const inflatedCommitment  = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), inflatedBlinding, inflatedAmount);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: 0n,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding, amount: depositAmount, pathIndices: poolTree.getProof(0).pathIndices, pathElements: poolTree.getProof(0).pathElements },
          dummyInput(),
        ],
        outputs: [
          { pubkey: alice.pubkey, nullifierKeyHash: toNullifierKeyHash(alice.nullifierKey), dataHash: 0n, aliasHash: aliceKey, registrySlot: aliceSlot, blinding: inflatedBlinding, amount: inflatedAmount, registrySiblings: registrySMT.getSiblings(aliceSlot) },
          dummyOutput(),
        ],
        inputNullifiers:   [nullifier, dummyNullifier()],
        outputCommitments: [inflatedCommitment, DUMMY_OUT_COMMITMENT],
      });

      try {
        await prove(input);
        expect.fail("Should throw — outputs exceed inputs");
      } catch (err: any) {
        expect(err.message).to.include("Assert Failed");
      }
    });
  });

  describe("Security: note ownership", function () {
    it("should reject spending with wrong private key", async function () {
      const alice = generateKeypair();
      const eve   = generateKeypair();
      registerInSMT(alice.pubkey, alice.nullifierKey);

      const amount = ethers.parseEther("1");
      const blinding = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const commitment = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), blinding, amount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(commitment);
      const poolProof = poolTree.getProof(0);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: FIELD_PRIME - amount,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: eve.spendingPrivateKey, viewingPrivateKey: eve.viewingPrivateKey, blinding, amount, pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
          dummyInput(),
        ],
        outputs: [dummyOutput(), dummyOutput()],
        inputNullifiers:   [computeNullifier(eve.nullifierKey, 0), dummyNullifier()],
        outputCommitments: [DUMMY_OUT_COMMITMENT, DUMMY_OUT_COMMITMENT],
      });

      try {
        await prove(input);
        expect.fail("Should throw — wrong private key");
      } catch (err: any) {
        expect(err.message).to.include("Assert Failed");
      }
    });
  });

  describe("Security: SMT registry proof", function () {
    it("should reject output to an unregistered alias", async function () {
      const alice = generateKeypair();
      const unregistered = generateKeypair();
      registerInSMT(alice.pubkey, alice.nullifierKey);

      const amount  = ethers.parseEther("1");
      const blinding = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const commitment = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), blinding, amount);

      const poolTree = new MerkleTree(POOL_LEVELS);
      poolTree.insert(commitment);
      const poolProof  = poolTree.getProof(0);
      const nullifier  = computeNullifier(alice.nullifierKey, 0);

      // Fake a random key that is NOT in the SMT
      const fakeKey = BigInt("0x" + crypto.randomBytes(31).toString("hex")) % FIELD_PRIME;
      // An arbitrary empty slot: no leaf there commits to this alias, so the proof fails.
      const fakeSlot = 9999;
      const outBlinding    = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const outCommitment  = createCommitment(unregistered.pubkey, toNullifierKeyHash(unregistered.nullifierKey), outBlinding, amount);

      const input = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: 0n,
        tokenAddress: ETH_TOKEN,
        paramsHash:  dummyParamsHash(),
        inputs: [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding, amount, pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
          dummyInput(),
        ],
        outputs: [
          { pubkey: unregistered.pubkey, nullifierKeyHash: toNullifierKeyHash(unregistered.nullifierKey), dataHash: 0n, aliasHash: fakeKey, registrySlot: fakeSlot, blinding: outBlinding, amount, registrySiblings: registrySMT.getSiblings(fakeSlot) },
          dummyOutput(),
        ],
        inputNullifiers:   [nullifier, dummyNullifier()],
        outputCommitments: [outCommitment, DUMMY_OUT_COMMITMENT],
      });

      try {
        await prove(input);
        expect.fail("Should throw — unregistered recipient");
      } catch (err: any) {
        expect(err.message).to.include("Assert Failed");
      }
    });
  });
});
