# Security review — second pass


> **Point-in-time record, 2026-08.** Kept as written; the code has moved since. Changes that
> post-date this pass and that it therefore does not cover: note keys now come from a BIP-39
> recovery phrase rather than a `personal_sign` signature; an alias is owned by a secp256k1
> key derived from that phrase rather than by the registering wallet, so `msg.sender`
> authorises no owner action at all; and signature verification, deadline and nonce bump are
> unified in `_consumeAuthorization`. See
> [keys-and-authorization.md](keys-and-authorization.md) for the current design.

Covers what the first pass (`audit-2026-08.md`) could not: the changes made since it was
written. Those are the F1 circuit fix and its transient-storage arming, the offer/accept
handover, the dual-mode owner authorisation, the removal of `updateKeys`/`rotateKeys`, and the
shortened registry-root window.

Same limitation as before, and it is worth restating because it matters more here: **this
reviews code I wrote, including code I wrote today.** The F1 fix in particular was designed in
this session, so a genuine outside pass on it is still owed. What follows came from working
against known failure patterns and from re-deriving each new invariant from the code rather
than from the design notes — which is how the siblings-binding hole in the original F1 plan
was caught, since the plan read as correct and the code would not have been.

Part 2 is the register of accepted trade-offs. Nothing there is a defect; all of it is a
choice, and the point of listing it is that a choice nobody wrote down is indistinguishable
from an oversight six months later.

---

# Part 1 — Findings

## N1 — `TRANSACT_GAS` no longer has meaningful headroom (medium, liveness)

The tenth public signal costs one extra `ecMul` plus `ecAdd` in Groth16 verification, plus 32
bytes of calldata — about 6,700 gas.

Measured on the new circuit with the real verifier: **2,514,409** for a deposit, **2,492,163**
for a transfer. The previously measured range across 150+ calls was 2,471,683–2,552,536, and
`TRANSACT_GAS` is **2,560,000** — chosen to sit just above that maximum. Adding ~6,700 to the
old worst case lands around 2,559,200, leaving **under 1,000 gas of margin**.

That constant is not decorative. `suggestRelayFee` quotes from it, so a relayer can underquote
its own cost; and a submitter setting exactly that gas limit on the worst-case path can run
out mid-verification, burning the gas and reverting.

**Action: re-measure across every path — deposit, transfer, withdrawal, relayed withdrawal,
claim, relayed claim, ERC-20 — and raise the constant.** The two figures above are the cheap
paths; the expensive one (relayer fee, which adds a payout) was where the old maximum came
from and has not been measured since the change.

## N2 — The F8 relay-blob expiry is advisory, not enforced (low, by construction)

`builtAt` lives inside the blob and is set by whoever built it. Nothing signs it and no
contract reads it. A backdated blob passes `quoteRelay` and the chain accepts any proof whose
registry root is inside the window regardless.

This is acceptable — the only party who gains from forging it is the sender, and what they
gain is the risk of paying an alias's previous owner with their own money. But the mitigation
must not be described as closing F8. It stops honest clients submitting stale proofs; the
on-chain window is unchanged, and the residual exposure in T3 stands.

## N3 — `offerAlias` and `cancelOffer` are not `nonReentrant` (low)

Every other mutating function on the domain is. These two are reachable by a relayer holding
control during a claim's payout.

Harmless as it stands: neither touches the registry tree, so the root cannot move mid-claim,
and the only state they reach is `pendingAliasOwner` and `aliasNonce` — both of which the same
caller could reach in a separate transaction with no extra privilege. The shape predates this
session, but the signature path widened who can reach them from "the owner" to "anyone holding
an owner signature".

Worth adding the guard for uniformity rather than for a live hole. The audit principle applies:
"this one is safe for a different reason than the others" is something a reader has to
re-derive every time.

## N4 — A shared `aliasNonce` gives a seller a second way to renege (low, accepted)

Every authorised action on an alias bumps the nonce, which is what makes the invalidation rule
one sentence. It also means a seller can kill a buyer's signed acceptance with any cheap owner
action — `updateAliasData` on their own alias — rather than by calling `cancelOffer`.

No new capability: an offer is revocable until accepted, so the seller could always renege.
But it has a consequence for the escrow flow in `key-rotation-and-transfer.md`: an escrow must
re-read the nonce immediately before submitting an acceptance, and must treat a
`NotOfferedToSigner` revert as "re-sign", not as "the offer is gone".

## N5 — `pendingSlot` may be any free slot, including beyond `nextAliasSlot` (informational)

Recorded so it is not rediscovered as a bug.

The prover chooses `pendingSlot` freely. The emptiness proof confines it to positions that
genuinely hold the empty leaf under `registryRoot`, which includes every slot above
`nextAliasSlot`. So a claim can derive a tree with its leaf somewhere other than where the
registry actually put it.

Harmless, for three reasons that must all hold: the slot appears nowhere in a note commitment;
the derived tree is never persisted on chain, only used inside the proof; and when the change
note is later spent, its *outputs* prove against the real registry root at the real position.

What the emptiness proof does buy is the thing that would not be harmless: an insertion can
never land on an occupied slot, so it cannot overwrite another alias's leaf.

## N6 — Cancun is now a deployment requirement (informational)

`armPendingLeaf` uses `TSTORE`/`TLOAD`. Before Cancun these are invalid opcodes, and the
failure mode is a revert with no reason string that reads as a contract bug — which is exactly
how it presented during development, via a hardhat network whose hardfork did not match the
compiler's `evmVersion`.

Both are now pinned to `cancun` in `hardhat.config.ts`. Any deployment target must support
EIP-1153.

## N7 — Timestamp semantics vary by chain (informational)

The root window now reads `block.timestamp` rather than counting blocks, which is what makes
the guarantee mean the same thing across chains with different block times. It introduces a
smaller assumption in exchange: some L2s derive `block.timestamp` from the sequencer and it can
lag or step relative to L1. At one-hour granularity this is immaterial, but it is a new
dependency on the deployment target that block counts did not have.

Related and unreachable, noted so it is not mistaken for a check: `block.timestamp - seen`
reverts on underflow rather than returning false if a stamp were ever in the future. Timestamps
are monotonic, so it cannot happen.

## N8 — Proving cost and artifact size grew with the fix (informational)

The circuit went 77,790 → 111,112 constraints (+43%), and the proving key is **48.7 MB**.

Not a security property, but it interacts with one: slower proving consumes more of the
one-hour root window before submission, which is the window T3 is about. It also matters for
the browser, where proving was already the bottleneck, and for anyone loading a 48 MB artifact
over a phone connection.

---

# Part 2 — Accepted trade-offs

Each of these is a deliberate choice with a known cost. None is a defect. They are listed
together so the total accepted risk is visible in one place.

## Cryptographic and circuit

**T1 — The trusted setup is a single self-generated `--dev` ceremony.**
One party generated the toxic waste and could forge proofs for any statement. **This is
blocking for real funds** and no amount of circuit review substitutes for fixing it. Tracked
separately; a multi-party phase 2 is a prerequisite for mainnet.

**T2 — Exact-copy proof replay is possible and is griefing only.**
Resubmitting someone's proof and params verbatim with higher gas redirects nothing — every
destination is committed in `paramsHash` — but it makes the victim's transaction revert on a
spent nullifier. Accepted pending encrypted mempools / inclusion lists.

**T3 — For one hour after a handover, a stale root pays the previous owner.**
Note commitments bind `spendingCommitment` at creation, and the pool accepts any root superseded
within `REGISTRY_ROOT_MAX_AGE`. Cut from ~24h to 1h; not closed, and not closable in the pool,
which cannot know an alias changed hands. Client mitigation is advisory only (N2).

**T4 — Re-keying takes up to an hour to take effect.**
The same window, from the other side. It is the reason the window cannot simply be widened to
buy liveness.

**T5 — The verifier contract is snarkjs-generated and was checked only for public-input
bounds**, not audited line by line. The `checkField` guard on all ten signals and the vkey
`IC`-point comparison against the Solidity constants are what it rests on.

**T6 — Slither and Aderyn have not been run.** circomspect has. The Solidity review is manual.

## Protocol design

**T7 — ETH has no per-note ledger** (F3). A broken conservation constraint would be caught for
an ERC-20 at that token's outstanding notes, but for ETH only once it exceeded the entire pool.
Deliberate: one SSTORE per ETH transact.

**T8 — Pool root history is unbounded** (F4). Diverges from Tornado's 30-root ring buffer in
the safe direction — an old proof never expires, so nobody loses a note to slow proving — at
one SSTORE per transact.

**T9 — Admin fee changes stall in-flight claims** (F2). `claim` requires an exact payout, so
changing `registrationFee` invalidates every outstanding claim. A fee change is a disruptive
operation and should be rare and announced.

**T10 — A withdrawal's recipient and amount are public.** They are in calldata and bound into
`paramsHash`. Only the *sender* is hidden. This is inherent to withdrawing to an address.

**T11 — Commit–reveal does not stop two honest parties wanting the same name.** First reveal
wins; the second gets `AliasTaken`. It stops the reveal being *stolen*, which is the attack.

**T12 — `MIN_COMMIT_AGE`/`MAX_COMMIT_AGE` are still block counts** while the root window is in
seconds. `MIN` is genuinely a block property ("cannot commit and reveal in the same block");
`MAX` is a time property with the same portability issue the root window had. Two unit systems
where one would do.

## Ownership and transfer

**T13 — A seller can front-run an acceptance with a cancel.**
Inherent to a revocable offer. It means **a direct peer-to-peer sale is unsafe** — buyer pays,
seller cancels, seller keeps both — and escrow is the only correct shape, not a nicety.

**T14 — A buyer acquires the name and every future payment, never a balance.**
Notes already under the seller's spending key stay spendable by the seller. Nothing on chain
can verify an alias is empty: the pool cannot compute a balance without breaking the privacy
that is the point of it. Sweeping first is a courtesy; a market must price the name alone.

**T15 — Re-keying clears `dataHash`.**
Rotation goes through `reassign`, which clears it. Free today because `dataHash` is zero on
every alias in existence. When proof-of-innocence or attestations give it a value, the
distinction belongs on `reassign` keyed on whether the owner actually changed.

**T16 — The 3-arg `safeTransferFrom` is closed by OpenZeppelin's routing, not by an override.**
It cannot be overridden — OZ 5.6.1 declares it non-virtual — so it is pinned by a test that
exercises it explicitly. An OZ change that made it independently routable would fail the suite
rather than ship.

**T17 — `updateAliasData` exists for a capability not yet built.**
`dataHash` is zero everywhere and is reserved for the alias trust layer. Note that this is
*not* Privacy-Pools-style proof of innocence: that is a statement about fund provenance and
needs an association set over commitments, which a per-alias field structurally cannot express.
Keeping the writer costs one function, one typehash and one leaf-writing path.

## Scope

**T18 — A compromised client is out of scope by construction.**
It holds the wallet connection and derives the spending keys, so it can sweep every note and
sign anything. Defending against it is unachievable, and pretending otherwise would add
surface without adding safety. The contract guarantees the recipient *consented*; the client
guarantees the keys are the recipient's *own*.

**T19 — Homoglyph aliases remain the residual name-confusion risk.**
Halias eliminates the hex-copy vector; a visually similar name is easier to spot than a
similar address and is friction'd by the registration fee, but it is not eliminated.
