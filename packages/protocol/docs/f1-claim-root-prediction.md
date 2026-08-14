# F1 — the claim that must predict a root — FIXED

> **Implemented.** Option B, below, with one correction the original plan needed: the pending
> siblings must be proved against `registryRoot` before being reused to derive the
> post-insertion root. Without that they are unconstrained, so a prover could fabricate any
> tree whenever `pendingLeaf` is non-zero — making registry membership vacuous on exactly the
> path that mints new aliases. The emptiness proof closes it and also confines an insertion to
> a free slot, so it can never overwrite an existing alias.
>
> Cost came in at **77,790 → 111,112 constraints (+43%)**, not the ~+2,500 estimated here: the
> fix needs two 32-level Merkle computations, and one of those is ~16,000 constraints, not
> 2,500. Public signals went 9 → 10, so the verifier, `_verifyTransact` and the mock all
> changed together. Still inside the 2^17 ceremony domain, with headroom down from 53k to 20k.


`claim` is the only operation in the system whose proof commits to a registry root **that
does not exist yet**. Everything else proves against a root already on chain.

The cause is ordering, and the ordering is not negotiable. A claim's change note is a
non-zero output, and the circuit demands registry membership for every non-zero output — so
the claimer's own alias must be in the tree before the proof is checked. The domain therefore
registers first and calls the pool second, which leaves the client predicting the result:

```ts
// packages/sdk/src/halias.ts — claimInvite
const ownSlot = Number(await this.registry.nextAliasSlot());
const postSmt = this.smt.clone();
postSmt.update(ownSlot, smtKey, poseidonHash([...]));   // the guess
```

Any registry write landing in between changes the base tree, the prediction is wrong, and the
pool rejects with `RegistryRootNotCurrent`.

**It is not only registrations.** Three functions write leaves — `register`, `setDataHash`,
`reassign` — reachable as `register`/`claim`, `updateAliasData`, and `acceptAlias`. Any of
them invalidates every claim in flight. (There were four; `rotateKeys` was removed with F7,
and `setDataHash` is itself a removal candidate, which would leave two.)
`updateAliasData` on an alias you already own costs gas alone: no fee, no commitment, no
waiting. Blocking someone's onboarding is therefore cheap and repeatable, which makes this
more than accidental contention.

Registration itself is unaffected — neither of its transactions carries a proof or reads a
root.

---

## How root acceptance actually works

Two different rules, and the difference matters for everything below.

**Pool roots never expire.** `knownPoolRoots` is a permanent mapping. Any root the pool ever
published stays valid forever, so a slow prover never loses a note. (Tornado uses a 30-root
ring buffer; this diverges in the safe direction — see F4.)

**Registry roots expire on a sliding window, measured from supersession:**

```solidity
function isKnownRegistryRoot(bytes32 root) public view returns (bool) {
    if (root == bytes32(0)) return false;
    if (root == smtRoot) return true;                       // current: always, however old
    uint256 seen = registryRootBlock[root];
    if (seen == 0) return false;
    return block.number - seen <= REGISTRY_ROOT_MAX_AGE;     // 7200 blocks, ~1 day
}
```

Not a ring buffer — a permanent mapping of root to *the block it stopped being current*.
The current root is accepted indefinitely, because an idle registry has not gone stale; a
superseded root is accepted for about a day afterwards.

### Why an older root cannot simply be reused

Because the window is the only thing bounding key rotation. Re-keying exists so that a
compromised key stops receiving; the window is how long "stops" takes. Accept arbitrarily old
registry roots and a replaced key is payable forever, which removes the point of re-keying.

The window is now **1 hour, measured in seconds** rather than 7200 blocks — see F8 in the
audit for why the units mattered as much as the duration.

So widening the window trades a security property for a liveness one. That is the wrong
direction, and it is why F1 cannot be fixed by simply accepting older roots.

---

## Option A — contract-only: verify the derivation

The claimer's predicted root is not arbitrary. It is `insert(R, slot, leaf)` where `R` is a
root they read from chain. That derivation is checkable, so the domain can vouch for it:

```
claim(r, p, ..., bytes32 preRoot, uint32 slot, bytes32[32] siblings)
    require(registry.isKnownRegistryRoot(preRoot))                // R really existed
    require(insert(preRoot, slot, leafOf(r)) == p.registryRoot)    // derived, not invented
    registry.stampDerivedRoot(p.registryRoot, preRoot)             // acceptable to the pool
    _record(r)
    pool.transact(...)
```

`leafOf(r)` is recomputed from `r`, which `externalData` already binds — so a claimer cannot
vouch for a root containing keys they did not authorise. `preRoot` must be genuinely known,
so nothing invented is ever stamped.

**Why the slot mismatch is harmless.** If someone else registered meanwhile, the claimer's
real slot differs from the one they proved at. It does not matter: a registry proof
establishes *"these keys belong to a registered alias"*, and the slot appears nowhere in the
note commitment. The change note remains spendable later against the real tree at its real
position. Only the root value is load-bearing.

### The trap in this option

**The derived root must inherit `preRoot`'s expiry, not get a fresh one.** Stamping it with
`block.number` would let anyone extend a root's life indefinitely: derive from a root about
to expire, stamp the result for a fresh 7200 blocks, later derive from *that*, and repeat.
Every such root carries whatever pre-rotation keys `preRoot` held, so the chain would keep a
compromised key payable forever — reintroducing exactly the property the window exists to
guarantee, by a side door.

So `stampDerivedRoot` must copy the source's timestamp:

```solidity
registryRootBlock[derived] = registryRootBlock[preRoot];   // never block.number
```

With that, a derived root expires no later than the root it came from, and no chain of
derivations can outlive the original.

**Cost:** ~32 Poseidon hashes on the claim path only (~100–150k gas), one controller-only
function on the registry, three extra calldata parameters. **No circuit change, no
ceremony.**

---

## Option B — circuit: let the proof do the insertion

Pass the **pre**-registration root as the public input and have the circuit compute the
insertion itself:

- Private: the claimer's leaf, its slot, the siblings
- Circuit computes `postRoot = insert(preRoot, slot, leaf)` and proves the change output
  against that
- Public `registryRoot` is `preRoot`, which exists and is inside the window

Nothing is predicted, and nothing needs vouching — the proof is self-contained.

### The selector, and why it is not caller-controlled

An ordinary transfer performs no insertion, so the circuit must distinguish the two shapes.
A naive boolean is fatal: a prover setting it on an ordinary transaction could insert their
own unregistered keys into a fictitious tree and pay themselves, destroying "you can only
send to a registered alias" — the entire reason the registry proof exists.

The fix is to make the selector a **public signal the domain sets, not the prover**:

```
signal input pendingLeaf;    // public. 0 for every ordinary transaction.
signal input pendingSlot;    // private

isOrdinary <== IsZero(pendingLeaf)
effectiveRoot <== isOrdinary ? registryRoot : insert(registryRoot, pendingSlot, pendingLeaf)
// every non-zero output proves membership against effectiveRoot
```

Then:

- `HaliasPool.transact` requires `pendingLeaf == 0`. The ordinary path cannot insert
  anything, and its behaviour is bit-for-bit what it is today.
- `HaliasController.claim` supplies `pendingLeaf = leafOf(r)`, computed by the domain from `r` —
  which `externalData` already binds. The prover never chooses it; a prover who lies about it
  produces a proof whose public signal disagrees with what the domain passes, and the
  verifier rejects.

So the selector is not bound by trusting the caller — it is *derived* by the contract that
already validates the registration. Nothing new is trusted.

One structural question remains: the pool needs a second entry point accepting a non-zero
`pendingLeaf`, and only the domain may use it. Two ways:

1. **Give the pool the domain's address.** Straightforward, but adds a pool → domain
   reference that does not exist today. `HaliasDeployer` already resolves the circular
   prediction, so it is deployable — it just widens what the pool depends on.
2. **A transient flag on the registry** (EIP-1153). The domain sets it during `_record`; the
   pool asks `registry.pendingLeaf()` and requires the signal to match. Keeps the existing
   one-way pool → registry dependency and cannot persist across transactions.

(2) is preferable: it preserves the dependency direction, and transient storage cannot leave
residue for a later transaction to exploit.

**Cost:** roughly +2,500 constraints on 77,790 (one extra 32-level Merkle computation), a
recompile, a ceremony, a regenerated verifier, and possibly a tenth public signal — which
changes `HaliasPool._verifyTransact` and the verifier's `checkField` block.

---

## Comparison

|                          | A — contract | B — circuit |
| ------------------------ | ------------ | ----------- |
| Ceremony required        | no           | **yes**     |
| Circuit constraints      | unchanged    | +~2,500     |
| Public signals           | 9            | possibly 10 |
| Gas on the claim path    | +100–150k    | unchanged   |
| Gas on every other path  | unchanged    | unchanged   |
| Trust placed in contract | root vouching| none        |
| Main risk                | expiry inheritance | selector binding |

The honest difference is where the guarantee lives. **A** makes the contract assert that a
root is legitimate; the proof no longer stands alone, and an auditor has to accept the
vouching argument and the expiry-inheritance detail. **B** keeps everything inside the proof,
which is the stronger position — the pool would go on checking one thing, exactly as now.

## Decision: B

The proof should stand on its own. A works, but it moves part of the guarantee out of the
circuit and into a contract that vouches for its inputs — and it leaves the
expiry-inheritance trap as a documented hazard rather than removing it. Every future reader
then has to reconstruct why stamping a derived root is safe, and get the `block.number`
detail right.

B leaves the pool checking exactly one thing, as it does today, and deletes the entire class:
nothing is predicted, so nothing can be invalidated by another party's write.

### Order of work

1. Circuit: add `pendingLeaf` (public) and `pendingSlot` (private); compute `effectiveRoot`;
   prove every non-zero output against it. Verify the constraint delta is close to the
   expected ~2,500.
2. Confirm whether the public-signal count goes 9 → 10. If so, `HaliasPool._verifyTransact`
   and the regenerated verifier's `checkField` block both change — this is the step where a
   half-landed change is silently wrong, so re-verify the vkey `IC` points against the
   Solidity constants as was done for A1.
3. Registry: transient `pendingLeaf`, set by the controller during `_record`.
4. Pool: require `pendingLeaf == 0` on `transact`; read the registry's transient value on the
   claim path.
5. Domain: pass `leafOf(r)`; drop nothing else — `externalData` already binds `r`.
6. SDK: delete the `postSmt` prediction in `claimInvite`; prove against the current root.
7. Ceremony, verifier export, and the full suite. Re-run the concurrency assertions with a
   registration *and* an `updateAliasData` landing between prepare and submit — both must now
   be harmless.

### Regression to add

The e2e suite currently asserts that a concurrent registration *invalidates* a prepared
claim. That assertion encodes the bug and must be inverted: after B, a claim survives any
number of intervening registry writes. Keep a case for each surviving leaf-writing path.

## Not a fix

- **Widening `REGISTRY_ROOT_MAX_AGE`** — buys liveness with the key-rotation guarantee.
- **SDK retry** — self-healing against ordinary contention, useless against a griefer with a
  spare alias and `updateAliasData`. Worth having regardless; not a fix.
- **Routing change to the invite account** — tried and reverted. The change note becomes
  indistinguishable from the invite note, so the invite reads as unspent and is claimable
  again; and the *inviter* knows the secret, so it hands them the claimer's remainder. Turns
  a liveness bug into a custody bug. Recorded in `claimInvite` so it is not re-attempted.
