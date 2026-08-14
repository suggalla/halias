# Test plan

What is covered, what is not, and the gap that matters before anyone else runs this.

All four boundaries are covered — **376 checks**: 179 hardhat, 86 SDK, 111 e2e-live. `scripts/e2e-live.ts` closed the last gap
and found eight real SDK bugs doing it, one of them permanent fund loss.

## Coverage by layer

The system has four boundaries, and a bug at each one fails differently.

| Boundary | Covered by | Tests |
|---|---|---|
| Contracts alone | `Pool`, `HaliasRegistry`, `HaliasController`, `Deployer`, `RootHistory` | 104 |
| Circuit ↔ contracts | `E2E` (real verifier), `Alignment` | 18 |
| SDK internals | `packages/sdk/test/sdk.test.ts` | 44 |
| SDK ↔ contracts | `scripts/e2e-live.ts` | 46 |

179 protocol tests and 86 SDK tests pass. `e2e-live.ts` is not part of either suite — it
needs a running node and real proving artifacts — and passes against a local node in ~25s.

### Contracts alone

`MockTransactVerifier` accepts any proof, so these test where value goes rather than whether
a proof is valid. That is the right trade — it makes it cheap to exercise every rejection
path — but it means a green suite here says nothing about the circuit.

No mocks beyond the verifier. `Pool.test.ts` runs against a real `HaliasRegistry` with a
signer standing in as controller; `HaliasController.test.ts` and `Deployer.test.ts` run against
the real pool and registry. Nothing stubs a dependency the split created.

### Circuit ↔ contracts

`E2E.test.ts` deploys through `HaliasDeployer` against the **real** `TransactVerifier` and
runs a deposit, a private transfer, and a relayer-fee withdrawal with genuine Groth16
proofs. The load-bearing case is the last one: a proof built for one `recipient`, submitted
with another, must be rejected — *and* the untampered proof must still work, so the
rejection is the tampering rather than something incidental.

That case exists because a wrong `paramsHash` preimage is not a named revert. It is a proof
that verifies against nothing, on a transaction that looks well formed. There is no other
signal.

`Alignment.test.ts` pins the boundary itself rather than a flow: publicSignals **order**,
the circuit's range checks at 2^248 and 2^160, zero-amount skip semantics, Poseidon layout
agreement, and tree depths. None of it is reachable from a flow test.

### SDK ↔ contracts

`scripts/e2e-live.ts` drives the SDK over HTTP against a live node — two clients on separate
wallets, real artifacts, real proofs. **46 assertions, all passing, ~50s.**

Every method on `Halias` is called, and where it matters the *property* is asserted rather
than the call: rotation keeps the alias in its slot, transfer moves the keys with the name
and clears reputation data, the previous owner loses access, an invite cannot be replayed,
an out-of-field `dataHash` is refused, spent funds cannot be respent. Both branches of every
value path are covered — change and no-change, ETH and ERC-20, relayed and self-submitted.

#### It found eight bugs

Every one reachable through the public API, and every one invisible to the 44 unit tests,
which passed throughout.

| | |
|---|---|
| `scanEvents` used a cached `getBlockNumber()` as its upper bound | just-mined logs dropped — one cause behind three symptoms that looked independent |
| `claimInvite` passed empty ciphertexts | **permanent fund loss**: the change commitment landed with no blob to decrypt, and the blinding was never persisted |
| `refresh()` discarded every token note | `findMyOutputs` defaulted to ETH, so a token deposit landed on chain and the client reported zero |
| `findMyOutputs` rebuilt entries with the *requested* asset | a note could be reconstructed under the wrong token |
| `deposit` attached `msg.value` unconditionally | ERC-20 deposits reverted `WrongMsgValue(0, amount)` after the proof was generated |
| `deposit` never approved the pool | ERC-20 deposits reverted on `safeTransferFrom` |
| `withdraw` had no relayer-fee parameter | the "pay for inclusion out of shielded funds" flow was unreachable |
| `transferAlias` imported but never wired to a method | the SDK could not transfer an alias at all |

**Four of the eight were code that had never executed** — not logic errors. Writing a test
that calls every method found them immediately, which is the argument for coverage by
enumeration rather than by scenario.

Worth recording what the bugs were *not*: `paramsHash` was the standing suspicion and it was
correct throughout. The deposit proof verified on the first run, which exercises the entire
preimage.

#### Still uncovered

Nothing on the `Halias` surface. What remains is depth rather than breadth: multi-note
selection when no single UTXO covers an amount, and behaviour against a reorg.

## Running it

```bash
# once, and leave the node running
npx hardhat node
npx hardhat run scripts/deploy.ts --network localhost

# per iteration — ~1s to build, ~25s to run
npx esbuild scripts/e2e-live.ts --bundle --platform=node --format=cjs \
  --outfile=scripts/.e2e.cjs --external:ethers --external:halias-sdk
node scripts/.e2e.cjs
```

**Do not run it through `npx hardhat run`.** The script needs ethers and the SDK, not
hardhat, and hardhat boots its whole toolchain — compile check, TS transpile, artifact load —
before the first line executes. esbuild bundles it in under a second and it exits cleanly.

Do not pipe it through `tail` or `grep` either. `tail` buffers, so nothing appears until the
end and a failure looks like a hang; `grep` replaces the exit code with its own, which is how
two runs were once launched concurrently against the same account and destroyed each other's
nonces.

Both the success and failure paths call `provider.destroy()` and `process.exit()`. Without
them node stays alive after every assertion has printed — ethers keeps a poller and snarkjs
leaves worker threads — and a finished script is indistinguishable from a stuck one. That
cost several rounds of misdiagnosis.

Two environment notes. The Hardhat node holds ~2 GB (full in-memory state, unlimited
contract size, both Poseidon libraries at ~33 KB each), and proving needs the zkey on top —
on a 6 GB box that is tight, and a stall at 0.3% CPU is memory, not computation. Anvil is
the lighter option. And both clients use freshly funded wallets so counts are deterministic
across repeated runs against the same node; reusing the funded account makes "owns exactly
one alias" fail on the second run for reasons unrelated to the code.

The path it covers:

```
register("alice.hls")      -> domain.register, alias minted, registry root advances
deposit(1 ETH)             -> real proof, pool balance, note found by scan
send("bob.hls", 0.4)       -> real proof, publicAmount == 0, bob's note decryptable
withdraw(addr, 0.5)        -> real proof, recipient paid
balance()                  -> reflects every step
```

Requirements that make it worth having rather than ceremonial:

- **Real artifacts.** `transact.wasm` and `transact_final.zkey`, not stubs. Each leg is a
  real proof, roughly 3s. The suite will be slow; run it separately from the fast ones.
- **Through `halias.ts`, not the contract helpers.** The point is to exercise scanning, note
  selection, SMT mirroring, and proof assembly — the parts with no coverage. Calling
  `contract.ts` directly would test the layer that already works.
- **Assert the scan, not just the transaction.** A send that lands on-chain but produces a
  note the recipient cannot find is a failure, and it is the failure mode most likely to
  survive every existing test.
- **Cover `claim`.** It is the only flow touching all three contracts, and its authorisation
  binding is what stops a relayer taking the alias.

This replaces the deleted `e2e-sepolia.ts`. It is not in CI yet — it needs a node and a
~100 MB zkey — but unlike its predecessor it can be, once the failures above are fixed and
the artifacts are available to a runner.

## Conventions

**Mutation verification.** A green test proves nothing until it has been shown to fail. Every
security-relevant guard added during the split was verified by deleting it and confirming a
specific test breaks — 18 mutations, 18 caught. New guards should follow: apply the
mutation, name the test that dies, restore, confirm byte-identical.

**Prefer a real dependency to a mock.** The only mocks are `MockTransactVerifier` (so
rejection paths are cheap), `MockERC20` / `MockFeeToken`, and `MockTreeSequential` (a
preserved copy of the pre-pairwise insertion, used as a differential oracle). A mock registry
was proposed and rejected: the real one needs only an immutable address for its controller,
so a signer can hold that role.

**Test the property, not the implementation.** `HaliasRegistry.test.ts` rebuilds the root
against an independently constructed off-chain SMT through registration, rotation and a data
write. That agreement is what every proof depends on, and it catches divergence that reading
either implementation alone would not.

**Findings get pinned, not just fixed.** Each of the four security findings has a regression
test named for what it prevents, including one that reverts `_mint` to `msg.sender` — the
original relayer-ownership bug — and fails.

## Deliberately not covered

**Gas.** No assertions on gas usage. Numbers in the docs came from measurement, and a
regression would show up as a failing deployment long before a failing test.

**Sepolia.** There is no live-network suite. `E2E.test.ts` covers what the deleted
`e2e-sepolia.ts` did, locally and repeatably. A live deployment is still worth exercising by
hand once, since RPC behaviour, gas estimation, and artifact fetching over the network are
all real and none of them appear in-process.

**The frontend.** `svelte-check` passes with no errors, and that is all. No component or
integration tests. Acceptable while the UI is a thin client over the SDK; not acceptable once
it holds logic of its own.

**Fuzz and invariants.** `testFuzz/PoolTree.t.sol` predates the split and targets the pool
tree. Porting it onto `HaliasPool` is worthwhile and not urgent — the tree it exercises is
unchanged.

## Order

1. **Sepolia deploy, then the CLI against it by hand.** Covers what in-process testing
   cannot: RPC, gas estimation, artifact fetching.
2. **Port the fuzz suite.**
3. **Frontend tests**, once the UI does more than call the SDK.
