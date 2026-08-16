# src/

ZK infrastructure — circuit-agnostic tooling for ceremony, proof generation, and verifier export.

## Modules

| File | Purpose |
|------|---------|
| `config.ts` | Loads `halias.config.json`, resolves paths with `{circuit}` templating |
| `zksnark.ts` | snarkjs wrapper: `generateProof`, `verifyProof`, `exportSolidityVerifier`, `exportCalldata` |
| `setup-ceremony.ts` | CLI: Powers of Tau + Groth16 trusted setup (`-c <circuit> -p <power>`) |
| `export-verifier.ts` | CLI: export Solidity verifier contract (`-c <circuit>`) |

## Ceremony CLI

```bash
npm run ceremony -- -c withdraw -p 16
```

| Flag | Default | Description |
|------|---------|-------------|
| `-c, --circuit` | `withdraw` | Circuit name |
| `-p, --power` | `16` | Powers of tau exponent (2^p constraints) |
| `-o, --outdir` | `circuits/out/{circuit}` | Output directory |
| `-e, --entropy` | random | Entropy for contributions |

Outputs to `circuits/out/{circuit}/ceremony/`:
- `{circuit}_final.zkey` — proving key
- `verification_key.json` — verification key
- `pot_final.ptau` — powers of tau

## Export Verifier CLI

```bash
npm run export-verifier -- -c withdraw
```

Writes `contracts/WithdrawVerifier.sol` (or `TransferVerifier.sol` for `-c transfer`).

## Concepts

- **Witness**: full assignment of all signals (private + public) that satisfies every circuit constraint
- **Commitment**: `Poseidon(spendingPubkey, nullifier, secret, denomination)` — stored on-chain in Merkle tree
- **Powers of Tau**: universal ceremony (circuit-independent), run once per constraint size
- **Phase 2 (zkey)**: circuit-specific setup on top of the Powers of Tau output
- **Nullifier**: deterministically derived from spending key + leaf index; its hash is published on-chain to prevent double-spend
