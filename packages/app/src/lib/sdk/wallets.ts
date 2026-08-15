import { createStore, type EIP6963ProviderDetail } from 'mipd';
import { readable } from 'svelte/store';

// Which wallet to talk to.
//
// Discovered over EIP-6963 rather than read off `window.ethereum`. Every extension injects
// into that one object, so with more than one installed the last to load wins and the user has
// no say — someone running MetaMask and Rabby would get whichever initialised second, with no
// way to pick the
// other. EIP-6963 replaces the collision with an announcement: each wallet emits its own
// provider plus a name, icon and reverse-DNS id, and the app lists them.
//
// Nothing downstream changes. What a wallet announces is an ordinary EIP-1193 provider,
// which is exactly what `new BrowserProvider(...)` already took.

const store = createStore();

/// Wallets that have announced themselves, newest announcement included.
///
/// Readable rather than a one-shot read: extensions announce asynchronously during page load,
/// so a list captured on mount is reliably short. Subscribing means a wallet that initialises
/// late still appears rather than looking uninstalled.
export const wallets = readable<readonly EIP6963ProviderDetail[]>(store.getProviders(), (set) => {
	set(store.getProviders());
	return store.subscribe((providers) => set(providers));
});

/// Look a wallet up by its reverse-DNS id (`io.metamask`, `io.rabby`, …).
export function findWallet(rdns: string): EIP6963ProviderDetail | undefined {
	return store.findProvider({ rdns });
}

/// The provider to use when the caller has not picked one.
///
/// Only sensible when exactly one wallet is present. With several, picking for the user is the
/// `window.ethereum` collision by another route, so callers are expected to prompt instead.
export function soleWallet(): EIP6963ProviderDetail | undefined {
	const found = store.getProviders();
	return found.length === 1 ? found[0] : undefined;
}

/// EIP-6963 is the discovery path, but a wallet predating it only injects `window.ethereum`.
/// Kept as a fallback so those still work; it is never preferred over an announced wallet.
export function legacyWallet(): any | undefined {
	return (globalThis as any).ethereum ?? undefined;
}

export function anyWalletAvailable(): boolean {
	return store.getProviders().length > 0 || legacyWallet() !== undefined;
}
