# halias

Private payments to a name you can read. Register `alice.hls`, send and receive ETH or ERC-20,
and every transfer provably moves between registered identities without revealing which ones.

*halias = Hal (Finney) + alias*

**This is unaudited testnet software with a single-contributor trusted setup. Do not put real
money in it.** See [Status](#status).

## Why it exists

Privacy tools and naming services are separate systems today. Railgun, Tornado and Aztec hide
value behind keys; ENS and Fluidkey make addresses readable without hiding much. halias joins
them at the circuit level — the proof spans the identity registry and the payment pool at once.

The consequence that matters is not "names are nicer than hex". It is that **registry
membership is a spend condition**. Every non-zero output must prove membership in the registry
SMT, so the pool will only pay a registered `.hls` alias. Every other mixer is built so the
recipient is unknowable; here the recipient set is public, permanent and fee-gated, while which
member received what stays hidden.

The second thing that falls out of it: the system is legible. You pay a name rather than forty
hex characters you have to trust you copied correctly, one recovery phrase derives every alias
you hold, and a view key lets you show your whole history to an accountant without letting them
spend. That readability is downstream of the design rather than painted on afterwards —
Railgun cannot write this paragraph, because their recipient is a `0zk1…` string.

## Structure

npm workspaces. `app → sdk → protocol`.

- `packages/protocol` — contracts, the circom circuit, ceremony tooling, deploy scripts.
- `packages/sdk` — TypeScript client and the bundled CLI: proof generation, note scanning,
  key derivation.
- `packages/app` — SvelteKit frontend, static-built so it can be served from IPFS.
- `packages/deployments` — per-network addresses, written by the deploy script and read by
  the other three.

## Architecture

Three contracts, deployed already wired together in one transaction by `HaliasDeployer`. The
split exists so the contract holding every user's funds has no admin key anywhere near it.

```
HaliasController ──writes──> HaliasRegistry <──reads── HaliasPool
   names, ERC-721,             aliasHash →              notes, nullifiers,
   fee, the only admin key     keys + dataHash          all custody
```

Their dependencies form a cycle — the pool reads the registry, the controller writes to it, and
the registry must name its controller before that contract exists. CREATE2 cannot break it,
because a CREATE2 address depends on the constructor arguments. Plain CREATE does not, so the
deployer computes its own third address, closes the loop, and asserts it was right.

### HaliasPool

Job: hold every asset, and move it only against a valid proof.

One mutating function. No admin, no owner, no upgrade path, and no key that can pause, drain,
redirect or rescue — including for the deployer. Deposits, transfers and withdrawals are one
proof shape, distinguished by the sign of `publicAmount`.

### HaliasRegistry

Job: map an alias to its keys, and publish roots the circuit can prove against.

A sparse Merkle tree, depth 32, with one immutable writer and no admin. Updates happen in
place, so an alias keeps its slot through a key rotation or a handover.

### HaliasController

Job: names, ERC-721 ownership, the registration fee, and the only admin key in the system.

Holds no user funds. Every `onlyAdmin` function in the repo is on this contract, and nothing
reachable from that key can address a user's collateral.

### transact.circom

Job: prove a transaction is valid without revealing what it was.

2 inputs, 2 outputs, 94,512 constraints, 14 public signals. It proves you own the input
commitments, that each non-zero output's recipient is in the registry, that nullifiers are
correctly derived and unspent, and that inputs equal outputs.

Why two inputs and not more is recorded in
[circuit-shape.md](packages/protocol/docs/circuit-shape.md), along with what wider shapes
measured at and when that decision stops being reversible.

## Build and test

```bash
npm install
npm run build --workspaces

cd packages/protocol
npm run compile          # contracts
npm run circuits:build   # compile the circuit, run the ceremony, export the verifier
npm run test:hardhat     # 202 tests, including E2E with real Groth16 proofs
npm run test:fuzz        # Foundry
```

Circuit artifacts are gitignored — they are 40MB+, and the proving key is generated rather than
authored. A locally generated key will not match a deployed verifier, because the verifier
contract is exported *from* the key.

`scripts/e2e-live.ts` is the only suite that drives the SDK against a real node over RPC —
chunked `eth_getLogs`, gas estimation, receipt polling. It catches the class of bug the
in-process suites structurally cannot:

```bash
npx hardhat node                                          # terminal 1
npx hardhat run scripts/deploy.ts --network localhost
RPC_URL=http://127.0.0.1:8545 npx hardhat run scripts/e2e-live.ts --network localhost
```

146 checks. The local deploy also puts up a 6-decimal mock USDC, so the multi-asset paths are
exercisable rather than theoretical — 18 decimals is the case that agrees with a hardcoded
`parseEther` by accident, and hides the bug worth catching.

## Using it

```bash
npx halias register alice.hls
npx halias deposit 0.5
npx halias send bob.hls 0.5
npx halias withdraw 0xAddress 0.5
npx halias balance
npx halias consolidate
```

Every value command takes `--token <address>`. Decimals are read from the token contract rather
than assumed, so a 6-decimal stablecoin behaves the same as an 18-decimal one.

A user holds two things: **a recovery phrase, and a name.** The phrase carries the note keys and
never signs anything. A connected EVM wallet broadcasts and pays gas and never sees the phrase.
They are deliberately separate secrets and the onboarding refuses to merge them — deriving note
keys from a wallet signature was removed as phishable and must not come back.

## Status

| | |
|---|---|
| Contracts | Feature complete, internally reviewed, **not externally audited** |
| Circuit | Frozen at 2 in / 2 out |
| Trusted setup | **One contributor. Ours.** Not suitable for real funds |
| Networks | Local only — there is no live deployment |
| Tests | 202 hardhat, 86 SDK, 17 app, 146 e2e-live |

Two things gate mainnet and neither is negotiable: an external audit of the circuit and the
contracts, and a multi-party ceremony over a public Powers of Tau file. A privacy pool whose
setup one person could have subverted is a pool that one person can silently mint in — and
because transactions are opaque, nobody could tell afterwards whether they had.

## Roadmap

- **Proof of innocence** — a Railgun-style provenance proof, published by independent parties
  and honoured by relayers rather than enforced by the pool. Building enforcement into
  `transact` would hand the deployer a freeze key over user funds, which is precisely what the
  contract split exists to prevent.
- **Attestation circuits** — prove statements about an alias's `dataHash` ("registered more
  than six months", "over 18") without revealing the hash or the alias.
- **Privacy score** — warn about timing correlation and small anonymity sets before a
  withdrawal, rather than after.
- **Incremental scanning** — `refresh()` currently rescans from the start block on every call,
  and per-alias keys make trial decryption O(notes × aliases). All the fixes are client-side.

## Documents

Under `packages/protocol/docs/`:

- [keys-and-authorization.md](packages/protocol/docs/keys-and-authorization.md) — every key,
  what it authorises, and the replay protection on each signed write path.
- [key-management.md](packages/protocol/docs/key-management.md) — where the recovery phrase
  comes from, how it is stored, and what recovery means.
- [circuit-shape.md](packages/protocol/docs/circuit-shape.md) — why two inputs, what wider
  shapes cost, and the deadline on changing it.
- [multi-tree-pool.md](packages/protocol/docs/multi-tree-pool.md) — why the pool is a sequence
  of trees and how the global index works.
- [prior-art-review.md](packages/protocol/docs/prior-art-review.md) — checked against
  Semaphore, World ID and zk.money; two real bugs came out of it.
- [legal-considerations.md](packages/protocol/docs/legal-considerations.md) — the Tornado Cash
  and Railgun record, and where halias differs. Engineering analysis, not legal advice.
- [rpc-surface.md](packages/protocol/docs/rpc-surface.md) — what the client reveals to its
  RPC provider. The category no contract audit covers.
- [static-analysis.md](packages/protocol/docs/static-analysis.md) — Slither, Aderyn,
  circomspect and Picus output, triaged.
- [test-plan.md](packages/protocol/docs/test-plan.md) — coverage by layer.

## Built on

- Transact circuit adapted from [Tornado Cash Nova](https://github.com/tornadocash/tornado-nova) (GPL-3.0)
- Registry membership proof follows [Semaphore](https://github.com/semaphore-protocol/semaphore) (MIT, PSE-audited)
- Poseidon and comparators from [circomlib](https://github.com/iden3/circomlib) (GPL-3.0)
- Groth16 setup and verifier export via [snarkjs](https://github.com/iden3/snarkjs) (GPL-3.0)

Reviewed against those foundations rather than merely alongside them: published findings from
the Semaphore audit and World ID's root-history implementation were checked against this code,
and both real bugs found in the most recent review came from that comparison rather than from
re-reading our own contracts.

Keys here are Poseidon hashes, not curve points — there is no BabyJubJub anywhere in this repo.
`spendingCommitment = Poseidon(spendingPrivateKey)`. The only asymmetric cryptography is X25519
(tweetnacl `nacl.box`), used to encrypt a note to its recipient; the circuit never sees it, and
it is how a recipient *finds* a note rather than how one is spent.

## Contributing

Issues and pull requests welcome. Two things worth knowing first:

- Nothing has launched, so note formats and key derivation are still base changes. Edit them in
  place — no migrations, no compatibility shims, no version bumps. Local state is disposable.
- Security fixes here reliably create the next bug. Review a change as a chain, and ask what
  freedom each fix hands the prover.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).

Not entirely a choice: the circuit builds on circomlib and is adapted from Tornado Nova, and the
verifier is generated by snarkjs — all GPL-3.0. It is the right licence anyway. Nobody should
run a privacy tool they cannot read, and copyleft is what keeps a modified halias readable too.
