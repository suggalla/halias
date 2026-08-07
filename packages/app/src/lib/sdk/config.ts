import sepolia from '../../../../deployments/networks/sepolia.json';

// Browser-safe deployment config.
//
// The halias-deployments package reads its JSON with fs at runtime, which cannot work in
// a browser build — importing it here is what broke the bundle. Vite inlines this JSON at
// build time instead, so the app ships with the addresses baked in and no filesystem
// access. Redeploying means rebuilding the app, which is correct: a static site should
// pin the contract it was built against.

export interface NetworkConfig {
	chainId: number;
	chainName: string;
	rpcUrl: string;
	blockExplorer: string;
	contractAddress: string;
	startBlock: number;
}

export const DEFAULT_CHAIN_ID = 11155111;

export const NETWORKS: Record<number, NetworkConfig> = {
	11155111: {
		chainId: 11155111,
		chainName: 'Sepolia',
		rpcUrl: import.meta.env.VITE_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
		blockExplorer: 'https://sepolia.etherscan.io',
		contractAddress: (sepolia as any).halias,
		startBlock: (sepolia as any).startBlock ?? 0
	}
};

export function getNetwork(chainId: number): NetworkConfig | undefined {
	return NETWORKS[chainId];
}

// One circuit handles deposit, transfer and withdraw via a signed publicAmount, so there
// is a single wasm/zkey pair. The v0 split into withdraw/transfer is long gone.
export const ARTIFACT_URLS = {
	transactWasm: '/artifacts/transact.wasm',
	transactZkey: '/artifacts/transact_final.zkey'
};
