import { ethers } from "ethers";
import * as nacl from "tweetnacl";
import { poseidonHash } from "./crypto";

// Invite keys are derived deterministically from a single secret, so the whole invite
// fits in a link fragment and the claimer needs nothing else. Domain bytes match the
// wallet derivation in crypto.ts so the two schemes can never produce the same keypair.
export interface InviteKeys {
  spendingPrivKey:       bigint;
  viewingPrivKey:        bigint;
  spendingCommitment:        bigint;
  nullifierKey:          bigint;
  nullifierKeyHash:      bigint;
  blinding:              bigint;
  encryption:            { privateKey: Uint8Array; publicKey: Uint8Array };
  encryptionPubkeyField: bigint;
  /// Holds the temporary alias an invite registers. Derived from the secret like everything
  /// else here, so the inviter's own wallet does not appear as the owner of a throwaway
  /// account — which would tie them to the invite in public state.
  ownerAddress:          string;
  /// The key behind {ownerAddress}. Exposed because redeeming an invite is authorised by a
  /// signature from it: holding the code has to be what entitles someone to the registration
  /// the inviter paid forward, and the code is all a claimer ever receives.
  ownerPrivKey:          string;
}

/// Domain tag for invite secrets. "INVT" ascii (0x494e5654), verified by derivation in the
/// SDK tests rather than trusted as a literal — a transposed digit in a domain constant is
/// invisible on its own, and this repo has already had one comment describe the wrong word.
export const INVITE_DOMAIN = 0x494e5654n;

/// The secret behind invite number `index`, derived from the creator's root.
///
/// Deterministic, and that is the whole point. A random secret exists only in the response
/// that returned it: close the window without saving the code and the funds are stranded, on
/// the one flow whose purpose is giving money to someone who has none. Deriving it from the
/// root instead means the creator can recompute it on any device holding the phrase — so
/// invites can be listed, their status checked, and unclaimed ones taken back.
///
/// The claimer never sees the root. They are handed one secret, which reveals nothing about
/// the others: Poseidon is preimage-resistant, so `secret(i)` gives no information about
/// `root`, and therefore none about `secret(j)`.
export function inviteSecretAt(root: bigint, index: number): bigint {
  return poseidonHash([root, BigInt(index), INVITE_DOMAIN]);
}

/// The registry entry an invite's note is paid to.
///
/// Must match `HaliasController._recordKeysOnly`, which forces exactly this value and rejects
/// anything else. An entry whose identity the caller cannot choose is an entry that can never
/// be a name — which is what lets it be registered without a fee of its own.
///
/// Drift here is silent and expensive: the registration would revert as NotAnInviteEntry, or
/// worse, succeed at a hash the claimer cannot recompute, stranding the note.
export function inviteEntryHash(spendingCommitment: bigint): string {
  return ethers.keccak256(ethers.toBeHex(spendingCommitment, 32));
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
    spendingCommitment:        poseidonHash([spendingPrivKey]),
    nullifierKey,
    nullifierKeyHash:      poseidonHash([nullifierKey, 1n]),
    blinding,
    encryption:            { privateKey: encPriv, publicKey: encKeypair.publicKey },
    encryptionPubkeyField: BigInt(ethers.hexlify(encKeypair.publicKey)),
    ownerAddress:          ethers.computeAddress(ownerPriv),
    ownerPrivKey:          ownerPriv,
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
