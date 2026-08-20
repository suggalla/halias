# halias-app

The browser front end. SvelteKit, static-built, no server anywhere in the picture.

It owns no payment logic. Every operation is [`halias-sdk`](../sdk/README.md); what lives
here is wallet plumbing, key custody in the browser, and the screens. If you are looking for
how a transfer actually works, it is not in this package.

## Running it

```bash
npm --workspace halias-app run dev        # localhost:5173
```

It needs a deployment to talk to, and there is no live one. From the repo root:

```bash
cd packages/protocol
npx hardhat node                                        # terminal 1
npx hardhat run scripts/deploy.ts --network localhost   # terminal 2
```

That writes `packages/deployments/networks/localhost.json`, which Vite inlines at build time.
Redeploying means rebuilding — which is correct: a static site should pin the contract it was
built against, rather than discovering one at runtime.

## Building

```bash
npm --workspace halias-app run build      # → build/
```

`build` runs `sync-artifacts` first, which copies the circuit wasm and proving key out of the
protocol package into `static/artifacts/`. Those come from `npm run circuits:build` and are
not in git, so the build fails on a fresh clone until the circuits are compiled. That is the
intended failure — an app shipped without a proving key cannot make a proof.

Only the `transact` artifacts are synced. The claim path has its own circuit and its own
proving key, and until those are synced too the claim screen is a dead button in a hosted
build. Recorded in [OPEN-ITEMS.md](../../OPEN-ITEMS.md).

The output is a plain directory of files with relative paths (`paths.relative` in
`svelte.config.js`), so it serves correctly from a subdirectory — IPFS, GitHub Pages, or any
dumb static host. Note that the proving key alone is 37MB, which rules out some of them.

## Layout

```
src/
├─ routes/           one page — the flow is a state machine, not a router
└─ lib/
   ├─ sdk/           client.ts, config.ts, vault.ts, wallets.ts
   └─ windows/       the screens
```

`lib/sdk/` is the boundary, and it is worth reading before the screens:

- **`config.ts`** — deployment addresses and the token list, inlined at build time by Vite's
  `import.meta.glob`, which yields an empty object for a network that was never deployed.
- **`vault.ts`** — where the recovery phrase lives in a browser, and what protects it.
- **`wallets.ts`** — EIP-6963 discovery via `mipd`. The connected wallet broadcasts and pays
  gas; it never sees a note key.
- **`client.ts`** — constructs the `Halias` client with a `BrowserCache`.

The flow is linear — wallet, then alias, then act. An earlier version was a retro desktop
window manager; the `windows/` directory name is what survives of it. The components are
screens.

## The two secrets

The onboarding refuses to merge them, and this is the part of the app most worth
understanding before changing anything:

| | |
|---|---|
| **A connected EVM wallet** | Broadcasts, pays gas. Never sees a note key |
| **A recovery phrase** | Derives every alias's note keys. Never signs anything |

Deriving note keys from a wallet signature would collapse this to one secret and a much
nicer onboarding. It was implemented, then deleted as phishable, and must not come back —
see [key-management.md](../protocol/docs/key-management.md).

## Test

```bash
npm --workspace halias-app run test         # vitest
npm --workspace halias-app run typecheck    # svelte-check
```

Thin — 17 checks, over `config.ts`. The screens are not covered, and the real end-to-end
confidence comes from `scripts/e2e-live.ts` in the protocol package, which drives the same
SDK against a real node. Known gap, listed in [OPEN-ITEMS.md](../../OPEN-ITEMS.md).

## Licence

GPL-3.0-only, like the rest of the repository.
