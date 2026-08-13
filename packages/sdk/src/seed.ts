import { ethers } from "ethers";

// Where the one secret behind every alias comes from.
//
// It used to come from a signature: keccak of `personal_sign("halias key derivation v1…")`.
// Signatures are deterministic, so any site that talked a user into signing that exact string
// derived every key for every alias index and could spend everything. That failure is silent
// (no transaction, no approval), total (spending *and* viewing keys), and unremediable —
// notes bind `pubkey = Poseidon(spendingPrivateKey)`, so rotating keys protects only future
// receipts, never the notes already on chain.
//
// A seed the wallet never sees removes the attack rather than warning about it. The wallet
// keeps its own job — signing transactions and paying gas — and the two roles no longer share
// a secret. See docs/key-management.md.

/// The one secret behind every alias a user holds.
///
/// Everything downstream takes a root, so a new source is additive: it implements this and
/// nothing else changes.
export interface SeedSource {
  root(): Promise<bigint>;
}

/// Separates the halias root from anything else the same phrase derives.
///
/// Users reuse mnemonics. Without this tag a phrase already backing an EOA would tie its
/// halias identity to that wallet by construction, and a leak of one would be a leak of both.
const ROOT_DOMAIN = "halias root v1";

/// A fresh 24-word phrase, from 256 bits of CSPRNG entropy.
///
/// This is the wallet. Nothing else — not the password, not a passkey — can reconstruct it.
export function generateMnemonic(): string {
  return ethers.Mnemonic.fromEntropy(ethers.randomBytes(32)).phrase;
}

/// True if `phrase` is a well-formed BIP-39 mnemonic, checksum included.
export function isValidMnemonic(phrase: string): boolean {
  return ethers.Mnemonic.isValidMnemonic(normalize(phrase));
}

/// The root a phrase derives.
///
/// `passphrase` is BIP-39's 25th word: it changes the seed, so a wrong one silently yields a
/// different, empty wallet rather than an error. That is BIP-39's design and the reason the
/// UI has to treat it as part of the phrase rather than as a password.
///
/// Throws on a malformed phrase. BIP-39's checksum makes a typo fail here instead of
/// deriving a valid-looking wallet nobody can find funds in.
export function rootFromMnemonic(phrase: string, passphrase?: string): bigint {
  const mnemonic = ethers.Mnemonic.fromPhrase(normalize(phrase), passphrase);
  // computeSeed is the standard BIP-39 stretch: PBKDF2-HMAC-SHA512, 2048 rounds.
  const seed = ethers.getBytes(mnemonic.computeSeed());
  return BigInt(ethers.keccak256(ethers.concat([seed, ethers.toUtf8Bytes(ROOT_DOMAIN)])));
}

/// A phrase held in memory, validated once when it is accepted.
///
/// Validating in the constructor rather than at first use means an import wizard rejects a bad
/// phrase while the user is still looking at it.
export class MnemonicSource implements SeedSource {
  private readonly value: bigint;

  constructor(phrase: string, passphrase?: string) {
    this.value = rootFromMnemonic(phrase, passphrase);
  }

  async root(): Promise<bigint> {
    return this.value;
  }
}

/// A root already in hand — restored from a keystore, or passed between clients that must not
/// re-derive. Also how a view-only client is built, once the viewing half can travel alone.
export class RootSource implements SeedSource {
  constructor(private readonly value: bigint) {}

  async root(): Promise<bigint> {
    return this.value;
  }
}

/// BIP-39 phrases are lowercase and single-spaced; pasted ones rarely are.
function normalize(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}
