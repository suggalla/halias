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
	optimizeDeps: {
		include: ['halias-sdk', 'ethers', 'snarkjs']
	},
	build: {
		commonjsOptions: {
			include: [/halias-sdk/, /circomlibjs/, /snarkjs/, /node_modules/]
		}
	},
	define: {
		global: 'globalThis'
	}
});
