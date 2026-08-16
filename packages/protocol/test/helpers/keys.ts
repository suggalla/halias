import { ethers } from "ethers";
import nacl from "tweetnacl";

export interface NaclKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateEncKeypair(privateKey?: Uint8Array): NaclKeypair {
  if (privateKey) return nacl.box.keyPair.fromSecretKey(privateKey);
  return nacl.box.keyPair();
}

// ── NaCl box output encryption (mirrors SDK crypto.ts) ───────────
//
// Blob: version(1) | viewTag(1) | ephPub(32) | nonce(24) | ciphertext(80) = 138 bytes

const BLOB_VERSION = 0x01;

export interface EncryptedOutput {
  ephemeralPub: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function encryptOutput(
  blinding: bigint,
  amount: bigint,
  recipientPub: Uint8Array,
): { encrypted: EncryptedOutput; viewTag: number } {
  const ephemeral = nacl.box.keyPair();
  const sharedKey = nacl.box.before(recipientPub, ephemeral.secretKey);
  const viewTag = sharedKey[0];
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const message = new Uint8Array(64);
  message.set(ethers.getBytes(ethers.toBeHex(blinding, 32)), 0);
  message.set(ethers.getBytes(ethers.toBeHex(amount, 32)), 32);

  const ciphertext = nacl.box.after(message, nonce, sharedKey);
  return { encrypted: { ephemeralPub: ephemeral.publicKey, nonce, ciphertext }, viewTag };
}

export function encodeOutputBlob(encrypted: EncryptedOutput, viewTag: number): string {
  const buf = new Uint8Array(138);
  buf[0] = BLOB_VERSION;
  buf[1] = viewTag;
  buf.set(encrypted.ephemeralPub, 2);
  buf.set(encrypted.nonce, 34);
  buf.set(encrypted.ciphertext, 58);
  return ethers.hexlify(buf);
}
