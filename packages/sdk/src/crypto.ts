import { ethers } from "ethers";
import nacl from "tweetnacl";

// @ts-expect-error — circomlibjs ships no types. An import rather than a require so this module
// is valid ESM: bundlers can then read this source directly instead of a CommonJS build,
// which is what stops the browser serving a stale copy after every SDK rebuild.
import { buildPoseidon } from "circomlibjs";

let poseidon: any;
let F: any;

export interface NaclKeypair {
  privateKey: Uint8Array;  // 32 bytes X25519
  publicKey: Uint8Array;   // 32 bytes X25519
}

export interface HaliasKeys {
  spendingPrivKey: bigint;  // private circuit witness
  spendingPubkey: bigint;   // Poseidon(spendingPrivKey) — registered on-chain
  viewingPrivKey: bigint;   // private circuit witness
  nullifierKey: bigint;     // Poseidon(viewingPrivKey) — nk: baked into commitments + nullifiers
  encryption: NaclKeypair;  // X25519 keypair for NaCl box output encryption
}

// Domain tag for per-alias seeds. Three inputs, so it cannot collide with the two-input
// hashes below: `Poseidon(seed, 0)` and `Poseidon(seed, 1)` are already the spending and
// viewing private keys, and reusing that shape would make alias 0's seed *be* your
// spending key. Same reasoning as NULLIFIER_DOMAIN in the circuit.
//
// "HALS" as ascii.
const ALIAS_DOMAIN = 1212371027n;

export async function init(): Promise<void> {
  const p = await buildPoseidon();
  poseidon = p;
  F = poseidon.F;
}

export function poseidonHash(inputs: bigint[]): bigint {
  if (!poseidon) throw new Error("Call init() first");
  return F.toObject(poseidon(inputs));
}

/// Derive the keys for one alias.
///
/// `aliasIndex` separates aliases held by the same wallet: each gets its own spending key,
/// nullifier key and encryption key, so the registry no longer publishes one shared pubkey
/// across every name an EOA owns. One signature still unlocks all of them, so the prompt
/// count does not change.
///
/// This does NOT make aliases unlinkable on its own — `HaliasController.ownerOf` still names
/// the same EOA for each. Separating those requires holding them from different addresses;
/// see multi-alias-flow.md. What it does fix is note separation: distinct balances,
/// distinct decryption, and no shared key in the registry.
///
/// The root comes from a {SeedSource} — see seed.ts. It is deliberately unrelated to the
/// wallet that broadcasts, so no signature can reproduce it.
export function deriveKeysFromRoot(root: bigint, aliasIndex: number = 0): HaliasKeys {
  // One seed per alias, hashed apart from the root before any key is taken from it.
  const seed = poseidonHash([root, BigInt(aliasIndex), ALIAS_DOMAIN]);
  const seedBytes = ethers.getBytes(ethers.toBeHex(seed, 32));

  const spendingPrivKey = poseidonHash([seed, 0n]);
  const viewingPrivKey  = poseidonHash([seed, 1n]);

  // X25519 encryption key: domain byte 0x02
  const encPriv = ethers.getBytes(
    ethers.keccak256(ethers.concat([seedBytes, new Uint8Array([2])]))
  );
  const encKeypair = nacl.box.keyPair.fromSecretKey(encPriv);

  return {
    spendingPrivKey,
    spendingPubkey: poseidonHash([spendingPrivKey]),
    viewingPrivKey,
    nullifierKey:   poseidonHash([viewingPrivKey]),
    encryption:     { privateKey: encPriv, publicKey: encKeypair.publicKey },
  };
}

// ── NaCl box output encryption ────────────────────────────────
//
// Blob layout, version 1 (137 bytes total):
//   version    [0]        1 byte   — 0x01; 0x00 reserved as invalid
//   ephPub     [1..32]   32 bytes  — X25519 ephemeral public key
//   nonce      [33..56]  24 bytes  — XSalsa20 nonce
//   ciphertext [57..136] 80 bytes  — XSalsa20-Poly1305 of (blinding || amount)
//
// No view tag, deliberately. The obvious optimisation — a byte of the shared secret checked
// before the AEAD open, as in Monero v0.18 and Zcash Orchard — was implemented, measured,
// and removed: X25519 shared-secret derivation is 541 µs per note and 99.3% of
// trial-decryption cost, and the tag cannot skip it because the tag comes from that same
// secret. Measured saving 0.1%. Monero and Orchard gain 30-40% because they still do a
// scalar multiplication and point addition afterwards; here everything after the ECDH is one
// 64-byte secretbox open, about 4 µs.
//
// Scan cost is therefore dominated by ECDH, and the things that help are incremental
// scanning, persisting decrypted results, and moving the work off the main thread.
//
// The version byte stays even with one version: it makes a future format change fail closed
// rather than misparse a nonce as ciphertext.

const BLOB_VERSION = 0x01;

export interface EncryptedOutput {
  ephemeralPub: Uint8Array;  // 32 bytes
  nonce: Uint8Array;         // 24 bytes
  ciphertext: Uint8Array;    // 80 bytes (64 plaintext + 16 MAC)
}

export function encryptOutput(
  blinding: bigint,
  amount: bigint,
  recipientPub: Uint8Array,
): EncryptedOutput {
  const ephemeral = nacl.box.keyPair();
  const sharedKey = nacl.box.before(recipientPub, ephemeral.secretKey);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const message = new Uint8Array(64);
  message.set(ethers.getBytes(ethers.toBeHex(blinding, 32)), 0);
  message.set(ethers.getBytes(ethers.toBeHex(amount, 32)), 32);

  const ciphertext = nacl.box.after(message, nonce, sharedKey);
  return { ephemeralPub: ephemeral.publicKey, nonce, ciphertext };
}

export function decryptOutput(
  encrypted: EncryptedOutput,
  encPrivKey: Uint8Array,
): { blinding: bigint; amount: bigint } | null {
  try {
    const sharedKey = nacl.box.before(encrypted.ephemeralPub, encPrivKey);
    const message = nacl.box.open.after(encrypted.ciphertext, encrypted.nonce, sharedKey);
    if (!message) return null;
    return {
      blinding: BigInt(ethers.hexlify(message.slice(0, 32))),
      amount:   BigInt(ethers.hexlify(message.slice(32, 64))),
    };
  } catch {
    return null;
  }
}

/// Scanner helper. Identical to {decryptOutput} — kept as a separate name because callers
/// read better for it, not because it does anything different.
export const tryDecryptOutput = decryptOutput;

export function encodeOutputBlob(encrypted: EncryptedOutput): string {
  const buf = new Uint8Array(137);
  buf[0] = BLOB_VERSION;
  buf.set(encrypted.ephemeralPub, 1);
  buf.set(encrypted.nonce, 33);
  buf.set(encrypted.ciphertext, 57);
  return ethers.hexlify(buf);
}

export function decodeOutputBlob(blob: string): EncryptedOutput | null {
  if (blob === "0x" || blob.length < 10) return null;
  try {
    const buf = ethers.getBytes(blob);
    if (buf.length < 137 || buf[0] !== BLOB_VERSION) return null;
    return {
      ephemeralPub: buf.slice(1, 33),
      nonce:        buf.slice(33, 57),
      ciphertext:   buf.slice(57, 137),
    };
  } catch {
    return null;
  }
}
