# src/

Ceremony and verifier-export tooling. Deliberately circuit-agnostic: every path comes from
`halias.config.json` with `{circuit}` interpolation, so the same two commands build
`transact` and `transactClaim` without either being named in the code.

## Modules

| File | Purpose |
|---|---|
| `config.ts` | Loads `halias.config.json`, resolves paths with `{circuit}` templating |
| `zksnark.ts` | snarkjs wrapper: `generateProof`, `verifyProof`, `exportSolidityVerifier`, `exportCalldata` |
| `setup-ceremony.ts` | CLI: Powers of Tau + Groth16 phase 2 (`-c <circuit> -p <power>`) |
| `export-verifier.ts` | CLI: export the Solidity verifier (`-c <circuit>`) |

## Ceremony

```bash
npm run ceremony -- -c transact -p 17 --dev
```

| Flag | Default | Description |
|---|---|---|
| `-c, --circuit` | from config (`transact`) | Circuit name |
| `-p, --power` | from config (`17`) | Powers of tau exponent — supports 2^p constraints |
| `-o, --outdir` | `circuits/out/{circuit}` | Output directory |
| `-e, --entropy` | random | Entropy for contributions |
| `--dev` | off | Single contributor, no prompts |

Writes to `circuits/out/{circuit}/ceremony/`:

- `{circuit}_final.zkey` — the proving key
- `verification_key.json` — the verification key
- `pot_final.ptau` — powers of tau

Power 17 covers both circuits: `transact` is 84,023 constraints and `transactClaim` is
117,344, against a 131,072 ceiling. A circuit that outgrows its power fails at setup rather
than producing a subtly wrong key.

**`--dev` is what the current keys were built with, and it is a single contributor: us.**
Fine for a testnet, disqualifying for real funds. Whoever ran it could forge proofs — mint
notes from nothing — and because pool transactions are opaque, nobody could tell afterwards
whether they had. A multi-party ceremony over a public Powers of Tau file is a prerequisite
for mainnet, and there is no way to retrofit one onto a deployed pool.

## Export verifier

```bash
npm run export-verifier -- -c transact
npm run export-verifier -- -c transactClaim
```

Writes `contracts/TransactVerifier.sol` and `contracts/TransactClaimVerifier.sol` — the name
is the circuit name, capitalised, plus `Verifier`.

Two things are rewritten on the way out, and both are there so a hand edit is never needed:
snarkjs names the contract `Groth16Verifier`, and it emits a floating
`pragma solidity >=0.7.0 <0.9.0`. Every other contract here pins `0.8.28`, and a generated
file is exactly the one that would otherwise drift to whatever compiler a reviewer happened
to have installed.

Both outputs are committed, and both are excluded from solhint in `.solhintignore` — a
generated file loses any fix on the next export, so linting it only produces noise.

## Concepts

- **Witness** — the full assignment of every signal, private and public, that satisfies the
  circuit's constraints. The proof asserts that such an assignment exists without revealing it.
- **Commitment** — `Poseidon(spendingCommitment, nullifierKeyHash, blinding, amount, tokenAddress)`,
  the leaf stored in the pool tree. Its exact field order is duplicated in the circuit, the
  contract and the SDK; `Alignment.test.ts` pins them against each other.
- **Nullifier** — derived from the spending key and the leaf's global index, published on
  spend so the pool can reject a second one. Dummy inputs produce nullifiers too, and they
  must be *distinct*, or padding trips the duplicate check.
- **Powers of Tau** — the circuit-independent half of the setup. Run once per constraint size,
  and reusable across circuits.
- **Phase 2 (zkey)** — the circuit-specific half, layered on the Powers of Tau output. This is
  the half that has to be redone for every circuit change, and the half a mainnet ceremony
  needs contributors for.
