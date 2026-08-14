/// Canonical alias names.
///
/// The whole registry keys on `keccak256(name + ".hls")`, so every place that turns user
/// input into a name must agree exactly. It did not: the rule was written out at ten call
/// sites as `alias.replace(/\.hls$/, "").toLowerCase()`, which strips one suffix and stops.
/// `alice.hls.hls` therefore normalised to `alice.hls` and registered `alice.hls.hls` — a
/// different alias from `alice.hls`, indistinguishable in the UI, and unreachable by anyone
/// typing the obvious thing.

/// Characters an alias may contain, after the suffix is stripped.
///
/// Deliberately narrow: ASCII letters and digits, nothing else.
///
/// A name is what someone reads off a screen, hears on a phone, and types into a payment
/// form, so the cost of two names that look or sound alike is money sent to the wrong person.
/// Unicode would reopen homoglyph attacks outright. Hyphens were allowed and are not any
/// more: `alice-bank` and `alicebank` are two names that survive being spoken as one, which
/// is the same failure in a quieter form.
///
/// Excluding them also makes `invite-…` unavailable to a user alias rather than merely
/// improbable, so the machinery an invite registers cannot be confused with anyone's name by
/// any client using this function. The contract enforces no charset — it cannot know what a
/// display layer renders confusably — so this is the layer that decides.
const VALID = /^[a-z0-9]+$/;

const MIN_LENGTH = 1;
const MAX_LENGTH = 63;   // one DNS label's worth, so a name is never awkward to display or speak

export class InvalidAliasError extends Error {}

/// The name is well-formed but already registered. Distinct from {InvalidAliasError} because
/// the answers differ: one means fix the name, the other means pick a different one.
export class AliasTakenError extends Error {}

/// Normalise user input to the bare label — no suffix, lowercase, trimmed.
///
/// Accepts `alice`, `alice.hls`, `ALICE.hls`, and ` alice.hls.hls ` alike, because people
/// paste all four. Rejects anything that would produce a name nobody could type back.
export function normalizeAlias(input: string): string {
  // Every trailing suffix, not just the last one.
  const bare = input.trim().toLowerCase().replace(/(\.hls)+$/, "");

  if (bare.length < MIN_LENGTH) throw new InvalidAliasError("An alias needs a name");
  if (bare.length > MAX_LENGTH)
    throw new InvalidAliasError(`An alias can be at most ${MAX_LENGTH} characters`);
  if (bare.includes("."))
    throw new InvalidAliasError("Aliases are a single label — no dots except the .hls suffix");
  if (!VALID.test(bare))
    throw new InvalidAliasError(
      "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit",
    );

  return bare;
}

/// The full display form, e.g. `alice.hls`.
export function fullAlias(input: string): string {
  return `${normalizeAlias(input)}.hls`;
}

/// Whether input normalises without throwing — for validating a field as it is typed.
export function isValidAlias(input: string): boolean {
  try {
    normalizeAlias(input);
    return true;
  } catch {
    return false;
  }
}
