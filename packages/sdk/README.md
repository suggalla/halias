# halias-sdk

The client. Every operation a user performs — derive keys, find your notes, build a proof,
send a transaction — happens here. The CLI and the web app are both thin shells over this
API; neither has payment logic of its own.

What the protocol *is* and why is in the [repository README](../../README.md).

## The shape of it

Two entry points, and which one you want depends on how much you want to own.

`Halias` is the high-level client. It holds a provider, a set of alias keys and a cache, and
its methods are the operations: `deposit`, `send`, `withdraw`, `consolidate`, `balance`. It
handles note selection, padding, proving and submission.

```ts
import { Halias, rootFromMnemonic, FileCache } from "halias-sdk";

const halias = await Halias.create({ ... });
await halias.deposit("0.5");
await halias.send("bob.hls", "0.1");
```

Below that, every piece is exported on its own — `proveTransact`, `buildEntry`,
`computeNullifier`, `scanEvents`, `MerkleTree`, `SMT`. Use those if you are building
something that is not a wallet.

## Modules

| File | What it owns |
|---|---|
| `crypto.ts` | Poseidon, key derivation, and the X25519 note encryption (`nacl.box`) |
| `seed.ts` | BIP-39 mnemonic → root. The note keys, which never sign a transaction |
| `viewkey.ts` | Encoding a view key: read your whole history, spend none of it |
| `entry.ts` | Note commitments and nullifiers. The formats the circuit agrees with |
| `proof.ts` | Witness assembly and `proveTransact`, plus the dummy input/output padding |
| `merkle.ts` | The pool tree mirror |
| `smt.ts` | The registry tree mirror, which must reproduce the contract's tree exactly |
| `events.ts` | `scanEvents` and `findMyOutputs` — trial decryption over the log range |
| `contract.ts` | ethers wrappers, ABIs, `paramsHash`, and the signed-write helpers |
| `alias.ts` | Normalising and validating `.hls` names |
| `relay.ts` | The relay payload, and quoting a relay before submitting it |
| `invite.ts` | Invite codes: a throwaway keypair, and a note encrypted to it |
| `cache.ts` | `FileCache` for Node, `BrowserCache` for the app |
| `halias.ts` | The `Halias` client that composes all of the above |
| `cli.ts` | The `halias` command |

Two of these carry a correctness obligation that is not local to them. `entry.ts` and
`smt.ts` both mirror something the circuit or the contract also computes, and a mismatch does
not throw — it produces a proof that verifies against nothing, or a path that resolves to the
wrong root. `Alignment.test.ts` in the protocol package pins both against live contracts.

## The CLI

```bash
npm run halias -- help        # from the repo root
```

Nothing is published to npm, so from a clone it runs through that root script or directly as
`node packages/sdk/dist/cli.js`. It needs two secrets, and they are deliberately different
things:

| | |
|---|---|
| `PRIVATE_KEY` | An EVM wallet. Broadcasts and pays gas. Never sees a note key |
| `HALIAS_MNEMONIC` | The note-key recovery phrase. Never signs a transaction |
| `RPC_URL` | Endpoint |
| `CHAIN_ID` | Default 11155111 (Sepolia) |

Both are read from the repo-root `.env`. Deriving note keys from a wallet signature was
removed as phishable and must not come back — see
[key-management.md](../protocol/docs/key-management.md).

## Build and test

```bash
npm run build       # tsc → dist/
npm test            # 86 tests, mocha
npm run typecheck
```

**Source changes need `npm run build` before the protocol tests see them.** They import
`halias-sdk`, which resolves to `dist/`. A stale `dist` shows up as a confusing failure in a
test you did not touch, and it has cost time three separate times.

The suites here cover key derivation, alias validation, view keys, seeds and the CLI's
argument handling. What they cannot cover is anything that needs a chain — that lives in the
protocol package, in `test/` and in `scripts/e2e-live.ts`.

## Proving artifacts

`proveTransact` takes an `ArtifactPaths` — the circuit wasm and the proving key. They are
40MB+, generated rather than authored, and gitignored; `npm run circuits:build` in the
protocol package produces them. In Node they are file paths; in the browser the app fetches
them from `static/artifacts/`.

## Licence

GPL-3.0-only, like the rest of the repository.
