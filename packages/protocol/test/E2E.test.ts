import { expect } from "chai";
import { ethers } from "hardhat";
import { registerAlias as commitAndRegister } from "./helpers/register";
import * as path from "path";
import { initPoseidon, poseidonHash } from "./helpers/poseidon";
import { MerkleTree } from "./helpers/merkleTree";
import { SMT, aliasHashToKey } from "./helpers/smt";
import { ensurePoseidon } from "../scripts/poseidon";
import { anchorOf } from "./helpers/anchor";
import { nullifierFor as nullifierOf, POOL_LEVELS } from "./helpers/nullifier";
import { FIELD_PRIME } from "./helpers/field";

const snarkjs = require("snarkjs");

const TRANSACT_WASM = path.resolve(__dirname, "../circuits/out/transact/transact_js/transact.wasm");
const TRANSACT_ZKEY = path.resolve(__dirname, "../circuits/out/transact/ceremony/transact_final.zkey");

// The split, against the real Groth16 verifier.
//
// Every other test of the new contracts uses MockTransactVerifier, which accepts anything.
// That is fine for checking where value goes, and useless for the question this file
// exists to answer: does the circuit still verify against the contracts after they were
// taken apart? Nothing about `paramsHash` produces a legible failure when it is wrong —
// the proof simply does not verify — so this is the only place a preimage or public-signal
// mistake surfaces.
//
// It is also the only real-proof coverage in the repo. Every other suite runs against
// MockTransactVerifier, which accepts anything — so a circuit that stopped agreeing with the
// contracts would be invisible everywhere but here.
// Every note in these tests lives in tree 0, which is what makes the multi-tree cases in
// PoolRollover worth testing separately.
const nullifierFor = (nullifierKey: bigint, leafIndex: number, treeNumber = 0) =>
  nullifierOf(nullifierKey, leafIndex, treeNumber);

describe("E2E against the real verifier", function () {
  this.timeout(600000);

  let pool: any, registry: any, domain: any;
  let poolAddr: string;
  let user: any, recipient: any, relayer: any;

  // Local mirrors of the on-chain trees, kept in step so proofs can be built.
  let tree: MerkleTree;
  let smt: SMT;

  // Shared across the sequence below. These tests are deliberately ordered — a deposit has
  // to exist before it can be transferred — so the state lives here rather than being
  // rebuilt per test, which would cost a fresh proof each time.
  let alice: any, bob: any;
  let aliceNote: any, aliceLeafIndex: number;
  const DEPOSIT = ethers.parseEther("1");

  // The circuit derives nullifierKey = Poseidon(viewingPrivateKey), and the registry
  // stores nullifierKeyHash = Poseidon(nullifierKey, 1). Storing Poseidon(key) instead
  // fails the input constraint with nothing but an assert number to go on.
  // Assigned in before(), not here: Poseidon is not initialised while the describe body
  // is being evaluated.
  const VIEWING_KEY = 3n;
  let NULLIFIER_KEY: bigint;
  const DUMMY_NK = () => poseidonHash([NULLIFIER_KEY, 1n]);
  const rand = () => BigInt(ethers.hexlify(ethers.randomBytes(31)));

  const params = (over: any = {}) => ({
    poolRoot: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], treeNumber: [0, 0, 0, 0], registryRoot: ethers.ZeroHash,
    publicAmount: 0n, tokenAddress: ethers.ZeroAddress,
    inputNullifiers: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
    outputCommitments: [ethers.ZeroHash, ethers.ZeroHash],
    recipient: ethers.ZeroAddress,
    relayerFee: { relayer: ethers.ZeroAddress, amount: 0n },
    externalData: ethers.ZeroHash,
    pendingLeaf:       ethers.ZeroHash,
      outputsEmpty:      false,
    ...over,
  });

  function circuitInput(o: any) {
    const s = (v: bigint) => v.toString();
    return {
      poolRoot: [s(o.poolRoot), s(o.poolRoot), s(o.poolRoot), s(o.poolRoot)],
      // Both inputs anchored on one tree; a test that needs two spans them explicitly.
      treeNumber: [String(o.treeNumber ?? 0), String(o.treeNumber ?? 0), String(o.treeNumber ?? 0), String(o.treeNumber ?? 0)],
      registryRoot: s(o.registryRoot), publicAmount: s(o.publicAmount),
      tokenAddress: "0", paramsHash: s(o.paramsHash),
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
      outSpendingCommitment:            o.outputs.map((x: any) => s(x.spendingCommitment)),
      outBlinding:          o.outputs.map((x: any) => s(x.blinding)),
      outAmount:            o.outputs.map((x: any) => s(x.amount)),
      outNullifierKeyHash:  o.outputs.map((x: any) => s(x.nullifierKeyHash)),
      outDataHash:          o.outputs.map((x: any) => s(x.dataHash)),
      outAliasHash:         o.outputs.map((x: any) => s(x.aliasHash)),
      outRegistryIndex:     o.outputs.map((x: any) => String(x.registrySlot ?? 0)),
      outRegistrySiblings:  o.outputs.map((x: any) => x.registrySiblings.map(s)),
    };
  }

  async function prove(input: any): Promise<string> {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, TRANSACT_WASM, TRANSACT_ZKEY);
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [pA, pB, pC] = JSON.parse("[" + calldata + "]");
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"], [pA, pB, pC]);
  }

  // A zero-value input, used to fill the second slot when only one real note is spent.
  //
  // The membership check is skipped for a zero amount, so the path can be anything — but
  // the NULLIFIER still is not. The circuit derives it from the key and the leaf index and
  // constrains it against the public signal, so a random one fails witness generation.
  // Uniqueness comes from the freshly random keys, not from the index — which is just as
  // well, because with 16-level trees an index only has 16 bits and the circuit packs it from
  // pathIndices. A high sentinel would silently truncate and the nullifier would disagree.
  function dummyInput(idx: number) {
    const finalIdx = idx % (1 << POOL_LEVELS);
    const spendingPrivateKey = rand();
    const viewingPrivateKey  = rand();
    const nullifierKey = poseidonHash([viewingPrivateKey]);
    return {
      input: {
        spendingPrivateKey, viewingPrivateKey, blinding: 0n, amount: 0n,
        pathIndices: Array.from({ length: POOL_LEVELS }, (_, i) => (finalIdx >> i) & 1),
        pathElements: new Array(POOL_LEVELS).fill(0n),
      },
      nullifier: nullifierFor(nullifierKey, finalIdx),
    };
  }

  function dummyOutput() {
    const spendingCommitment = poseidonHash([0n]);
    return {
      spendingCommitment, nullifierKeyHash: 0n, blinding: 0n, amount: 0n, dataHash: 0n,
      aliasHash: 0n, registrySlot: 0, registrySiblings: new Array(32).fill(0n),
    };
  }

  before(async function () {
    await initPoseidon();
    NULLIFIER_KEY = poseidonHash([VIEWING_KEY]);
    [user, recipient, relayer] = await ethers.getSigners();

    const { PoseidonT3: t3, PoseidonT4: t4 } = await ensurePoseidon();
    // The real verifier. If this is ever swapped for the mock, the file stops testing
    // anything it was written for.
    const verifier = await (await (await ethers.getContractFactory("TransactVerifier")).deploy()).getAddress();

    const deployer = await (await ethers.getContractFactory("HaliasDeployer", {
      libraries: { PoseidonT3: t3, PoseidonT4: t4 },
    })).deploy(verifier, verifier, user.address);

    pool     = await ethers.getContractAt("HaliasPool",     await deployer.pool());
    registry = await ethers.getContractAt("HaliasRegistry", await deployer.registry());
    domain   = await ethers.getContractAt("HaliasController",   await deployer.controller());
    poolAddr = await pool.getAddress();

    tree = new MerkleTree(POOL_LEVELS);
    smt  = new SMT();

    alice = await registerAlias("alice.hls", rand());
    bob   = await registerAlias("bob.hls", rand());
  });

  // Registers an alias through the domain and mirrors it into the local SMT.
  async function registerAlias(name: string, spendingPrivateKey: bigint) {
    const aliasHash = ethers.keccak256(ethers.toUtf8Bytes(name));
    const spendingCommitment = poseidonHash([spendingPrivateKey]);
    const nkHash = DUMMY_NK();
    const enc = ethers.keccak256(ethers.randomBytes(32));

    await (await commitAndRegister(
      domain, (await ethers.getSigners())[0],
      name, ethers.toBeHex(spendingCommitment, 32), ethers.toBeHex(nkHash, 32), enc,
      await domain.registrationFee(),
    )).wait();

    const slot = Number(await registry.aliasSlot(aliasHash)) - 1;
    smt.update(slot, aliasHashToKey(aliasHash), poseidonHash([spendingCommitment, nkHash, 0n]));
    expect(BigInt(await registry.getRegistryRoot())).to.equal(smt.root);

    return { aliasHash: aliasHashToKey(aliasHash), spendingCommitment, nkHash, slot, spendingPrivateKey };
  }

  function noteFor(a: any, amount: bigint) {
    const blinding = rand();
    const commitment = poseidonHash([a.spendingCommitment, a.nkHash, blinding, amount, 0n]);
    return {
      spendingCommitment: a.spendingCommitment, nullifierKeyHash: a.nkHash, blinding, amount, dataHash: 0n,
      aliasHash: a.aliasHash, registrySlot: a.slot,
      registrySiblings: smt.getSiblings(a.slot), commitment,
    };
  }

  it("registered two aliases and tracks the registry root", async function () {
    expect(await registry.isRegistered(ethers.keccak256(ethers.toUtf8Bytes("alice.hls")))).to.equal(true);
    expect(await registry.isRegistered(ethers.keccak256(ethers.toUtf8Bytes("bob.hls")))).to.equal(true);
    expect(BigInt(await registry.getRegistryRoot())).to.equal(smt.root);
  });

  it("deposits with a real proof", async function () {
    const out0 = noteFor(alice, DEPOSIT);
    const out1 = dummyOutput();
    const comm1 = poseidonHash([out1.spendingCommitment, 0n, 0n, 0n, 0n]);

    const d0 = dummyInput(0), d1 = dummyInput(1), d0p = dummyInput(0+900), d1p = dummyInput(1+900);
    const p = params({
      poolRoot: [ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32)], treeNumber: [0, 0, 0, 0],
      registryRoot: ethers.toBeHex(smt.root, 32),
      publicAmount: DEPOSIT,
      inputNullifiers: [ethers.toBeHex(d0.nullifier, 32), ethers.toBeHex(d1.nullifier, 32), ethers.toBeHex(d0p.nullifier, 32), ethers.toBeHex(d1p.nullifier, 32)],
      outputCommitments: [ethers.toBeHex(out0.commitment, 32), ethers.toBeHex(comm1, 32)],
    });
    const paramsHash = BigInt(await pool.computeParamsHash(p, "0x", "0x"));

    const proof = await prove(circuitInput({
      poolRoot: tree.getRoot(), registryRoot: smt.root, publicAmount: DEPOSIT, paramsHash,
      inputNullifiers: [BigInt(p.inputNullifiers[0]), BigInt(p.inputNullifiers[1]), BigInt(p.inputNullifiers[2]), BigInt(p.inputNullifiers[3])],
      outputCommitments: [out0.commitment, comm1],
      inputs: [d0.input, d1.input, d0p.input, d1p.input],
      outputs: [out0, out1],
    }));

    await (await pool.transact(p, "0x", "0x", proof, { value: DEPOSIT })).wait();

    aliceLeafIndex = tree.leaves.length;
    tree.insert(out0.commitment);
    tree.insert(comm1);
    aliceNote = out0;

    expect(await ethers.provider.getBalance(poolAddr)).to.equal(DEPOSIT);
    expect(BigInt((await anchorOf(pool)).root)).to.equal(tree.getRoot());
  });

  it("transfers privately to another alias with a real proof", async function () {
    // publicAmount == 0: no value enters or leaves, the whole movement is in the outputs.
    const send = ethers.parseEther("0.4");
    const toBob   = noteFor(bob, send);
    const change  = noteFor(alice, aliceNote.amount - send);

    const inProof = tree.getProof(aliceLeafIndex);
    const nullifier = nullifierFor(NULLIFIER_KEY, aliceLeafIndex);
    const dNull = dummyInput(1), dNulla = dummyInput(1+700), dNullb = dummyInput(1+800);

    const p = params({
      poolRoot: [ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32)], treeNumber: [0, 0, 0, 0],
      registryRoot: ethers.toBeHex(smt.root, 32),
      publicAmount: 0n,
      inputNullifiers: [ethers.toBeHex(nullifier, 32), ethers.toBeHex(dNull.nullifier, 32), ethers.toBeHex(dNulla.nullifier, 32), ethers.toBeHex(dNullb.nullifier, 32)],
      outputCommitments: [ethers.toBeHex(toBob.commitment, 32), ethers.toBeHex(change.commitment, 32)],
    });
    const paramsHash = BigInt(await pool.computeParamsHash(p, "0x", "0x"));

    const proof = await prove(circuitInput({
      poolRoot: tree.getRoot(), registryRoot: smt.root, publicAmount: 0n, paramsHash,
      inputNullifiers: [nullifier, BigInt(p.inputNullifiers[1]), BigInt(p.inputNullifiers[2]), BigInt(p.inputNullifiers[3])],
      outputCommitments: [toBob.commitment, change.commitment],
      inputs: [{
        spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: VIEWING_KEY,
        blinding: aliceNote.blinding, amount: aliceNote.amount,
        pathIndices: inProof.pathIndices, pathElements: inProof.pathElements,
      }, dNull.input, dNulla.input, dNullb.input],
      outputs: [toBob, change],
    }));

    await (await pool.transact(p, "0x", "0x", proof)).wait();

    tree.insert(toBob.commitment);
    aliceLeafIndex = tree.leaves.length;
    tree.insert(change.commitment);
    aliceNote = change;

    // Value never left the pool.
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(DEPOSIT);
    expect(await pool.spentNullifiers(ethers.toBeHex(nullifier, 32))).to.equal(true);
  });

  it("exits with a real proof, inserting nothing and leaving the root alone", async function () {
    // The uniform path above is a full withdrawal that still inserts two zero-amount dummy
    // commitments. This is the same shape with the exit flag set, which is what the circuit's
    // one-way constraint makes optional rather than forced.
    //
    // Worth doing against the real verifier specifically: an index mix-up between pendingLeaf
    // and outputsEmpty would be invisible in the ordering test, where both are zero.
    const fresh = noteFor(alice, ethers.parseEther("0.2"));
    const fillIn = dummyOutput();
    const fillComm = poseidonHash([fillIn.spendingCommitment, 0n, 0n, 0n, 0n]);
    const dA = dummyInput(7), dB = dummyInput(8), dAp = dummyInput(7+900), dBp = dummyInput(8+900);

    // Fund a note to exit.
    const dp = params({
      poolRoot: [ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32)], treeNumber: [0, 0, 0, 0],
      registryRoot: ethers.toBeHex(smt.root, 32),
      publicAmount: ethers.parseEther("0.2"),
      inputNullifiers: [ethers.toBeHex(dA.nullifier, 32), ethers.toBeHex(dB.nullifier, 32), ethers.toBeHex(dAp.nullifier, 32), ethers.toBeHex(dBp.nullifier, 32)],
      outputCommitments: [ethers.toBeHex(fresh.commitment, 32), ethers.toBeHex(fillComm, 32)],
    });
    const dHash = BigInt(await pool.computeParamsHash(dp, "0x", "0x"));
    const dProof = await prove(circuitInput({
      poolRoot: tree.getRoot(), registryRoot: smt.root,
      publicAmount: ethers.parseEther("0.2"), paramsHash: dHash,
      inputNullifiers: [BigInt(dp.inputNullifiers[0]), BigInt(dp.inputNullifiers[1]), BigInt(dp.inputNullifiers[2]), BigInt(dp.inputNullifiers[3])],
      outputCommitments: [fresh.commitment, fillComm],
      inputs: [dA.input, dB.input, dAp.input, dBp.input],
      outputs: [fresh, fillIn],
    }));
    await (await pool.transact(dp, "0x", "0x", dProof, { value: ethers.parseEther("0.2") })).wait();
    const freshIndex = tree.leaves.length;
    tree.insert(fresh.commitment);
    tree.insert(fillComm);

    // Now take all of it out, creating nothing.
    const inProof = tree.getProof(freshIndex);
    const nullifier = nullifierFor(NULLIFIER_KEY, freshIndex);
    const dC = dummyInput(9), dCa = dummyInput(9+700), dCb = dummyInput(9+800);
    const e0 = dummyOutput(), e1 = dummyOutput();
    const ec0 = poseidonHash([e0.spendingCommitment, 0n, 0n, 0n, 0n]);
    e1.blinding = 1n;
    const ec1 = poseidonHash([e1.spendingCommitment, 0n, 1n, 0n, 0n]);

    const ep = params({
      poolRoot: [ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32)], treeNumber: [0, 0, 0, 0],
      registryRoot: ethers.toBeHex(smt.root, 32),
      publicAmount: FIELD_PRIME - ethers.parseEther("0.2"),
      inputNullifiers: [ethers.toBeHex(nullifier, 32), ethers.toBeHex(dC.nullifier, 32), ethers.toBeHex(dCa.nullifier, 32), ethers.toBeHex(dCb.nullifier, 32)],
      outputCommitments: [ethers.toBeHex(ec0, 32), ethers.toBeHex(ec1, 32)],
      recipient: recipient.address,
      outputsEmpty: true,
    });
    const eHash = BigInt(await pool.computeParamsHash(ep, "0x", "0x"));
    const eProof = await prove(circuitInput({
      poolRoot: tree.getRoot(), registryRoot: smt.root,
      publicAmount: FIELD_PRIME - ethers.parseEther("0.2"), paramsHash: eHash,
      inputNullifiers: [nullifier, BigInt(ep.inputNullifiers[1]), BigInt(ep.inputNullifiers[2]), BigInt(ep.inputNullifiers[3])],
      outputCommitments: [ec0, ec1],
      inputs: [{
        spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: VIEWING_KEY,
        blinding: fresh.blinding, amount: fresh.amount,
        pathIndices: inProof.pathIndices, pathElements: inProof.pathElements,
      }, dC.input, dCa.input, dCb.input],
      outputs: [e0, e1],
      outputsEmpty: true,
    }));

    const rootBefore = (await anchorOf(pool)).root;
    const idxBefore  = (await pool.position()).leaf;
    const before     = await ethers.provider.getBalance(recipient.address);

    await expect(pool.transact(ep, "0x", "0x", eProof)).to.emit(pool, "PoolExit");

    expect((await anchorOf(pool)).root).to.equal(rootBefore);   // tree did not move
    expect((await pool.position()).leaf).to.equal(idxBefore);
    expect(await ethers.provider.getBalance(recipient.address) - before)
      .to.equal(ethers.parseEther("0.2"));
    expect(await pool.spentNullifiers(ep.inputNullifiers[0])).to.equal(true);
  });

  it("withdraws with a relayer fee, paying both destinations from one proof", async function () {
    // The path that changed most in the split: the fee is a struct now, it is committed
    // inside paramsHash, and the pool settles relayer and recipient itself.
    const out = aliceNote.amount;
    const fee = ethers.parseEther("0.01");

    const inProof = tree.getProof(aliceLeafIndex);
    const nullifier = nullifierFor(NULLIFIER_KEY, aliceLeafIndex);
    const dNull2 = dummyInput(2), dNull2a = dummyInput(2+700), dNull2b = dummyInput(2+800);
    const d0 = dummyOutput(), d1 = dummyOutput();
    const c0 = poseidonHash([d0.spendingCommitment, 0n, 0n, 0n, 0n]);
    const c1 = poseidonHash([d1.spendingCommitment, 0n, 1n, 0n, 0n]);
    d1.blinding = 1n;

    const p = params({
      poolRoot: [ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32)], treeNumber: [0, 0, 0, 0],
      registryRoot: ethers.toBeHex(smt.root, 32),
      publicAmount: FIELD_PRIME - out,
      inputNullifiers: [ethers.toBeHex(nullifier, 32), ethers.toBeHex(dNull2.nullifier, 32), ethers.toBeHex(dNull2a.nullifier, 32), ethers.toBeHex(dNull2b.nullifier, 32)],
      outputCommitments: [ethers.toBeHex(c0, 32), ethers.toBeHex(c1, 32)],
      recipient: recipient.address,
      relayerFee: { relayer: relayer.address, amount: fee },
    });
    const paramsHash = BigInt(await pool.computeParamsHash(p, "0x", "0x"));

    const proof = await prove(circuitInput({
      poolRoot: tree.getRoot(), registryRoot: smt.root,
      publicAmount: FIELD_PRIME - out, paramsHash,
      inputNullifiers: [nullifier, BigInt(p.inputNullifiers[1]), BigInt(p.inputNullifiers[2]), BigInt(p.inputNullifiers[3])],
      outputCommitments: [c0, c1],
      inputs: [{
        spendingPrivateKey: alice.spendingPrivateKey, viewingPrivateKey: VIEWING_KEY,
        blinding: aliceNote.blinding, amount: aliceNote.amount,
        pathIndices: inProof.pathIndices, pathElements: inProof.pathElements,
      }, dNull2.input, dNull2a.input, dNull2b.input],
      outputs: [d0, d1],
    }));

    const relayerBefore   = await ethers.provider.getBalance(relayer.address);
    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await expect(pool.transact(p, "0x", "0x", proof))
      .to.emit(pool, "Withdrawal")
      .withArgs(recipient.address, out - fee, relayer.address, fee, 0n);

    expect(await ethers.provider.getBalance(relayer.address) - relayerBefore).to.equal(fee);
    expect(await ethers.provider.getBalance(recipient.address) - recipientBefore).to.equal(out - fee);
  });

  it("rejects a proof whose paramsHash was built for different parameters", async function () {
    // The failure mode this whole file exists to catch. Everything is valid except that
    // the recipient changed after the proof was made, so paramsHash no longer matches.
    const amount = ethers.parseEther("0.5");
    const out0 = noteFor(alice, amount);
    const d0 = dummyInput(4), d1 = dummyInput(5), d0p = dummyInput(4+900), d1p = dummyInput(5+900);
    const d = dummyOutput();
    const comm1 = poseidonHash([d.spendingCommitment, 0n, 0n, 0n, 0n]);

    const honest = params({
      poolRoot: [ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32), ethers.toBeHex(tree.getRoot(), 32)], treeNumber: [0, 0, 0, 0],
      registryRoot: ethers.toBeHex(smt.root, 32),
      publicAmount: amount,
      inputNullifiers: [ethers.toBeHex(d0.nullifier, 32), ethers.toBeHex(d1.nullifier, 32), ethers.toBeHex(d0p.nullifier, 32), ethers.toBeHex(d1p.nullifier, 32)],
      outputCommitments: [ethers.toBeHex(out0.commitment, 32), ethers.toBeHex(comm1, 32)],
      recipient: recipient.address,
    });
    const paramsHash = BigInt(await pool.computeParamsHash(honest, "0x", "0x"));

    const proof = await prove(circuitInput({
      poolRoot: tree.getRoot(), registryRoot: smt.root, publicAmount: amount, paramsHash,
      inputNullifiers: [BigInt(honest.inputNullifiers[0]), BigInt(honest.inputNullifiers[1]), BigInt(honest.inputNullifiers[2]), BigInt(honest.inputNullifiers[3])],
      outputCommitments: [out0.commitment, comm1],
      inputs: [d0.input, d1.input, d0p.input, d1p.input],
      outputs: [out0, d],
    }));

    const tampered = { ...honest, recipient: relayer.address };
    await expect(pool.transact(tampered, "0x", "0x", proof, { value: amount }))
      .to.be.revertedWithCustomError(pool, "InvalidProof");

    // ...and the untampered one still works, so the rejection was the tampering rather than
    // anything else about the proof. Asserted on the event: this is the control that gives the
    // revert above its meaning, so it has to show the transaction did its work, not merely
    // that it survived.
    await expect(pool.transact(honest, "0x", "0x", proof, { value: amount }))
      .to.emit(pool, "Transact");
  });
});
