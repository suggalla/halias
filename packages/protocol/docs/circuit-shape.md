# Circuit shape — 2 in, 2 out

`transact.circom` is instantiated as `Transact(16, 32, 2, 2)`: pool depth 16, registry SMT
depth 32, **two note inputs and two note outputs**. This records why, what the alternatives
measured at, and — the part that matters — when the decision stops being reversible.

Decided 2026-08-14. Frozen at the mainnet ceremony, not before.

---

## What the shape costs a user

Two inputs means **a balance spread across three or more notes cannot leave in one
transaction**, however it is selected. The money is present, the balance says so, and every
attempt to move all of it is refused. This is not a bug and no selection algorithm fixes it.

It is escapable in software, which is the whole reason 2-in/2-out survives. `consolidate()`
merges notes into one, and ordinary spending helps on its own: `selectEntries` always fills
both input slots when two notes exist, even when one would cover the amount, so every
transaction is a net **−1 note** for the sender. A wallet paid more often than it spends still
accumulates, and that is what `consolidate()` is for.

The invariant worth stating plainly: **at 2-in/2-out no note is ever stranded.** *n* notes
always collapse to one in *n*−1 transactions. The cost is throughput and gas, never funds.
That is why the irreversibility below does not bite the way it would on a shape that could
lock money up.

Client-side support:

- `balance().sendableNow` — the two largest notes, i.e. what can actually move at once. Below
  `total` exactly when consolidation is needed. A UI that shows `total` alone offers an amount
  the wallet will then refuse.
- `consolidate(token, { target, onProgress })` — with a target, merges the two *largest* until
  a pair covers it, the fewest transactions that unblock a specific payment. Without one,
  merges the two *smallest* all the way down, so an interrupted run has at least cleared the
  dust. Each merge is its own proof and its own transaction, and stands alone.
- The error when stuck names consolidation rather than blaming the balance. It used to say
  "insufficient balance", which was false and sent people looking for money already there.

On chain a merge is a transfer to yourself: `publicAmount = 0`, two nullifiers, two
commitments, one of them the zero-value filler an ordinary change-free transfer also produces.
The real output's slot is randomised as it is on a send, so merges are not a recognisable
class.

---

## Measured alternatives

All shapes compiled from the same `transact.circom` with only the `Transact(16, 32, n, m)`
instantiation changed.

| shape | non-linear | linear | total | ptau |
| --- | ---: | ---: | ---: | --- |
| **2-in/2-out** (current) | 45,210 | 49,302 | **94,512** | 2¹⁷ |
| 2-in/1-out | 36,200 | 39,337 | 75,537 | 2¹⁷ |
| 4-in/1-out | 47,201 | 51,168 | 98,369 | 2¹⁷ |
| 5-in/1-out | 52,703 | 57,085 | 109,788 | 2¹⁷ |
| 6-in/1-out | 58,206 | 63,003 | 121,209 | 2¹⁷ |
| 8-in/1-out | 69,215 | 74,842 | 144,057 | **2¹⁸** |
| 4-in/2-out | 56,211 | 61,133 | 117,344 | 2¹⁷ |

Marginal costs: **~11,400 per input, ~19,000 per output.** An output is worth about 1.7
inputs because it carries a depth-32 registry SMT proof while an input carries only a depth-16
pool proof. Constraints are static, so the zero-amount branch that skips the registry check at
proving time saves nothing here — the circuit pays for both branches.

Two consequences:

- Dropping to one output is worth more than adding two inputs. A sweep does not need a second
  output, so **N-in/1-out is the right shape for consolidation**, not N-in/2-out.
- **8-in breaks into 2¹⁸** — larger Powers of Tau, roughly double the ceremony compute and
  zkey size. Everything at 6 and below reuses the 2¹⁷ ceremony already planned. Note that
  6-in/1-out (121,209) costs about the same as 4-in/2-out (117,344) while removing five notes
  per transaction instead of three.

If a second shape is ever added, **5-in/1-out** is the pick: same ceremony as 4 and 6, one more
note per sweep than 4, and 16% headroom under 2¹⁷ against 6's 7.5% — headroom that any
pre-launch circuit change would otherwise consume, forcing 2¹⁸.

Measured on-chain cost of the current shape, for calibration
(`npx hardhat run scripts/gasbench.ts --network localhost`):

```
transact      : 511488
withdraw      : 522103
exit          : 107727  (79.4% cheaper)
```

A wider shape adds ~6,150 gas per extra public signal — the Groth16 verifier does one `ecMul`
(6,000) plus one `ecAdd` (150) each — so 4-in/2-out's six extra signals are ~37k, plus ~3k of
calldata: **+7.8% on every transaction**. Proving time at 94,512 constraints is 3–5 s on a fast
desktop. The wall-clock for larger shapes has **not** been measured; constraint count does not
map linearly to proving time, because witness generation and the FFTs scale differently.

---

## Two verifiers, if it ever comes to that

A second shape does **not** require an admin key. The pool already welds its dependencies at
construction (`HaliasPool.sol:67`), and a second verifier goes in the same way:

```solidity
ITransactVerifier  public immutable transactVerifier;   // 14 public signals
ITransactVerifier5 public immutable transactVerifier5;  // 20 public signals
```

Both immutable, both valid forever, nothing rotatable. A separate `transact5(...)` entrypoint
keeps calldata fixed-width and avoids dynamic dispatch. The shapes are structurally
non-confusable: a 5-in proof handed to `transact` is checked against the 2-in verifying key and
fails — the type system enforces it rather than a runtime check.

The blocker is not the verifier. **The pool's insertion is pairwise**
(`MerkleTreeWithHistory.sol:71`):

- `_insertPair` adds exactly two leaves and advances `leafIndex` by 2, so it is always even
- the LEVELS+1-hash walk depends on the aligned (even, odd) pair
- "a pair can never straddle a boundary" — the rollover guarantee — depends on that evenness
- `left == 0 || right == 0` reverts, so a zero second leaf is not available

So a 1-output circuit does not drop in. The workable fix is for `transact5` to insert the real
commitment plus a **pool-derived filler** — `Poseidon(nullifier0, SWEEP_FILLER_DOMAIN)` or
similar: non-zero, deterministic, with no preimage anyone can spend. Every invariant survives
and it burns one leaf slot per sweep, which is nothing against 2⁴⁸ capacity. Teaching the tree
to insert single leaves is the alternative and it breaks both the straddle guarantee and the
even-index optimisation, in the most safety-critical code in the repo. Don't.

Total cost of a second shape, then: a second circuit, a second ceremony run, a second
entrypoint, a filler derivation on the insert path, and a second immutable verifier. Plus a
second zkey (~53 MB on top of 42.7 MB) — lazy-loadable, so a client that never sweeps never
fetches it — and a split anonymity set, since the entrypoint reveals which shape was used and
sweep usage would cluster in one of them.

---

## When this stops being reversible

**At the mainnet ceremony.** Not at some later review.

Every dependency in the stack is immutable, and they form a cycle:

```
Pool → verifier (immutable)          HaliasPool.sol:67
Controller → pool (immutable)        HaliasController.sol:71
Registry → controller (immutable)    HaliasRegistry.sol:47
```

A new circuit means a new verifier, which forces a new pool, which forces a new controller,
which forces **a new registry**. Every alias, every ownership NFT, every registration goes with
it, and users re-register their names. That is the product, not just the shielded balances.
`HaliasController.sol:350` already says as much in another context.

Today the cost is a recompile and a `--dev` ceremony re-run — hours. The ceremony has to be
regenerated for mainnet regardless, so until that run happens the shape is free to change.
After it, there is no upgrade path short of redeploying the whole stack.

Revisit before running the multi-party ceremony. There is no revisiting after.
