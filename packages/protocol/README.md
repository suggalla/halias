# halias-protocol

Contracts, circuits and ceremony tooling. What the protocol *is* and why is in the
[repository README](../../README.md); this covers building and testing it.

## Layout

```
contracts/     the three contracts, their deployer, and the generated verifiers
  base/        Constants, SMTRegistry, TreeZeros
  interfaces/  IHaliasPool, IHaliasRegistry, ITransactVerifier
  mocks/       test doubles — small trees, a full tree, a fee-on-transfer token
circuits/      transact.circom, transactClaim.circom, and lib/
  verify/      single-template wrappers, so Picus has declared outputs to check
src/           circuit-agnostic ceremony and verifier-export tooling
scripts/       deploy, preflight, gasbench, e2e-live, analyze.sh
test/          hardhat suites
testFuzz/      Foundry
docs/          design records
```

## Contracts

Three, deployed already wired together in one transaction by `HaliasDeployer`. The split
exists so the contract holding every user's funds has no admin key anywhere near it.

```
HaliasController ──writes──> HaliasRegistry <──reads── HaliasPool
   names, ERC-721,              aliasHash →              notes, nullifiers,
   fee, admin key               keys + dataHash          all custody
```

- **HaliasPool** — the shielded pool. Holds every deposit, verifies one Groth16 proof per
  transaction, and has no admin function of any kind. Nothing can reach the funds but a proof.
- **HaliasRegistry** — a sparse Merkle tree of alias → keys, with one writer and no admin.
  In-place updates, so an alias keeps its slot through a key rotation or a handover.
- **HaliasController** — names, ownership, the registration fee and the only admin key.
  Holds no user funds.

## Build

```bash
npm run compile          # contracts
npm run circuits:build   # both circuits: compile, ceremony, export verifier
```

`circuits:build` takes around ten minutes and does four things twice — `transact` and
`transactClaim` each get compiled, put through a dev ceremony, and exported as a Solidity
verifier. Both are needed: `Alignment.test.ts` proves a claim-path proof against the claim
verifier, and skipping the second circuit leaves that suite unable to run.

It needs [circom 2.2+](https://docs.circom.io/getting-started/installation/) on `PATH`. That
is the Rust binary — the `circom` package on npm is an abandoned 0.5.x and fails with parse
errors on these circuits.

The artifacts are gitignored: they are 40MB+ and the proving key is generated, not authored.
`npm run circuits:build` reproduces them, but note that a locally generated proving key will
not match a deployed verifier, because the verifier contract is exported *from* the key.

## Test

```bash
npm run test:hardhat     # 228 tests — contracts and circuits, in-process
npm run test:fuzz        # Foundry fuzzing
npm run test:all         # both
```

`test:hardhat` needs the circuit artifacts. The suites that make real Groth16 proofs are the
slow ones and also the ones worth having, so there is no fast path that skips them.

`scripts/e2e-live.ts` is the only suite that exercises the SDK against a real node over RPC —
chunked `eth_getLogs`, gas estimation, receipt polling. It is what catches the class of bug
the in-process suites cannot see, and it is 157 checks:

```bash
npx hardhat node                                          # terminal 1
npx hardhat run scripts/deploy.ts --network localhost
RPC_URL=http://127.0.0.1:8545 npx hardhat run scripts/e2e-live.ts --network localhost
```

## Before deploying

```bash
npx hardhat run scripts/preflight.ts --network <net>   # right chain, funded, nothing already live
npx hardhat run scripts/gasbench.ts --network localhost # gas for the two hot paths
```

## Static analysis

Slither, Aderyn, circomspect and Picus are wired up. Raw output is not committed — it pins
line numbers and goes stale on the next edit. Regenerate with `npm run analyze`; the triage
that is worth reading lives in [docs/static-analysis.md](docs/static-analysis.md).

## Documents

- [keys-and-authorization.md](docs/keys-and-authorization.md) — every key, what it
  authorises, how an action is authorised when the signer is not the payer, and the replay
  protection on each write path.
- [key-management.md](docs/key-management.md) — where the recovery phrase comes from, how it
  is stored, and what recovery means.
- [multi-tree-pool.md](docs/multi-tree-pool.md) — why the pool is a sequence of trees and how
  the global index works.
- [circuit-shape.md](docs/circuit-shape.md) — why the circuit takes four inputs, why the
  claim path is a second circuit, what wider shapes measured at, and why the decision expires
  at the mainnet ceremony.
- [test-plan.md](docs/test-plan.md) — coverage by layer and the conventions the suites follow.
- [rpc-surface.md](docs/rpc-surface.md) — what the client tells its RPC provider, and the one
  call that reveals who you are about to pay. No earlier audit covered the client.
- [static-analysis.md](docs/static-analysis.md) — what each tool found and which findings are
  real.
- [prior-art-review.md](docs/prior-art-review.md) — checked against Semaphore and World ID.
- [security-audit.md](docs/security-audit.md), [audit-2026-08.md](docs/audit-2026-08.md),
  [audit-2026-08-second-pass.md](docs/audit-2026-08-second-pass.md) — internal review passes.
  Point-in-time records; each states what it covered.
- [legal-considerations.md](docs/legal-considerations.md) — Tornado Cash and Railgun
  precedent, and where halias differs.

## Ceremony

See [src/README.md](src/README.md). The current proving key comes from a single-contributor
`--dev` ceremony, which is fine for a testnet and **not fine for real funds** — a multi-party
ceremony over a public Powers of Tau file is a prerequisite for mainnet.

It is also the deadline for the circuit. Every dependency in the stack is immutable and they
form a cycle, so a new circuit forces a new verifier, a new pool, a new controller and a new
registry — taking every registered alias with it. Before the ceremony a circuit change costs a
recompile; after it, there is no upgrade path. See
[circuit-shape.md](docs/circuit-shape.md).

## Licence

GPL-3.0-only, like the rest of the repository, and required for this package specifically:
`transact.circom` includes circomlib and is adapted from Tornado Cash Nova, and both verifier
contracts are generated by snarkjs — all GPL-3.0.
