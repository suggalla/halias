# halias-deployments

Contract addresses, one JSON file per chain. The smallest package here and the one with the
clearest job: no address is hardcoded in two places, so the SDK, the app and the scripts
cannot disagree about which pool is the pool.

Written by `scripts/deploy.ts` in the protocol package. Read by everything else.

## Contents

```
networks.json        chain id → name, RPC, explorer
networks/
  localhost.json     written by every local deploy; gitignored
  sepolia.json       absent — there is no live deployment
src/index.ts         the accessors
```

`networks/localhost.json` is the one file the deploy script rewrites constantly, so it alone
is gitignored. The directory is not — an unanchored `deployments/` rule once swallowed this
entire package, source and `package.json` with it, and a fresh clone could not install.

## API

```ts
import { getPoolAddress, getRegistryAddress, getControllerAddress,
         getStartBlock, getNetwork, listDeployments } from "halias-deployments";

const pool = getPoolAddress(31337);
```

`getStartBlock` matters more than it looks: it is the block the deploy landed in, and it is
where event scanning begins. Without it a client scans from genesis.

Three addresses are required, and the accessors throw when one is missing. A deployment
recorded before the contract split has a `halias` address and no `pool`; the pool hashes its own
address into `paramsHash`, so pointing a client at the wrong one yields proofs that verify
against nothing. The error names the reason.

The `Deployment` type carries more fields — the verifiers, the Poseidon libraries, the deployer
— but only those three are read at runtime.

## Tokens

`tokens[]` on a deployment is a list of assets the app is willing to *offer*, with their
symbols and decimals. Local chains only, and deliberately so: every asset added to a pool
splits its anonymity set, so it is a per-deployment decision rather than something a script
does by default.

The decimals here are a hint for rendering before the token contract has been read. The SDK
reads the real ones on chain and those win.

## Build

```bash
npm --workspace halias-deployments run build      # tsc → dist/
```

Nothing to test. It is a typed reader over JSON files, and what could break about it — a
missing address, a stale format — throws at the call site by design.

## Licence

GPL-3.0-only, like the rest of the repository.
