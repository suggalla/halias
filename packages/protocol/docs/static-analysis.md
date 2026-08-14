# Static analysis

Five tools run against this repo: three on the circuits, two on the contracts. This page says
what each one actually proves, how to run it, and how every finding it currently reports was
triaged.

Last full run: **2026-08-12**, at commit `2adeef7`.

| Tool | Version | Target | Result |
|---|---|---|---|
| [Picus](https://github.com/Veridise/Picus) | `d0e2f5c` + cvc5 1.3.4 | each template | all 4 properly constrained (strong mode) |
| [Ecne](https://github.com/0xPARC/Ecne) | `2593535` | `transact.r1cs` | 94,454 / 94,463 signals determined; 9 exceptions accounted for |
| [circomspect](https://github.com/trailofbits/circomspect) | 0.9.0 | `transact.circom` | 5 warnings, all triaged |
| [Slither](https://github.com/crytic/slither) | 0.11.6 | `contracts/` | 11 findings, all triaged |
| [Aderyn](https://github.com/Cyfrin/aderyn) | 0.6.8 | `contracts/` | 4 high, 11 low, all triaged |

Nothing exploitable was found. That is a weaker statement than it sounds — one of these tools
reports success on this circuit for a reason that has nothing to do with the circuit, and the
next section explains both that and what the tools structurally cannot see.

## What these tools do and do not prove

**Ecne** answers one question about the compiled R1CS: is every witness signal uniquely
determined by the public inputs? That is the under-constrainedness question — the bug class
where a malicious prover picks a second satisfying witness and mints value from nothing. It is
also the class no test can find, because a test only ever exercises the witness the honest
prover generates.

The asymmetry matters when reading its output:

- **Determined** is a genuine result: that signal is pinned by the constraints.
- **Not determined** is inconclusive. Ecne cannot distinguish "under-constrained" from "my
  propagation rules were not strong enough", and it hands you no counterexample to debug with.

### Do not trust Ecne's banner on this circuit

Ecne ends its run with `R1CS function transact has sound constraints (No trusted functions
needed!)`. **On this circuit that message is vacuous, and it should not be quoted as a result.**

Its criterion is `target_unique == length(target_variables)`
(`R1CSConstraintSolver.jl:1595`), where `target_variables` is the main component's *output*
signals (`readJSON`, line 465). `transact.circom` declares public inputs and no outputs —
`snarkjs r1cs info` reports `# of Outputs: 0` — so the test reduces to `0 == 0` and passes
without examining anything. The run confirms it in the line above the banner: `Solved for 0
target variables out of 0 total target variables`.

The substantive result is the other counter:

```
Solved for 94454 variables out of 94463 total variables
```

Nine signals were not determined, and Ecne prints the nine constraints containing them under
`------ Bad Constraints ------`. **All nine are accounted for**, and the accounting is what the
verdict actually rests on:

Every one has the shape `a * b = 1 - c` or `a * b = 1` — the circomlib `IsZero` inverse pattern.
`IsZero` computes `out <== -in*inv + 1` with `in*out === 0`. When `in ≠ 0` those force
`inv = 1/in` uniquely; when `in == 0`, `out` is pinned to 1 but **`inv` is genuinely free**, since
`0 * anything = 0` satisfies both. `inv` appears in no other constraint, so the freedom cannot
propagate. This is the textbook benign case and is present in every circomlib-based circuit.

The count matches exactly. `transact` instantiates nine components of the `IsZero` family, each
contributing exactly one free `inv`:

| Site | Component | Instances |
|---|---|---|
| `transact.circom:263` | `ForceEqualIfEnabled` (`inCheckRoot`) | 2 |
| `:276` | `IsEqual` (`sameNullifiers`) | 1 |
| `:318` | `IsZero` (`pendingIsZero`) | 1 |
| `:333` | `ForceEqualIfEnabled` (`pendingEmptyCheck`) | 1 |
| `:371` | `IsZero` (`outAmountNz`) | 2 |
| `:426` | `ForceEqualIfEnabled` (`outRegistryCheckRoot`) | 2 |
| | | **9** |

Nine components, nine free signals, nine bad constraints. Nothing is unexplained.

One trap when reading that section: the **signal names Ecne prints are misaligned with the
constraints**, an artefact of how it indexes the `.sym` file. Constraint #44767 prints as
`(main.pendingLeaf) * (main.pendingEmpty.hashers[3].pEx.sigmaP[42].in) = (1 - main.isOrdinary)`,
which pairs signals that share no constraint in the source. The constraint *shapes* are reliable;
the names attached to them are not. Do not chase a named signal from this output without
confirming it against `transact.circom`.

**circomspect** is a linter over circom source. Heuristics, not proof — it flags shapes that are
*often* bugs. Useful as a fast pre-commit check, never as evidence.

**Slither** and **Aderyn** are Solidity static analysers with overlapping detector sets (76 and
88 respectively, after exclusions). They cover reentrancy, access control, storage patterns, and
a long tail of style. Both are heuristic and both produce false positives freely; see the triage
below, where most findings are exactly that.

### The gap none of them cover

Ecne proves the circuit is *deterministic*. It does not check that the circuit constrains **the
right thing**, and a circuit can be perfectly determined and completely wrong. Every fund-affecting
bug found in the 2026-08 hardening pass was of that second kind:

- `treeNumber` was forgeable, because nothing tied it to the root the Merkle proof was checked
  against — one note re-spendable under a fresh nullifier every time.
- The circuit bounded trees to `2^16` while the contract allowed `2^32`, so notes past tree
  65,535 would be on chain and unprovable forever.
- Constraining `outputsEmpty` by equality would have made the cheap exit path *mandatory* on any
  full withdrawal, turning a gas optimisation into a privacy leak.

Ecne blesses all three. So would Picus. The property that catches them is **circuit ↔ contract
agreement** — public-signal ordering, range agreement, and the binding between what the proof
asserts and what the contract enforces — and no off-the-shelf tool checks it, because it is
specific to this protocol. That is what `test/` and `testFuzz/` are for, and it is where review
effort should go.

### Picus, and why it runs per template

[Picus](https://github.com/Veridise/Picus) targets **the same property as Ecne** by a different
route: an SMT solver rather than rule propagation, producing a concrete counterexample — two
witnesses satisfying the same public inputs — where Ecne produces only silence.

**It inherits the same vacuity, for the same reason.** Its target set is the main component's
output list unless `--strong` is passed (`picus.rkt:162`), and `transact` declares no outputs,
so the default run reports "properly constrained" without examining anything. `--strong` targets
every wire instead, which is the honest question — and at 94,480 constraints it is undecidable:
**"Cannot determine whether the circuit is properly constrained"**, with both z3 and cvc5.

So Picus is not a drop-in upgrade over Ecne on the whole circuit. It is *less* informative there,
because Ecne at least returns a signal-by-signal count. What Picus can do that nothing else here
can is decide a **template**, completely, including every internal wire.

That is what `circuits/verify/` exists for. `transact.circom`'s templates were moved into
`circuits/lib/notes.circom` so each can be given its own `main` — the compiled `transact.r1cs` is
byte-identical after the move, so it cost no ceremony — and each wrapper is small enough for
`--strong` to terminate:

| Template | Constraints | `--strong` verdict |
|---|---|---|
| `NoteCommitment` | 324 | properly constrained |
| `NoteNullifier(16)` | 296 | properly constrained |
| `RegistryLeaf` | 264 | properly constrained |
| `MerkleProof(16)` | 3,936 | properly constrained |

These are genuine results: every wire, not just outputs, uniquely determined given the inputs.

**Neither tool subsumes the other, so both are kept.** Picus decides the components. Ecne is the
only evidence that covers the assembled 94k-constraint circuit at all. Read together they say:
the pieces are individually sound under a complete check, and the whole determines 94,454 of
94,463 signals with the nine exceptions accounted for.

## Running them

### Circuits

Requires the circuit to have been compiled — `npm run circuits:compile` writes the `.r1cs` and
`.sym` that Ecne reads.

```bash
# From packages/protocol/
npm run analyze:circuit       # circomspect + Picus per template
npm run analyze:picus         # Picus alone — minutes
npm run analyze:ecne          # Ecne on the whole circuit — a few minutes
```

`analyze:picus` expects Picus at `$PICUS_HOME` (default `~/tools/Picus`) and honours
`$PICUS_SOLVER` (default `cvc5`). `analyze:ecne` expects `$ECNE_HOME`, default
`~/tools/EcneProject`. Picus recompiles anything in `circuits/verify/` that has no `.r1cs` yet,
so adding a template to check is a three-line wrapper and nothing else.

### Contracts

```bash
# From packages/protocol/
npm run analyze:slither       # writes docs/reports/slither.md
npm run analyze:aderyn        # writes docs/reports/aderyn.md
npm run analyze               # both
```

Both run from the **repo root**, not `packages/protocol/` — the root holds `foundry.toml`, and
both tools compile through Foundry. Slither reports "Multiple frameworks detected: Foundry,
Hardhat. Using Foundry" and that is the intended path; `--hardhat-ignore-compile` has no effect
here.

Slither exits non-zero whenever it has findings, so a non-zero exit is not a failure signal.

### Installing from scratch

```bash
# Slither. This box has no python3-venv and no pip, so uv is the path of least resistance.
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install slither-analyzer

# Aderyn — prebuilt binary, no Rust toolchain needed
curl -sL -o aderyn.tar.xz \
  https://github.com/Cyfrin/aderyn/releases/download/aderyn-v0.6.8/aderyn-x86_64-unknown-linux-gnu.tar.xz
tar xf aderyn.tar.xz && install aderyn-*/aderyn ~/.local/bin/

# circomspect
cargo install circomspect

# Picus. Racket installs to $HOME with no root; the distro package needs sudo.
sh <(curl -sL https://download.racket-lang.org/releases/8.12/installers/racket-8.12-x86_64-linux-cs.sh) \
  --in-place --dest ~/racket
git clone https://github.com/Veridise/Picus ~/tools/Picus
cd ~/tools/Picus && PATH=~/racket/bin:$PATH raco pkg install --auto --batch

# cvc5 WITH finite-field support, which Picus wants and which the plain build lacks.
# The GPL static release has it already — no CoCoA build, no sudo. Verify with a QF_FF query.
curl -sL -o cvc5.zip https://github.com/cvc5/cvc5/releases/download/cvc5-1.3.4/cvc5-Linux-x86_64-static-gpl.zip
unzip -q cvc5.zip && install cvc5-Linux-x86_64-static-gpl/bin/cvc5 ~/.local/bin/

# Ecne — needs Julia 1.8 EXACTLY. Its pinned dependencies use `@_pure_meta`, which was
# removed from Base, so any current Julia fails to instantiate.
juliaup add 1.8
git clone https://github.com/0xPARC/Ecne ~/tools/EcneProject
cd ~/tools/EcneProject && julia +1.8 --project=. -e 'using Pkg; Pkg.instantiate()'
```

## Findings

Raw tool output is not committed — it is pinned to line numbers and goes stale on the next
edit, which is worse than absent because it reads as current. Regenerate it with the commands
above. The triage below is the part worth keeping;
re-running the tools reproduces the raw reports but not the reasoning.

### Circuits — circomspect (5 warnings)

**`paramsHashSquare` occurs in only one constraint** (`transact.circom:531`). Deliberate, and the
warning is inverted here. `paramsHashSquare <== paramsHash * paramsHash` exists precisely to
anchor `paramsHash` into the constraint system so a prover cannot present a proof against a
different one. A signal appearing once is the mechanism, not a defect.

**Four `Num2Bits` / `Bits2Num` aliasing warnings** (lines 322, 411, and two in `NoteNullifier`).
The concern is real in general: `Num2Bits(n)` does not prove the input is under `2^n`, so a value
above the prime can alias to a smaller bit pattern. It does not apply at these widths. Every one
of these converts at most 32 bits, against a 254-bit prime — there is no second field element
sharing a 32-bit representation. `Num2Bits_strict` would add constraints to rule out a case that
cannot arise.

### Contracts — the high-severity findings are all false positives

**Caret read as exponentiation** (Slither ID-0/ID-1, Aderyn H-2) — `SMTRegistry.sol:112` and
`:151`. `nodePath ^ 1` is genuine XOR: flipping the low bit of a node index is how you address its
sibling in a binary tree. Exponentiation would be meaningless here. This detector fires on every
Merkle implementation ever written.

**Locked ether in `Create2Factory`** (Slither ID-3, Aderyn H-1) — `deploy` is `payable` with no
withdraw function, but the assembly reads `create2(callvalue(), ...)`, forwarding the entire
`msg.value` to the contract being deployed. Nothing is retained, so there is nothing to strand.
Both tools miss this because neither models `callvalue()` inside inline assembly.

**Unsafe downcast** (Aderyn H-4) — `address(uint160(tokenAddress))`, when `TransactParams.tokenAddress`
was a `uint256`. **This one was right, and the code changed rather than the finding being waved
off.**

The cast itself was lossless — the circuit range-checks that public signal with
`Num2Bits(160)` at `transact.circom:489`. But chasing *why* the bound mattered turned up
something sharper than a truncation concern. ETH is the sentinel `tokenAddress == 0`, and that
test ran on the full `uint256` in `_checkPayment` while settlement branched on the *truncated*
address. Those disagree exactly when the high bits are set: `tokenAddress = 2**160` reads as
"not ETH", so the caller owes no `msg.value`, then truncates to `address(0)`, which
`_creditPool` treats as ETH. A free ETH note — minting, not aliasing. (Aliasing two field
values onto one *real* ERC-20 is harmless by comparison: the depositor pays that token in and
takes it out again.)

Two things already blocked it — the circuit bound, and `_checkPayment`'s rejection of a
non-zero `tokenAddress` whose address has no code, which `address(0)` never has. It is now
unrepresentable instead: `tokenAddress` is declared `address`, so Solidity's ABI decoder
rejects any value with the top 96 bits set before a line of the pool runs (verified — a
calldata `address` with dirty high bits reverts at decode, both bare and inside a struct). The
`_token()` helper is deleted; the single remaining conversion is the *widening* back to a field
element for the verifier's public-signal array, which is total.

The general lesson, since it recurred: a type wider than its domain forces an unchecked
narrowing at every read. `knownPoolRootTree` was the same shape — a `uint256` mapping holding
only a `uint32 + 1`, narrowed by two readers — and is now `uint32`. The casts that survive are
the ones where truncation *is* the definition (CREATE2 taking the low 20 bytes of a keccak) or
where the narrowing is deliberate packing (`uint64(block.timestamp)`).

**Reentrancy: state change after external call** (Slither ID-5, Aderyn H-3, 5 instances) — three
in `HaliasController.claim`, two in `HaliasPool.transact`. Both functions are `nonReentrant`, both
call only `pool` and `registry`, and both of those are immutable and set at construction, so
there is no attacker-controlled callee. In `claim` the flagged write is `accumulatedFees +=
received`, where `received` is *measured* as a balance delta and then checked against
`registrationFee` before being accumulated — a reentrant path cannot inflate it without failing
that equality. In `transact` the flagged reads are `isKnownRegistryRoot` and `pendingLeaf`, both
`view`.

### Contracts — low severity

| Finding | Status |
|---|---|
| `block.timestamp` comparisons, 5 sites (Slither ID-6–10) | **Accepted.** Every window here is an hour or more (`REGISTRY_ROOT_MAX_AGE` 1h, `MAX_COMMIT_AGE` 1 day, EIP-712 deadlines). Validator timestamp drift is on the order of seconds and cannot move any of these decisions. |
| `seen == 0` strict equality (Slither ID-2) | **False positive.** `registryRootSeenAt` maps root → timestamp; zero is the absence sentinel, and an exact comparison is the correct test for absence. |
| `_mint` rather than `_safeMint` (Aderyn L-8) | **Deliberate — see the comment at the call site.** `_safeMint` invokes `onERC721Received` on the recipient, and the recipient is `r.owner`, chosen by the prover. That would hand an attacker-controlled callback a re-entry point inside `claim`, in the window where the registry has an armed pending leaf. `nonReentrant` blocks re-entry into `claim` itself but not calls into everything else. `_mint` removes the question entirely. |
| Unchecked return of `_authorizeOwner` (Aderyn L-7) | **False positive.** It reverts on every failure path; the returned owner is a convenience for callers that need it. Ignoring it discards information, not a failure. |
| No event on `accumulatedFees` (Slither ID-4, Aderyn L-6) | **Accepted, minor.** Fee accrual is derivable from `AliasRegistered` / `AliasClaimed`. `updateAliasData` is a second instance where the event is emitted one layer down, by `HaliasRegistry.setDataHash`. |
| SSTORE inside a loop (Aderyn L-1) | **Inherent.** Both sites are Merkle path updates; writing each level *is* the algorithm. |
| Unspecific pragma `^0.8.20` (Aderyn L-9, 10 files) | **Open, worth doing.** Everything is built and tested under 0.8.28 with `viaIR`; a floating pragma permits a reviewer or a downstream integrator to compile the same source under a compiler this project never tested. |

## What is still not covered

- **Trusted setup.** Still a single self-generated `--dev` ceremony. Blocking for real funds,
  and untouched by anything on this page.
- **Circuit ↔ contract agreement**, as described above. The highest-value work remaining is a
  differential test asserting the SDK's public-signal encoding matches the contract's
  `pubSignals` layout element by element — the seam that produced the real bugs.
- **Formal verification of contract invariants.** No Certora/Halmos-style proofs; the invariant
  testing in `testFuzz/PoolTree.t.sol` is the closest thing and covers only the pool tree.
