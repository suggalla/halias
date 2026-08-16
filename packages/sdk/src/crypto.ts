import { ethers } from "ethers";
import nacl from "tweetnacl";

const { buildPoseidon } = require("circomlibjs");

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

export interface Signer {
  signMessage(message: string): Promise<string>;
}

const DERIVATION_MESSAGE =
  "halias key derivation v1\n\nSign this message to derive your halias keys.\nThis does NOT authorize any transaction.";

export async function init(): Promise<void> {
  const p = await buildPoseidon();
  poseidon = p;
  F = poseidon.F;
}

export function poseidonHash(inputs: bigint[]): bigint {
  if (!poseidon) throw new Error("Call init() first");
  return F.toObject(poseidon(inputs));
}

export async function deriveKeysFromWallet(signer: Signer): Promise<HaliasKeys> {
  const signature = await signer.signMessage(DERIVATION_MESSAGE);
  const seedBytes = ethers.getBytes(ethers.keccak256(ethers.getBytes(signature)));
  const seed = BigInt(ethers.hexlify(seedBytes));

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
// Blob layout (138 bytes total):
//   version    [0]        1 byte   — 0x01 (NaCl box); 0x00 reserved as invalid
//   viewTag    [1]        1 byte   — first byte of shared key, fast pre-reject
//   ephPub     [2..33]   32 bytes  — X25519 ephemeral public key
//   nonce      [34..57]  24 bytes  — XSalsa20 nonce
//   ciphertext [58..137] 80 bytes  — XSalsa20-Poly1305 of (blinding || amount)

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
): { encrypted: EncryptedOutput; viewTag: number } {
  const ephemeral = nacl.box.keyPair();
  const sharedKey = nacl.box.before(recipientPub, ephemeral.secretKey);
  const viewTag = sharedKey[0];
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const message = new Uint8Array(64);
  message.set(ethers.getBytes(ethers.toBeHex(blinding, 32)), 0);
  message.set(ethers.getBytes(ethers.toBeHex(amount, 32)), 32);

  const ciphertext = nacl.box.after(message, nonce, sharedKey);
  return {
    encrypted: { ephemeralPub: ephemeral.publicKey, nonce, ciphertext },
    viewTag,
  };
}

export function decryptOutput(
  encrypted: EncryptedOutput,
  encPrivKey: Uint8Array,
): { blinding: bigint; amount: bigint; viewTag: number } | null {
  try {
    const sharedKey = nacl.box.before(encrypted.ephemeralPub, encPrivKey);
    const viewTag = sharedKey[0];
    const message = nacl.box.open.after(encrypted.ciphertext, encrypted.nonce, sharedKey);
    if (!message) return null;
    return {
      blinding: BigInt(ethers.hexlify(message.slice(0, 32))),
      amount:   BigInt(ethers.hexlify(message.slice(32, 64))),
      viewTag,
    };
  } catch {
    return null;
  }
}

// Optimised scanner helper: check view tag BEFORE symmetric decryption.
// ECDH (nacl.box.before) is unavoidable — we need the shared key to read the tag.
// This skips the XSalsa20-Poly1305 open + Poseidon commitment check for ~255/256 notes.
export function tryDecryptOutput(
  decoded: { viewTag: number; encrypted: EncryptedOutput },
  encPrivKey: Uint8Array,
): { blinding: bigint; amount: bigint } | null {
  try {
    const sharedKey = nacl.box.before(decoded.encrypted.ephemeralPub, encPrivKey);
    if (sharedKey[0] !== decoded.viewTag) return null;
    const message = nacl.box.open.after(decoded.encrypted.ciphertext, decoded.encrypted.nonce, sharedKey);
    if (!message) return null;
    return {
      blinding: BigInt(ethers.hexlify(message.slice(0, 32))),
      amount:   BigInt(ethers.hexlify(message.slice(32, 64))),
    };
  } catch {
    return null;
  }
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

export function decodeOutputBlob(blob: string): { viewTag: number; encrypted: EncryptedOutput } | null {
  if (blob === "0x" || blob.length < 10) return null;
  try {
    const buf = ethers.getBytes(blob);
    if (buf.length < 138 || buf[0] !== BLOB_VERSION) return null;
    return {
      viewTag: buf[1],
      encrypted: {
        ephemeralPub: buf.slice(2, 34),
        nonce:        buf.slice(34, 58),
        ciphertext:   buf.slice(58, 138),
      },
    };
  } catch {
    return null;
  }
}
