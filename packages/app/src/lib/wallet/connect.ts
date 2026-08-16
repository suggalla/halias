import { BrowserProvider } from 'ethers';
import { walletStore } from './store.js';
import { NETWORKS, DEFAULT_CHAIN_ID, getNetwork } from '../sdk/config.js';

export { walletStore };

export async function connectMetaMask() {
	const ethereum = (window as any).ethereum;
	if (!ethereum) {
		walletStore.update((s) => ({ ...s, error: 'No wallet detected' }));
		return;
	}

	walletStore.update((s) => ({ ...s, connecting: true, error: null }));

	try {
		const provider = new BrowserProvider(ethereum);
		const signer = await provider.getSigner();
		const address = await signer.getAddress();
		const network = await provider.getNetwork();
		const chainId = Number(network.chainId);

		// Prompt to switch if on wrong network
		if (!getNetwork(chainId)) {
			await switchNetwork(ethereum, DEFAULT_CHAIN_ID);
			// Provider needs refresh after chain switch
			const newProvider = new BrowserProvider(ethereum);
			const newSigner = await newProvider.getSigner();
			const newAddress = await newSigner.getAddress();

			walletStore.set({
				provider: newProvider,
				signer: newSigner,
				address: newAddress,
				chainId: DEFAULT_CHAIN_ID,
				connecting: false,
				error: null
			});
		} else {
			walletStore.set({
				provider,
				signer,
				address,
				chainId,
				connecting: false,
				error: null
			});
		}

		ethereum.on('accountsChanged', handleAccountsChanged);
		ethereum.on('chainChanged', handleChainChanged);
	} catch (err: any) {
		walletStore.update((s) => ({
			...s,
			connecting: false,
			error: err.message ?? 'Connection failed'
		}));
	}
}

async function switchNetwork(ethereum: any, chainId: number) {
	const hexChainId = '0x' + chainId.toString(16);
	try {
		await ethereum.request({
			method: 'wallet_switchEthereumChain',
			params: [{ chainId: hexChainId }],
		});
	} catch (err: any) {
		// 4902 = chain not added yet
		if (err.code === 4902) {
			const net = getNetwork(chainId)!;
			await ethereum.request({
				method: 'wallet_addEthereumChain',
				params: [{
					chainId: hexChainId,
					chainName: net.chainName,
					rpcUrls: [net.rpcUrl],
					blockExplorerUrls: [net.blockExplorer],
				}],
			});
		} else {
			throw err;
		}
	}
}

export function disconnect() {
	const ethereum = (window as any).ethereum;
	if (ethereum) {
		ethereum.removeListener('accountsChanged', handleAccountsChanged);
		ethereum.removeListener('chainChanged', handleChainChanged);
	}
	walletStore.set({
		provider: null,
		signer: null,
		address: null,
		chainId: null,
		connecting: false,
		error: null
	});
}

function handleAccountsChanged(accounts: string[]) {
	if (accounts.length === 0) {
		disconnect();
	} else {
		walletStore.update((s) => ({ ...s, address: accounts[0] }));
	}
}

function handleChainChanged() {
	window.location.reload();
}
