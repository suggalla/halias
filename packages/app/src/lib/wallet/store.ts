import { writable } from 'svelte/store';
import type { BrowserProvider, JsonRpcSigner } from 'ethers';

export interface WalletState {
	provider: BrowserProvider | null;
	signer: JsonRpcSigner | null;
	address: string | null;
	chainId: number | null;
	connecting: boolean;
	error: string | null;
}

export const walletStore = writable<WalletState>({
	provider: null,
	signer: null,
	address: null,
	chainId: null,
	connecting: false,
	error: null
});
