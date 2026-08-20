import { expect } from "chai";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import {
  init,
  poseidonHash,
  deriveKeysFromRoot,
  encryptOutput,
  decryptOutput,
  encodeOutputBlob,
  decodeOutputBlob,
} from "../src/crypto";
import { generateMnemonic, rootFromMnemonic } from "../src/seed";
import { MerkleTree } from "../src/merkle";
import { buildEntry, computeNullifier, NULLIFIER_DOMAIN, POOL_LEVELS, ETH_TOKEN_ADDRESS } from "../src/entry";
import { findMyOutputs, Output } from "../src/events";
import { Halias } from "../src/halias";
import { SMT } from "../src/smt";
import {
  deriveInviteKeys,
  encodeInviteCode, decodeInviteCode,
} from "../src/invite";
import { computeParamsHash, encodeRegistration, type TransactParams } from "../src/contract";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

before(async () => {
  await init();
});

describe("crypto", () => {
  it("poseidonHash changes with different inputs", () => {
    expect(poseidonHash([1n, 2n])).to.not.equal(poseidonHash([1n, 3n]));
  });

  it("poseidonHash returns a bigint", () => {
    const h = poseidonHash([42n]);
    expect(typeof h).to.equal("bigint");
    expect(h > 0n).to.be.true;
  });

  it("deriveKeysFromRoot returns all expected fields", () => {
    const keys = deriveKeysFromRoot(rootFromMnemonic(generateMnemonic()));
    expect(keys.spendingPrivKey).to.be.a("bigint");
    expect(keys.spendingCommitment).to.equal(poseidonHash([keys.spendingPrivKey]));
    expect(keys.nullifierKey).to.equal(poseidonHash([keys.viewingPrivKey]));
    expect(keys.encryption.privateKey).to.be.instanceOf(Uint8Array);
    expect(keys.encryption.publicKey).to.be.instanceOf(Uint8Array);
    expect(keys.encryption.privateKey).to.have.lengthOf(32);
    expect(keys.encryption.publicKey).to.have.lengthOf(32);
  });

  it("is deterministic — the same phrase always rebuilds the same keys", () => {
    const phrase = generateMnemonic();
    const a = deriveKeysFromRoot(rootFromMnemonic(phrase));
    const b = deriveKeysFromRoot(rootFromMnemonic(phrase));
    expect(a.spendingPrivKey).to.equal(b.spendingPrivKey);
    expect(a.viewingPrivKey).to.equal(b.viewingPrivKey);
    expect(Buffer.from(a.encryption.privateKey).toString("hex"))
      .to.equal(Buffer.from(b.encryption.privateKey).toString("hex"));
  });

  it("differs per phrase", () => {
    const a = deriveKeysFromRoot(rootFromMnemonic(generateMnemonic()));
    const b = deriveKeysFromRoot(rootFromMnemonic(generateMnemonic()));
    expect(a.spendingPrivKey).to.not.equal(b.spendingPrivKey);
  });
});

describe("NaCl box encryption", () => {
  it("encrypt then decrypt recovers blinding and amount", () => {
    const recipient = nacl.box.keyPair();
    const blinding = 123456789n;
    const amount   = ethers.parseEther("1");

    const encrypted = encryptOutput(blinding, amount, recipient.publicKey);
    const decrypted = decryptOutput(encrypted, recipient.secretKey);

    expect(decrypted).to.not.be.null;
    expect(decrypted!.blinding).to.equal(blinding);
    expect(decrypted!.amount).to.equal(amount);
  });

  it("wrong key fails MAC and returns null", () => {
    const recipient = nacl.box.keyPair();
    const eve       = nacl.box.keyPair();
    const encrypted = encryptOutput(111n, 222n, recipient.publicKey);
    const decrypted = decryptOutput(encrypted, eve.secretKey);
    expect(decrypted).to.be.null;
  });

  it("encode/decode blob roundtrips", () => {
    const recipient = nacl.box.keyPair();
    const encrypted = encryptOutput(42n, 99n, recipient.publicKey);
    const blob    = encodeOutputBlob(encrypted);
    const decoded = decodeOutputBlob(blob);
    expect(decoded).to.not.be.null;
    expect(Buffer.from(decoded!.ephemeralPub).toString("hex"))
      .to.equal(Buffer.from(encrypted.ephemeralPub).toString("hex"));
  });

  it("decodeOutputBlob returns null for empty blob", () => {
    expect(decodeOutputBlob("0x")).to.be.null;
  });

  it("blob is 137 bytes with version prefix", () => {
    const encrypted = encryptOutput(1n, 2n, nacl.box.keyPair().publicKey);
    const blob = encodeOutputBlob(encrypted);
    const buf = ethers.getBytes(blob);
    expect(buf).to.have.lengthOf(137);
    expect(buf[0]).to.equal(0x01);
  });
});

describe("MerkleTree", () => {
  it("root changes after insert", () => {
    const tree = new MerkleTree();
    const empty = tree.getRoot();
    tree.insert(42n);
    expect(tree.getRoot()).to.not.equal(empty);
  });

  it("proof has POOL_LEVELS elements, matching the circuit", () => {
    const tree = new MerkleTree();
    tree.insert(100n);
    const proof = tree.getProof(0);
    expect(proof.pathElements).to.have.lengthOf(POOL_LEVELS);
    expect(proof.pathIndices).to.have.lengthOf(POOL_LEVELS);
  });

  it("proof hashes back to root", () => {
    const tree = new MerkleTree();
    tree.insert(11n);
    tree.insert(22n);
    tree.insert(33n);
    const root = tree.getRoot();
    const { pathElements, pathIndices } = tree.getProof(1);
    let cur = 22n;
    for (let i = 0; i < POOL_LEVELS; i++) {
      const [l, r] = pathIndices[i] === 0 ? [cur, pathElements[i]] : [pathElements[i], cur];
      cur = poseidonHash([l, r]);
    }
    expect(cur).to.equal(root);
  });
});

describe("entry", () => {
  it("buildEntry produces correct commitment", () => {
    const spendingCommitment = poseidonHash([12345n]);
    const nullifierKey = poseidonHash([99999n]);
    const blinding = 999n;
    const amount   = ethers.parseEther("1");
    const entry = buildEntry(spendingCommitment, nullifierKey, blinding, amount, ETH_TOKEN_ADDRESS);
    expect(entry.commitment).to.equal(poseidonHash([spendingCommitment, nullifierKey, blinding, amount, ETH_TOKEN_ADDRESS]));
  });

  it("computeNullifier depends on leafIndex", () => {
    const nullifierKey = poseidonHash([42n]);
    const n0 = computeNullifier(nullifierKey, 0, 0);
    const n1 = computeNullifier(nullifierKey, 0, 1);
    expect(n0).to.not.equal(n1);
    expect(n0).to.equal(poseidonHash([nullifierKey, 0n, NULLIFIER_DOMAIN]));
  });

  it("computeNullifier depends on the tree, not just the leaf", () => {
    // The bug this exists to prevent: the pool is a sequence of trees, so a leaf index alone
    // does not identify a note. If the tree were left out, leaf 5 of tree 0 and leaf 5 of
    // tree 3 would nullify identically and whichever was spent second would be permanently
    // unspendable — silent, irreversible, and invisible to any single-tree test.
    const nullifierKey = poseidonHash([42n]);
    expect(computeNullifier(nullifierKey, 0, 5)).to.not.equal(computeNullifier(nullifierKey, 3, 5));
  });

  it("computeNullifier keys on the global position", () => {
    // Must match NoteNullifier in transact.circom exactly: tree * 2^POOL_LEVELS + leaf.
    const nullifierKey = poseidonHash([42n]);
    const global = (BigInt(3) << BigInt(POOL_LEVELS)) + 5n;
    expect(computeNullifier(nullifierKey, 3, 5))
      .to.equal(poseidonHash([nullifierKey, global, NULLIFIER_DOMAIN]));
  });

  it("no two (tree, leaf) pairs share a global position", () => {
    const nullifierKey = poseidonHash([7n]);
    const seen = new Set<bigint>();
    for (let t = 0; t < 4; t++) {
      for (let l = 0; l < 4; l++) {
        const n = computeNullifier(nullifierKey, t, l);
        expect(seen.has(n), `collision at tree ${t} leaf ${l}`).to.equal(false);
        seen.add(n);
      }
    }
  });

  it("different spendingCommitment gives different commitment", () => {
    const nk = poseidonHash([0n]);
    const a = buildEntry(poseidonHash([1n]), nk, 0n, 1n, 0n);
    const b = buildEntry(poseidonHash([2n]), nk, 0n, 1n, 0n);
    expect(a.commitment).to.not.equal(b.commitment);
  });
});

describe("findMyOutputs", () => {
  it("identifies encrypted outputs belonging to me", () => {
    const myKey           = nacl.box.keyPair();
    const myPubkey        = poseidonHash([11111n]);
    const myNullifierKey  = poseidonHash([22222n]);            // raw key
    const myNKHash        = poseidonHash([myNullifierKey, 1n]); // hash baked into the commitment
    const amount   = ethers.parseEther("1");
    const blinding = 777n;

    const myEntry = buildEntry(myPubkey, myNKHash, blinding, amount, ETH_TOKEN_ADDRESS);
    const encrypted = encryptOutput(blinding, amount, myKey.publicKey);
    const blob = encodeOutputBlob(encrypted);

    const otherKey  = nacl.box.keyPair();
    const oe = encryptOutput(1n, 2n, otherKey.publicKey);
    const otherBlob = encodeOutputBlob(oe);

    const outputs: Output[] = [
      { commitment: myEntry.commitment, treeNumber: 0, leafIndex: 0, encryptedBlob: blob, spentNullifiers: [0n, 0n], blockNumber: 1, transactionIndex: 0, logIndex: 0, publicAmount: 0n, txHash: "0x" + "00".repeat(32), tokenAddress: 0n },
      { commitment: 12345n, treeNumber: 0, leafIndex: 1, encryptedBlob: otherBlob, spentNullifiers: [0n, 0n], blockNumber: 1, transactionIndex: 0, logIndex: 1, publicAmount: 0n, txHash: "0x" + "00".repeat(32), tokenAddress: 0n },
    ];

    const found = findMyOutputs(outputs, myPubkey, myNullifierKey, myKey.secretKey);
    expect(found).to.have.lengthOf(1);
    expect(found[0].commitment).to.equal(myEntry.commitment);
    expect(found[0].leafIndex).to.equal(0);
  });

  it("returns empty for no matches", () => {
    const myKey    = nacl.box.keyPair();
    const myPubkey = poseidonHash([55555n]);
    const myVK     = poseidonHash([66666n]);  // nullifierKey
    const otherKey = nacl.box.keyPair();
    const encrypted = encryptOutput(1n, 2n, otherKey.publicKey);

    const outputs: Output[] = [
      { commitment: 99999n, treeNumber: 0, leafIndex: 0, encryptedBlob: encodeOutputBlob(encrypted), spentNullifiers: [0n, 0n], blockNumber: 1, transactionIndex: 0, logIndex: 0, publicAmount: 0n, txHash: "0x" + "00".repeat(32), tokenAddress: 0n },
    ];

    expect(findMyOutputs(outputs, myPubkey, myVK, myKey.secretKey)).to.have.lengthOf(0);
  });
});

// The Halias class is the package's main entry point and, until this was added, no test
// had ever constructed one — which let a constructor that threw unconditionally pass CI.
describe("Halias construction", () => {
  const cfg = (): any => ({
    provider: new ethers.JsonRpcProvider("http://127.0.0.1:8545"),
    signer: ethers.Wallet.createRandom(),
    chainId: 31337,
    // Three addresses since the split. poolAddress is the one paramsHash commits to.
    poolAddress:     "0x" + "11".repeat(20),
    registryAddress: "0x" + "22".repeat(20),
    controllerAddress:   "0x" + "33".repeat(20),
    artifacts: { transactWasm: "/dev/null", transactZkey: "/dev/null" },
  });

  it("constructs without Poseidon being initialised", () => {
    // A caller cannot await init() before the constructor runs, so nothing in it may
    // depend on global crypto setup. SMT used to compute its empty root eagerly, which
    // made `new Halias(...)` throw unconditionally.
    expect(() => new Halias(cfg())).to.not.throw();
  });

  it("reports a clear error when used before init()", async () => {
    const h = new Halias(cfg());
    try {
      await h.balance();
      expect.fail("expected a pre-init call to be rejected");
    } catch (e: any) {
      expect(e.message).to.match(/init/i);
    }
  });
});

describe("SMT lazy root", () => {
  it("constructs eagerly but resolves the empty root on demand", () => {
    expect(() => new SMT()).to.not.throw();
    const a = new SMT(), b = new SMT();
    expect(a.root).to.equal(b.root);       // two empty trees agree
    a.update(0, 1n, 42n);                  // slot 0, alias key 1n
    expect(a.root).to.not.equal(b.root);   // an update moves the root
  });

  it("places the same leaf differently depending on the slot", () => {
    // Position and identity are separate now: the same alias key in a different slot is
    // a different tree. This is what makes assigned slots collision-free.
    const a = new SMT(), b = new SMT();
    a.update(0, 7n, 42n);
    b.update(1, 7n, 42n);
    expect(a.root).to.not.equal(b.root);
  });

  it("clone snapshots without aliasing the original", () => {
    const a = new SMT();
    a.update(0, 1n, 42n);
    const snapshot = a.root;
    const b = a.clone();
    b.update(1, 2n, 99n);
    expect(a.root).to.equal(snapshot);
    expect(b.root).to.not.equal(snapshot);
  });
});

// invite.ts is the newest code in the package and had no tests at all. The keys it derives
// are the whole security of an invite: anyone who can reproduce them can spend the note.
describe("invite keys", () => {
  it("derives deterministically from the secret", () => {
    const s = 0xdeadbeefn;
    const a = deriveInviteKeys(s), b = deriveInviteKeys(s);
    expect(a.spendingCommitment).to.equal(b.spendingCommitment);
    expect(a.nullifierKey).to.equal(b.nullifierKey);
    expect(a.blinding).to.equal(b.blinding);
    expect(ethers.hexlify(a.encryption.publicKey)).to.equal(ethers.hexlify(b.encryption.publicKey));
  });

  it("gives different secrets different keys", () => {
    const a = deriveInviteKeys(1n), b = deriveInviteKeys(2n);
    expect(a.spendingCommitment).to.not.equal(b.spendingCommitment);
    expect(a.nullifierKey).to.not.equal(b.nullifierKey);
    expect(a.blinding).to.not.equal(b.blinding);
  });

  it("keeps the four derived values distinct from each other", () => {
    // A collision between, say, blinding and a private key would be catastrophic and
    // silent, so pin that the domain tags actually separate them.
    const k = deriveInviteKeys(12345n);
    const vals = [k.spendingPrivKey, k.viewingPrivKey, k.blinding, k.nullifierKey];
    expect(new Set(vals.map(String)).size).to.equal(vals.length);
  });

  it("derives nullifierKeyHash as Poseidon(nullifierKey, 1), matching the registry", () => {
    const k = deriveInviteKeys(999n);
    expect(k.nullifierKeyHash).to.equal(poseidonHash([k.nullifierKey, 1n]));
  });

  it("derives spendingCommitment as Poseidon(spendingPrivKey), matching the circuit", () => {
    const k = deriveInviteKeys(777n);
    expect(k.spendingCommitment).to.equal(poseidonHash([k.spendingPrivKey]));
  });
});

// The relayer fee used to be address(20) || uint96(12) packed into one word, mirrored
// bit-for-bit in the SDK. It is a struct now and the pool settles it directly, so the
// packing helpers are gone — deleting a whole class of encoding bug along with them.
//
// What replaced them is a hash the SDK and the contract must agree on. That agreement is
// asserted against a live contract in the protocol package (SdkPreimage.test.ts); what is
// checkable here without a chain is that the encoding is stable and actually sensitive to
// every field.
describe("paramsHash preimage", () => {
  const POOL = "0x" + "11".repeat(20);
  const params = (over: Partial<TransactParams> = {}): TransactParams => ({
    recipient: "0x" + "22".repeat(20),
    relayerFee: { relayer: "0x" + "33".repeat(20), amount: 7n },
    externalData: ethers.ZeroHash,
    ...over,
  });
  const hash = (p: TransactParams, e0 = "0x", e1 = "0x") =>
    computeParamsHash(p, e0, e1, 1n, POOL);

  it("stays inside the field", () => {
    expect(hash(params()) < FIELD_PRIME).to.equal(true);
  });

  it("depends on both members of the relayer fee", () => {
    // A struct encodes as two independent words. If either fell out of the preimage a
    // submitter could rewrite it and keep the proof valid.
    const base = hash(params());
    expect(hash(params({ relayerFee: { relayer: "0x" + "44".repeat(20), amount: 7n } }))).to.not.equal(base);
    expect(hash(params({ relayerFee: { relayer: "0x" + "33".repeat(20), amount: 8n } }))).to.not.equal(base);
  });

  it("accepts a fee above the old uint96 ceiling", () => {
    // The 96-bit cap was an artefact of the packing, not a real bound. Nothing should
    // reject or truncate a larger figure now.
    const big = (1n << 100n) + 1n;
    expect(() => hash(params({ relayerFee: { relayer: "0x" + "33".repeat(20), amount: big } }))).to.not.throw();
    expect(hash(params({ relayerFee: { relayer: "0x" + "33".repeat(20), amount: big } })))
      .to.not.equal(hash(params()));
  });

  it("depends on the recipient, externalData and both ciphertexts", () => {
    const base = hash(params());
    expect(hash(params({ recipient: "0x" + "55".repeat(20) }))).to.not.equal(base);
    expect(hash(params({ externalData: "0x" + "ab".repeat(32) }))).to.not.equal(base);
    expect(hash(params(), "0xdead")).to.not.equal(base);
    expect(hash(params(), "0x", "0xbeef")).to.not.equal(base);
  });

  it("depends on the pool address and the chain id", () => {
    // Both are replay boundaries: the same proof must not be reusable on another chain
    // or against a different pool.
    const base = hash(params());
    expect(computeParamsHash(params(), "0x", "0x", 1n, "0x" + "99".repeat(20))).to.not.equal(base);
    expect(computeParamsHash(params(), "0x", "0x", 2n, POOL)).to.not.equal(base);
  });
});

describe("claim authorisation", () => {
  it("binds every field of the registration", () => {
    // The domain recomputes this hash and refuses a mismatch, which is what stops a
    // relayer minting the alias to itself. A field left out of the encoding would let the
    // submitter vary it freely.
    const base = {
      owner: "0x" + "11".repeat(20),
      aliasHash: 1n, spendingCommitment: 2n, nullifierKeyHash: 3n, encryptionPubkey: 4n,
    };
    const h = encodeRegistration(base);
    for (const v of [
      { ...base, owner: "0x" + "22".repeat(20) },
      { ...base, aliasHash: 9n },
      { ...base, spendingCommitment: 9n },
      { ...base, nullifierKeyHash: 9n },
      { ...base, encryptionPubkey: 9n },
    ]) {
      expect(encodeRegistration(v)).to.not.equal(h);
    }
    expect(encodeRegistration(base)).to.equal(h);
  });
});

describe("invite codes", () => {
  it("round-trips", () => {
    const s = BigInt("0x" + "ab".repeat(32)) >> 8n;
    expect(decodeInviteCode(encodeInviteCode(s))).to.equal(s);
  });

  it("accepts a code with or without the 0x prefix", () => {
    const code = encodeInviteCode(42n);
    expect(decodeInviteCode(code)).to.equal(42n);
    expect(decodeInviteCode(code.slice(2))).to.equal(42n);
  });

  it("rejects a zero code, which would derive keys anyone could guess", () => {
    expect(() => decodeInviteCode(ethers.ZeroHash)).to.throw(/invalid/i);
  });
});
