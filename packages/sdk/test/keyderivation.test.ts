import { expect } from "chai";
import { ethers } from "ethers";
import { init, deriveKeysFromRoot, poseidonHash } from "../src/crypto";
import { generateMnemonic, rootFromMnemonic } from "../src/seed";

// Per-alias key derivation. One identity used to publish a single spendingCommitment for every
// alias it registered, which linked them all in the public registry and merged their
// notes into one balance.
describe("per-alias key derivation", () => {
  const root = rootFromMnemonic(
    "test test test test test test test test test test test junk",
  );
  const keysFor = (i?: number) => deriveKeysFromRoot(root, i);

  before(async () => { await init(); });

  it("gives each alias index a completely distinct key set", () => {
    const a = keysFor(0);
    const b = keysFor(1);
    expect(a.spendingCommitment).to.not.equal(b.spendingCommitment);
    expect(a.spendingPrivKey).to.not.equal(b.spendingPrivKey);
    expect(a.viewingPrivKey).to.not.equal(b.viewingPrivKey);
    expect(a.nullifierKey).to.not.equal(b.nullifierKey);
    expect(ethers.hexlify(a.encryption.publicKey))
      .to.not.equal(ethers.hexlify(b.encryption.publicKey));
  });

  it("is deterministic — the same index always rebuilds the same alias", () => {
    expect(keysFor(3).spendingCommitment).to.equal(keysFor(3).spendingCommitment);
    expect(ethers.hexlify(keysFor(3).encryption.publicKey))
      .to.equal(ethers.hexlify(keysFor(3).encryption.publicKey));
  });

  it("defaults to index 0", () => {
    expect(keysFor().spendingCommitment).to.equal(keysFor(0).spendingCommitment);
  });

  it("separates roots as well as aliases", () => {
    const other = rootFromMnemonic(generateMnemonic());
    expect(keysFor(0).spendingCommitment)
      .to.not.equal(deriveKeysFromRoot(other, 0).spendingCommitment);
  });

  it("no alias seed collides with the spending or viewing key", () => {
    // The trap this domain tag exists to avoid. With a two-input hash, alias 0's seed
    // would BE the spending private key and alias 1's the viewing key, so exposing one
    // would compromise every alias derived from it.
    const k = keysFor(0);
    for (const i of [0, 1, 2, 3]) {
      const derived = keysFor(i);
      expect(derived.spendingPrivKey).to.not.equal(k.viewingPrivKey);
      expect(derived.viewingPrivKey).to.not.equal(k.spendingPrivKey);
    }
  });

  it("spans many indices without collision", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) seen.add(keysFor(i).spendingCommitment.toString());
    expect(seen.size).to.equal(24);
  });

  it("keeps the spending commitment the Poseidon image of its private key", () => {
    // What the registry publishes and the circuit re-derives. If these ever disagree the
    // alias receives notes it cannot spend.
    for (const i of [0, 5]) {
      const k = keysFor(i);
      expect(k.spendingCommitment).to.equal(poseidonHash([k.spendingPrivKey]));
      expect(k.nullifierKey).to.equal(poseidonHash([k.viewingPrivKey]));
    }
  });
});
