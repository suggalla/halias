import { expect } from "chai";
import { ethers } from "ethers";
import { init, deriveKeysFromRoot, poseidonHash } from "../src/crypto";
import { rootFromMnemonic, generateMnemonic } from "../src/seed";
import { encodeViewKey, decodeViewKey, viewKeysFrom, keysFromViewKeys } from "../src/viewkey";

// A key that reads one alias and cannot spend it.
//
// The property that matters is negative — what a view key does *not* carry — so most of this
// asserts absence. The spending key is derived alongside the viewing key from a shared alias
// seed, which is exactly why the seed itself must never travel: it is spending authority.
describe("view keys", () => {
  const root = rootFromMnemonic(
    "test test test test test test test test test test test junk",
  );

  before(async () => { await init(); });

  it("round-trips", () => {
    const v = viewKeysFrom(deriveKeysFromRoot(root, 0));
    const back = decodeViewKey(encodeViewKey(v));
    expect(back.spendingCommitment).to.equal(v.spendingCommitment);
    expect(back.viewingPrivKey).to.equal(v.viewingPrivKey);
    expect(ethers.hexlify(back.encryptionPrivKey)).to.equal(ethers.hexlify(v.encryptionPrivKey));
  });

  it("carries what reading needs", () => {
    const full = deriveKeysFromRoot(root, 3);
    const rebuilt = keysFromViewKeys(decodeViewKey(encodeViewKey(viewKeysFrom(full))));

    // Recognising your own notes, and recognising them as spent.
    expect(rebuilt.spendingCommitment).to.equal(full.spendingCommitment);
    expect(rebuilt.nullifierKey).to.equal(full.nullifierKey);
    // Opening the ciphertexts.
    expect(ethers.hexlify(rebuilt.encryption.privateKey))
      .to.equal(ethers.hexlify(full.encryption.privateKey));
    expect(ethers.hexlify(rebuilt.encryption.publicKey))
      .to.equal(ethers.hexlify(full.encryption.publicKey));
  });

  it("does not carry the spending key", () => {
    const full = deriveKeysFromRoot(root, 0);
    const encoded = encodeViewKey(viewKeysFrom(full));

    // Not present verbatim, in either byte order a careless encoder might have used.
    const spend = ethers.toBeHex(full.spendingPrivKey, 32).slice(2);
    expect(encoded.toLowerCase()).to.not.include(spend.toLowerCase());
    expect(keysFromViewKeys(decodeViewKey(encoded)).spendingPrivKey).to.equal(0n);
  });

  it("does not carry the alias seed, which would BE the spending key", () => {
    // The trap this format exists to avoid. spendingPrivKey = Poseidon(seed, 0), so anyone
    // holding the seed can compute it — a "view key" containing the seed is a spending key.
    const ALIAS_DOMAIN = 1212371027n;
    for (const i of [0, 1, 5]) {
      const seed = poseidonHash([root, BigInt(i), ALIAS_DOMAIN]);
      const encoded = encodeViewKey(viewKeysFrom(deriveKeysFromRoot(root, i)));
      expect(encoded.toLowerCase()).to.not.include(ethers.toBeHex(seed, 32).slice(2).toLowerCase());
    }
  });

  it("does not let the spending key be recomputed from what it carries", () => {
    // viewingPrivKey is Poseidon(seed, 1) and spending is Poseidon(seed, 0); recovering one
    // from the other means inverting Poseidon. This asserts the obvious near-misses rather
    // than the hardness: that no published value simply *is* the spending key.
    const full = deriveKeysFromRoot(root, 0);
    const v = viewKeysFrom(full);
    for (const candidate of [
      v.viewingPrivKey,
      v.spendingCommitment,
      poseidonHash([v.viewingPrivKey]),
      poseidonHash([v.viewingPrivKey, 0n]),
      BigInt(ethers.hexlify(v.encryptionPrivKey)),
    ]) {
      expect(candidate).to.not.equal(full.spendingPrivKey);
      expect(poseidonHash([candidate])).to.not.equal(full.spendingCommitment);
    }
  });

  it("is scoped to one alias — it reveals no other index", () => {
    const encoded = encodeViewKey(viewKeysFrom(deriveKeysFromRoot(root, 2)));
    for (const other of [0, 1, 3, 4]) {
      const k = deriveKeysFromRoot(root, other);
      expect(encoded.toLowerCase()).to.not.include(ethers.toBeHex(k.viewingPrivKey, 32).slice(2).toLowerCase());
      expect(encoded.toLowerCase()).to.not.include(ethers.hexlify(k.encryption.privateKey).slice(2).toLowerCase());
    }
    // And nothing in it is the root, which would derive every index.
    expect(encoded.toLowerCase()).to.not.include(ethers.toBeHex(root, 32).slice(2).toLowerCase());
  });

  it("differs per alias and per wallet", () => {
    const a = encodeViewKey(viewKeysFrom(deriveKeysFromRoot(root, 0)));
    const b = encodeViewKey(viewKeysFrom(deriveKeysFromRoot(root, 1)));
    const c = encodeViewKey(viewKeysFrom(deriveKeysFromRoot(rootFromMnemonic(generateMnemonic()), 0)));
    expect(a).to.not.equal(b);
    expect(a).to.not.equal(c);
  });

  describe("encoding", () => {
    const good = () => encodeViewKey(viewKeysFrom(deriveKeysFromRoot(root, 0)));

    it("is prefixed so it is recognisable", () => {
      expect(good().startsWith("hvk1")).to.equal(true);
    });

    it("rejects a key that is not one", () => {
      expect(() => decodeViewKey("0xdeadbeef")).to.throw(/begin with hvk1/);
    });

    it("rejects one cut short", () => {
      // The failure this checksum exists for: a truncated key that decoded cleanly would
      // find no notes, which is indistinguishable from an alias with no history.
      expect(() => decodeViewKey(good().slice(0, -8))).to.throw(/cut short|length/);
    });

    it("rejects a single flipped character", () => {
      const k = good();
      const at = 40;
      const flipped = k.slice(0, at) + (k[at] === "a" ? "b" : "a") + k.slice(at + 1);
      expect(() => decodeViewKey(flipped)).to.throw(/checksum/);
    });

    it("tolerates surrounding whitespace", () => {
      expect(decodeViewKey(`  ${good()}\n`).spendingCommitment)
        .to.equal(decodeViewKey(good()).spendingCommitment);
    });
  });
});
