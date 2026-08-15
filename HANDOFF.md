# Where things stand — 2026-08-15

Everything is green and **nothing is committed**. That is the first thing to deal with.

```
209 hardhat   86 SDK   17 app   157 e2e-live
```

## Do this first

**Commit.** ~110 modified files, and the pile now includes circuit signal renames, contract API
renames, key derivation for invites, and a widened registry event. Losing it to an accident
would be expensive. Suggested split, each with the reasoning in the message:

1. `spendingPubkey` → `spendingCommitment`, circuit included — **the r1cs is byte-identical**
   (`912845c03faaa3634faf3bbb710b6c00c8d0ed7efb1b564bc3c5d292dd0c7811` before and after), so
   the zkey and deployed verifier stay valid. Put that hash in the message.
2. Licensing and docs — LICENSE (GPL-3.0), SECURITY.md, README rewrite, prior-art correction.
3. ERC-20: decimals, token discovery, app token UI.
4. Invite secrets derived from the root, plus `listInvites`/`reclaimInvite`.
5. `reserveRegistration`/`revealRegistration`/`directRegistration` + the reservation rename.
6. Tests: capacity limits, shared helpers, the assertions.
7. The RPC surface work.

## The half-change is finished

`registryProof` now derives its membership path from `registrySMT` — the mirror rebuilt from
scanned events — and fetches nothing unless the derived path fails to rebuild the published
root. **A send makes two `eth_calls`, and neither names the recipient.** All three targeted
registry reads are gone from the common path.

Two suites hold it in place, and both were necessary for a reason worth remembering: **a wrong
mirror does not throw.** Its root mismatches, the client falls back to fetching, and every test
passes while the leak quietly returns.

- `SdkPreimage.test.ts` → *registry tree* (7 tests): builds the tree from logs against a live
  registry, asserts the root and every sibling path equal the contract's, including an
  unoccupied slot — plus the negatives, where a stale mirror or stale leaf must fail the check.
- `e2e-live` wraps `provider._send` across a real `send()` and asserts no `eth_call` carries
  the `aliasSlot`, `getSmtSiblings` or `aliases` selector. This is the only check that can tell
  whether the client *uses* the mirror rather than merely having a correct one.

One bug the tests caught immediately: `AliasRegistered` emits a **one-based** slot (0 means
unregistered), and the path key is one less. Off by one there derives the neighbour's path and
throws nothing.

**Measured, because it runs after every scan.** The first implementation built the tree with
one `SMT.update` per alias, which walks 32 levels every time and so recomputes each internal
node once per descendant — 330,000 hashes for 10,000 aliases, 18.5 s. Building bottom-up
(`SMT.fromLeaves`) hashes each node once: 20,023 hashes, **1.27 s, 14x faster**, identical
roots and identical sibling paths. No contract change, no download. `SdkPreimage.test.ts`
asserts the two builders agree, since they share no code.

At 10,000 aliases the tree is 20,022 nodes, 2.4 MB of heap, 8 µs to read a path, 1.5 MB
serialised, 19 ms to load back. Storage was never the issue; hashing was.

| after a scan that… | 10,000 aliases |
| --- | --- |
| built the tree the first time | 1,272 ms |
| changed nothing | 0 ms (skipped on raw fields, no hashing) |
| added a few registrations | ~1.9 ms each |

`rebuildRegistryTree` picks whichever is cheaper: `update` costs 33 hashes per changed entry,
`fromLeaves` about 2 per entry for the whole tree, so it patches until the changed set passes
N/16 and rebuilds past that.

**Scale — and the tree is not the ceiling.** Resolving names locally means scanning every
registration, measured at **785 B of log JSON per alias**:

| aliases | registry logs | tree build | tree in memory |
| --- | --- | --- | --- |
| 10,000 | 8 MB | 1.3 s | 2.4 MB |
| 100,000 | 78 MB | 13 s | 24 MB |
| 1,000,000 | **785 MB** | 102 s | 240 MB |

At a million the client dies on an 800 MB download long before the two minutes of hashing
matter. That ordering predates this change — `lookup()` and the slot already came from the same
scan — so nothing here moved the limit, it only made it measurable. Nor is the hash constant
rescuable: `poseidon-lite` is bit-identical and **4x slower** (202 µs vs 51 µs), so Web Workers
are the only lever left.

**A design that reaches 1M is written up** in `packages/protocol/docs/registry-buckets.md`:
split the slot into a hash-derived bucket plus a counter within it, so a client computes the
recipient's bucket from the name and scans only that bucket — 785 MB becomes 3.1 MB, and the
circuit shrinks 18% because the only circuit edit is the depth constant. Needs a new ceremony,
which is free now and expensive later. Not implemented.

**Good to ~10k as it stands. ~100k needs persistence + incremental scanning** — which turns the
O(N) into a once-per-device cost with milliseconds of steady state, the way an SPV wallet
handles the same shape. Both are already on this list and neither is built. **1M needs a
different architecture**, not tuning: k-anonymous prefix buckets (item 7), PIR, or a helper
trusted more than an RPC provider. Details in `docs/rpc-surface.md`.

## What got done today

**Privacy — `docs/rpc-surface.md`.** No previous audit had looked at the client. A send used to
make **three targeted calls naming the recipient**; it now makes **none**. `lookup()`, the slot,
the sibling path and `dataHash` all come from the scan, and the path is *verified* against the
chain's root rather than trusted — strictly more checking than the old code did, with the calls
removed rather than reduced.

Also fixed: `registrationCommitment` was `public pure` and the SDK called it over `eth_call`
**with the plaintext name**, handing it to a provider before the opaque reservation was
broadcast. Now computed locally, and the function is `internal` so nobody can reintroduce it.

**Tests.** 191 → 209. Every custom error is now asserted except `PredictionMismatch`. New
`Capacity.test.ts` reaches `RegistryFull` and `TreeSpaceExhausted` via mocks that move only the
ceiling. `ReservationTooNew` — the front-running defence — was asserted as a bare `rejected`;
now named, by replaying the call at the block it failed in.

**Consolidation.** `FIELD_PRIME` went from **14 copies to one** (the second time this pattern
bit — see `helpers/nullifier.ts`). New `helpers/field.ts`, `helpers/tx.ts`, `helpers/stack.ts`.

**Assembly removed.** `pendingLeaf` used three `tstore`/`tload` blocks and a hand-picked slot
constant. Solidity 0.8.28 supports `transient` state variables — same semantics, compiler-
assigned slot, no assembly.

**Reservation rename.** `commitRegistration` → `reserveRegistration`, and the block-number
packing is gone: a timestamp already enforces "a strictly later block", because every
transaction in a block shares one. `MIN_COMMIT_AGE`, two unpacking helpers and a paragraph
explaining why both existed all deleted.

## Open, in rough priority

1. **Persistence + incremental scanning — together, this is the scaling story.** The registry
   tree already has `serializeNodes()`/`fromSerialized()` unused (1.27 s build becomes a 19 ms
   load at 10k aliases), and `refresh()` still rescans from `startBlock` every call. Neither
   alone helps much; both turn every O(N) cost into once-per-device.
2. **Invites are ETH-only.** `createInvite`/`claimInvite` pin `ETH_TOKEN_ADDRESS`.
3. **Added tokens do not survive a reload** — `addToken` writes session state only; should
   persist per-chain like the alias name map.
4. **No multi-asset sweep test.** `sweepAndOffer` was fixed to honour each note's token; nothing
   covers it.
5. **Copy says "alias" and "name" inconsistently.** A dozen user-facing strings. Decided *not*
   to rename the 1,162 identifiers — the product is Hal + alias, and `HaliasController` already
   has an ERC-721 `name()`.
6. **Adding a passkey after onboarding** — offered once, no way back to it.
7. **Prefix bucketing** (`getAliasesByPrefix`) if the full scan stops scaling. A `view`
   function, addable at audit time with evidence.

## Decisions made today, so they are not relitigated

- **Web wallet for v1.** Desktop/mobile via Tauri v2 (which does both from one codebase) is a
  post-audit concern. Two unresolved questions there: WebAuthn **PRF** support in WKWebView and
  Android WebView, and replacing `window.ethereum`.
- **No `hls1…` payment strings.** Passing opaque strings is the thing the product exists to
  remove.
- **Registry depth stays 32.** Registration measures ~1.13M gas and depth dominates it, but the
  registry has no rollover so over-provisioning is deliberate.
- **`REGISTRY_ROOT_MAX_AGE` stays 1 hour.** Raising it lengthens the window in which a payment
  can land on rotated-away or previous-owner keys, and `RELAY_MAX_AGE_SECONDS` (45 min) binds
  first anyway.
- **Railgun is upgradeable** — `PausableUpgradableProxy` under token governance, which can
  upgrade and pause. `HaliasPool` has neither. `legal-considerations.md` understates this.

## Still gating mainnet

External audit, and a multi-party ceremony. Nothing done today moves either.

## Two placeholders to replace

- `SECURITY.md` points at `github.com/suggalla/halias/security/advisories/new` — inferred from
  git config.
- Contract headers say `Copyright 2026 halias contributors.`

## Gotcha that cost time three times today

**SDK source changes need `npm run build` before the protocol tests see them** — they import
`halias-sdk`, which resolves to `dist/`. A stale `dist` surfaces as a confusing failure in a
test you did not touch.
