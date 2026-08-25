# Halias

**Private payments made simple. No admin keys, no clunky addresses.**

Send ETH and ERC-20s privately, to a recipient you can actually name — both guaranteed by
zero-knowledge proofs rather than by trusting an operator.

**[Try it → suggalla.github.io/halias](https://suggalla.github.io/halias/)** — running against
Sepolia. Bring a wallet with some Sepolia ETH; everything else the app derives for you.

*Halias = Hal (Finney) + alias*

**This is unaudited testnet software with a single-contributor trusted setup. Do not put real
money in it.** See [Status](#status).

## What you get

- **No servers.** Purely contracts and proofs. The client is a static site you can run from
  IPFS, a web host or your own laptop; there is no backend holding keys, no API between you
  and the chain, and no operator whose honesty you are relying on.
- **No admin keys.** Your shielded funds and registered aliases are 100% owned by your keys.
  The contract holding every deposit has one mutating function, no owner and no upgrade path —
  nothing that can pause, freeze, drain or rescue it, for us or anyone else.
- **One-time name registration fee. That's it.** No transaction fees, no renewals, no expiry,
  no scam-coins — there is no protocol token at all. The fee is paid to the name contract,
  which holds no user funds; the pool your money sits in has no fee mechanism and never takes
  a cut of a transfer.
- **No clunky addresses.** Pay `alice.hls`. Address poisoning needs you to misread a hex
  string, and here there is no hex string to misread.
- **Privacy you can expect, to a recipient you know.** Amounts and balances stay inside the
  shielded pool, while registry membership is a spend condition enforced in the circuit — so
  the pool will only ever pay a registered `.hls` alias, and funds cannot vanish into a typo.
  Both halves are proved, not promised.
- **Aliases and pool notes are decoupled from your EOA.** Ownership lives in keys derived from
  one recovery phrase, never in the wallet that broadcasts. Pick whichever EOA you like to pay
  the fees, switch it whenever, or use a different one every time — your balance does not
  move, because it was never attached to one.
- **Relayers remove your fee footprint.** Hand a proved transaction to someone else and let
  them take their fee out of the transaction itself. You can spend from an EOA that has never
  held ETH, so there is no funding trail leading back to you.
- **Invites onboard from nothing.** Fund a code that registers a new name and pays its own
  registration fee on redemption. Someone joins on a completely fresh EOA, with no prior
  balance and no history using a relayer.
- **Many aliases from one phrase, unlinkable to each other.** Aliases come from derivation
  indices, so `work.hls` and `personal.hls` can be the same person with nothing on chain to
  say so. Keep them separate, and nobody can join them up.
- **The name is yours to keep or sell.** Each alias is an ERC-721. Transfer is a two-step
  offer-then-accept, so the new owner installs their own keys — a seller cannot hand over the
  token while quietly keeping keys that still receive its payments. Rotating your own keys is
  that same handover made to yourself: all three replaced, the registry slot kept, and
  relayable, so losing access to a key does not mean losing the name.
- **A view key, not your spending key.** Show an accountant your whole history without
  granting them the ability to spend a wei of it.

## Why it exists

Privacy tools and naming services are separate systems today. Railgun, Tornado and Aztec hide
value behind keys; ENS and Fluidkey make addresses readable without hiding much. Halias joins
them at the circuit level — the proof spans the identity registry and the payment pool at once.

The consequence that matters is not "names are nicer than hex". It is that **registry
membership is a spend condition**. Every non-zero output must prove membership in the registry
SMT, so the pool will only pay a registered `.hls` alias. Most shielded pools are built so the
recipient is unknowable; here the recipient set is public, permanent and fee-gated, while which
member received what stays hidden.

The second thing that falls out of it: the system is legible. You pay a name rather than forty
hex characters you have to trust you copied correctly, one recovery phrase derives every alias
you hold, and a view key lets you show your whole history to an accountant without letting them
spend. That readability is downstream of the design rather than painted on afterwards: a pool
whose recipients are opaque keys has no name available to show you in the first place.

## Structure

Four npm workspaces. Dependencies run one way, `app → sdk → protocol → deployments`, and
nothing points back — the contracts do not know the app exists.

```
halias/
├─ packages/protocol/      contracts, circuits, ceremony, deploy scripts
│  ├─ contracts/           HaliasPool, HaliasRegistry, HaliasController, HaliasDeployer
│  ├─ circuits/            transact.circom, transactClaim.circom
│  ├─ src/                 circuit-agnostic ceremony + verifier-export tooling
│  ├─ scripts/             deploy, preflight, gasbench, e2e-live
│  ├─ test/                hardhat suites, including real-proof E2E
│  └─ docs/                design records — the reasoning behind each decision
├─ packages/sdk/           TypeScript client library + the `halias` CLI
│  └─ src/                 keys, notes, proving, scanning, contract calls, relay
├─ packages/app/           SvelteKit frontend, static-built
│  └─ src/lib/             wallet plumbing and the screens
└─ packages/deployments/   per-network contract addresses
   └─ networks/            one JSON per chain, written by the deploy script
```

| Package | Role | Depends on |
|---|---|---|
| [`protocol`](packages/protocol/README.md) | The trust boundary. Contracts, the circom circuits, the trusted setup, and the deploy scripts. Everything that has to be right. | — |
| [`sdk`](packages/sdk/README.md) | The whole client. Key derivation, note encryption, proof generation, event scanning, contract calls — and the CLI, which is a thin shell over the same API the app uses. | `deployments` |
| [`app`](packages/app/README.md) | A browser front end for the SDK. No logic of its own beyond wallet plumbing; static-built so it can be served from IPFS or any dumb host. | `sdk` |
| [`deployments`](packages/deployments/README.md) | Contract addresses per chain, written by the deploy script and read by everything else, so no address is ever hardcoded in two places. | — |

Each package has its own README covering how to build, test and work inside it. This one
covers the system and the path from a fresh clone to a working local stack.

## Architecture

Three contracts, deployed already wired together in one transaction by `HaliasDeployer`. The
split exists so the contract holding every user's funds has no admin key anywhere near it.

```
HaliasController ──writes──> HaliasRegistry <──reads── HaliasPool
   names, ERC-721,             aliasHash →              notes, nullifiers,
   fee, the only admin key     keys + dataHash          all custody
```

Their dependencies form a cycle — the pool reads the registry, the controller writes to it, and
the registry must name its controller before that contract exists. The deployer computes the
third address ahead of deploying it, closes the loop, and asserts it was right.

### HaliasPool

Job: hold every asset, and move it only against a valid proof.

One mutating function. No admin, no owner, no upgrade path, and no key that can pause, drain,
redirect or rescue — including for the deployer. Deposits, transfers and withdrawals are one
proof shape, distinguished by the sign of `publicAmount`.

### HaliasRegistry

Job: map an alias to its keys, and publish roots the circuit can prove against.

A Merkle tree, depth 32, with one immutable writer and no admin. Slots are handed out in
arrival order, so depth is a capacity bound rather than a birthday bound — it is not sparse in
any way that matters, whatever the leaf hash borrows from one.

Updates happen **in place**, which is the real difference from the pool's tree and the reason
every node is stored. An alias keeps its slot through a key rotation or a handover, so being
in the tree and being current are the same statement — which is what lets a sender trust a
membership proof about the keys they are about to pay.

### HaliasController

Job: names, ERC-721 ownership, the registration fee, and the only admin key in the system.

Holds no user funds. Every `onlyAdmin` function in the repo is on this contract, and nothing
reachable from that key can address a user's collateral.

### transact.circom

Job: prove a transaction is valid without revealing what it was.

4 inputs, 2 outputs, 84,023 constraints, 20 public signals. It proves you own the input
commitments, that each non-zero output's recipient is in the registry, that nullifiers are
correctly derived and unspent, and that inputs equal outputs.

Unused input slots are filled with dummies whose nullifiers are published and written like any
other, so a one-note spend and a four-note spend are indistinguishable on chain.

`transactClaim.circom` is the same template with the claim path compiled in — 117,344
constraints, the same 20 public signals — for the case where an alias is registered and spent
in one proof. R1CS has no runtime branching, so the only way to stop ordinary sends paying for
machinery they never use is a second circuit. The pool routes on `pendingLeaf` and holds both
verifiers immutably.

Why four inputs and not more is recorded in
[circuit-shape.md](packages/protocol/docs/circuit-shape.md), along with what wider shapes
measured at and when that decision stops being reversible.

## Getting started

### Prerequisites

| | | |
|---|---|---|
| Node | 20+ | `npm install` |
| [circom](https://docs.circom.io/getting-started/installation/) | 2.2+ | builds the circuits. Rust toolchain, then `cargo install --path circom` |
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | any | `npm run test:fuzz` only. Everything else works without it |

circom is the one that catches people out. It is a Rust binary, not an npm package — the
`circom` on npm is an abandoned 0.5.x and will fail with parse errors on these circuits.

### From a fresh clone

```bash
npm install
npm run build                       # deployments + sdk

cd packages/protocol
npm run compile                     # contracts
npm run circuits:build              # ~10 min: compiles both circuits, runs a dev
                                    # ceremony, exports both verifiers
npm run test:hardhat                # 228 tests, including E2E with real Groth16 proofs
```

`circuits:build` is the slow step and the one everything else waits on. Circuit artifacts are
gitignored — they are 40MB+ and the proving key is generated rather than authored — so a fresh
clone has to produce them before any suite that makes a real proof can run. A locally generated
key will not match a deployed verifier, because the verifier contract is exported *from* the key.

### Run it locally

```bash
npx hardhat node                                        # terminal 1
npx hardhat run scripts/deploy.ts --network localhost   # terminal 2
```

That writes `packages/deployments/networks/localhost.json`, which the SDK and the app both
read. Then either front end:

```bash
npm run halias -- balance                 # CLI, from the repo root
npm --workspace halias-app run dev        # browser, at localhost:5173
```

The local deploy also puts up a 6-decimal mock USDC, so the multi-asset paths are exercisable
rather than theoretical — 18 decimals is the case that agrees with a hardcoded `parseEther` by
accident, and hides the bug worth catching.

### The full suite

```bash
npm run check                             # typecheck + lint, whole repo
npm test                                  # every workspace's own tests

cd packages/protocol
npm run test:fuzz                         # Foundry
RPC_URL=http://127.0.0.1:8545 npx hardhat run scripts/e2e-live.ts --network localhost
```

`e2e-live.ts` is the only suite that drives the SDK against a real node over RPC — chunked
`eth_getLogs`, gas estimation, receipt polling. It catches the class of bug the in-process
suites structurally cannot, and it needs a node and a deploy first. 157 checks.

## Using it

```bash
npm run halias -- register alice.hls
npm run halias -- deposit 0.5
npm run halias -- send bob.hls 0.5
npm run halias -- withdraw 0xAddress 0.5
npm run halias -- balance
npm run halias -- consolidate
```

Nothing is published to npm, so from a clone the CLI runs through the root script above, or
directly as `node packages/sdk/dist/cli.js`. `npm run halias -- help` lists every command.
Every value command takes `--token <address>`. Decimals are read from the token contract rather
than assumed, so a 6-decimal stablecoin behaves the same as an 18-decimal one.

## Keys and ownership

A user holds two things, and keeping them apart is the design.

**One recovery phrase owns everything.** A single BIP-39 mnemonic derives the keys for every
alias you hold and for every note in the pool — spending keys, nullifier keys, encryption
keys, all of it. Back up the phrase and you have backed up your aliases and your balance
together. It never signs a transaction and never touches the chain.

**Any EOA can pay the gas.** The connected wallet is a broadcaster and nothing else. It does
not own your notes, cannot spend them, and is not recorded as their owner anywhere — ownership
lives entirely in the mnemonic-derived keys the circuit checks. So the wallet is
interchangeable: connect MetaMask today and a hardware wallet tomorrow, use a fresh EOA for
every transaction, or borrow one. Your balance and your aliases do not move, because they were
never attached to it. That also means the gas payer and the fund owner need not be the same
person.

**Or pay no gas at all.** A user holding notes but no ETH can hand the transaction to someone
else. The prover names a relayer and a fee inside `paramsHash`, and the pool pays that address
out of the transaction itself. Because the fee is bound into the proof, a submitter can alter
neither the recipient nor the amount — and anyone who takes the payload other than the named
relayer pays gas and receives nothing. There is no incentive to steal it and no way to redirect
it, so the payload can travel over any channel: a message, a QR code, a public board, with no
trust in the carrier. `--relayer <addr> --relayer-fee <eth>` on any value command.

The two secrets stay separate and the onboarding refuses to merge them. Deriving note keys
from a wallet signature was removed as phishable and must not come back — see
[key-management.md](packages/protocol/docs/key-management.md).

## Status

| | |
|---|---|
| Contracts | Feature complete, internally reviewed, **not externally audited** |
| Circuit | Frozen at 4 in / 2 out, with the claim path in a second circuit |
| Trusted setup | **One contributor. Ours.** Not suitable for real funds |
| Networks | **Sepolia**, and local. No mainnet deployment, and there will not be one before an audit |
| Tests | 243 hardhat, 92 SDK, 17 app, 158 e2e-live |

Two things gate mainnet and neither is negotiable: an external audit of the circuit and the
contracts, and a multi-party ceremony over a public Powers of Tau file. A privacy pool whose
setup one person could have subverted is a pool that one person can silently mint in — and
because transactions are opaque, nobody could tell afterwards whether they had.

## Live on Sepolia

The app is at **[suggalla.github.io/halias](https://suggalla.github.io/halias/)**, built from
`main` and pointed at the contracts below. Verified on Etherscan, so the source behind each
address can be read rather than trusted.

<!-- deployment:sepolia -->
| | |
|---|---|
| HaliasPool | [`0xB7836cf859836e801204f3918427FcCeb7Cb5d9f`](https://sepolia.etherscan.io/address/0xB7836cf859836e801204f3918427FcCeb7Cb5d9f#code) |
| HaliasRegistry | [`0x9E54164d4ff98Aa97aaac6CCb14f7163e68be4d9`](https://sepolia.etherscan.io/address/0x9E54164d4ff98Aa97aaac6CCb14f7163e68be4d9#code) |
| HaliasController | [`0x4BD25d89C9dc561a130C044CB2a420C929c407bf`](https://sepolia.etherscan.io/address/0x4BD25d89C9dc561a130C044CB2a420C929c407bf#code) |
| TransactVerifier | [`0x818655DC9638Bf7574084cDAa328fA0e50322566`](https://sepolia.etherscan.io/address/0x818655DC9638Bf7574084cDAa328fA0e50322566#code) |
| TransactClaimVerifier | [`0x80d311aD0f9AcF1f7f715cE4d9B897D963498957`](https://sepolia.etherscan.io/address/0x80d311aD0f9AcF1f7f715cE4d9B897D963498957#code) |
<!-- /deployment:sepolia -->

PoseidonT3 and PoseidonT4 are the canonical `poseidon-solidity` deployments at
`0x3333333C…3B93` and `0x4443338E…ECF0` — the same addresses on every chain, reused rather
than redeployed. `HaliasDeployer` at `0x41226674…4FC5` created the first three in one
transaction and is not verifiable: it links Poseidon inside its constructor only, so the
addresses cannot be recovered from deployed bytecode.

These were deployed and verified from `e0eee20`, before the project name was capitalised in
the source headers. Recompiling at `main` therefore differs from the deployed bytecode in its
last 32 bytes and nowhere else: solc embeds a hash of the source, and a changed comment
changes that hash. The executable code is byte-identical, which is checkable by compiling both
and comparing everything before the trailing metadata. The next deployment removes the
discrepancy.

**The proving key cannot be rebuilt.** A phase-2 ceremony draws fresh entropy every run, so
recompiling the circuits produces a different key that will not verify against these
contracts. Check a downloaded artifact against
[`artifacts.sha256`](packages/deployments/networks/artifacts.sha256) rather than against a
rebuild — that file is the only thing tying the artifacts to the verifiers above.

Still a testnet with a single-contributor setup. Do not put real money in it.

## Roadmap

- **Proof of innocence** — a Railgun-style provenance proof, published by independent parties
  and honoured by relayers. It stays outside the pool, which has no key that can freeze funds
  and is not getting one.
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
- [circuit-shape.md](packages/protocol/docs/circuit-shape.md) — why four inputs, what wider
  shapes cost, and the deadline on changing it.
- [multi-tree-pool.md](packages/protocol/docs/multi-tree-pool.md) — why the pool is a sequence
  of trees and how the global index works.
- [prior-art-review.md](packages/protocol/docs/prior-art-review.md) — checked against
  Semaphore, World ID and zk.money; two real bugs came out of it.
- [legal-considerations.md](packages/protocol/docs/legal-considerations.md) — the Tornado Cash
  and Railgun record, and where Halias differs. Engineering analysis, not legal advice.
- [rpc-surface.md](packages/protocol/docs/rpc-surface.md) — what the client reveals to its
  RPC provider. The category no contract audit covers.
- [static-analysis.md](packages/protocol/docs/static-analysis.md) — Slither, Aderyn,
  circomspect and Picus output, triaged.
- [test-plan.md](packages/protocol/docs/test-plan.md) — coverage by layer.

At the root, [OPEN-ITEMS.md](OPEN-ITEMS.md) — what is known-incomplete, and the decisions
already taken, in more detail than the roadmap above.

## Built on

- Transact circuit adapted from [Tornado Cash Nova](https://github.com/tornadocash/tornado-nova) (GPL-3.0)
- Registry membership proof follows [Semaphore](https://github.com/semaphore-protocol/semaphore) (MIT, PSE-audited)
- Poseidon and comparators from [circomlib](https://github.com/iden3/circomlib) (GPL-3.0)
- Groth16 setup and verifier export via [snarkjs](https://github.com/iden3/snarkjs) (GPL-3.0)

Published findings from the Semaphore audit and World ID's root-history implementation were
checked against this code. Both real bugs in the most recent review came out of that comparison
rather than from re-reading our own contracts.

Keys here are Poseidon hashes rather than curve points: `spendingCommitment =
Poseidon(spendingPrivateKey)`. The only asymmetric cryptography is X25519 (tweetnacl
`nacl.box`), which encrypts a note to its recipient. The circuit never sees it — it is how a
recipient *finds* a note, not how one is spent.

## How this was built

Developed with heavy AI assistance throughout. The architecture, the design decisions, the
adversarial review and the rejected alternatives recorded under `docs/` are mine; much of the
code was generated against them. The commit history is the honest record of how it went — it
includes the designs that were reverted, the bugs caught in review, and the static analyser
that turned out to be wrong.

That matters most for the circuit. Underconstrained signals do not fail tests, so a passing
suite is not evidence of soundness, and this circuit has not had the one thing that would be:
review by someone who was not involved in writing it. If you know circom, that is the single
most useful contribution anyone could make here.

## Contributing

Issues and pull requests welcome. Two things worth knowing first:

- Nothing has launched, so note formats and key derivation are still base changes. Edit them in
  place — no migrations, no compatibility shims, no version bumps. Local state is disposable.
- Security fixes here reliably create the next bug. Review a change as a chain, and ask what
  freedom each fix hands the prover.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).

Required by the dependencies — circomlib, Tornado Nova, snarkjs are all GPL-3.0 — and the right
licence regardless. Nobody should run a privacy tool they cannot read, and copyleft is what
keeps a modified Halias readable too.
