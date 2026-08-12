# Multi-tree pool — design

Replace the single 32-level commitment tree with a sequence of shallow reusable trees, the
way Railgun does. Commitments become addressed by `(treeNumber, leafIndex)` instead of a
single index, and when a tree fills the contract starts the next one.

Not implemented. This is the design to argue with before anything is written.

---

## Why

The tree walk is the dominant cost of every transaction, and it is **fixed, not worst case**.
`_insertPair` calls `_hashLeftRight` exactly once per level with no early exit — both branches
of its `if` hash — so an insert is exactly `LEVELS` Poseidon hashes, always. At ~58,430 gas
each that is 32 × 58,430 = **1,869,760 gas, about 74% of a 2.52M transact**.

Shortening the tree is therefore the only lever with real leverage, and doing it on a *single*
tree costs capacity. Multi-tree gets the same saving and gives capacity back:

| | Gas saved | Capacity | Ceiling behaviour |
| --- | ---: | --- | --- |
| depth 26, single tree | ~350k (14%) | 33.5M transacts | forced migration |
| depth 20, reusable | ~700k (28%) | unbounded | none |
| **depth 16, reusable** | **~935k (37%)** | **unbounded** | **none** |

It also shrinks the circuit — two input Merkle proofs lose 16 levels each at ~520 constraints
per level, roughly −16,600 on 111,116 — and it retires `PoolFull` entirely, along with the
whole depth-versus-catastrophe argument that produced the exit path.

Root history stays a permanent set rather than a ring buffer, so roots from every tree coexist
in it — but it has to start recording *which* tree each root belongs to. See circuit change 3,
which is a double-spend vector if that is skipped.

## Decision: depth 16

Chosen over 20 for the extra 12.7% of gas, accepting the finer time buckets. The reasoning is
that adoption starts slow and usage is uneven, so early trees span long, irregular periods and
the tree number pins down very little.

That is right for the early phase and worth writing down honestly, because it **inverts later**
and the property is permanent for notes already placed:

| Volume | Time to fill a depth-16 tree |
| --- | --- |
| 10 tx/day | ~9 years |
| 100 tx/day | ~11 months |
| 1,000 tx/day | ~33 days |
| 10,000 tx/day | ~3 days |

At low volume there may be only one tree at all, in which case nothing leaks. At high volume a
tree is a few days, and notes created then are permanently in a narrow-window bucket. So the
exposure grows exactly as the protocol succeeds, and cannot be repaired retroactively.

**Depth is also fixed for every tree, forever.** The circuit's Merkle proof depth is a
compile-time parameter, so all trees must share it; changing it later is a new ceremony and a
new verifier, not a configuration change. Sixteen is a commitment, not a default.

## What depth 16 gives up, stated plainly

**Trees fill in order, so the tree number is a timestamp bucket.** The root is a public
signal, so it identifies which tree a note lives in — and therefore roughly *when it was
created*. In a single deep tree the leaf index is private and nothing about creation time
leaks at all. This cuts against timing correlation, which is already the dominant
deanonymisation vector here.

Depth 20 was the alternative: 1,048,576 notes per tree, buckets of ~1.4 years at 1,000 tx/day
instead of ~33 days. Measured against today's 2,521,513:

| | Total | Saving |
| --- | ---: | ---: |
| depth 20 | 1,840,453 | 27.0% |
| depth 16 | 1,606,733 | 36.3% |

so depth 16 is **233,720 gas — 12.7% — cheaper than depth 20**, not the 9 percentage points
that comparing the two savings suggests. It was taken on the judgement that early usage is
slow and irregular enough for the bucket distinction not to matter yet.

If that judgement turns out wrong, the remedy is a new ceremony and a new pool, not a setting
— so it is worth revisiting before mainnet rather than after.

---

## Contract

```solidity
uint32 public constant LEVELS = 16;
uint32 public treeNumber;                 // which tree is filling
uint32 public leafIndex;                  // position within it
mapping(uint256 => bytes32) private filledSubtrees;   // level => hash — NOT keyed by tree
```

**`filledSubtrees` does not need to be keyed by tree, and must not be reset.** The obvious
design — a fresh set of slots per tree — costs ~16 zero → non-zero SSTOREs (~354,000 gas) on
whichever transaction happens to open a new tree, and at depth 16 that lottery runs every
32,768 transacts. None of it is necessary.

The incremental-tree invariant is that `filledSubtrees[i]` is only ever *read* on the odd
branch, and the odd branch at level `i` is always preceded by an even branch at level `i`
within the same tree. A tree starting at index 0 takes the even branch at every level on its
first insert, writing before anything reads. So stale values left by the previous tree are
never read — they are simply overwritten as the new tree fills.

Reusing the slots keeps them warm forever: every write stays a 5,000-gas non-zero → non-zero
update, and **a rollover costs nothing beyond the two counters**.

`_insertPair` is otherwise unchanged, plus a rollover at the end:

```solidity
leafIndex += 2;
if (leafIndex >= (1 << LEVELS)) { treeNumber += 1; leafIndex = 0; }
```

Rollover is automatic and inline — no keeper, no separate transaction, no one paying extra.
Pairs are always even and `2^LEVELS` is even, so a pair can never straddle a boundary; that
still wants asserting rather than assuming.

`PoolFull` disappears. The remaining bound is `treeNumber` overflowing a `uint32`, which is
4.3 billion trees of 65,536 notes each and is not a real limit — but it should still revert
explicitly rather than wrap, for the same reason `RegistryFull` exists.

`Transact` must emit the tree number alongside the leaf indices, or a scanner cannot place the
commitments. `PoolExit` is unaffected — it inserts nothing.

## Circuit

Three changes, and the second is the one that will bite.

**1. Proof depth.** `poolLevels` goes 32 → 16. Mechanical.

**2. The nullifier must include the tree number.** This is a correctness bug waiting to
happen, not an optimisation. Today:

```
nullifier = Poseidon(nullifierKey, leafIndex, NULLIFIER_DOMAIN)
```

where `leafIndex` is packed from the 32 `pathIndices` bits. With 16-level trees those bits
give only 16 — so **leaf 5 in tree 0 and leaf 5 in tree 3 produce the same nullifier**. The
second note would read as already spent and become permanently unspendable by anyone. Silent,
irreversible, and it would look like a double-spend guard working correctly.

The index has to be global:

```
globalIndex = treeNumber * 2^LEVELS + localIndex
```

with `treeNumber` range-checked to `2^(32 - LEVELS)` so that `globalIndex` stays below `2^32`
and the decomposition is unique. (Public, not private — see the next point.) `NULLIFIER_DOMAIN` stays as
it is. Note this preserves the current nullifier for `treeNumber = 0`, which is a useful
sanity check while developing but must not be mistaken for compatibility — nothing has
launched, so the format is free to change.

**3. The tree number must be PUBLIC and bound to the root — or the nullifier fix reopens as a
double spend.**

This is worse than the collision above and was an open question in the first draft of this
document. It is not optional.

If `treeNumber` is a private input used only to build the global index, nothing relates it to
the root the Merkle proof was checked against. `knownPoolRoots` is a flat `bytes32 => bool`
set that carries no tree information, and pool roots never expire. So the holder of a note at
(tree 3, leaf 5) can:

1. Spend it: prove against tree 3's root, claim `treeNumber = 3`, publish nullifier `N₃`.
2. Spend it **again**: prove against tree 3's root — still valid, still known — but claim
   `treeNumber = 7`. The nullifier is now `N₇ ≠ N₃`, which is unspent.

The contract sees a known root and a fresh nullifier and accepts. Repeat for every value of
`treeNumber` in range. That is unlimited theft, not a denial of service.

**Fix:** store the tree with the root and check it.

```solidity
// was: mapping(bytes32 => bool) knownPoolRoots
mapping(bytes32 => uint256) public knownPoolRootTree;   // treeNumber + 1; 0 = unknown
```

and make `treeNumber[nIns]` public so the pool can require
`knownPoolRootTree[p.poolRoot[i]] == p.treeNumber[i] + 1` for every non-dummy input.

Cost: two more public signals (~13,400 gas of verification) and two SLOADs. The rejected
alternative was to domain-separate the root itself as `Poseidon(treeRoot, treeNumber)`, which
keeps the tree number private and needs no new signals — but it adds an on-chain Poseidon to
every insert, ~58,430 gas, which is four times the price of just making it public.

One wrinkle to handle rather than discover: **every tree's empty root is the same value**, so
a rolled-over tree cannot re-publish it under a new number. Publish roots only after an
insert, and let the first writer win. Nothing can be proven against an empty root anyway,
since it has no leaves.

**4. `poolRoot` becomes `poolRoot[nIns]`.** Two inputs may legitimately live in different
trees, and requiring them to share one would mean a holder could not spend a note from tree 3
alongside one from tree 5 — an arbitrary and user-visible restriction. So each input proves
against its own root, and the pool checks `isKnownPoolRoot` for both. A zero-amount dummy
input skips the Merkle check, so its root is unconstrained as before.

Public signals go 11 → 14: `poolRoot[2]` and `treeNumber[2]` in place of a single root.

**Estimated constraints:** −16,600 for the shallower proofs, plus a handful for the global
index and the tree-number range checks. Roughly **94,700**, from 111,116.

## SDK

- A `MerkleTree` per tree number rather than one, built during the scan.
- Every note record carries `(treeNumber, leafIndex)`; the cache format changes with it.
- `Transact` decoding reads the new tree-number field.
- Proof construction passes the per-input tree number and the two pool roots.
- `dummyInput` needs a tree number too — zero is fine, since dummies skip the Merkle check.

## What this does not change

- The registry SMT. It is a different tree with different properties: slots are permanent and
  addressed by alias, so it cannot be split this way, and it is only written on registration
  and handover rather than on every transaction.
- The exit path. It stops being a safety valve — there is no full pool to rescue — but it
  remains a ~85% saving on full withdrawals and should stay.
- Root history. Already a permanent set.

## Risks

**The nullifier collision above is the one that matters.** It is the only change here that can
destroy funds, it fails silently, and it is invisible until two notes happen to share a local
index across trees — which will not occur in any test that uses a single tree. **The suite
must force a tree rollover and then spend one note from each of two trees in the same
transaction.** Without that test this change should not land.

**Anonymity buckets are a permanent, non-reversible property.** Once notes are spread across
trees, the leak exists for every note in them. This is the trade being made and it should be
a deliberate decision, not a side effect of a gas optimisation.

**Reusing `filledSubtrees` across trees rests on an invariant, not on an obvious property.**
It holds only because the tree fills sequentially from index 0, so every read at a level is
preceded by a write at that level in the same tree. Anything that breaks sequential filling —
a resumable tree, an out-of-order insert, a tree that starts part-full — silently reads the
previous tree's values and produces a root that no one can prove against. Worth an explicit
test that the first insert after a rollover matches an independently computed empty-tree
insert.

## Concurrency

Checked before implementing rather than after. The short version is that **multi-tree
introduces no new races**, and the reason is worth stating precisely because it is a property
that could be lost by accident later.

### Why slot contention is benign

**Output position is bound in nothing.** The proof's public signals carry the output
*commitments* but not their indices — there is no `outputLeafIndex` among them, and the
circuit neither knows nor constrains where its outputs will land. The contract inserts them
wherever `leafIndex` happens to point when the transaction executes.

So a transaction is valid regardless of which slot, or which tree, its outputs occupy. Two
transactions cannot contend for a slot in any meaningful sense: the EVM is serial, the first
takes the position it finds, the second takes the next one, and neither's validity depended on
which it got. The owner learns the final `(treeNumber, leafIndex)` from the `Transact` event
after the fact, which is also where the nullifier for that note is derived from later.

The three cases raised, each with the outcome:

| Race | Outcome |
| --- | --- |
| Two transactions for the last slot pair of tree N | First fills tree N and rolls over; second opens tree N+1. Both succeed. |
| One for the tail of tree N, one for the head of N+1 | Same thing — the ordering *is* the resolution. |
| Two for the first slot of tree N+1 | Slots 0–1 and 2–3. Both succeed. |

A pair can never straddle a boundary: `leafIndex` is always even and `2^LEVELS` is even, so
the last pair of a tree fills it exactly. This should be asserted rather than assumed.

### Why a prepared transaction cannot be invalidated

An input proves membership against a root of whichever tree holds it. Pool roots are permanent
and old trees are frozen — nothing ever modifies tree T after it rolls over — so a proof built
against tree T's root stays valid indefinitely, whatever else lands in between. This is the
same property that makes the pool immune to the contention that produced F1 on the registry
side, and it survives the change intact.

### The one new requirement

`knownPoolRootTree` must be **first-writer-wins**:

```solidity
if (knownPoolRootTree[root] == 0) knownPoolRootTree[root] = treeNumber + 1;
```

Overwriting unconditionally would let a later tree steal an earlier root's mapping, and every
note proving against that root would then fail the tree-number check — funds frozen, not
stolen, but frozen permanently. Every tree's *empty* root is the same value, which is exactly
why roots are published only after an insert; nothing can be proven against an empty tree
anyway.

A deliberate collision between two non-empty trees' roots would require controlling all 65,536
leaves of both, and achieves only self-inflicted denial. Not a threat, but it is the reason
the rule is first-writer-wins rather than last.

### Unchanged, and worth re-testing anyway

- Double-spending the same note still fails on the nullifier, in whichever tree it lives.
- A stale client mirror is still harmless: it proves against an older root, which is still
  known and still tagged to the right tree.
- Reorgs remain the one case where a recorded position can change — and multi-tree widens it
  slightly, since `treeNumber` can move as well as `leafIndex`. Clients should treat a note's
  position as settled only after confirmations, as they should already.

## Spending across trees

Each input names its own tree, so a transaction can spend one note from tree 3 and another
from tree 7 with no special handling — that is exactly why `poolRoot` and `treeNumber` become
per-input arrays rather than single signals. Both inputs being in the same tree is the same
code path with equal values.

Two things follow from the 2-in/2-out shape rather than from multi-tree:

- **There is no "3+ inputs" case.** At most two notes can be spent per transaction regardless
  of trees, so consolidating a scattered balance takes several transactions. Outputs always
  land in the *current* tree, so notes naturally migrate forward over time.
- **Old notes never expire.** Every tree's roots stay in the known set permanently, so a note
  in tree 3 is spendable years later with no refresh.

Two costs worth stating:

- Spending notes from two different trees reveals **two** creation epochs instead of one.
- A dummy input skips the Merkle check but still occupies a root slot the contract will check,
  so it must carry some genuinely known root and its matching tree number. Any current root
  does; its nullifier is unique regardless, because dummy keys are freshly random.
