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
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("Halias (on-chain Transact)", function () {
  this.timeout(600000);

  let REGISTRATION_FEE: bigint;
  let CHAIN_ID: bigint;
  let HALIAS_ADDRESS: string;

  let halias: any;
  let registrySMT: SMT;

  let DUMMY_NULLIFIER_KEY: bigint;
  let DUMMY_OUT_PUBKEY: bigint;
  let DUMMY_OUT_COMMITMENT: bigint;

  // ── Deploy ────────────────────────────────────────────────────────

  async function deployHaliasStack() {
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    const PoseidonT4 = await ethers.getContractFactory("PoseidonT4");
    const poseidonT4 = await PoseidonT4.deploy();
    const TransactVerifier = await ethers.getContractFactory("TransactVerifier");
    const transactVerifier = await TransactVerifier.deploy();
    const MockEntryPoint = await ethers.getContractFactory("MockEntryPoint");
    const mockEntryPoint = await MockEntryPoint.deploy();
    const Halias = await ethers.getContractFactory("Halias", {
      libraries: {
        PoseidonT3: await poseidonT3.getAddress(),
        PoseidonT4: await poseidonT4.getAddress(),
      },
    });
    const h = await Halias.deploy(
      await transactVerifier.getAddress(),
      await mockEntryPoint.getAddress(),
    );
    return { halias: h, mockEntryPoint };
  }

  before(async function () {
    await initPoseidon();

    ({ halias } = await deployHaliasStack());
    CHAIN_ID       = (await ethers.provider.getNetwork()).chainId;
    HALIAS_ADDRESS = await halias.getAddress();
    REGISTRATION_FEE = await halias.registrationFee();

    registrySMT = new SMT();

    DUMMY_NULLIFIER_KEY  = poseidonHash([2n]);  // raw nullifierKey for computing dummy nullifiers
    DUMMY_OUT_PUBKEY     = poseidonHash([0n]);
    DUMMY_OUT_COMMITMENT = poseidonHash([DUMMY_OUT_PUBKEY, 0n, 0n, 0n, 0n]); // nullifierKeyHash=0 for dummy
  });

  // ── Helpers ───────────────────────────────────────────────────────

  function generateKeypair() {
    const spendingPrivateKey = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    const viewingPrivateKey  = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    return {
      spendingPrivateKey,
      viewingPrivateKey,
      pubkey:       poseidonHash([spendingPrivateKey]),
      nullifierKey: poseidonHash([viewingPrivateKey]),
    };
  }

  const createCommitment = (pubkey: bigint, nullifierKeyHash: bigint, blinding: bigint, amount: bigint) =>
    poseidonHash([pubkey, nullifierKeyHash, blinding, amount, 0n]); // tokenAddress=0 for ETH

  const computeNullifier = (nullifierKey: bigint, leafIndex: number) =>
    poseidonHash([nullifierKey, BigInt(leafIndex)]);

  function dummyInput(leafIndex: number) {
    const pathIndices = Array.from({ length: POOL_LEVELS }, (_, i) => (leafIndex >> i) & 1);
    return {
      spendingPrivateKey: 1n,
      viewingPrivateKey:  2n,
      blinding:           0n,
      amount:             0n,
      pathIndices,
      pathElements:       new Array(POOL_LEVELS).fill(0n),
    };
  }

  const dummyNullifier = (leafIndex: number) =>
    computeNullifier(DUMMY_NULLIFIER_KEY, leafIndex);

  function dummyOutput() {
    return {
      pubkey:           DUMMY_OUT_PUBKEY,
      nullifierKeyHash: 0n,
      dataHash:         0n,
      aliasHash:        0n,
      blinding:         0n,
      amount:           0n,
      registrySiblings: new Array(32).fill(0n),
    };
  }

  // Minimal TransactParams for tests — zero roots/amounts filled in per-call.
  const ZERO_TRANSACT_PARAMS = {
    poolRoot:          ethers.ZeroHash,
    registryRoot:      ethers.ZeroHash,
    publicAmount:      0n,
    tokenAddress:      0n,
    inputNullifiers:   [ethers.ZeroHash, ethers.ZeroHash],
    outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
    recipient:         ethers.ZeroAddress,
    externalData:      ethers.ZeroHash,
  };

  async function computeTransactParamsHash(params: {
    recipient?: string;
    encryptedOutput0?: string;
    encryptedOutput1?: string;
    externalData?: string;
  }, contract = halias): Promise<bigint> {
    return BigInt(await contract.computeParamsHash(
      { ...ZERO_TRANSACT_PARAMS, recipient: params.recipient ?? ethers.ZeroAddress, externalData: params.externalData ?? ethers.ZeroHash },
      params.encryptedOutput0 ?? "0x",
      params.encryptedOutput1 ?? "0x",
    ));
  }

  function buildCircuitInput(opts: {
    poolRoot: bigint; registryRoot: bigint; publicAmount: bigint; paramsHash: bigint;
    inputs: any[]; outputs: any[]; inputNullifiers: bigint[]; outputCommitments: bigint[];
  }) {
    const s = (v: bigint) => v.toString();
    return {
      poolRoot:               s(opts.poolRoot),
      registryRoot:           s(opts.registryRoot),
      publicAmount:           s(opts.publicAmount),
      tokenAddress:           "0",
      paramsHash:             s(opts.paramsHash),
      inputNullifier:         opts.inputNullifiers.map(s),
      outputCommitment:       opts.outputCommitments.map(s),
      inSpendingPrivateKey:   opts.inputs.map((i: any) => s(i.spendingPrivateKey)),
      inViewingPrivateKey:    opts.inputs.map((i: any) => s(i.viewingPrivateKey)),
      inBlinding:             opts.inputs.map((i: any) => s(i.blinding)),
      inAmount:               opts.inputs.map((i: any) => s(i.amount)),
      inPathIndices:          opts.inputs.map((i: any) => i.pathIndices.map(String)),
      inPathElements:         opts.inputs.map((i: any) => i.pathElements.map(s)),
      outPubkey:              opts.outputs.map((o: any) => s(o.pubkey)),
      outBlinding:            opts.outputs.map((o: any) => s(o.blinding)),
      outAmount:              opts.outputs.map((o: any) => s(o.amount)),
      outNullifierKeyHash:    opts.outputs.map((o: any) => s(o.nullifierKeyHash)),
      outDataHash:            opts.outputs.map((o: any) => s(o.dataHash)),
      outAliasHash:           opts.outputs.map((o: any) => s(o.aliasHash)),
      outRegistrySiblings:    opts.outputs.map((o: any) => o.registrySiblings.map(s)),
    };
  }

  async function prove(input: any) {
    return snarkjs.groth16.fullProve(input, TRANSACT_WASM, TRANSACT_ZKEY);
  }

  async function verifyProofLocally(proof: any, publicSignals: any): Promise<boolean> {
    const vkey = require(TRANSACT_VKEY);
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
  }

  async function encodeProof(proof: any, publicSignals: any): Promise<string> {
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [pA, pB, pC] = JSON.parse("[" + calldata + "]");
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"],
      [pA, pB, pC]
    );
  }

  // Register a keypair on-chain and track in local SMT.
  async function register(pubkey: bigint, nullifierKey: bigint): Promise<{ key: bigint }> {
    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    await halias.register(
      aliasHash,
      ethers.toBeHex(pubkey, 32),
      ethers.toBeHex(toNullifierKeyHash(nullifierKey), 32),  // contract expects hash
      ethers.keccak256(ethers.randomBytes(32)),
      { value: REGISTRATION_FEE }
    );
    const key = aliasHashToKey(aliasHash);
    registrySMT.update(key, registryLeaf(pubkey, nullifierKey));  // registryLeaf hashes internally
    return { key };
  }

  // ── Contract validation (table-driven, no ZK proofs) ─────────────

  describe("input validation", function () {
    const GARBAGE_PROOF = ethers.ZeroHash;
    let validPoolRoot: string;
    let nullifiers: string[];

    before(async function () {
      const alice = generateKeypair();
      await register(alice.pubkey, alice.nullifierKey);
      validPoolRoot = ethers.toBeHex(new MerkleTree(POOL_LEVELS).getRoot(), 32);
      nullifiers = [
        ethers.toBeHex(dummyNullifier(100), 32),
        ethers.toBeHex(dummyNullifier(101), 32),
      ];
    });

    function callTransact(overrides: any = {}) {
      const defaults = {
        poolRoot:          validPoolRoot,
        registryRoot:      ethers.toBeHex(registrySMT.root, 32),
        publicAmount:      0n,
        tokenAddress:      0n,
        inputNullifiers:   [nullifiers[0], nullifiers[1]],
        outputCommitments: [ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)],
        recipient:         ethers.ZeroAddress,
        externalData:      ethers.ZeroHash,
        value:             0n,
      };
      const o = { ...defaults, ...overrides };
      const p = {
        poolRoot: o.poolRoot, registryRoot: o.registryRoot,
        publicAmount: o.publicAmount, tokenAddress: o.tokenAddress,
        inputNullifiers: o.inputNullifiers, outputCommitments: o.outputCommitments,
        recipient: o.recipient, externalData: o.externalData,
      };
      return halias.transact(p, "0x", "0x", GARBAGE_PROOF, { value: o.value });
    }

    it("rejects unknown pool root", async function () {
      await expect(callTransact({ poolRoot: ethers.ZeroHash }))
        .to.be.revertedWithCustomError(halias, "PoolRootUnknown");
    });

    it("rejects stale registry root", async function () {
      await expect(callTransact({ registryRoot: ethers.ZeroHash }))
        .to.be.revertedWithCustomError(halias, "RegistryRootNotCurrent");
    });

    it("rejects duplicate nullifiers", async function () {
      await expect(callTransact({ inputNullifiers: [nullifiers[0], nullifiers[0]] }))
        .to.be.revertedWithCustomError(halias, "DuplicateNullifier");
    });

    it("rejects deposit with wrong msg.value", async function () {
      await expect(callTransact({ publicAmount: ethers.parseEther("1"), value: ethers.parseEther("0.5") }))
        .to.be.revertedWithCustomError(halias, "WrongDepositValue");
    });

    it("rejects transfer with msg.value", async function () {
      await expect(callTransact({ value: 1n }))
        .to.be.revertedWithCustomError(halias, "TransferCannotHaveValue");
    });
  });

  describe("withdrawal validation", function () {
    const GARBAGE_PROOF = ethers.ZeroHash;
    let validPoolRoot: string;
    let withdrawPublicAmount: bigint;
    let nullifiers: string[];

    before(async function () {
      validPoolRoot = ethers.toBeHex(new MerkleTree(POOL_LEVELS).getRoot(), 32);
      withdrawPublicAmount = FIELD_PRIME - ethers.parseEther("1");
      nullifiers = [
        ethers.toBeHex(dummyNullifier(500), 32),
        ethers.toBeHex(dummyNullifier(501), 32),
      ];
    });

    it("rejects withdrawal with no destination", async function () {
      await expect(
        halias.transact(
          { ...ZERO_TRANSACT_PARAMS, poolRoot: validPoolRoot, registryRoot: ethers.toBeHex(registrySMT.root, 32), publicAmount: withdrawPublicAmount, inputNullifiers: nullifiers, outputCommitments: [ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)], recipient: ethers.ZeroAddress },
          "0x", "0x", GARBAGE_PROOF
        )
      ).to.be.revertedWithCustomError(halias, "NoDestination");
    });

  });

  // ── paramsHash binding (real proofs, fresh contract) ────────────

  describe("Security: paramsHash binding", function () {
    let localHalias: any;
    let localSMT: SMT;

    beforeEach(async function () {
      ({ halias: localHalias } = await deployHaliasStack());
      localSMT = new SMT();
    });

    async function localRegister(pubkey: bigint, nk: bigint): Promise<{ key: bigint }> {
      const aliasHash = ethers.keccak256(ethers.randomBytes(32));
      await localHalias.register(
        aliasHash, ethers.toBeHex(pubkey, 32), ethers.toBeHex(toNullifierKeyHash(nk), 32),
        ethers.keccak256(ethers.randomBytes(32)),
        { value: REGISTRATION_FEE }
      );
      const key = aliasHashToKey(aliasHash);
      localSMT.update(key, registryLeaf(pubkey, nk));
      return { key };
    }

    it("rejects withdrawal when recipient is swapped after proof generation", async function () {
      const [, legitRecipient, attacker] = await ethers.getSigners();
      const alice    = generateKeypair();
      const poolTree = new MerkleTree(POOL_LEVELS);

      const { key: aliceKey } = await localRegister(alice.pubkey, alice.nullifierKey);
      let dummyIdx = 600;

      const amount     = ethers.parseEther("1");
      const blinding   = 0x600n;
      const commitment = createCommitment(alice.pubkey, toNullifierKeyHash(alice.nullifierKey), blinding, amount);

      const depositInput = buildCircuitInput({
        poolRoot:         poolTree.getRoot(),
        registryRoot:     localSMT.root,
        publicAmount:     amount,
        paramsHash:      await computeTransactParamsHash(ZERO_TRANSACT_PARAMS, localHalias),
        inputs:           [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs:          [
          { pubkey: alice.pubkey, nullifierKeyHash: toNullifierKeyHash(alice.nullifierKey), dataHash: 0n, aliasHash: aliceKey, blinding, amount, registrySiblings: localSMT.getSiblings(aliceKey) },
          dummyOutput(),
        ],
        inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
        outputCommitments: [commitment, DUMMY_OUT_COMMITMENT],
      });
      dummyIdx += 2;

      const { proof: dp, publicSignals: dps } = await prove(depositInput);
      await localHalias.transact(
        { ...ZERO_TRANSACT_PARAMS, poolRoot: ethers.toBeHex(poolTree.getRoot(), 32), registryRoot: ethers.toBeHex(localSMT.root, 32), publicAmount: amount, inputNullifiers: [ethers.toBeHex(dummyNullifier(600), 32), ethers.toBeHex(dummyNullifier(601), 32)], outputCommitments: [ethers.toBeHex(commitment, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)] },
        "0x", "0x", await encodeProof(dp, dps),
        { value: amount }
      );
      poolTree.insert(commitment);
      poolTree.insert(DUMMY_OUT_COMMITMENT);

      const alicePoolProof = poolTree.getProof(0);
      const nullifier      = computeNullifier(alice.nullifierKey, 0);
      const legitTransactParams    = { ...ZERO_TRANSACT_PARAMS, recipient: legitRecipient.address };

      const withdrawInput = buildCircuitInput({
        poolRoot:         poolTree.getRoot(),
        registryRoot:     localSMT.root,
        publicAmount:     FIELD_PRIME - amount,
        paramsHash:      await computeTransactParamsHash(legitTransactParams, localHalias),
        inputs:           [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding, amount, pathIndices: alicePoolProof.pathIndices, pathElements: alicePoolProof.pathElements },
          dummyInput(dummyIdx),
        ],
        outputs:          [dummyOutput(), dummyOutput()],
        inputNullifiers:  [nullifier, dummyNullifier(dummyIdx)],
        outputCommitments: [DUMMY_OUT_COMMITMENT, DUMMY_OUT_COMMITMENT],
      });

      const { proof: wp, publicSignals: wps } = await prove(withdrawInput);
      const proofBytes = await encodeProof(wp, wps);

      await expect(
        localHalias.transact(
          { ...ZERO_TRANSACT_PARAMS, poolRoot: ethers.toBeHex(poolTree.getRoot(), 32), registryRoot: ethers.toBeHex(localSMT.root, 32), publicAmount: FIELD_PRIME - amount, inputNullifiers: [ethers.toBeHex(nullifier, 32), ethers.toBeHex(dummyNullifier(dummyIdx), 32)], outputCommitments: [ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)], recipient: attacker.address }, // tampered
          "0x", "0x", proofBytes
        )
      ).to.be.revertedWithCustomError(localHalias, "InvalidProof");
    });
  });

  // ── E2E happy path ────────────────────────────────────────────────

  describe("E2E: deposit → transfer → withdraw", function () {
    it("full lifecycle", async function () {
      const [, recipient] = await ethers.getSigners();
      const alice = generateKeypair();
      const bob   = generateKeypair();
      const poolTree = new MerkleTree(POOL_LEVELS);

      const { key: aliceKey } = await register(alice.pubkey, alice.nullifierKey);
      const { key: bobKey }   = await register(bob.pubkey, bob.nullifierKey);

      let dummyIdx = 200;

      // ── Deposit: Alice → 1 ETH ──────────────────────────────────

      const depositAmount  = ethers.parseEther("1");
      const aliceBlinding  = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const aliceNKHash    = toNullifierKeyHash(alice.nullifierKey);
      const aliceCommitment = createCommitment(alice.pubkey, aliceNKHash, aliceBlinding, depositAmount);

      const depositInput = buildCircuitInput({
        poolRoot:         poolTree.getRoot(),
        registryRoot:     registrySMT.root,
        publicAmount:     depositAmount,
        paramsHash:      await computeTransactParamsHash(ZERO_TRANSACT_PARAMS),
        inputs:           [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
        outputs:          [
          { pubkey: alice.pubkey, nullifierKeyHash: aliceNKHash, dataHash: 0n, aliasHash: aliceKey, blinding: aliceBlinding, amount: depositAmount, registrySiblings: registrySMT.getSiblings(aliceKey) },
          dummyOutput(),
        ],
        inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
        outputCommitments: [aliceCommitment, DUMMY_OUT_COMMITMENT],
      });

      const depositResult = await prove(depositInput);
      expect(await verifyProofLocally(depositResult.proof, depositResult.publicSignals), "deposit proof must verify locally").to.be.true;
      const depositProof  = await encodeProof(depositResult.proof, depositResult.publicSignals);

      const contractBefore = await ethers.provider.getBalance(HALIAS_ADDRESS);
      await halias.transact(
        { ...ZERO_TRANSACT_PARAMS, poolRoot: ethers.toBeHex(poolTree.getRoot(), 32), registryRoot: ethers.toBeHex(registrySMT.root, 32), publicAmount: depositAmount, inputNullifiers: [ethers.toBeHex(dummyNullifier(dummyIdx), 32), ethers.toBeHex(dummyNullifier(dummyIdx + 1), 32)], outputCommitments: [ethers.toBeHex(aliceCommitment, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)] },
        "0x", "0x", depositProof,
        { value: depositAmount }
      );

      dummyIdx += 2;
      poolTree.insert(aliceCommitment);
      poolTree.insert(DUMMY_OUT_COMMITMENT);

      expect(await ethers.provider.getBalance(HALIAS_ADDRESS) - contractBefore).to.equal(depositAmount);
      expect(await halias.spentNullifiers(ethers.toBeHex(dummyNullifier(200), 32))).to.be.true;

      // ── Transfer: Alice → 0.6 ETH to Bob, 0.4 change ───────────

      const sendAmount   = ethers.parseEther("0.6");
      const changeAmount = ethers.parseEther("0.4");

      const alicePoolProof  = poolTree.getProof(0);
      const aliceNullifier  = computeNullifier(alice.nullifierKey, 0);
      const bobBlinding     = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const bobNKHash       = toNullifierKeyHash(bob.nullifierKey);
      const bobCommitment   = createCommitment(bob.pubkey, bobNKHash, bobBlinding, sendAmount);
      const changeBlinding  = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
      const changeCommitment = createCommitment(alice.pubkey, aliceNKHash, changeBlinding, changeAmount);

      const transferInput = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: 0n,
        paramsHash:  await computeTransactParamsHash(ZERO_TRANSACT_PARAMS),
        inputs:  [
          { spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: alice.viewingPrivateKey, blinding: aliceBlinding, amount: depositAmount, pathIndices: alicePoolProof.pathIndices, pathElements: alicePoolProof.pathElements },
          dummyInput(dummyIdx),
        ],
        outputs: [
          { pubkey: bob.pubkey,   nullifierKeyHash: bobNKHash,   dataHash: 0n, aliasHash: bobKey,   blinding: bobBlinding,   amount: sendAmount,   registrySiblings: registrySMT.getSiblings(bobKey) },
          { pubkey: alice.pubkey, nullifierKeyHash: aliceNKHash, dataHash: 0n, aliasHash: aliceKey, blinding: changeBlinding, amount: changeAmount, registrySiblings: registrySMT.getSiblings(aliceKey) },
        ],
        inputNullifiers:   [aliceNullifier, dummyNullifier(dummyIdx)],
        outputCommitments: [bobCommitment, changeCommitment],
      });

      const transferResult = await prove(transferInput);
      const transferProof  = await encodeProof(transferResult.proof, transferResult.publicSignals);

      await halias.transact(
        { ...ZERO_TRANSACT_PARAMS, poolRoot: ethers.toBeHex(poolTree.getRoot(), 32), registryRoot: ethers.toBeHex(registrySMT.root, 32), inputNullifiers: [ethers.toBeHex(aliceNullifier, 32), ethers.toBeHex(dummyNullifier(dummyIdx), 32)], outputCommitments: [ethers.toBeHex(bobCommitment, 32), ethers.toBeHex(changeCommitment, 32)] },
        "0x", "0x", transferProof
      );

      dummyIdx += 1;
      poolTree.insert(bobCommitment);
      poolTree.insert(changeCommitment);

      expect(await halias.spentNullifiers(ethers.toBeHex(aliceNullifier, 32))).to.be.true;

      // ── Withdraw: Bob → 0.6 ETH to recipient ────────────────────

      const bobPoolProof = poolTree.getProof(2);
      const bobNullifier = computeNullifier(bob.nullifierKey, 2);
      const withdrawTransactParams  = { ...ZERO_TRANSACT_PARAMS, recipient: recipient.address };

      const withdrawInput = buildCircuitInput({
        poolRoot:     poolTree.getRoot(),
        registryRoot: registrySMT.root,
        publicAmount: FIELD_PRIME - sendAmount,
        paramsHash:  await computeTransactParamsHash(withdrawTransactParams),
        inputs:  [
          { spendingPrivateKey: bob.spendingPrivateKey, viewingPrivateKey: bob.viewingPrivateKey, blinding: bobBlinding, amount: sendAmount, pathIndices: bobPoolProof.pathIndices, pathElements: bobPoolProof.pathElements },
          dummyInput(dummyIdx),
        ],
        outputs:           [dummyOutput(), dummyOutput()],
        inputNullifiers:   [bobNullifier, dummyNullifier(dummyIdx)],
        outputCommitments: [DUMMY_OUT_COMMITMENT, DUMMY_OUT_COMMITMENT],
      });

      const withdrawResult = await prove(withdrawInput);
      const withdrawProof  = await encodeProof(withdrawResult.proof, withdrawResult.publicSignals);

      const recipientBefore = await ethers.provider.getBalance(recipient.address);
      await halias.transact(
        { ...ZERO_TRANSACT_PARAMS, poolRoot: ethers.toBeHex(poolTree.getRoot(), 32), registryRoot: ethers.toBeHex(registrySMT.root, 32), publicAmount: FIELD_PRIME - sendAmount, inputNullifiers: [ethers.toBeHex(bobNullifier, 32), ethers.toBeHex(dummyNullifier(dummyIdx), 32)], outputCommitments: [ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)], recipient: recipient.address },
        "0x", "0x", withdrawProof
      );

      expect(await ethers.provider.getBalance(recipient.address) - recipientBefore).to.equal(sendAmount);
      expect(await halias.spentNullifiers(ethers.toBeHex(bobNullifier, 32))).to.be.true;
    });
  });
});
