# What the client tells its RPC provider

Every audit in this repository has looked at on-chain code. `security-audit.md` is titled
*"the split, against Halias.sol"*; `audit-2026-08.md` is *"circuits and contracts"*;
`prior-art-review.md` checks the registry against Semaphore and World ID. Not one of them
examined what the client reveals to the infrastructure it talks to, and by their standard the
contracts are correct — the leaks below are all in *how the client asks*, not in what the
contract answers.

This pass enumerates every outbound call the SDK makes and asks one question of each: **what
does the party answering learn?**

It found the leak that matters most on the main path. It also found that most of it is
avoidable, because the client already holds the data it is asking for.

## The rule this should have been written against

A privacy client has two ways to read a chain, and only one of them is safe:

> **Read in bulk. Never ask a targeted question.**

Bulk reads are what everyone gets. A targeted read is a statement about you — *this* alias,
*this* nullifier, *this* token — delivered to a party who also sees your IP, your timing, and
usually your broadcasts.

The SDK has both models living side by side with nothing saying which to use. `scanEvents`
fetches every log and decrypts locally, which is right. `registryProof` asks three pointed
questions about the person you are paying, which is not. Neither was decided; both were
written, and the second survived because nobody looked.

## The findings

Ordered by what an answering node learns.

### 1. The recipient of every private payment — `registryProof` — **fixed**

*Was* `client-core.ts:501` and `:507`, three calls carrying the same alias hash:

```ts
const oneBased = await this.registry.aliasSlot(h, { blockTag });
const [siblings, root, record] = await Promise.all([
  this.registry.getSmtSiblings(slot, { blockTag }),
  this.registry.getRegistryRoot({ blockTag }),
  this.registry.aliases(h, { blockTag }),
]);
```

Every `send()` resolves its recipient this way. Names are published at registration, so the
hash reverses trivially — the provider learns, in plaintext, **who you are about to pay
privately**, moments before a transfer that publishes nothing.

This is the one that undoes the product's central claim, and it is on the main path.

**Two of the three calls are already redundant.**

- `aliasSlot(h)` — the slot is carried in `AliasRegistered(…, uint32 slot)`, and the client
  scans every one of those events into `registryEntries`.
- `aliases(h)` — the record's `spendingCommitment` and `encryptionPubkey` are in the same
  event, and `dataHash` comes from `AliasDataUpdated`. Only **`nullifierKeyHash` is missing**,
  which is why the call exists at all.

**The third has a proportionate fix.** `getSmtSiblings(slot)` returns 32 hashes; the leak is
the selectivity, not the data. A batch endpoint taking several slots gives tunable
k-anonymity at a cost that stays sensible:

| slots requested | download | what the provider learns |
| --- | --- | --- |
| 1 (today) | 1 KB | exactly who you are paying |
| 50 | 51 KB | one of fifty |
| 200 | 205 KB | one of two hundred |
| every occupied slot | ~2N × 32 B | nothing |

51 KB is nothing beside the 42 MB proving key the same client already fetches.

**What was done instead: full local resolution, with no new endpoint at all.** Widening
`AliasRegistered` with `nullifierKeyHash` made every registration reconstructible from logs,
and once that holds the client can rebuild the *whole tree* from the scan it already performs
— `rebuildRegistryTree` — and read any sibling path out of it. No batch endpoint, no bulk node
read, no k-anonymity parameter to tune: the query does not exist.

All three calls are gone from the common path. What remains is `getRegistryRoot()`, which
every caller asks and every caller gets the same answer to.

The mirror is only sound if it is the contract's tree exactly, and a wrong one fails silently
— its root simply mismatches, the client falls back to fetching, and every test still passes
while the leak returns. Two suites close that:

- `SdkPreimage.test.ts` → *registry tree*: builds the tree from logs against a live registry
  and asserts the root, and every sibling path, equals the contract's — plus the negative
  cases, where a stale mirror or a stale leaf must fail the check rather than produce a proof.
- `e2e-live` watches `_send` across a real `send()` and asserts no `eth_call` carries
  `aliasSlot`, `getSmtSiblings` or `aliases`. That is the only check that can tell whether the
  client *uses* the mirror, as opposed to merely having a correct one.

The local copy is also *verified*, not trusted: the derived path must rebuild the published
root before it is used, which is strictly more checking than fetching the fields and using
them unchecked. A rotated key, an updated `dataHash`, or any registration landing since the
last scan all fail that comparison locally, and only then is anything fetched.

#### What this costs, and where it stops

Trading a 1 KB request for a client-side mirror is not free, and the bill is CPU. Measured on
one machine at 10,000 aliases:

| | |
| --- | --- |
| nodes held | 20,022 (~2 per alias) |
| heap | 2.4 MB (243 B/alias) |
| read a sibling path | 0.008 ms |
| serialise / load back | 18 ms / 19 ms, 1.5 MB of JSON |
| **build from scratch** | **1,272 ms** (0.13 ms/alias) |

Storage and reads are nothing; the build is the whole cost, and it is Poseidon. `F.toObject`
is 2.6 µs of a 49 µs hash, so there is no marshalling overhead to remove — the only thing that
moves the number is doing fewer hashes.

**Which is where the first version was wrong, by 14x.** Building the tree with one `update`
per alias walks 32 levels each time, so every internal node is recomputed once per descendant:
330,000 hashes for 10,000 aliases, and 18.5 s. Hashing each node exactly once — `SMT.fromLeaves`,
bottom-up — needs 20,023 for the same tree, and takes 1.27 s. Identical roots, identical
sibling paths, no contract change, no download. `SdkPreimage.test.ts` asserts the two builders
agree, since they now share no code.

That correction is what decides whether the design holds. At 0.13 ms/alias against the 541 µs
per note the same sync already spends on trial decryption, the tree is a fraction of a cost
the client already pays. At 1.85 ms it was competing with it.

Extrapolated: 0.13 s at a thousand aliases, 1.3 s at ten thousand, ~13 s at a hundred thousand,
~2 min at a million.

**But the tree is not what caps this design, and it is worth being clear about that before
optimising it further.** The client resolves names locally, which means scanning every
registration — measured at **785 bytes of log JSON per alias** over RPC:

| aliases | registry logs | tree build | tree in memory |
| --- | --- | --- | --- |
| 10,000 | 8 MB | 1.3 s | 2.4 MB |
| 100,000 | 78 MB | 13 s | 24 MB |
| 1,000,000 | **785 MB** | 102 s | 240 MB |

At a million aliases the client has died on an 800 MB download long before it reaches two
minutes of hashing. The scan is the ceiling; the tree rides on it. That ordering predates this
change — `lookup()` and the slot already came from the same scan — so nothing here moved the
limit, it only made it measurable.

The constant is also not rescuable by swapping hash libraries: `poseidon-lite`, the obvious
alternative, produces identical output and is **4x slower** (202 µs against circomlibjs's
51 µs). Web Workers are the only remaining lever, and they are already wanted for the note
scan.

**What actually raises the ceiling is making O(N) a once-ever cost rather than a per-session
one** — persistence plus incremental scanning, which is the same pair of fixes the note scan
needs. A client that syncs once and then keeps up with new registrations pays the big number a
single time on a single device and milliseconds thereafter, which is how every SPV wallet
handles the same shape of problem. Neither is built yet.

Past that, staying private *and* avoiding the full scan is a different architecture, not a
tuning exercise: k-anonymous prefix buckets (item 7 in the handoff), PIR, or a helper you trust
more than an RPC provider. Two things extend the present design first:

1. **Persist the tree.** `serializeNodes`/`fromSerialized` exist and are unused. Wiring them
   makes even the 1.27 s once per device rather than once per session — a returning client
   pays the 19 ms load. This is the cheap one, and it is client-side only.
2. **Download the tree instead of computing it**, if a registry ever gets large enough that
   hashing it is the problem. The occupied region is a dense prefix of ~2N nodes, so a bulk
   node read over `_smtNodes` trades the hashing for ~640 KB at 10,000 aliases and leaks
   nothing — every client fetches the same range, so there is no k-anonymity parameter to
   argue about. **Not currently worth it:** 640 KB of bandwidth to avoid 1.27 s of CPU is a bad
   trade, and it costs a contract function. Revisit past ~100k aliases.

None of this is what breaks first. `refresh()` rescanning from `startBlock` on every call, at
O(notes × aliases) trial decryption, still is.

### 2. Which alias you are acting on

- `halias.ts:1084` — `aliasAuth(aliasHash)`
- `contract.ts:392`, `:506` — `aliasNonce(aliasHash)`, before signing
- `halias.ts:933` — `ownerOf(hash)`

Weaker than the above, because these concern an alias you already control rather than the
counterparty. Still a targeted statement. `ownerOf` is reconstructible from ERC-721 `Transfer`
logs, which the client is positioned to scan; the nonces are not in any event.

### 3. That you are enumerating invites

`halias.ts:1503` and `:1531` — `isRegistered(inviteAliasHash)`, walking indices until a gap.
Introduced with `listInvites`. The secret is not revealed (the name carries a hash of it), but
the walk is a recognisable pattern that links an IP to a set of invites. `isRegistered` is
answerable from scanned registrations.

### 4. Which asset you hold

`client-core.ts:566`, `:571` — `decimals()` and `symbol()` on a token contract. Small, cached
after the first call, and only for tokens you actually touch.

### 5. That you are about to deposit

`halias.ts:296` — `allowance(me, pool)` ties your public address to an intent to deposit,
shortly before the deposit publishes that anyway. Marginal.

### 6. A prepared transaction, before it is broadcast

`relay.ts:185` — `estimateGas` on the relay path. Already handled: simulation is opt-in there
and defaulted off, because on that path your address never touches the chain and simulating
would hand the calldata to a provider that would otherwise never see it.

## What leaks nothing

Global reads, identical for every caller: `registrationFee()`, `nextAliasSlot()`,
`getRegistryRoot()`, `getFeeData()`. Broadcasts are not leaks — `transact`, `approve` and
`reserveRegistration` are going on chain regardless, and the reservation is an opaque hash.

`scanEvents` is the model the rest should follow: one chunked `getLogs` pass, everything
decrypted locally, nothing said about which notes are yours.

## Fixed by this pass

`registrationCommitment` was `public pure` on the controller, and the SDK called it over
`eth_call` **with the plaintext name as its first argument** — handing the name to a provider
before the opaque reservation was broadcast, on the one flow whose entire purpose is that
nobody learns the name until front-running is impossible.

The SDK now computes it locally, and the function is `internal`, so no integrator can
reintroduce the leak. `SdkPreimage.test.ts` proves the encodings agree by reserving with the
SDK's hash and revealing against the contract's — a disagreement surfaces as `NoReservation`
in a test rather than as a stranded registration in production.

## What to do

1. ~~**Add `nullifierKeyHash` to `AliasRegistered` and `AliasReassigned`.**~~ Done. ~2,000 gas
   on a fee-bearing transaction, reveals nothing new — it is already public in `aliases()` and
   already committed inside `leaf` — and it makes the registry fully reconstructible from
   logs, which is what everything below rests on.
2. ~~**Stop calling `aliasSlot`.**~~ Done; the slot is in the event the client already scans.
3. ~~**Batch the sibling read.**~~ Superseded. The tree is rebuilt from the same logs, so there
   is no read to batch and no k-anonymity parameter to choose. `getSmtSiblingsBatch` was never
   added, and if the registry ever outgrows a local rebuild the answer is a bulk **node** read
   — see *What this costs, and where it stops* — which needs no k-anonymity either.
4. **Separate the read provider from the broadcast provider.** One config field. Whoever
   learns "this IP resolved bob.hls" is then not whoever sees the transaction land, and
   neither can correlate them.
5. **Say so in the About screen.** It enumerates what is public and currently reads as
   exhaustive. It does not mention the RPC provider at all, and for a project whose pitch is
   being legible about what leaks, that omission matters more than any single call.

## What this does not cover

Network-level metadata — IP, timing, TLS fingerprint — and anything a provider infers from
correlating reads with broadcasts. Running your own node removes all of it and is the only
complete answer; everything above is about not making the problem worse than it needs to be.

None of this is unique to halias. Every light client leaks to whatever node it queries, and
Zcash, Tornado and Railgun all carry the same caveat. Railgun never had finding #1 because its
recipient *is* the key, so no lookup exists — the name layer created the exposure, and closing
it took rebuilding the registry client-side. Worth stating plainly: readable names cost
something here, and the cost was paid in client work rather than passed to the user.
