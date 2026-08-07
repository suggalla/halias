// Cryptographically secure randomness that works in both runtimes.
//
// The SDK previously imported node:crypto, which Vite externalises for the browser — the
// app failed at connect with "Module crypto has been externalized". globalThis.crypto is
// the Web Crypto API, present in browsers and in Node 18+, so one implementation serves
// both without a polyfill or a bundler alias.
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const webcrypto = (globalThis as any).crypto;
  if (!webcrypto?.getRandomValues) {
    throw new Error("No secure randomness available (needs Web Crypto: browser or Node 18+)");
  }
  webcrypto.getRandomValues(out);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A random field-sized scalar. 31 bytes stays comfortably below the BN254 prime, so no
// rejection sampling is needed and the value is always a valid field element.
export function randomFieldElement(): bigint {
  return BigInt("0x" + toHex(randomBytes(31)));
}
