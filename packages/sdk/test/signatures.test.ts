import { expect } from "chai";
import { ethers } from "ethers";
import { init, deriveRoot, deriveKeysFromRoot, deriveKeysFromWallet } from "../src/crypto";

// How many times the wallet is asked to sign.
//
// This is a correctness property, not a nicety. Key derivation needs a signature, and every
// code path that builds a client can trigger one — so a refactor that looks harmless turns
// registering an alias into thirty-five MetaMask prompts. It happened three times: once when
// enumeration derived per-index from the signer, once when alias discovery re-signed on every
// reload, and once when a wallet holding no aliases never cached the root at all.
//
// Nothing else catches it. It typechecks, every unit test passes, and the only symptom is a
// user staring at a prompt loop.
describe("signature count", () => {
  // A signer that counts, and refuses to be the reason a test passes by accident.
  function countingSigner(key = "0x" + "11".repeat(32)) {
    const w = new ethers.Wallet(key);
    let calls = 0;
    return {
      signer: {
        signMessage: (m: string) => { calls++; return w.signMessage(m); },
        getAddress: () => w.getAddress(),
      } as any,
      get calls() { return calls; },
    };
  }

  before(async () => { await init(); });

  it("derives a root with exactly one signature", async () => {
    const s = countingSigner();
    await deriveRoot(s.signer);
    expect(s.calls).to.equal(1);
  });

  it("derives any number of aliases from that root with none", async () => {
    const s = countingSigner();
    const root = await deriveRoot(s.signer);
    for (let i = 0; i < 64; i++) deriveKeysFromRoot(root, i);
    expect(s.calls).to.equal(1);
  });

  it("still produces the same keys either way", async () => {
    // The fast path must not be a different derivation, or a cached root would silently
    // yield a different identity from a fresh one.
    const s = countingSigner();
    const root = await deriveRoot(s.signer);
    for (const i of [0, 1, 7]) {
      const viaRoot = deriveKeysFromRoot(root, i);
      const viaWallet = await deriveKeysFromWallet(s.signer, i);
      expect(viaRoot.spendingPubkey).to.equal(viaWallet.spendingPubkey);
      expect(ethers.hexlify(viaRoot.encryption.publicKey))
        .to.equal(ethers.hexlify(viaWallet.encryption.publicKey));
    }
  });

  it("the convenience wrapper signs once per call — which is why enumeration must not use it", async () => {
    // Documents the trap rather than forbidding it: deriveKeysFromWallet is correct for a
    // single alias and catastrophic in a loop.
    const s = countingSigner();
    for (let i = 0; i < 5; i++) await deriveKeysFromWallet(s.signer, i);
    expect(s.calls).to.equal(5);
  });
});
