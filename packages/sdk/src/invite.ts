import { ethers } from "ethers";
import * as nacl from "tweetnacl";
import { poseidonHash } from "./crypto";

// Invite keys are derived deterministically from a single secret, so the whole invite
// fits in a link fragment and the claimer needs nothing else. Domain bytes match the
// wallet derivation in crypto.ts so the two schemes can never produce the same keypair.
export interface InviteKeys {
  spendingPrivKey:       bigint;
  viewingPrivKey:        bigint;
  spendingPubkey:        bigint;
  nullifierKey:          bigint;
  nullifierKeyHash:      bigint;
  blinding:              bigint;
  encryption:            { privateKey: Uint8Array; publicKey: Uint8Array };
  encryptionPubkeyField: bigint;
}

export function deriveInviteKeys(secret: bigint): InviteKeys {
  const secretBytes = ethers.getBytes(ethers.toBeHex(secret, 32));

  const spendingPrivKey = poseidonHash([secret, 0n]);
  const viewingPrivKey  = poseidonHash([secret, 1n]);
  const blinding        = poseidonHash([secret, 2n]);
  const nullifierKey    = poseidonHash([viewingPrivKey]);

  // X25519 encryption key: domain byte 0x02, same construction as the wallet path.
  const encPriv    = ethers.getBytes(ethers.keccak256(ethers.concat([secretBytes, new Uint8Array([2])])));
  const encKeypair = nacl.box.keyPair.fromSecretKey(encPriv);

  return {
    spendingPrivKey,
    viewingPrivKey,
    spendingPubkey:        poseidonHash([spendingPrivKey]),
    nullifierKey,
    nullifierKeyHash:      poseidonHash([nullifierKey, 1n]),
    blinding,
    encryption:            { privateKey: encPriv, publicKey: encKeypair.publicKey },
    encryptionPubkeyField: BigInt(ethers.hexlify(encKeypair.publicKey)),
  };
}

// Relayer fee as Halias._decodeRelayerFee reads it: address in the high 160 bits,
// fee in wei in the low 96. Zero means no relayer and the ordinary self-submitted path.
export function packRelayerFee(relayer: string, feeWei: bigint): string {
  if (feeWei >= 1n << 96n) throw new Error("relayer fee exceeds uint96");
  if (feeWei > 0n && relayer === ethers.ZeroAddress) throw new Error("relayer fee requires a relayer address");
  return ethers.toBeHex((BigInt(relayer) << 96n) | feeWei, 32);
}

export function unpackRelayerFee(externalData: string): { relayer: string; fee: bigint } {
  const v = BigInt(externalData);
  return {
    relayer: ethers.getAddress(ethers.toBeHex(v >> 96n, 20)),
    fee:     v & ((1n << 96n) - 1n),
  };
}

// Invite link payload. The secret is the whole invite — treat it like cash.
export function encodeInviteCode(secret: bigint): string {
  return ethers.toBeHex(secret, 32);
}

export function decodeInviteCode(code: string): bigint {
  const hex = code.startsWith("0x") ? code : "0x" + code;
  const v = BigInt(hex);
  if (v === 0n) throw new Error("Invalid invite code");
  return v;
}
