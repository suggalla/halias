import { expect } from "chai";
import { ethers } from "ethers";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CONTRACT_ERRORS } from "../src/errors";

// The custom-error list, checked against the contracts that declare them.
//
// A custom error reaches a wallet as four bytes and nothing else, so an error missing from
// this list is reported as "unknown custom error" — the message is lost at exactly the moment
// someone needs it. That failure is silent: nothing throws, no test goes red, the text simply
// stops appearing. It has already happened once, to all four reservation errors, which is why
// the list is generated and why this compares it against the source rather than trusting it.
const CONTRACTS = join(__dirname, "../../protocol/contracts");

function solFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return solFiles(p);
    return p.endsWith(".sol") ? [p] : [];
  });
}

function declaredInSource(): Map<string, string> {
  const out = new Map<string, string>();
  // Mocks declare errors that exist only to be triggered by tests, and generated verifiers
  // declare none — the same exclusions the generator makes.
  const files = solFiles(CONTRACTS)
    .filter((f) => !f.includes("mocks") && !f.endsWith("Verifier.sol"));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/error\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*;/g)) {
      const params = m[2].trim() === "" ? [] : m[2].split(",").map((a) => a.trim().split(/\s+/)[0]);
      out.set(`${m[1]}(${params.join(",")})`, f);
    }
  }
  return out;
}

describe("contract error list", () => {
  const declared = declaredInSource();
  const listed = new Set(CONTRACT_ERRORS.map((f) => f.replace(/^error\s+/, "")));

  it("covers every error the contracts declare", () => {
    const missing = [...declared.keys()].filter((sig) => !listed.has(sig));
    expect(missing, `run: cd packages/protocol && npm run gen:errors`).to.deep.equal([]);
  });

  it("declares nothing the contracts do not", () => {
    // A stale entry is harmless at runtime but means the file was hand-edited, which is the
    // habit that lost the reservation errors in the first place.
    const extra = [...listed].filter((sig) => !declared.has(sig));
    expect(extra).to.deep.equal([]);
  });

  it("parses as ABI fragments, which is the only thing ethers will accept", () => {
    expect(() => new ethers.Interface(CONTRACT_ERRORS as string[])).to.not.throw();
  });

  it("decodes the reverts registration can actually produce", () => {
    // The four that were missing, pinned by selector. These are the ones a user meets while
    // registering, and each has to survive as a name rather than four bytes.
    const iface = new ethers.Interface(CONTRACT_ERRORS as string[]);
    for (const name of ["ReservationPending", "ReservationTooNew", "ReservationExpired", "NoReservation"]) {
      const selector = ethers.id(`${name}()`).slice(0, 10);
      expect(iface.parseError(selector)?.name, `${name} (${selector})`).to.equal(name);
    }
  });

  it("assigns a distinct selector to every error", () => {
    // Two errors sharing four bytes would decode as whichever the interface met first, and
    // the user would be told the wrong thing with full confidence.
    const bySelector = new Map<string, string>();
    for (const sig of listed) {
      const sel = ethers.id(sig).slice(0, 10);
      expect(bySelector.has(sel), `${sig} collides with ${bySelector.get(sel)}`).to.equal(false);
      bySelector.set(sel, sig);
    }
  });
});
