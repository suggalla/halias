import { writable, get } from 'svelte/store';
import type { HaliasKeys } from 'halias-sdk';

export const sdkReady = writable(false);
export const keysStore = writable<HaliasKeys | null>(null);
export const notesStore = writable<any[]>([]);

let initPromise: Promise<void> | null = null;

export async function ensureInit() {
	if (get(sdkReady)) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		const { init } = await import('halias-sdk');
		await init();
		sdkReady.set(true);
	})();

	return initPromise;
}

export async function deriveKeys(signer: any) {
	await ensureInit();
	const { deriveKeysFromWallet } = await import('halias-sdk');
	const keys = await deriveKeysFromWallet(signer);
	keysStore.set(keys);
	return keys;
}
