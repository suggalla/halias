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
const POOL_LEVELS = 32;
const REGISTRY_LEVELS = 32;
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Invite claim, end to end, against the REAL Groth16 verifier.
//
// This suite must never be pointed at MockTransactVerifier. The previous voucher tests
// ran on an always-true verifier, which hid the fact that the flow they described could
// not produce a valid proof at all: the circuit enforces registry membership for every
// non-zero output, and the old createVoucher path sent to aliasHash = 0.
//
// The flow under test:
//   1. Inviter registers an UNNAMED account whose keys derive from the invite secret,
//      and funds it with a pool note. (Nothing here is claimer-specific.)
//   2. Claimer derives those keys from the secret and calls registerWithPoolNote, which
//      registers their real name and pays registrationFee out of the note.
//
// Ordering is the subtle part. _doRegister runs BEFORE _transactCore, so the claimer's
// own leaf is in the tree when the proof is checked — the change output is addressed to
// the freshly registered alias, and the circuit demands membership for it. The proof is
// therefore built against the POST-registration root, which the claimer computes locally.
describe("Invite claim (registerWithPoolNote)", function () {
  this.timeout(600000);

  let halias: any;
  let haliasAddress: string;
  let REGISTRATION_FEE: bigint;

  let registrySMT: SMT;
  let poolTree: MerkleTree;
  let dummyIdx = 900;

  let DUMMY_NULLIFIER_KEY: bigint;
  let DUMMY_OUT_PUBKEY: bigint;
  let DUMMY_OUT_COMMITMENT: bigint;

  let inviter: any, claimer: any, relayer: any;

  // ── Helpers (mirrors of the circuit's hashing) ────────────────────

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

  const createCommitment = (pubkey: bigint, nkHash: bigint, blinding: bigint, amount: bigint) =>
    poseidonHash([pubkey, nkHash, blinding, amount, 0n]);

  const computeNullifier = (nullifierKey: bigint, leafIndex: number) =>
    poseidonHash([nullifierKey, BigInt(leafIndex), 1314148940n]); // NULLIFIER_DOMAIN

  function dummyInput(leafIndex: number) {
    return {
      spendingPrivateKey: 1n,
      viewingPrivateKey:  2n,
      blinding:           0n,
      amount:             0n,
      pathIndices:        Array.from({ length: POOL_LEVELS }, (_, i) => (leafIndex >> i) & 1),
      pathElements:       new Array(POOL_LEVELS).fill(0n),
    };
  }

  const dummyNullifier = (leafIndex: number) => computeNullifier(DUMMY_NULLIFIER_KEY, leafIndex);

  const dummyOutput = () => ({
    pubkey: DUMMY_OUT_PUBKEY, nullifierKeyHash: 0n, dataHash: 0n, aliasHash: 0n, registrySlot: 0,
    blinding: 0n, amount: 0n, registrySiblings: new Array(REGISTRY_LEVELS).fill(0n),
  });

  const ZERO_PARAMS = {
    poolRoot:          ethers.ZeroHash,
    registryRoot:      ethers.ZeroHash,
    publicAmount:      0n,
    tokenAddress:      0n,
    inputNullifiers:   [ethers.ZeroHash, ethers.ZeroHash],
    outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
    recipient:         ethers.ZeroAddress,
    externalData:      ethers.ZeroHash,
  };

  // Packs a relayer fee the way Halias._decodeRelayerFee reads it back.
  function packRelayerFee(relayerAddr: string, fee: bigint): string {
    return ethers.toBeHex((BigInt(relayerAddr) << 96n) | fee, 32);
  }

  async function paramsHashFor(p: { recipient?: string; externalData?: string }): Promise<bigint> {
    return BigInt(await halias.computeParamsHash(
      { ...ZERO_PARAMS, recipient: p.recipient ?? ethers.ZeroAddress, externalData: p.externalData ?? ethers.ZeroHash },
      "0x", "0x",
    ));
  }

  function buildCircuitInput(o: any) {
    const s = (v: bigint) => v.toString();
    return {
      poolRoot: s(o.poolRoot), registryRoot: s(o.registryRoot), publicAmount: s(o.publicAmount),
      tokenAddress: "0", paramsHash: s(o.paramsHash),
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

  async function proveAndEncode(input: any): Promise<string> {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, TRANSACT_WASM, TRANSACT_ZKEY);
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [pA, pB, pC] = JSON.parse("[" + calldata + "]");
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"], [pA, pB, pC]);
  }

  // ── Setup ─────────────────────────────────────────────────────────

  before(async function () {
    await initPoseidon();
    [inviter, claimer, relayer] = await ethers.getSigners();
    DUMMY_NULLIFIER_KEY  = poseidonHash([2n]);
    DUMMY_OUT_PUBKEY     = poseidonHash([0n]);
    DUMMY_OUT_COMMITMENT = poseidonHash([DUMMY_OUT_PUBKEY, 0n, 0n, 0n, 0n]);
  });

  beforeEach(async function () {
    const t3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
    const t4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
    const tv = await (await ethers.getContractFactory("TransactVerifier")).deploy();
    halias = await (await ethers.getContractFactory("Halias", {
      libraries: { PoseidonT3: await t3.getAddress(), PoseidonT4: await t4.getAddress() },
    })).deploy(await tv.getAddress(), (await ethers.getSigners())[0].address);
    haliasAddress    = await halias.getAddress();
    REGISTRATION_FEE = await halias.registrationFee();
    registrySMT      = new SMT();
    poolTree         = new MerkleTree(POOL_LEVELS);
  });

  // Registers an alias on-chain (paying the fee in ETH) and mirrors it locally.
  async function registerOnChain(signer: any, pubkey: bigint, nullifierKey: bigint) {
    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    await halias.connect(signer).register(
      aliasHash,
      ethers.toBeHex(pubkey, 32),
      ethers.toBeHex(toNullifierKeyHash(nullifierKey), 32),
      ethers.keccak256(ethers.randomBytes(32)), "",
      { value: REGISTRATION_FEE },
    );
    const key  = aliasHashToKey(aliasHash);
    const slot = Number(await halias.aliasSlot(aliasHash)) - 1;
    registrySMT.update(slot, key, registryLeaf(pubkey, nullifierKey));
    return { aliasHash, key, slot };
  }

  // Step 1 of the invite: inviter registers the unnamed account and funds it.
  // Returns everything the claimer would derive from the invite secret.
  async function createInvite(noteAmount: bigint) {
    const temp = generateKeypair();
    const { key: tempKey, slot: tempSlot } = await registerOnChain(inviter, temp.pubkey, temp.nullifierKey);

    const blinding   = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    const nkHash     = toNullifierKeyHash(temp.nullifierKey);
    const commitment = createCommitment(temp.pubkey, nkHash, blinding, noteAmount);

    const proofBytes = await proveAndEncode(buildCircuitInput({
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: noteAmount, paramsHash: await paramsHashFor({}),
      inputs: [dummyInput(dummyIdx), dummyInput(dummyIdx + 1)],
      outputs: [
        { pubkey: temp.pubkey, nullifierKeyHash: nkHash, dataHash: 0n, aliasHash: tempKey, registrySlot: tempSlot,
          blinding, amount: noteAmount, registrySiblings: registrySMT.getSiblings(tempSlot) },
        dummyOutput(),
      ],
      inputNullifiers:   [dummyNullifier(dummyIdx), dummyNullifier(dummyIdx + 1)],
      outputCommitments: [commitment, DUMMY_OUT_COMMITMENT],
    }));

    await halias.connect(inviter).transact(
      { ...ZERO_PARAMS,
        poolRoot: ethers.toBeHex(poolTree.getRoot(), 32),
        registryRoot: ethers.toBeHex(registrySMT.root, 32),
        publicAmount: noteAmount,
        inputNullifiers: [ethers.toBeHex(dummyNullifier(dummyIdx), 32), ethers.toBeHex(dummyNullifier(dummyIdx + 1), 32)],
        outputCommitments: [ethers.toBeHex(commitment, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)],
      },
      "0x", "0x", proofBytes, { value: noteAmount },
    );
    dummyIdx += 2;

    const leafIndex = poolTree.insert(commitment);
    poolTree.insert(DUMMY_OUT_COMMITMENT);
    return { temp, blinding, noteAmount, leafIndex: leafIndex ?? 0, tempSlot };
  }

  // Step 2: the claimer registers their own name, paying the fee from the note.
  // relayerFee > 0 means a third party broadcasts and is reimbursed from the note.
  async function claim(invite: any, opts: { relayerFee?: bigint; submitter?: any; relayerAddr?: string } = {}) {
    const relayerFee  = opts.relayerFee ?? 0n;
    const submitter   = opts.submitter ?? claimer;
    const relayerAddr = opts.relayerAddr ?? relayer.address;
    const own         = generateKeypair();

    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    const ownKey    = aliasHashToKey(aliasHash);
    const ownNKHash = toNullifierKeyHash(own.nullifierKey);

    // The proof must see the tree AFTER this registration, because the change output is
    // addressed to it. registerWithPoolNote registers before it verifies, so the slot the
    // contract is about to hand out is the one this proof must use.
    const ownSlot = Number(await halias.nextAliasSlot());
    const postSMT = registrySMT.clone();
    postSMT.update(ownSlot, ownKey, registryLeaf(own.pubkey, own.nullifierKey));

    const absAmount   = REGISTRATION_FEE + relayerFee;
    const changeAmt   = invite.noteAmount - absAmount;
    const changeBlind = BigInt("0x" + crypto.randomBytes(31).toString("hex"));
    const changeComm  = createCommitment(own.pubkey, ownNKHash, changeBlind, changeAmt);

    const externalData = relayerFee > 0n ? packRelayerFee(relayerAddr, relayerFee) : ethers.ZeroHash;
    const poolProof    = poolTree.getProof(invite.leafIndex);

    const changeOut = changeAmt > 0n
      ? { pubkey: own.pubkey, nullifierKeyHash: ownNKHash, dataHash: 0n, aliasHash: ownKey, registrySlot: ownSlot,
          blinding: changeBlind, amount: changeAmt, registrySiblings: postSMT.getSiblings(ownSlot) }
      : dummyOutput();
    const changeCommitment = changeAmt > 0n ? changeComm : DUMMY_OUT_COMMITMENT;

    const nullifier = computeNullifier(invite.temp.nullifierKey, invite.leafIndex);

    const proofBytes = await proveAndEncode(buildCircuitInput({
      poolRoot: poolTree.getRoot(), registryRoot: postSMT.root,
      publicAmount: FIELD_PRIME - absAmount,
      paramsHash: await paramsHashFor({ recipient: haliasAddress, externalData }),
      inputs: [
        { spendingPrivateKey: invite.temp.spendingPrivateKey, viewingPrivateKey: invite.temp.viewingPrivateKey,
          blinding: invite.blinding, amount: invite.noteAmount,
          pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
        dummyInput(dummyIdx),
      ],
      outputs: [changeOut, dummyOutput()],
      inputNullifiers:   [nullifier, dummyNullifier(dummyIdx)],
      outputCommitments: [changeCommitment, DUMMY_OUT_COMMITMENT],
    }));

    const params = { ...ZERO_PARAMS,
      poolRoot: ethers.toBeHex(poolTree.getRoot(), 32),
      registryRoot: ethers.toBeHex(postSMT.root, 32),
      publicAmount: FIELD_PRIME - absAmount,
      inputNullifiers: [ethers.toBeHex(nullifier, 32), ethers.toBeHex(dummyNullifier(dummyIdx), 32)],
      outputCommitments: [ethers.toBeHex(changeCommitment, 32), ethers.toBeHex(DUMMY_OUT_COMMITMENT, 32)],
      recipient: haliasAddress,
      externalData,
    };
    dummyIdx += 2;

    const tx = halias.connect(submitter).registerWithPoolNote(
      params, "0x", "0x", proofBytes,
      aliasHash,
      ethers.toBeHex(own.pubkey, 32),
      ethers.toBeHex(ownNKHash, 32),
      ethers.keccak256(ethers.randomBytes(32)),
      "",
    );
    return { tx, aliasHash, own, ownKey, nullifier, postSMT, changeAmt, params, proofBytes };
  }

  // ── Happy paths ───────────────────────────────────────────────────

  it("claimer registers a name paying the fee from the invite note", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const before = await halias.accumulatedFees();

    const { tx, aliasHash, own } = await claim(invite);
    await (await tx).wait();

    expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(claimer.address);
    expect(await halias.accumulatedFees()).to.equal(before + REGISTRATION_FEE);

    const stored = await halias.aliases(aliasHash);
    expect(BigInt(stored.spendingPubkey)).to.equal(own.pubkey);
  });

  it("pays a relayer out of the note so the claimer never needs ETH", async function () {
    const invite     = await createInvite(ethers.parseEther("0.05"));
    const relayerFee = ethers.parseEther("0.001");
    const beforeFees = await halias.accumulatedFees();
    const beforeBal  = await ethers.provider.getBalance(relayer.address);

    // Submitted by the inviter, standing in for any third party: the claimer signs
    // nothing on-chain and spends no gas.
    const { tx, aliasHash } = await claim(invite, { relayerFee, submitter: inviter });
    await expect(tx).to.emit(halias, "RelayerPaid").withArgs(relayer.address, relayerFee);

    expect(await ethers.provider.getBalance(relayer.address)).to.equal(beforeBal + relayerFee);
    expect(await halias.accumulatedFees()).to.equal(beforeFees + REGISTRATION_FEE);
    expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(inviter.address);
  });

  it("marks the invite note's nullifier spent", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const { tx, nullifier } = await claim(invite);
    await (await tx).wait();
    expect(await halias.spentNullifiers(ethers.toBeHex(nullifier, 32))).to.equal(true);
  });

  it("leaves pool ETH exactly equal to the change note", async function () {
    const noteAmount = ethers.parseEther("0.05");
    const invite     = await createInvite(noteAmount);
    const { tx, changeAmt } = await claim(invite, { relayerFee: ethers.parseEther("0.001") });
    await (await tx).wait();

    // Contract holds: change still shielded + fees booked. The rest left as relayer pay.
    const bal = await ethers.provider.getBalance(haliasAddress);
    expect(bal).to.equal(changeAmt + (await halias.accumulatedFees()));
  });

  // ── Boundary: zero and exact values ───────────────────────────────

  it("accepts a note worth exactly the registration fee (zero change)", async function () {
    const invite = await createInvite(REGISTRATION_FEE);
    const { tx, aliasHash, changeAmt } = await claim(invite);
    expect(changeAmt).to.equal(0n);
    await (await tx).wait();
    expect(await halias.ownerOf(BigInt(aliasHash))).to.equal(claimer.address);
  });

  it("accepts relayerFee = 0 written as an explicit zero externalData", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const { tx } = await claim(invite, { relayerFee: 0n });
    await (await tx).wait();
    expect(await halias.accumulatedFees()).to.be.gt(0n);
  });

  // ── Rejections ────────────────────────────────────────────────────

  it("rejects a note that does not equal registrationFee + relayerFee", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const { params, proofBytes, aliasHash, own } = await claim(invite, { relayerFee: ethers.parseEther("0.001") });

    // Same proof, but claim a smaller fee than the note pays out.
    const tampered = { ...params, externalData: packRelayerFee(relayer.address, ethers.parseEther("0.0005")) };
    await expect(
      halias.connect(claimer).registerWithPoolNote(
        tampered, "0x", "0x", proofBytes, aliasHash,
        ethers.toBeHex(own.pubkey, 32),
        ethers.toBeHex(toNullifierKeyHash(own.nullifierKey), 32),
        ethers.keccak256(ethers.randomBytes(32)),
        "",
      ),
    ).to.be.revertedWithCustomError(halias, "PoolNoteWrongFee");
  });

  it("rejects a relayer fee naming the pool itself", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const { params, proofBytes, aliasHash, own } = await claim(invite, { relayerFee: ethers.parseEther("0.001") });
    const tampered = { ...params, externalData: packRelayerFee(haliasAddress, ethers.parseEther("0.001")) };
    await expect(
      halias.connect(claimer).registerWithPoolNote(
        tampered, "0x", "0x", proofBytes, aliasHash,
        ethers.toBeHex(own.pubkey, 32),
        ethers.toBeHex(toNullifierKeyHash(own.nullifierKey), 32),
        ethers.keccak256(ethers.randomBytes(32)),
        "",
      ),
    ).to.be.revertedWithCustomError(halias, "RelayerCannotBePool");
  });

  it("rejects a relayer fee with a zero relayer address", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const { params, proofBytes, aliasHash, own } = await claim(invite, { relayerFee: ethers.parseEther("0.001") });
    const tampered = { ...params, externalData: packRelayerFee(ethers.ZeroAddress, ethers.parseEther("0.001")) };
    await expect(
      halias.connect(claimer).registerWithPoolNote(
        tampered, "0x", "0x", proofBytes, aliasHash,
        ethers.toBeHex(own.pubkey, 32),
        ethers.toBeHex(toNullifierKeyHash(own.nullifierKey), 32),
        ethers.keccak256(ethers.randomBytes(32)),
        "",
      ),
    ).to.be.revertedWithCustomError(halias, "NoDestination");
  });

  it("rejects a claim whose proof was built against the PRE-registration root", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const own    = generateKeypair();
    const aliasHash = ethers.keccak256(ethers.randomBytes(32));
    const ownKey    = aliasHashToKey(aliasHash);
    const ownSlot   = Number(await halias.nextAliasSlot());
    const ownNKHash = toNullifierKeyHash(own.nullifierKey);

    const absAmount = REGISTRATION_FEE;
    const changeAmt = invite.noteAmount - absAmount;
    const blind     = 0x1234n;
    const comm      = createCommitment(own.pubkey, ownNKHash, blind, changeAmt);
    const poolProof = poolTree.getProof(invite.leafIndex);
    const nullifier = computeNullifier(invite.temp.nullifierKey, invite.leafIndex);

    // Deliberately proves against the CURRENT root, which does not yet contain the
    // claimer's leaf — the exact mistake the register-before-transact ordering exists
    // to make impossible. The change output cannot prove membership, so witness
    // generation fails before a proof is ever produced.
    await expect(proveAndEncode(buildCircuitInput({
      poolRoot: poolTree.getRoot(), registryRoot: registrySMT.root,
      publicAmount: FIELD_PRIME - absAmount,
      paramsHash: await paramsHashFor({ recipient: haliasAddress }),
      inputs: [
        { spendingPrivateKey: invite.temp.spendingPrivateKey, viewingPrivateKey: invite.temp.viewingPrivateKey,
          blinding: invite.blinding, amount: invite.noteAmount,
          pathIndices: poolProof.pathIndices, pathElements: poolProof.pathElements },
        dummyInput(dummyIdx),
      ],
      outputs: [
        { pubkey: own.pubkey, nullifierKeyHash: ownNKHash, dataHash: 0n, aliasHash: ownKey, registrySlot: ownSlot,
          blinding: blind, amount: changeAmt, registrySiblings: registrySMT.getSiblings(ownSlot) },
        dummyOutput(),
      ],
      inputNullifiers:   [nullifier, dummyNullifier(dummyIdx)],
      outputCommitments: [comm, DUMMY_OUT_COMMITMENT],
    }))).to.be.rejected;
  });

  it("rejects a deposit (non-withdrawal) publicAmount", async function () {
    await expect(
      halias.connect(claimer).registerWithPoolNote(
        { ...ZERO_PARAMS, publicAmount: ethers.parseEther("1"), recipient: haliasAddress },
        "0x", "0x", "0x",
        ethers.keccak256(ethers.randomBytes(32)),
        ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), ethers.keccak256(ethers.randomBytes(32)), "",
      ),
    ).to.be.revertedWithCustomError(halias, "NotAWithdrawal");
  });

  it("rejects an ERC-20 pool note", async function () {
    await expect(
      halias.connect(claimer).registerWithPoolNote(
        { ...ZERO_PARAMS, tokenAddress: 1n, publicAmount: FIELD_PRIME - REGISTRATION_FEE, recipient: haliasAddress },
        "0x", "0x", "0x",
        ethers.keccak256(ethers.randomBytes(32)),
        ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), ethers.keccak256(ethers.randomBytes(32)), "",
      ),
    ).to.be.revertedWithCustomError(halias, "PoolNoteMustBeETH");
  });

  it("rejects a recipient other than the pool", async function () {
    await expect(
      halias.connect(claimer).registerWithPoolNote(
        { ...ZERO_PARAMS, publicAmount: FIELD_PRIME - REGISTRATION_FEE, recipient: claimer.address },
        "0x", "0x", "0x",
        ethers.keccak256(ethers.randomBytes(32)),
        ethers.toBeHex(1n, 32), ethers.toBeHex(2n, 32), ethers.keccak256(ethers.randomBytes(32)), "",
      ),
    ).to.be.revertedWithCustomError(halias, "MustWithdrawToSelf");
  });

  it("rejects double-claiming the same invite note", async function () {
    const invite = await createInvite(ethers.parseEther("0.05"));
    const first  = await claim(invite);
    await (await first.tx).wait();

    registrySMT = first.postSMT;
    const second = await claim(invite);
    await expect(second.tx).to.be.revertedWithCustomError(halias, "Input0AlreadySpent");
  });
});
