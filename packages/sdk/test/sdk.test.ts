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
import {
  deriveInviteKeys, packRelayerFee, unpackRelayerFee,
  encodeInviteCode, decodeInviteCode,
} from "../src/invite";

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

// invite.ts is the newest code in the package and had no tests at all. Its byte layout is
// a cross-package contract: packRelayerFee must produce exactly what Halias._decodeRelayerFee
// reads back, or a claimer silently pays the wrong relayer — or nobody.
describe("invite keys", () => {
  it("derives deterministically from the secret", () => {
    const s = 0xdeadbeefn;
    const a = deriveInviteKeys(s), b = deriveInviteKeys(s);
    expect(a.spendingPubkey).to.equal(b.spendingPubkey);
    expect(a.nullifierKey).to.equal(b.nullifierKey);
    expect(a.blinding).to.equal(b.blinding);
    expect(ethers.hexlify(a.encryption.publicKey)).to.equal(ethers.hexlify(b.encryption.publicKey));
  });

  it("gives different secrets different keys", () => {
    const a = deriveInviteKeys(1n), b = deriveInviteKeys(2n);
    expect(a.spendingPubkey).to.not.equal(b.spendingPubkey);
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

  it("derives spendingPubkey as Poseidon(spendingPrivKey), matching the circuit", () => {
    const k = deriveInviteKeys(777n);
    expect(k.spendingPubkey).to.equal(poseidonHash([k.spendingPrivKey]));
  });
});

describe("relayer fee packing", () => {
  const addr = "0x1234567890AbcdEF1234567890aBcdef12345678";

  it("round-trips through pack/unpack", () => {
    const packed = packRelayerFee(addr, 12345n);
    const { relayer, fee } = unpackRelayerFee(packed);
    expect(relayer).to.equal(ethers.getAddress(addr));
    expect(fee).to.equal(12345n);
  });

  it("packs the address into the high 160 bits and the fee into the low 96", () => {
    // The layout Halias._decodeRelayerFee assumes: address << 96 | fee.
    const packed = packRelayerFee(addr, 1n);
    expect(BigInt(packed) >> 96n).to.equal(BigInt(addr));
    expect(BigInt(packed) & ((1n << 96n) - 1n)).to.equal(1n);
    expect(packed.length).to.equal(66); // 0x + 32 bytes
  });

  it("is zero for a zero relayer and zero fee, which means no relayer", () => {
    expect(packRelayerFee(ethers.ZeroAddress, 0n)).to.equal(ethers.ZeroHash);
  });

  it("accepts the largest fee that fits", () => {
    const max = (1n << 96n) - 1n;
    expect(unpackRelayerFee(packRelayerFee(addr, max)).fee).to.equal(max);
  });

  it("rejects a fee that would overflow into the address", () => {
    expect(() => packRelayerFee(addr, 1n << 96n)).to.throw(/uint96/);
  });

  it("rejects a non-zero fee with no relayer to pay", () => {
    expect(() => packRelayerFee(ethers.ZeroAddress, 1n)).to.throw(/relayer/i);
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
