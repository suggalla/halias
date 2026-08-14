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
  /// Holds the temporary alias an invite registers. Derived from the secret like everything
  /// else here, so the inviter's own wallet does not appear as the owner of a throwaway
  /// account — which would tie them to the invite in public state.
  ownerAddress:          string;
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

  // Ownership key: domain byte 0x03, matching the wallet path.
  const ownerPriv = ethers.keccak256(ethers.concat([secretBytes, new Uint8Array([3])]));

  return {
    spendingPrivKey,
    viewingPrivKey,
    spendingPubkey:        poseidonHash([spendingPrivKey]),
    nullifierKey,
    nullifierKeyHash:      poseidonHash([nullifierKey, 1n]),
    blinding,
    encryption:            { privateKey: encPriv, publicKey: encKeypair.publicKey },
    encryptionPubkeyField: BigInt(ethers.hexlify(encKeypair.publicKey)),
    ownerAddress:          ethers.computeAddress(ownerPriv),
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
