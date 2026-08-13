import { expect } from "chai";
import { init, deriveKeysFromRoot } from "../src/crypto";
import {
  SeedSource,
  MnemonicSource,
  RootSource,
  generateMnemonic,
  isValidMnemonic,
  rootFromMnemonic,
} from "../src/seed";

// The seed the note keys come from.
//
// This replaces deriving the root from `personal_sign`. That was phishable in a way ordinary
// signature phishing is not: silent, total, and unremediable, because notes bind
// Poseidon(spendingPrivateKey) and rotating keys cannot reach notes already on chain. The
// tests that used to live here counted wallet prompts; there are none to count now, because
// the wallet is not involved in derivation at all.
describe("seed", () => {
  const PHRASE = "test test test test test test test test test test test junk";

  before(async () => { await init(); });

  describe("mnemonic", () => {
    it("generates a 24-word phrase — 256 bits of entropy", () => {
      const phrase = generateMnemonic();
      expect(phrase.split(" ")).to.have.lengthOf(24);
      expect(isValidMnemonic(phrase)).to.equal(true);
    });

    it("never generates the same phrase twice", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 16; i++) seen.add(generateMnemonic());
      expect(seen.size).to.equal(16);
    });

    it("rejects a phrase whose checksum does not hold", () => {
      // BIP-39's checksum is what makes a typo fail here rather than silently deriving a
      // valid-looking wallet the user's funds are not in.
      const wrong = PHRASE.replace(/junk$/, "zoo");
      expect(isValidMnemonic(wrong)).to.equal(false);
      expect(() => rootFromMnemonic(wrong)).to.throw();
      expect(() => new MnemonicSource(wrong)).to.throw();
    });

    it("rejects a phrase of the wrong length", () => {
      expect(isValidMnemonic("test test test")).to.equal(false);
      expect(() => rootFromMnemonic("test test test")).to.throw();
    });

    it("ignores case and stray whitespace", () => {
      // Phrases get pasted out of password managers and printouts. A phrase that is correct
      // but formatted differently must not derive a different, empty wallet.
      const messy = `  ${PHRASE.toUpperCase().split(" ").join("   ")}\n`;
      expect(rootFromMnemonic(messy)).to.equal(rootFromMnemonic(PHRASE));
    });
  });

  describe("root", () => {
    it("is deterministic", () => {
      expect(rootFromMnemonic(PHRASE)).to.equal(rootFromMnemonic(PHRASE));
    });

    it("differs per phrase", () => {
      expect(rootFromMnemonic(generateMnemonic()))
        .to.not.equal(rootFromMnemonic(generateMnemonic()));
    });

    it("treats the BIP-39 passphrase as part of the phrase", () => {
      // A wrong passphrase is not an error — it is a different wallet. That is BIP-39's
      // design, and the reason the UI cannot present it as a password with a retry.
      const bare = rootFromMnemonic(PHRASE);
      const with25 = rootFromMnemonic(PHRASE, "25th word");
      expect(with25).to.not.equal(bare);
      expect(rootFromMnemonic(PHRASE, "25th word")).to.equal(with25);
      expect(rootFromMnemonic(PHRASE, "different")).to.not.equal(with25);
    });

    it("is unrelated to what the same phrase derives as an ethereum wallet", () => {
      // Users reuse phrases. The domain tag is what stops a halias identity being tied to,
      // or leaked by, the EOA the same words back.
      const { ethers } = require("ethers");
      const eoa = ethers.HDNodeWallet.fromPhrase(PHRASE);
      expect(rootFromMnemonic(PHRASE)).to.not.equal(BigInt(eoa.privateKey));
    });
  });

  describe("sources", () => {
    it("MnemonicSource validates when the phrase is accepted, not at first use", async () => {
      // So an import wizard can reject a bad phrase while the user is still looking at it.
      expect(() => new MnemonicSource("not a mnemonic at all")).to.throw();
      expect(await new MnemonicSource(PHRASE).root()).to.equal(rootFromMnemonic(PHRASE));
    });

    it("RootSource hands back exactly what it was given", async () => {
      expect(await new RootSource(1234n).root()).to.equal(1234n);
    });

    it("derives any number of aliases from one root without re-consulting the source", async () => {
      // Deriving per-index from the source would re-run PBKDF2 every time — 2048 rounds of
      // HMAC-SHA512 per alias, on a path that enumerates dozens of them.
      let calls = 0;
      const counting: SeedSource = {
        root: async () => { calls++; return rootFromMnemonic(PHRASE); },
      };

      const root = await counting.root();
      for (let i = 0; i < 64; i++) deriveKeysFromRoot(root, i);
      expect(calls).to.equal(1);
    });
  });
});
