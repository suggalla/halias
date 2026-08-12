import { expect } from "chai";
import { normalizeAlias, fullAlias, isValidAlias, InvalidAliasError } from "../src/alias";

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

  it("allows interior hyphens but not leading or trailing ones", () => {
    expect(normalizeAlias("my-alias-1")).to.equal("my-alias-1");
    expect(isValidAlias("-alice")).to.equal(false);
    expect(isValidAlias("alice-")).to.equal(false);
  });

  it("bounds the length", () => {
    expect(isValidAlias("a")).to.equal(true);
    expect(isValidAlias("a".repeat(63))).to.equal(true);
    expect(isValidAlias("a".repeat(64))).to.equal(false);
  });

  it("is idempotent — normalising twice changes nothing", () => {
    for (const input of ["Alice.HLS", "  my-alias.hls.hls  ", "x9"]) {
      const once = normalizeAlias(input);
      expect(normalizeAlias(once)).to.equal(once);
    }
  });
});
