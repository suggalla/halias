import { expect } from "chai";
import { ethers } from "ethers";
import { init, deriveKeysFromWallet, poseidonHash } from "../src/crypto";

// Per-alias key derivation. One EOA used to publish a single spendingPubkey for every
// alias it registered, which linked them all in the public registry and merged their
// notes into one balance.
describe("per-alias key derivation", () => {
  const w = new ethers.Wallet("0x" + "11".repeat(32));
  before(async () => { await init(); });

  it("gives each alias index a completely distinct key set", async () => {
    const a = await deriveKeysFromWallet(w as any, 0);
    const b = await deriveKeysFromWallet(w as any, 1);
    expect(a.spendingPubkey).to.not.equal(b.spendingPubkey);
    expect(a.spendingPrivKey).to.not.equal(b.spendingPrivKey);
    expect(a.viewingPrivKey).to.not.equal(b.viewingPrivKey);
    expect(a.nullifierKey).to.not.equal(b.nullifierKey);
    expect(ethers.hexlify(a.encryption.publicKey))
      .to.not.equal(ethers.hexlify(b.encryption.publicKey));
  });

  it("is deterministic — the same index always rebuilds the same alias", async () => {
    const a = await deriveKeysFromWallet(w as any, 3);
    const b = await deriveKeysFromWallet(w as any, 3);
    expect(a.spendingPubkey).to.equal(b.spendingPubkey);
    expect(ethers.hexlify(a.encryption.publicKey)).to.equal(ethers.hexlify(b.encryption.publicKey));
  });

  it("defaults to index 0", async () => {
    expect((await deriveKeysFromWallet(w as any)).spendingPubkey)
      .to.equal((await deriveKeysFromWallet(w as any, 0)).spendingPubkey);
  });

  it("separates wallets as well as aliases", async () => {
    const other = new ethers.Wallet("0x" + "22".repeat(32));
    expect((await deriveKeysFromWallet(w as any, 0)).spendingPubkey)
      .to.not.equal((await deriveKeysFromWallet(other as any, 0)).spendingPubkey);
  });

  it("no alias seed collides with the spending or viewing key", async () => {
    // The trap this domain tag exists to avoid. With a two-input hash, alias 0's seed
    // would BE the spending private key and alias 1's the viewing key, so exposing one
    // would compromise every alias derived from it.
    const k = await deriveKeysFromWallet(w as any, 0);
    for (const i of [0, 1, 2, 3]) {
      const derived = await deriveKeysFromWallet(w as any, i);
      expect(derived.spendingPrivKey).to.not.equal(k.viewingPrivKey);
      expect(derived.viewingPrivKey).to.not.equal(k.spendingPrivKey);
    }
  });

  it("spans many indices without collision", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) seen.add((await deriveKeysFromWallet(w as any, i)).spendingPubkey.toString());
    expect(seen.size).to.equal(24);
  });
});
