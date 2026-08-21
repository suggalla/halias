# Open items

Standing list of what is known-incomplete, and of decisions already taken so they are not
relitigated. Not a roadmap — the README has that. This is the detail a roadmap bullet hides.

## Open, in rough priority

1. **Persistence + incremental scanning — together, this is the scaling story.** The registry
   tree already has `serializeNodes()`/`fromSerialized()` defined and unused (a 1.27 s build
   becomes a 19 ms load at 10k aliases), and `refresh()` still rescans from `startBlock` on
   every call. Neither alone helps much; both turn every O(N) cost into once-per-device.
   Trial decryption is the other half — per-alias keys make it O(notes × aliases), and it
   belongs in a Web Worker with one shared `getLogs` pass across aliases.
2. **The prefix index is on-chain but unused.** `getAliasesByPrefix` is implemented in
   `HaliasRegistry` and covered by `PrefixIndex.test.ts`; no SDK code calls it. It exists so a
   client can mirror a slice of the registry without naming the alias it wants, which is the
   whole point, and that path is not wired up.
3. **Invites are ETH-only.** `createInvite`/`claimInvite` pin `ETH_TOKEN_ADDRESS`.
4. **Creating an invite takes two transactions, and could take one.** `reserveRegistration`,
   `revealRegistration`, then `pool.transact` to fund the note. Both halves are avoidable:

   - ~~The reservation~~ **Done.** Invite names use `directRegistration`, which was already on
     the contract. Front-running one is possible and pays nothing: the funding proof binds the
     note to the invite's spending commitment, so an attacker who takes the name cannot
     receive, spend, or derive anything — they only force a retry at the next index, having
     paid a registration fee for it. That removed a transaction, a block wait and a wallet
     prompt with no contract change.
   - Registering and funding could be one call. `domain.claim` already does exactly that for
     redemption: `transactClaim` proves against the pre-registration root and derives the
     resulting tree, so the alias need not exist before the proof is built.

   **Worth ~110k gas, about 5%** — the 1.24M depth-32 SMT write dominates and survives either
   change, and Groth16 verification does not scale with constraints, so the larger claim
   circuit verifies for the same gas. The real wins are one confirmation instead of three, and
   atomicity: today a reveal that lands before a failed `transact` leaves a registered invite
   alias with no note and a spent fee.

   Not done because it needs a new armed-leaf path on the controller, and
   `HaliasController.sol:421` records that arming is the only thing stopping a prover claiming
   an insertion of their own keys into a tree of their choosing. That is the highest-risk
   surface in the repo and the wrong place to spend 5% before an audit. Estimated 2-3 days,
   almost all of it in tests.
5. **A half-created invite is invisible and its fee is lost.** If `revealRegistration` lands
   and the funding `transact` does not, the invite alias is registered but has no note.
   `nextInviteIndex` skips it because registration is the record, and `listInvites` reports it
   with `amount: null` and `claimable: false`, which the UI filters out. The 0.001 fee is gone
   and nothing anywhere says so. The client can tell this apart from a redeemed invite — a
   redeemed one has an output that decrypts to the invite keys and a spent nullifier, an
   unfunded one never had an output at all.
6. **Added tokens do not survive a reload** — `addToken` writes session state only; should
   persist per-chain like the alias name map.
7. **No multi-asset sweep test.** `sweepAndOffer` was fixed to drain per token rather than per
   note; nothing covers the multi-token case.
8. **Copy says "alias" and "name" inconsistently.** A dozen user-facing strings. Decided *not*
   to rename the 1,162 identifiers — the product is Hal + alias, and `HaliasController` already
   has an ERC-721 `name()`.
9. **Adding a passkey after onboarding** — offered once, with no way back to it.

## Decisions already made

- **Web wallet for v1.** Desktop/mobile via Tauri v2 (which does both from one codebase) is a
  post-audit concern. Two unresolved questions there: WebAuthn **PRF** support in WKWebView and
  Android WebView, and replacing `window.ethereum`.
- **No `hls1…` payment strings.** Passing opaque strings is the thing the product exists to
  remove.
- **Registry depth stays 32.** Registration measures ~1.13M gas and depth dominates it, but the
  registry has no rollover, so over-provisioning is deliberate.
- **`REGISTRY_ROOT_MAX_AGE` stays 1 hour.** Raising it lengthens the window in which a payment
  can land on rotated-away or previous-owner keys, and `RELAY_MAX_AGE_SECONDS` (45 min) binds
  first anyway.
- **Railgun is upgradeable** — `PausableUpgradableProxy` under token governance, which can
  upgrade and pause. `HaliasPool` has neither. `legal-considerations.md` understates this.

## Test coverage

Six user-facing capabilities are exercised **only** by `scripts/e2e-live.ts`, which needs a
node and a deploy and is therefore not run by `npm test`: `consolidate`, `sweepAndOffer`,
`reclaimInvite`, `heldTokens`, `privacyContext` and `listInvites`. Each is well covered there
— e2e-live is 158 checks against a real node — but a change that breaks one of them passes
every suite CI would run by default. Either wire e2e-live into CI behind a hardhat node, or
give each an in-process test.

The cross-system alignment is in good shape by contrast: `SdkPreimage.test.ts` checks the
SDK's `paramsHash` against the pool's own, reproduces the registry root from logs alone,
derives sibling paths for every occupied slot, and pins nullifier derivation and tree depth
against the contract. Those are the tests worth keeping green.

## The gap between hardhat and a real node

Three bugs in one evening lived here, and none of them could have been caught by any suite in
the repo:

- **`ReservationTooNew` on registration.** The reveal is estimated before it is sent, and
  `eth_estimateGas` simulates against the latest block — the one the commit just landed in,
  where `block.timestamp == madeAt`. Hardhat estimates against a pending block with an
  advanced timestamp, so it never fires there.
- **`range 18446744073709551615 exceeds limit of 10000`.** A resumed scan asks to start from a
  block the provider does not believe exists yet, and the last chunk ends at `"latest"`. A
  node computes that span unsigned and it wraps. Hardhat answers the same request happily.
- **`ReservationPending` matched by name.** A wallet returns raw revert data, so the name is
  never in the error. In-process tests get decoded errors and the string is there.

`e2e-live` was built to catch exactly this class and cannot, because it also runs against
hardhat. **Pointing it at a testnet occasionally is the highest-value testing change
available** — it needs an RPC URL and a funded key, and nothing else about it changes.

## Still gating mainnet

An external audit and a multi-party ceremony. Nothing else on this page moves either.

The circuit in particular has never been reviewed by anyone who was not involved in writing it.
Underconstrained signals do not fail tests, so the passing suites are not evidence here.

## Publishing readiness

`npm run check` and `npm test` are both green on a clean checkout. What is left:

- **The proving keys are 37MB and 49MB.** Fetched lazily, and only the pair a given proof
  needs, so an ordinary send never pulls the claim key. Served from the Pages site itself;
  GitHub's soft bandwidth cap is 100GB/month, which is roughly 1,100 cold visitors.
  `artifacts.sha256` is what ties them to the deployed verifiers, so moving them to IPFS or a
  CDN later changes nothing about trust.

## Placeholders to replace before publishing

- **No private channel for security reports.** `SECURITY.md` asks for an issue or a pull
  request, which is right while nothing holds real money and wrong the moment something does.
  GitHub's security advisories would be the obvious answer and are unavailable on private
  repositories — both REST endpoints 404 rather than explaining why — so this resolves itself
  on the day the repository goes public. Decide before mainnet, not after.
- Contract headers say `Copyright 2026 Halias contributors.`

## Gotcha that cost time three times

**SDK source changes need `npm run build` before the protocol tests see them** — they import
`halias-sdk`, which resolves to `dist/`. A stale `dist` surfaces as a confusing failure in a
test you did not touch.
