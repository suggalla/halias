# Bucketed registry slots

Status: **proposal**. Nothing implemented. Depends on the mainnet ceremony not having happened,
which is currently true and will not stay true.

## The problem

A sender must prove the recipient's alias is in the registry, which needs a Merkle path. The
client can either **ask for that path** — which names the recipient to whoever answers — or
**derive it**, which needs the whole tree.

`docs/rpc-surface.md` took the second option and measured it. Deriving the tree means scanning
every registration:

| aliases | registry logs | tree build | tree in memory |
| --- | --- | --- | --- |
| 10,000 | 8 MB | 1.3 s | 2.4 MB |
| 100,000 | 78 MB | 13 s | 24 MB |
| 1,000,000 | **785 MB** | 102 s | 240 MB |

785 B of log JSON per alias is measured, not estimated. At a million aliases the client dies on
the download long before the hashing matters. **This design is good to ~10k as it stands, and
~100k with persistence and incremental scanning. It does not reach a million.**

## Two things that look like fixes and are not

**"It's a sparse Merkle tree — exploit the sparsity."** It is not sparse where it matters.
`SMTRegistry.sol:88` assigns `slot = ++nextAliasSlot`, so the occupied region is a *dense
prefix* of N leaves and depth 32 is a capacity bound rather than a birthday bound. Above level
log₂(N) every sibling is a precomputed zero and already free; below it every sibling is real
and summarises a subtree you must have built. There is no sparsity left to spend.

**"Roll to smaller trees like the pool does."** The pool's `globalIndex = treeNumber · 2^16 +
leafIndex` bounds the tree a client must hold, and the same trick shrinks the registry
proof — but it does not fix the scan, because it is circular. To know which tree Bob is in you
need Bob's slot; slots are assigned in arrival order, so his slot is only discoverable from his
own `AliasRegistered` event. Find that without a targeted query and you are scanning all 785 MB
again. Query it directly — `aliasHash` is an indexed topic, so one filtered `eth_getLogs`
returns exactly his registration — and that is precisely the leak this all exists to remove.

The circularity is the real finding: **anything that partitions the registry by arrival order
requires a lookup to use.**

## The design: make the slot an address, not a counter

Split the slot into a bucket derived from the alias hash and a counter within that bucket:

```
slot = bucket ‖ localIndex
       │        └── (depth − 8) bits, sequential within the bucket
       └── 8 bits, taken from the alias hash
```

The client computes the bucket **from the name it was given**, with no lookup and nothing
disclosed. It then needs only that bucket's registrations. The circularity is gone because the
partition is a function of the name rather than of when the name arrived.

Two properties are worth stating precisely, because they are what makes this cheap:

**It is still one tree.** Buckets are subtrees of a single depth-*d* tree, not separate trees.
So there is still exactly one `registryRoot` public signal, one `isKnownRegistryRoot` check,
and one `REGISTRY_ROOT_MAX_AGE`. None of the freshness logic in `HaliasPool.sol:200` or
`SMTRegistry.sol:122` changes. This matters more than it sounds: the circuit has a *single*
`registryRoot` shared by both outputs and the pending-insert path (`transact.circom:63`), and a
design with per-bucket roots would need one root per output and a rework of that whole area.

**The circuit change is one constant.** `transact.circom:314` decomposes the slot with
`Num2Bits(registryLevels)` and walks the bits — it never interprets them. Redefining what the
bits *mean* is free. The only edit is `Transact(16, 32, 2, 2)` → `Transact(16, d, 2, 2)`.

## What the client does

1. `bucket = topBits(keccak(name), 8)` — local, instant, discloses nothing.
2. `eth_getLogs` for `AliasRegistered` filtered on the bucket topic. Discloses the bucket.
3. `getBucketRoots()` → `bytes32[256]`, **8 KB**, identical for every caller, discloses nothing.
   Fold to the top 8 levels locally: 255 hashes, ~13 ms.
4. Build the bucket's subtree bottom-up from its leaves — still a dense prefix, so
   `SMT.fromLeaves` applies unchanged.
5. Path = (d−8) siblings inside the bucket + 8 siblings up the top.

| registry | own bucket | logs | build | k |
| --- | --- | --- | --- | --- |
| 100,000 | 391 | 0.3 MB | 0.04 s | ~391 |
| 1,000,000 | 3,906 | 3.1 MB | 0.40 s | ~3,900 |
| 10,000,000 | 39,062 | 30.7 MB | 3.98 s | ~39,000 |

785 MB → 3.1 MB at a million aliases, and the cost stops depending on how big the registry is.

**k is a client-side knob, not a fixed property.** Nothing stops a client fetching several
buckets, or all 256 — which is exactly today's behaviour and today's zero leak. That makes this
strictly a superset of the current design rather than a trade, and it matters early on: see the
sequentiality section below.

## Question: what happens when a bucket fills?

"`alice.hls` cannot be registered because a hash bucket is full" is an unacceptable sentence to
say to a user, so this section is the one that decides whether the design is worth building.
Three things need separating, because they are not equally bad.

### A fixed-depth tree always has a hard cap. That is not new.

Depth 32 with a global counter caps the registry at 4.3B and reverts with `RegistryFull`
(`SMTRegistry.sol:95`). The cap exists today; bucketing does not introduce it. What bucketing
does is **lower the ceiling** — depth 24 with 8 bucket bits gives 16.8M slots — and make the top
sliver of that ceiling probabilistic per name rather than exact.

So the question is not "does a cap exist" but "is the reachable part of it fair".

### The probabilistic zone is the last ~1% of capacity, not a broad band

Occupancy is binomial, and the relevant number is how far the per-bucket cap sits above the
mean — not a fixed sigma count. At depth 24 with 256 buckets:

| registry | mean/bucket | σ | headroom | P(any bucket full) |
| --- | --- | --- | --- | --- |
| 1,000,000 | 3,906 | 62 | 988σ | 0 |
| 5,000,000 | 19,531 | 139 | 330σ | 0 |
| 10,000,000 | 39,062 | 197 | 134σ | 0 |
| 14,000,000 | 54,688 | 233 | 46σ | 0 |
| 16,000,000 | 62,500 | 250 | 12σ | 6e−32 |
| 16,700,000 | 65,234 | 255 | 1.2σ | certain |

An earlier draft of this document sized at "mean + 4σ" and reported a safe size of ~16.5M, which
badly misrepresents the shape: the probability is not a gradient, it is zero to floating point
until roughly 95% of capacity and then turns on sharply. At a million aliases the cap is 988σ
away. **For any registry within 5x of ENS's ~2–3M, this failure cannot occur.**

### If that is still not good enough — and it is reasonable to say it is not — probe

A naming system arguably should not have a per-name failure at *any* utilisation. It can be
removed outright, cheaply, with a locally computable probe sequence:

```
bucket_i = topBits(keccak(name ‖ i), 8)     for i = 0, 1, …
```

The contract assigns to the first candidate with room. The client tries probe 0, and only if the
name is not there does it fetch probe 1 — so the average cost stays one bucket, because
essentially everyone lands in probe 0. Registration now fails only when *all* of a name's
candidates are full, which pushes the failure back to global exhaustion.

This is worth deciding now rather than later. Contract-side, spilling is one extra branch and it
never moves an existing name, so it could be added at any time. **Client-side it cannot**: a
client that only knows probe 0 would report a spilled name as unregistered — a wrong answer
rather than a safe failure. Since nothing has launched, the cheap insurance is to make the
client probe-aware from the start even if the contract never spills a single name.

### Sizing

| depth | per bucket | total slots | constraints | vs 32 |
| --- | --- | --- | --- | --- |
| 20 | 4,096 | 1.0M | 69,516 | −26% |
| 22 | 16,384 | 4.2M | 73,682 | −22% |
| **24** | **65,536** | **16.8M** | **77,848** | **−18%** |
| 32 (today) | — | 4.3B | 94,512 | — |

**Recommendation: depth 24, 256 buckets, probe-aware client.** Depth 20 caps at a million, which
is the ceiling this proposal exists to raise, so it defeats the purpose.

**The depth is a permanent commitment.** It cannot be raised without invalidating every existing
proof and re-running the ceremony. Choose it for the registry you would be content to cap at,
not the one you expect.

**Rejected: generations per bucket.** Bucket B rolls to a second tree when full. Within a single
tree this is not a distinct option at all — "another generation" and "more local index bits" are
the same thing. As *separate* trees it means a root per (bucket, generation), which breaks the
single-`registryRoot` property that keeps the circuit and the freshness logic untouched. Probing
achieves the same end for one branch.

### Bucket count is a three-way trade

Fewer, larger buckets give better anonymity *and* better capacity utilisation, and cost more
client work. Headroom below is at 14M aliases, depth 24:

| buckets | cap/bucket | k at 1M | client MB at 1M | headroom at 14M |
| --- | --- | --- | --- | --- |
| 64 | 262,144 | 15,625 | 12.3 | 93σ |
| 128 | 131,072 | 7,812 | 6.1 | 66σ |
| **256** | **65,536** | **3,906** | **3.1** | **46σ** |
| 512 | 32,768 | 1,953 | 1.5 | 33σ |

256 is a middle default, not a derived answer. 128 buys double the anonymity set for double the
download and is worth considering if 6 MB per cold sync is acceptable.

## Question: are buckets sequential?

No, and it is worth being precise about what sequentiality was buying, because part of it
survives and part does not.

Global `++nextAliasSlot` bought two things:

1. **A dense prefix** — the occupied region is contiguous, so the tree is ~2N nodes and the
   bottom-up build is cheap.
2. **Depth as a capacity bound rather than a birthday bound.** Hash-derived *slots* would need
   roughly double the depth to make collisions negligible. A counter needs none.

Under `bucket ‖ localIndex`, both survive **within a bucket**: `localIndex` is still a counter,
so each bucket's subtree is a dense prefix and (depth − 8) bits is exact capacity with no
birthday margin. The bucket bits are hash-derived, but a bucket is not a slot — collisions there
are the entire point, which is why they cost nothing.

Globally, sequentiality is gone, and three consequences follow:

- **Buckets fill in parallel, not in order.** At 1,000 aliases every bucket holds ~4. The tree
  is now sparse *between* buckets, which is free — empty subtrees are precomputed zeros — so
  node count stays ~2N + 255 rather than 2^24.
- **Path length is fixed by depth, not occupancy.** A 10-name registry still pays depth-24
  proofs. That cost is already paid today at depth 32, so this is an improvement, not a
  regression.
- **k-anonymity is poor while the registry is small.** At 1,000 aliases, naming a bucket narrows
  the recipient to about four people — *worse than today's zero leak.* This is the one place
  the design is not a strict improvement, and it is why step 2 below makes bucket-scoped
  scanning a client policy rather than a mandate: while the registry is small, download all 256
  buckets, because it is cheap precisely when k would be bad. Narrow only once N/256 is a crowd
  worth hiding in.

## Contract changes

- Slot assignment in `SMTRegistry._smtUpdate`: `slot = (bucket << (d-8)) | ++nextLocal[bucket]`,
  preserving the "0 means unregistered" convention, with the probe loop taking the first
  candidate bucket that has room.
- `nextAliasSlot` → `nextLocalSlot(uint8 bucket)`. The claim path reads it
  (`halias.ts:1381`) — a targeted read that now discloses your own bucket, at a moment when
  registration is about to publish your name anyway.
- `_registryCapacity()` becomes per bucket; new `BucketFull` error. `Capacity.test.ts` already
  has the mock-the-ceiling pattern for reaching it.
- `AliasRegistered` gains `uint8 indexed bucket`. The bucket is derivable from the slot, but
  `eth_getLogs` cannot compute over topics, so it has to be its own indexed field to be
  filterable.
- New `getBucketRoots() → bytes32[256]`: a global read, same answer for every caller.
- Unchanged: `registryRootSeenAt`, `isKnownRegistryRoot`, `REGISTRY_ROOT_MAX_AGE`, the
  `pendingLeaf` transient mechanism, and `reassign` keeping an alias in its slot.

## Client changes

- Bucket derivation, the probe sequence, and a scan scoped to one or more buckets. Probe
  awareness has to ship from the start — see the bucket-full section — even if the contract
  never spills.
- A partial-tree build: leaves for the buckets held, fetched roots for the rest. `SMT.fromLeaves`
  builds a complete tree today and needs a variant that grafts known subtree roots.
- The k policy described above.
- `SdkPreimage.test.ts` → *registry tree* already asserts the mirror equals the contract's tree
  and would carry straight over; the `e2e-live` selector watch likewise.

## Ceremony timing

**This is the window.** The ceremony is still `--dev`, single-contributor, and already blocking
for real funds. Changing `registryLevels` changes the r1cs, so it needs a new ceremony — which
is free while the ceremony is a placeholder and expensive once it is not. Nothing has launched,
so there is no migration and no compatibility shim: per the project's standing rule, this is a
base change made in place.

## Phasing

1. **Depth and slot layout, no privacy change.** Change the constant, change slot assignment,
   update tests. The client still downloads every bucket, so behaviour is identical — the only
   visible effect is an 18% smaller circuit and a proportionally smaller proving key. Low risk,
   independently valuable, and it can be tested against the existing suites.
2. **Bucket-scoped scanning.** Add the bucket topic and `getBucketRoots()`, teach the client to
   fetch a subset, add the k policy. This is where the 785 MB → 3.1 MB lands.
3. **Ceremony**, once the shape is frozen.

## Open questions

- 8 bucket bits is as permanent as the depth, and the trade is three-way — fewer buckets means
  better k *and* better capacity utilisation, for more client work. 128 deserves a look.
- How many probe candidates. Two removes the failure for any plausible utilisation; more costs
  nothing until they are used.
- Whether the top-8 fold belongs in `getBucketRoots()` or a general `getSmtNodes(level, from,
  count)` — the latter is more useful and a wider surface.
- Interaction with prefix bucketing for *lookup* (`getAliasesByPrefix`, handoff item 7). These
  are the same idea applied to two different problems and should probably share a partition.
