# Circuit shape — 4 in, 2 out, across two circuits

Two circuits are compiled from one `lib/transactCore.circom` template:

| circuit | instantiation | constraints | public signals | zkey |
| --- | --- | ---: | ---: | ---: |
| `transact.circom` | `Transact(16, 32, 4, 2, 0)` | 84,023 | 20 | 37.1 MB |
| `transactClaim.circom` | `Transact(16, 32, 4, 2, 1)` | 117,344 | 20 | 48.6 MB |

Pool depth 16, registry SMT depth 32, **four note inputs and two note outputs**. The fifth
parameter is `withClaim`, and it is what separates the two. This records why, what the
alternatives measured at, and — the part that matters — when the decision stops being
reversible.

Decided 2026-08-14 at 2-in/2-out; widened to 4-in and split 2026-08-15. Frozen at the mainnet
ceremony, not before.

---

## What the shape costs a user

Four inputs means **a balance spread across five or more notes cannot leave in one
transaction**, however it is selected. The money is present, the balance says so, and every
attempt to move all of it is refused. This is not a bug and no selection algorithm fixes it —
it is inherent to a fixed-width circuit, and only the threshold moves.

It is escapable in software. `consolidate()` merges notes, and ordinary spending helps on its
own: `selectEntries` fills all four input slots when four notes exist, even when one would
cover the amount, so every transaction is a net **−3 notes** for the sender.

The invariant worth stating plainly: **no note is ever stranded.** *n* notes always collapse to
one, in ⌈(*n*−1)/3⌉ transactions. The cost is throughput and gas, never funds. That is why the
irreversibility below does not bite the way it would on a shape that could lock money up.

Widening from two inputs to four cut that from *n*−1 transactions to ⌈(*n*−1)/3⌉ — six notes
went from five merges to one. Measured end to end, consolidation got 65–78% cheaper in total
gas despite each individual transaction costing more.

Client-side support:

- `balance().sendableNow` — the four largest notes, i.e. what can actually move at once. Below
  `total` exactly when consolidation is needed. A UI that shows `total` alone offers an amount
  the wallet will then refuse.
- `consolidate(token, { target, onProgress })` — with a target, merges the largest until a
  spendable set covers it, the fewest transactions that unblock a specific payment. Without
  one, merges the smallest all the way down, so an interrupted run has at least cleared the
  dust. Each merge is its own proof and its own transaction, and stands alone.
- The error when stuck names consolidation rather than blaming the balance. It used to say
  "insufficient balance", which was false and sent people looking for money already there.

On chain a merge is a transfer to yourself: `publicAmount = 0`, four nullifiers, two
commitments, one of them the zero-value filler an ordinary change-free transfer also produces.
The real output's slot is randomised as it is on a send, so merges are not a recognisable
class.

## Unused input slots are not visible

A transaction that spends one real note still publishes four nullifiers and still writes all
four to storage. Dummy inputs are generated with random blinding, and their nullifiers are
indistinguishable from real ones — same derivation, same 20,000-gas `SSTORE`, same event field.

This is deliberate and it is most of what the extra gas buys. A one-note spend and a four-note
spend are the same transaction from the outside. Padding that skipped the write, or that
reused a constant dummy, would leak the real input count on every transaction and partition the
anonymity set by spend width.

The one thing it does cost: the padding must produce four *distinct* nullifiers, or the pool's
duplicate check rejects the transaction. `padInputs` handles this; it is the kind of thing that
looks like a test bug when it fires.

## Why the claim path is a separate circuit

Claiming — registering an alias and spending in the same proof — needs a pending-leaf witness
and a second effective-root computation. That machinery is **33,321 constraints**, and an
ordinary transaction never uses any of it.

R1CS has no runtime branching. Every constraint in the circuit is enforced on every proof, so a
disabled feature is not free; a single circuit carrying both paths makes every ordinary send
pay for claim machinery it does not touch. A compile-time template parameter is the only way to
omit constraints, which is what `withClaim` is: the pending logic sits behind `if (withClaim ==
1)`, and the else branch pins `pendingLeaf === 0` and passes the registry root through
unchanged.

Splitting cut the ordinary circuit from 117,344 to 84,023 constraints — **−28%** — and the zkey
from 48.6 MB to 37.1 MB. Since claims are rare and sends are not, that discount applies to
almost every proof anyone generates.

Both circuits expose the identical 20-signal public list, so the pool routes on
`pendingLeaf == 0` and hands the proof to the matching verifier. Both verifiers are immutable
and neither can accept the other's proof: the verifying keys differ, so a mis-routed proof
fails rather than being checked against the wrong constraints.

The r1cs files are **not** byte-identical between the two, and the shared constraints are not
in the same wire order — three signals moved index. Semantic equivalence was verified instead,
by decoding each r1cs against its own `.sym` file: the 84,023 constraints of `transact` appear
identically as a subset of `transactClaim`. Both circuits needed their own ceremony run.

---

## Measured alternatives

All shapes below were compiled from the pre-split `transact.circom` — that is, with the claim
machinery always present. They are comparable to each other and to the 117,344 figure, not to
the post-split 84,023.

| shape | non-linear | linear | total | ptau |
| --- | ---: | ---: | ---: | --- |
| 2-in/2-out | 45,210 | 49,302 | 94,512 | 2¹⁷ |
| 2-in/1-out | 36,200 | 39,337 | 75,537 | 2¹⁷ |
| **4-in/2-out** (chosen) | 56,211 | 61,133 | **117,344** | 2¹⁷ |
| 4-in/1-out | 47,201 | 51,168 | 98,369 | 2¹⁷ |
| 5-in/1-out | 52,703 | 57,085 | 109,788 | 2¹⁷ |
| 6-in/1-out | 58,206 | 63,003 | 121,209 | 2¹⁷ |
| 8-in/1-out | 69,215 | 74,842 | 144,057 | **2¹⁸** |

Marginal costs: **~11,400 per input, ~19,000 per output.** An output is worth about 1.7 inputs
because it carries a depth-32 registry SMT proof while an input carries only a depth-16 pool
proof. Constraints are static, so the zero-amount branch that skips the registry check at
proving time saves nothing here — the circuit pays for both branches.

Two consequences:

- Dropping to one output is worth more than adding two inputs. A sweep does not need a second
  output, so **N-in/1-out is the right shape for consolidation**, if a third circuit is ever
  added.
- **8-in breaks into 2¹⁸** — larger Powers of Tau, roughly double the ceremony compute and zkey
  size. Everything at 6 and below reuses the 2¹⁷ ceremony already planned.

If a third shape is ever added, **5-in/1-out** is the pick: same ceremony as 4 and 6, and 16%
headroom under 2¹⁷ against 6's 7.5% — headroom that any pre-launch circuit change would
otherwise consume, forcing 2¹⁸.

## Gas moves the opposite way to constraints

Widening to four inputs made the circuit smaller and the transaction more expensive. Two extra
nullifier writes put **~53,000 gas** on every transaction — **+10%** on both `transact` and
`withdraw` — and, as above, a dummy's nullifier costs the same 20,000 as a real one. That is
precisely what buys the indistinguishability, so it is the intended trade rather than an
overhead to optimise away.

Against it: consolidation is 65–78% cheaper in total, because it takes a third as many
transactions. A wallet that receives more often than it spends comes out well ahead; a wallet
that spends single notes pays the 10%.

Verifier cost scales with public signals — the Groth16 verifier does one `ecMul` (6,000) plus
one `ecAdd` (150) each — so the move from 14 to 20 signals is ~37k of the total, plus ~3k of
calldata.

Re-measure with `npx hardhat run scripts/gasbench.ts --network localhost` against a local
deploy. Proving time has **not** been measured for the current shape; constraint count does not
map linearly to it, because witness generation and the FFTs scale differently.

---

## When this stops being reversible

**At the mainnet ceremony.** Not at some later review.

Every dependency in the stack is immutable, and they form a cycle:

```
Pool → verifiers (immutable)         HaliasPool.sol:67
Controller → pool (immutable)        HaliasController.sol:71
Registry → controller (immutable)    HaliasRegistry.sol:47
```

A new circuit means a new verifier, which forces a new pool, which forces a new controller,
which forces **a new registry**. Every alias, every ownership NFT, every registration goes with
it, and users re-register their names. That is the product, not just the shielded balances.
`HaliasController.sol:350` already says as much in another context.

Today the cost is a recompile and a `--dev` ceremony re-run — hours, now doubled because there
are two circuits. The ceremony has to be regenerated for mainnet regardless, so until that run
happens the shape is free to change. After it, there is no upgrade path short of redeploying
the whole stack.

Revisit before running the multi-party ceremony. There is no revisiting after.
