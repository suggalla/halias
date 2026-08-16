import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		include: ['halias-sdk', 'ethers']
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
