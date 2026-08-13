import sepolia from '../../../../deployments/networks/sepolia.json';

// Optional, unlike sepolia: a fresh clone has never run a local deploy, and a static
// import of a missing file is a build error. glob returns an empty object instead.
const localModules = import.meta.glob('../../../../deployments/networks/localhost.json', {
	eager: true
}) as Record<string, { default: Record<string, string | number> }>;
const localhost = Object.values(localModules)[0]?.default;

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
	// Three contracts since the pool/registry/domain split. poolAddress is the one that
	// must be right for a proof to verify — the pool hashes its own address into paramsHash.
	poolAddress: string;
	registryAddress: string;
	controllerAddress: string;
	startBlock: number;
}

export const DEFAULT_CHAIN_ID = 11155111;

export const NETWORKS: Record<number, NetworkConfig> = {
	11155111: {
		chainId: 11155111,
		chainName: 'Sepolia',
		rpcUrl: import.meta.env.VITE_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
		blockExplorer: 'https://sepolia.etherscan.io',
		poolAddress: (sepolia as any).pool,
		registryAddress: (sepolia as any).registry,
		controllerAddress: (sepolia as any).domain,
		startBlock: (sepolia as any).startBlock ?? 0
	}
};

// MetaMask can already reach a local node; this is what lets the app accept one. Without an
// entry here connect() rejects chain 31337 before the wallet connection is ever used.
//
// Registered only when a local deployment exists, so a fresh clone is unaffected.
if (localhost?.pool) {
	NETWORKS[31337] = {
		chainId: 31337,
		chainName: 'Localhost',
		rpcUrl: 'http://127.0.0.1:8545',
		blockExplorer: '',
		poolAddress: localhost.pool as string,
		registryAddress: localhost.registry as string,
		controllerAddress: localhost.domain as string,
		startBlock: (localhost.startBlock as number) ?? 0
	};
}

export function getNetwork(chainId: number): NetworkConfig | undefined {
	return NETWORKS[chainId];
}

// A deployment JSON written before the split has only `halias`, so every address above is
// undefined. Connecting against it would fail deep inside proof generation with nothing to
// say why, so it is caught here instead.
/// Networks this build can actually talk to — configured AND deployed post-split.
///
/// Local first when present: a developer with a node running wants that, and Sepolia is
/// only usable once it has been redeployed.
export function usableNetworks(): NetworkConfig[] {
	return Object.values(NETWORKS)
		.filter(isSplitDeployment)
		.sort((a, b) => (a.chainId === 31337 ? -1 : b.chainId === 31337 ? 1 : 0));
}

export function isSplitDeployment(net: NetworkConfig): boolean {
	return Boolean(net.poolAddress && net.registryAddress && net.controllerAddress);
}

// One circuit handles deposit, transfer and withdraw via a signed publicAmount, so there
// is a single wasm/zkey pair. The v0 split into withdraw/transfer is long gone.
export const ARTIFACT_URLS = {
	transactWasm: '/artifacts/transact.wasm',
	transactZkey: '/artifacts/transact_final.zkey'
};
