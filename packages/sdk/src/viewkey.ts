import { ethers } from "ethers";
import nacl from "tweetnacl";
import { HaliasKeys, poseidonHash } from "./crypto";

// A key that reads one alias and cannot spend it.
//
// Everything needed to reconstruct a balance and a history is here; the one thing that
// authorises a spend is not. `spendingPrivKey` appears in exactly one place in this SDK — as
// a circuit witness in proof.ts — so a holder of these three values can decrypt every note
// addressed to the alias, tell which are spent, and total them, while being unable to
// produce a proof.
//
// **The seed is deliberately not what travels.** deriveKeysFromRoot builds an alias seed and
// takes both keys from it — spending is Poseidon(seed, 0), viewing is Poseidon(seed, 1) — and
// the X25519 key is keccak(seed || 0x02). So the seed *is* spending authority, and a view key
// that carried it would be a spending key with a polite name. These are the derived values,
// individually, with the spending half absent rather than withheld.
//
// Scope is one alias index, for the same reason aliases have separate keys at all: a
// wallet-wide viewing key would link every alias its holder can see, permanently, since a
// viewing key cannot be rotated without re-registering the alias.

export interface ViewKeys {
  /// Public. Identifies which commitments belong to this alias — it cannot be derived from
  /// the viewing half, so it has to travel.
  spendingCommitment: bigint;
  /// Yields the nullifier key, which is what makes a spent note recognisable as spent.
  viewingPrivKey: bigint;
  /// X25519. What actually opens the note ciphertexts.
  encryptionPrivKey: Uint8Array;
}

const PREFIX = "hvk1";
const ZERO_KEY = "0x" + "00".repeat(32);
const BODY_BYTES = 96;   // 32 spendingCommitment + 32 viewing + 32 x25519

/// The view-only half of a key set. The spending key is not included and cannot be recovered
/// from what is.
export function viewKeysFrom(keys: HaliasKeys): ViewKeys {
  return {
    spendingCommitment: keys.spendingCommitment,
    viewingPrivKey: keys.viewingPrivKey,
    encryptionPrivKey: keys.encryption.privateKey,
  };
}

/// Rebuild the full key shape a client needs, with no spending key.
///
/// `spendingPrivKey` is zero rather than absent so the type stays one type. Nothing may treat
/// that as a usable key — {HaliasCore.initViewOnly} sets a flag that refuses every spend, and
/// that flag is the guard, not this value.
export function keysFromViewKeys(v: ViewKeys): HaliasKeys {
  return {
    spendingPrivKey: 0n,
    spendingCommitment: v.spendingCommitment,
    viewingPrivKey: v.viewingPrivKey,
    nullifierKey: poseidonHash([v.viewingPrivKey]),
    encryption: {
      privateKey: v.encryptionPrivKey,
      publicKey: nacl.box.keyPair.fromSecretKey(v.encryptionPrivKey).publicKey,
    },
    // No ownership key either, and for the same reason as the spending key: a viewer must not
    // be able to offer the alias away. It is derived from the alias seed, which a view key
    // deliberately does not carry.
    owner: { privateKey: ZERO_KEY, address: ethers.ZeroAddress },
  };
}

/// `hvk1` + hex of the three values + a four-byte checksum.
///
/// The checksum is why this is not just concatenated hex: a view key is transcribed by hand
/// or pasted out of a chat, and a truncated one would otherwise decode to a valid-looking key
/// that silently finds no notes — indistinguishable from an alias with no history.
export function encodeViewKey(v: ViewKeys): string {
  const body = ethers.concat([
    ethers.toBeHex(v.spendingCommitment, 32),
    ethers.toBeHex(v.viewingPrivKey, 32),
    v.encryptionPrivKey,
  ]);
  if (ethers.getBytes(body).length !== BODY_BYTES) {
    throw new Error("view key body is the wrong length");
  }
  return PREFIX + ethers.hexlify(ethers.concat([body, checksum(body)])).slice(2);
}

export function decodeViewKey(code: string): ViewKeys {
  const trimmed = code.trim();
  if (!trimmed.toLowerCase().startsWith(PREFIX)) {
    throw new Error("Not a view key — it should begin with hvk1");
  }
  let raw: Uint8Array;
  try {
    raw = ethers.getBytes("0x" + trimmed.slice(PREFIX.length));
  } catch {
    throw new Error("View key is not valid hex");
  }
  if (raw.length !== BODY_BYTES + 4) {
    throw new Error("View key is the wrong length — it may have been cut short");
  }
  const body = raw.slice(0, BODY_BYTES);
  const want = checksum(body);
  const got = raw.slice(BODY_BYTES);
  if (ethers.hexlify(want) !== ethers.hexlify(got)) {
    throw new Error("View key failed its checksum — check it was copied in full");
  }
  return {
    spendingCommitment: BigInt(ethers.hexlify(body.slice(0, 32))),
    viewingPrivKey: BigInt(ethers.hexlify(body.slice(32, 64))),
    encryptionPrivKey: body.slice(64, 96),
  };
}

function checksum(body: ethers.BytesLike): Uint8Array {
  return ethers.getBytes(ethers.keccak256(body)).slice(0, 4);
}
