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
4. **Invites cannot be relayed by a stranger.** Creating one pays the registration fee in
   ETH from `msg.value`, so whoever submits it must hold ETH. A third party *can* submit it —
   `createInvite` never reads `msg.sender` for anything but the event — but they would be
   paying the fee, so in practice the creator submits and their address appears on chain
   alongside the transaction. The value itself is still private; only the act of creating is
   visible. Fixing it properly means a fee paid some other way, which is the same problem the
   paymaster work is for.
5. **A reclaimed invite strands its credit.** `reclaimInvite` spends the note back but leaves
   `prepaidClaim` set. Nobody loses money they would otherwise have had — the fee bought one
   registration and one registration is still available — but the credit can only be redeemed
   through `claimInvite`, which needs the note that was just spent. So it sits there
   permanently unspendable. Releasing it would need a `cancelInvite` on the controller that
   the credit's owner signs for; worth doing when something else takes the controller back
   into surgery.
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
- **Registry depth stays 32.** Depth is 81% of a registration and cutting it is the largest
  single saving available — 237,080 at depth 24, 474,160 at depth 16 — but every one of them
  buys a permanent capacity ceiling frozen by the ceremony, and 32 levels is 4.29e9 aliases
  with no ceiling at all. See the gas entry below for the rest of the arithmetic.
- **`REGISTRY_ROOT_MAX_AGE` stays 1 hour.** Raising it lengthens the window in which a payment
  can land on rotated-away or previous-owner keys, and `RELAY_MAX_AGE_SECONDS` (45 min) binds
  first anyway.
- **One fee per invite, paid in ETH, never from the pool.** Creating an invite registers a
  keys-only entry whose identity is forced to `keccak256(spendingCommitment)` — it cannot be a
  name, so it is not sold as one — and stores a prepaid credit against it. Redeeming spends
  that credit with an EIP-712 signature from the key derived from the invite secret. The
  alternatives were all worse: taking the fee from the note is protocol revenue drawn out of
  the shielded set (a legal line, not a preference); a free claim path lets anyone mint names
  for nothing; a global counter is fungible, so one invite claims as many names as anyone else
  paid for; charging twice defeats the point of removing the pool fee at all. The accepted
  cost is that creator and claimer are linkable through the credit — acceptable because this
  is an onboarding feature, not a privacy one, and the *amounts* stay private throughout.
- **Gas: the constants are spent; what remains is structural.** Measured against the canonical
  Poseidon build, with throwaway probes since deleted — one Poseidon(2) is 18,841 gas, one
  registry level 29,635, one Groth16 public signal ~6,150 (ECMUL 6,000 + ECADD 150). A transact
  is ~882k with the real verifier and a registration 1,187,200. **Deferred: this is a Sepolia
  deployment and there is no mainnet plan, so none of the below is worth doing now.**
  - *Packing all 20 public signals into one hashed signal:* saves ~117k in the verifier
    (~6,150 per signal: ECMUL 6,000 + ECADD 150), and costs 345,372 to fold 20 values with
    Poseidon on chain — a **net loss of 228k**. Keccak costs 325 gas on chain but needs
    keccak *in circuit*: 640 bytes is five permutation blocks, roughly 750k constraints on a
    94,480-constraint circuit. Not viable in a browser.
  - *Bit-packing the small signals* — `treeNumber[4]` (128 bits), `tokenAddress` (160),
    `outputsEmpty` (1) — fits six signals into two and saves ~24,600, **2.8%**. Free on both
    sides, and still not worth touching a frozen public layout shared by two circuits.
  - *Rolling registry trees:* the registry assigns slots sequentially, so depth is a capacity
    bound and rolling is arithmetically the same as a shallower single tree. It only beats one
    by making the tree number public — and `registryRoot` is shared across outputs while
    `outRegistryIndex` is private, so a public tree number would publish the **recipient's**
    registration cohort on every transfer. `multi-tree-pool.md` accepted that leak for the
    pool, where the tree number describes the sender's own notes. Here it describes the payee.
  - *Reducing `REGISTRY_LEVELS`:* one level costs 29,635 (18,841 of it Poseidon, the rest a
    sibling read and a node write), so the 32-level walk is 81% of a registration. 32→24 saves
    237,080, 32→20 saves 355,620, 32→16 saves 474,160. All of them buy a permanent capacity
    ceiling frozen by the ceremony. Rejected: 32 levels is 4.29e9 aliases and no ceiling at all.
  - *Making registration take an append-only path* (registrations are already appends; only
    rotations are true updates) measures **108,556, 9.1%**, from a mock that was the real
    contract with only the tree write swapped. Rejected for what the other half costs: with no
    stored nodes a rotation must carry its sibling path in calldata and verify it before
    recomputing (~64 hashes against 32), the `filledSubtrees` entries a rotation's path runs
    through must be repaired or the root corrupts silently, and `getSmtSiblings` disappears —
    which is the SDK's fallback whenever a client's local mirror is stale.
  - *The prefix index* costs 44,566 per registration and nothing calls `getAliasesByPrefix`
    yet — see item 2. Reconstructible from `AliasRegistered`, which the SDK already scans.
  - *Four nullifier SSTOREs*, 88,400 per transact, `HaliasPool.sol:267`. Skipping the unused
    ones leaks how many real inputs a transaction has — the same trade `outputsEmpty`
    documents and declines by default.
  - *INPUTS 4 -> 2* is the largest ceremony-gated lever left: two fewer nullifier writes and
    six fewer public signals, ~81,000 (9%), plus a smaller circuit.
    `circuit-freeze-review.md` already says that choice expires at the mainnet ceremony.

  **None of it changes the order of magnitude, which is the point.** ~404k of a transact and
  ~948k of a registration is on-chain Poseidon walking a tree, and the only way to remove it
  is to move the insertion into a proof. Doing that per-transaction reintroduces exactly what
  `f1-claim-root-prediction.md` rejected — a proof that commits to a leaf index dies whenever
  anyone else's lands first, so every transact would race every other one. The version that
  works is deferring insertion to a batch, and `gasbench`'s exit path shows the floor it
  leaves: 160,796 without insertion, so ~500k with a real verifier. Below that sits the
  Groth16 pairing at 181,000, fixed by BN254, removable only by amortising one proof over many
  transactions. Both exits sell a property the design currently holds — immediate finality, or
  submittable-by-anyone — and both are larger than everything else left before launch. The
  deployment target decides whether either is ever worth it, and on an L2 neither is.
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

## Target: Sepolia. There is no mainnet plan

Stated because so much of this page only makes sense against it. Gas work, ceremony work and
capacity limits all matter differently on a testnet, and the answer to most of them right now
is "not yet, and possibly not by us" — the optimisation items are written up with their
numbers precisely so someone else can pick them up without re-deriving anything.

## What mainnet would still need

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
