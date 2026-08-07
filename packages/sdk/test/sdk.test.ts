import { expect } from "chai";
import { ethers } from "ethers";
import nacl from "tweetnacl";
import {
  init,
  poseidonHash,
  deriveKeysFromWallet,
  encryptOutput,
  decryptOutput,
  encodeOutputBlob,
  decodeOutputBlob,
} from "../src/crypto";
import { MerkleTree } from "../src/merkle";
import { buildEntry, computeNullifier, NULLIFIER_DOMAIN, ETH_TOKEN_ADDRESS } from "../src/entry";
import { findMyOutputs, Output } from "../src/events";
import { Halias } from "../src/halias";
import { SMT } from "../src/smt";

before(async () => {
  await init();
});

describe("crypto", () => {
  it("poseidonHash is deterministic", () => {
    expect(poseidonHash([1n, 2n])).to.equal(poseidonHash([1n, 2n]));
  });

  it("poseidonHash changes with different inputs", () => {
    expect(poseidonHash([1n, 2n])).to.not.equal(poseidonHash([1n, 3n]));
  });

  it("poseidonHash returns a bigint", () => {
    const h = poseidonHash([42n]);
    expect(typeof h).to.equal("bigint");
    expect(h > 0n).to.be.true;
  });

  it("deriveKeysFromWallet returns all expected fields", async () => {
    const wallet = ethers.Wallet.createRandom();
    const keys = await deriveKeysFromWallet(wallet);
    expect(keys.spendingPrivKey).to.be.a("bigint");
    expect(keys.spendingPubkey).to.equal(poseidonHash([keys.spendingPrivKey]));
    expect(keys.nullifierKey).to.equal(poseidonHash([keys.viewingPrivKey]));
    expect(keys.encryption.privateKey).to.be.instanceOf(Uint8Array);
    expect(keys.encryption.publicKey).to.be.instanceOf(Uint8Array);
    expect(keys.encryption.privateKey).to.have.lengthOf(32);
    expect(keys.encryption.publicKey).to.have.lengthOf(32);
  });

  it("deriveKeysFromWallet is deterministic", async () => {
    const wallet = ethers.Wallet.createRandom();
    const a = await deriveKeysFromWallet(wallet);
    const b = await deriveKeysFromWallet(wallet);
    expect(a.spendingPrivKey).to.equal(b.spendingPrivKey);
    expect(a.viewingPrivKey).to.equal(b.viewingPrivKey);
    expect(Buffer.from(a.encryption.privateKey).toString("hex"))
      .to.equal(Buffer.from(b.encryption.privateKey).toString("hex"));
  });

  it("deriveKeysFromWallet differs per wallet", async () => {
    const a = await deriveKeysFromWallet(ethers.Wallet.createRandom());
    const b = await deriveKeysFromWallet(ethers.Wallet.createRandom());
    expect(a.spendingPrivKey).to.not.equal(b.spendingPrivKey);
  });
});

describe("NaCl box encryption", () => {
  it("encrypt then decrypt recovers blinding and amount", () => {
    const recipient = nacl.box.keyPair();
    const blinding = 123456789n;
    const amount   = ethers.parseEther("1");

    const { encrypted, viewTag } = encryptOutput(blinding, amount, recipient.publicKey);
    const decrypted = decryptOutput(encrypted, recipient.secretKey);

    expect(decrypted).to.not.be.null;
    expect(decrypted!.blinding).to.equal(blinding);
    expect(decrypted!.amount).to.equal(amount);
    expect(decrypted!.viewTag).to.equal(viewTag);
  });

  it("wrong key fails MAC and returns null", () => {
    const recipient = nacl.box.keyPair();
    const eve       = nacl.box.keyPair();
    const { encrypted } = encryptOutput(111n, 222n, recipient.publicKey);
    const decrypted = decryptOutput(encrypted, eve.secretKey);
    expect(decrypted).to.be.null;
  });

  it("encode/decode blob roundtrips", () => {
    const recipient = nacl.box.keyPair();
    const { encrypted, viewTag } = encryptOutput(42n, 99n, recipient.publicKey);
    const blob    = encodeOutputBlob(encrypted, viewTag);
    const decoded = decodeOutputBlob(blob);
    expect(decoded).to.not.be.null;
    expect(decoded!.viewTag).to.equal(viewTag);
    expect(Buffer.from(decoded!.encrypted.ephemeralPub).toString("hex"))
      .to.equal(Buffer.from(encrypted.ephemeralPub).toString("hex"));
  });

  it("decodeOutputBlob returns null for empty blob", () => {
    expect(decodeOutputBlob("0x")).to.be.null;
  });

  it("blob is 138 bytes with version prefix", () => {
    const { encrypted, viewTag } = encryptOutput(1n, 2n, nacl.box.keyPair().publicKey);
    const blob = encodeOutputBlob(encrypted, viewTag);
    const buf = ethers.getBytes(blob);
    expect(buf).to.have.lengthOf(138);
    expect(buf[0]).to.equal(0x01);
  });
});

describe("MerkleTree", () => {
  it("empty tree has a deterministic root", () => {
    expect(new MerkleTree().getRoot()).to.equal(new MerkleTree().getRoot());
  });

  it("root changes after insert", () => {
    const tree = new MerkleTree();
    const empty = tree.getRoot();
    tree.insert(42n);
    expect(tree.getRoot()).to.not.equal(empty);
  });

  it("proof has 32 elements (LEVELS=32 matches circuit)", () => {
    const tree = new MerkleTree();
    tree.insert(100n);
    const proof = tree.getProof(0);
    expect(proof.pathElements).to.have.lengthOf(32);
    expect(proof.pathIndices).to.have.lengthOf(32);
  });

  it("proof hashes back to root", () => {
    const tree = new MerkleTree();
    tree.insert(11n);
    tree.insert(22n);
    tree.insert(33n);
    const root = tree.getRoot();
    const { pathElements, pathIndices } = tree.getProof(1);
    let cur = 22n;
    for (let i = 0; i < 32; i++) {
      const [l, r] = pathIndices[i] === 0 ? [cur, pathElements[i]] : [pathElements[i], cur];
      cur = poseidonHash([l, r]);
    }
    expect(cur).to.equal(root);
  });
});

describe("entry", () => {
  it("buildEntry produces correct commitment", () => {
    const pubkey = poseidonHash([12345n]);
    const nullifierKey = poseidonHash([99999n]);
    const blinding = 999n;
    const amount   = ethers.parseEther("1");
    const entry = buildEntry(pubkey, nullifierKey, blinding, amount, ETH_TOKEN_ADDRESS);
    expect(entry.commitment).to.equal(poseidonHash([pubkey, nullifierKey, blinding, amount, ETH_TOKEN_ADDRESS]));
  });

  it("computeNullifier depends on leafIndex", () => {
    const nullifierKey = poseidonHash([42n]);
    const n0 = computeNullifier(nullifierKey, 0);
    const n1 = computeNullifier(nullifierKey, 1);
    expect(n0).to.not.equal(n1);
    expect(n0).to.equal(poseidonHash([nullifierKey, 0n, NULLIFIER_DOMAIN]));
  });

  it("different pubkey gives different commitment", () => {
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
    const { encrypted, viewTag } = encryptOutput(blinding, amount, myKey.publicKey);
    const blob = encodeOutputBlob(encrypted, viewTag);

    const otherKey  = nacl.box.keyPair();
    const { encrypted: oe, viewTag: ot } = encryptOutput(1n, 2n, otherKey.publicKey);
    const otherBlob = encodeOutputBlob(oe, ot);

    const outputs: Output[] = [
      { commitment: myEntry.commitment, leafIndex: 0, encryptedBlob: blob, spentNullifiers: [0n, 0n], blockNumber: 1, transactionIndex: 0, logIndex: 0, tokenAddress: 0n },
      { commitment: 12345n, leafIndex: 1, encryptedBlob: otherBlob, spentNullifiers: [0n, 0n], blockNumber: 1, transactionIndex: 0, logIndex: 1, tokenAddress: 0n },
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
    const { encrypted, viewTag } = encryptOutput(1n, 2n, otherKey.publicKey);

    const outputs: Output[] = [
      { commitment: 99999n, leafIndex: 0, encryptedBlob: encodeOutputBlob(encrypted, viewTag), spentNullifiers: [0n, 0n], blockNumber: 1, transactionIndex: 0, logIndex: 0, tokenAddress: 0n },
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
    contractAddress: "0x" + "11".repeat(20),
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
    a.update(1n, 42n);
    expect(a.root).to.not.equal(b.root);   // an update moves the root
  });

  it("clone snapshots without aliasing the original", () => {
    const a = new SMT();
    a.update(1n, 42n);
    const snapshot = a.root;
    const b = a.clone();
    b.update(2n, 99n);
    expect(a.root).to.equal(snapshot);
    expect(b.root).to.not.equal(snapshot);
  });
});
