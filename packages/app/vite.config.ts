import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
	plugins: [
		sveltekit(),
		// snarkjs and its ffjavascript dependency were written for Node and still reach for
		// buffer, events, util and stream. Vite externalises those in a browser build,
		// which surfaced as "Module X has been externalized" at connect time rather than
		// as a build failure. The SDK's own code is isomorphic; this covers the
		// dependencies we do not control.
		nodePolyfills({ include: ['buffer', 'events', 'util', 'stream', 'process'] })
	],
	resolve: {
		alias: {
			// Resolve the SDK to its TypeScript source rather than its build output.
			//
			// It was pre-bundled from dist/ before, which froze it at whatever existed when
			// the dev server started: rebuilding the SDK left the browser serving the old
			// copy, surfacing as "X is not a function" for anything newly exported. Reading
			// source means Vite watches those files and picks changes up like any other.
			//
			// This only works because the SDK is valid ESM — the three `require` calls it
			// used to carry are now imports. Reintroducing one breaks the browser build.
			'halias-sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url))
		}
	},
	optimizeDeps: {
		// halias-sdk is deliberately absent: it is source now, not a dependency to bundle.
		include: ['ethers', 'snarkjs']
	},
	build: {
		commonjsOptions: {
			include: [/halias-sdk/, /circomlibjs/, /snarkjs/, /node_modules/]
		}
	},
	define: {
		global: 'globalThis'
	},
	server: {
		fs: {
			// The SDK is served from source now, which lives outside this package. Without
			// this Vite refuses to serve it: "outside of Vite serving allow list".
			allow: [fileURLToPath(new URL('..', import.meta.url))]
		},
		watch: {
			// The repo lives on /mnt/e, a Windows drive mounted through drvfs, where inotify
			// does not fire. Without polling Vite never sees a file change: it keeps serving
			// cached transforms and HMR goes silent, so edits appear to have no effect.
			usePolling: true,
			interval: 300
		}
	}
});
