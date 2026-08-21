import { expect } from "chai";
import { ethers } from "ethers";
import { normalizeAlias, fullAlias, isValidAlias, InvalidAliasError,
  aliasPrefix, ALIAS_PREFIX_BITS } from "../src/alias";

// The registry keys on keccak(name + ".hls"), so normalisation is not cosmetic: two inputs
// a user considers the same must produce the same hash, or their money goes to an alias
// nobody can reach.
describe("alias normalisation", () => {
  it("accepts the forms people actually paste", () => {
    for (const input of ["alice", "alice.hls", "ALICE", "Alice.HLS", "  alice.hls  "]) {
      expect(normalizeAlias(input)).to.equal("alice");
    }
  });

  it("strips a repeated suffix rather than half of it", () => {
    // The bug this module exists for. `replace(/\.hls$/, "")` removed one suffix, so
    // "alice.hls.hls" became "alice.hls" and registered "alice.hls.hls" — a distinct alias
    // that renders identically to "alice.hls" and cannot be typed back.
    expect(normalizeAlias("alice.hls.hls")).to.equal("alice");
    expect(normalizeAlias("alice.hls.hls.hls")).to.equal("alice");
    expect(fullAlias("alice.hls.hls")).to.equal("alice.hls");
  });

  it("rejects interior dots — an alias is one label", () => {
    for (const bad of ["a.b", "alice.hls.eth", "sub.alice"]) {
      expect(() => normalizeAlias(bad)).to.throw(InvalidAliasError);
    }
  });

  it("rejects an empty name", () => {
    for (const bad of ["", "   ", ".hls", "  .hls  "]) {
      expect(() => normalizeAlias(bad)).to.throw(InvalidAliasError);
    }
  });

  it("rejects characters that make two names look alike", () => {
    // Homoglyphs are the residual address-poisoning risk once hex is gone; the cheapest
    // defence is not accepting the characters in the first place.
    for (const bad of ["аlice", "ali ce", "alice!", "ALICE_1", "alice@hls", "аliсe"]) {
      expect(isValidAlias(bad), bad).to.equal(false);
    }
    // Surrounding whitespace is a paste artefact, not a different name — trimmed, not refused.
    expect(normalizeAlias("  alice  ")).to.equal("alice");
  });

  it("allows letters and digits, and nothing else", () => {
    expect(normalizeAlias("myalias1")).to.equal("myalias1");
    // Hyphens were allowed once. They are not, because `alice-bank` and `alicebank` are two
    // names that survive being spoken as one.
    expect(isValidAlias("my-alias")).to.equal(false);
    expect(isValidAlias("-alice")).to.equal(false);
    expect(isValidAlias("alice-")).to.equal(false);
    // Unicode never was, and is what a homoglyph attack needs.
    expect(isValidAlias("аlice")).to.equal(false);   // Cyrillic а
    expect(isValidAlias("alice_bank")).to.equal(false);
  });

  it("bounds the length", () => {
    expect(isValidAlias("a")).to.equal(true);
    expect(isValidAlias("a".repeat(63))).to.equal(true);
    expect(isValidAlias("a".repeat(64))).to.equal(false);
  });

  it("is idempotent — normalising twice changes nothing", () => {
    for (const input of ["Alice.HLS", "  myalias.hls.hls  ", "x9"]) {
      const once = normalizeAlias(input);
      expect(normalizeAlias(once)).to.equal(once);
    }
  });
});

// The prefix index.
//
// A group is the top ALIAS_PREFIX_BITS of the raw alias hash, and the client computes it
// locally so that resolving a name never puts the name on the wire. Everything here is about
// the derivation agreeing with HaliasRegistry._aliasPrefix — a disagreement does not throw,
// it fetches a group the alias is not in, which is indistinguishable from an unregistered
// name. The round trip against a live contract is PrefixIndex.test.ts in the protocol package.
describe("alias prefix index", function () {
  const hash = (name: string) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(name)));

  it("takes the top 12 bits, which is what the contract shifts for", function () {
    expect(ALIAS_PREFIX_BITS).to.equal(12);
    // The contract computes uint16(uint256(aliasHash) >> (256 - 12)). Pinned against a hand
    // worked value rather than by repeating the shift, which would pass on a wrong constant.
    const top12 = (1n << 12n) - 1n;
    expect(aliasPrefix(top12 << 244n)).to.equal(4095);
    expect(aliasPrefix(1n << 244n)).to.equal(1);
  });

  it("depends on the top bits and only the top bits", function () {
    const base = 0xabcn << 244n;
    // Half one: every low bit set must not disturb the group. A prefix that moved with the
    // remainder would scatter one group across many.
    expect(aliasPrefix(base)).to.equal(0xabc);
    expect(aliasPrefix(base + ((1n << 244n) - 1n))).to.equal(0xabc);

    // Half two, and the half that discriminates: flipping the *lowest* bit inside the prefix
    // must move the group. Without this an implementation that shifted one bit too far passes
    // the check above — it ignores the low bits, it just ignores one of the real ones too.
    expect(aliasPrefix((0xabcn ^ 1n) << 244n)).to.equal(0xabd);
    expect(aliasPrefix(0x800n << 244n)).to.equal(0x800);
  });

  it("puts the extremes in the first and last group", function () {
    expect(aliasPrefix(0n)).to.equal(0);
    expect(aliasPrefix((1n << 256n) - 1n)).to.equal(4095);
  });

  it("spreads names across the table rather than piling them into one group", function () {
    // The assertion that catches a degenerate implementation. A prefix that always returned 0,
    // or masked the wrong end of the hash, still lands in range and still passes a
    // same-input-same-output check — it just puts every alias in one group, which is a
    // correctness bug and the end of the k-anonymity the index exists for.
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const p = aliasPrefix(hash(`name${i}.hls`));
      expect(p).to.be.at.least(0);
      expect(p).to.be.below(1 << ALIAS_PREFIX_BITS);
      seen.add(p);
    }
    // 200 draws over 4096 groups: colliding down to 100 or fewer distinct groups has
    // probability far below anything that will be seen, so this is not a flaky bound.
    expect(seen.size).to.be.above(100);
  });

  it("refuses a value that is not a 256-bit hash", function () {
    // Guards the caller who passes an SMT key or a negative. Reducing into the field changes
    // the top bits of any hash above the prime, which would silently select another group.
    expect(() => aliasPrefix(-1n)).to.throw(/256-bit/);
    expect(() => aliasPrefix(1n << 256n)).to.throw(/256-bit/);
  });
});
