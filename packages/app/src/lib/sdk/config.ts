// Every network is optional. A static import of a missing file is a build error, and neither
// deployment is guaranteed to exist: a fresh clone has never run a local deploy, and there is
// currently no live Sepolia deployment at all — the last one predates the contract split and
// was deleted rather than left to look usable. glob returns an empty object instead.
const load = (glob: Record<string, unknown>) =>
	(Object.values(glob)[0] as { default: Record<string, unknown> } | undefined)?.default;

const sepolia = load(
	import.meta.glob('../../../../deployments/networks/sepolia.json', { eager: true })
);
const localhost = load(
	import.meta.glob('../../../../deployments/networks/localhost.json', { eager: true })
);

// Browser-safe deployment config.
//
// The halias-deployments package reads its JSON with fs at runtime, which cannot work in
// a browser build — importing it here is what broke the bundle. Vite inlines this JSON at
// build time instead, so the app ships with the addresses baked in and no filesystem
// access. Redeploying means rebuilding the app, which is correct: a static site should
// pin the contract it was built against.

/// One asset the pool will hold notes in.
///
/// Decimals are carried rather than assumed, because they decide what every amount means:
/// "1.0" of a 6-decimal token like USDC is a millionth of what 18 decimals would compute.
/// The SDK reads them from the token contract too — this list is what the app is willing to
/// *offer*, not what it is able to handle.
export interface TokenConfig {
	/// The zero address for ETH, which is the same sentinel a note commitment carries.
	address: string;
	symbol: string;
	decimals: number;
}

export const ETH_TOKEN: TokenConfig = {
	address: '0x0000000000000000000000000000000000000000',
	symbol: 'ETH',
	decimals: 18
};

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
	/// What this app offers, ETH first. Deliberately a short curated list rather than an
	/// open token field, and the reason is privacy rather than convenience: a note's token
	/// address is a public signal, so each asset has its own anonymity set. Ten tokens is
	/// ten small crowds, and the holders of the least-used one are barely hidden at all.
	/// Adding an asset here is a decision to split the pool, so it is made deliberately and
	/// per deployment.
	tokens: TokenConfig[];
}

/// The token list a deployment declares, ETH first and always present.
///
/// Read from the deployment JSON so a local chain that deploys a mock token can offer it
/// without this file knowing anything about it, and so no address is hardcoded here that
/// cannot be checked against a deployment.
export function tokensFrom(deployment: Record<string, unknown> | undefined): TokenConfig[] {
	const declared = Array.isArray(deployment?.tokens) ? (deployment!.tokens as TokenConfig[]) : [];
	return [ETH_TOKEN, ...declared.filter((t) => t?.address && t.address !== ETH_TOKEN.address)];
}

export const DEFAULT_CHAIN_ID = 11155111;

export const NETWORKS: Record<number, NetworkConfig> = {
	11155111: {
		chainId: 11155111,
		chainName: 'Sepolia',
		rpcUrl: import.meta.env.VITE_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
		blockExplorer: 'https://sepolia.etherscan.io',
		poolAddress: (sepolia as any)?.pool,
		registryAddress: (sepolia as any)?.registry,
		// `controller`, and it has to match exactly what deploy.ts writes. A key that is merely
		// close leaves this undefined, isSplitDeployment rejects the network, and the app reports
		// having no deployment at all — with nothing pointing at the spelling.
		controllerAddress: (sepolia as any)?.controller,
		startBlock: (sepolia as any)?.startBlock ?? 0,
		tokens: tokensFrom(sepolia as any)
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
		controllerAddress: localhost.controller as string,
		startBlock: (localhost.startBlock as number) ?? 0,
		tokens: tokensFrom(localhost)
	};
}

export function getNetwork(chainId: number): NetworkConfig | undefined {
	return NETWORKS[chainId];
}

/// Networks this build can actually talk to — configured, and actually deployed.
///
/// A network whose JSON is missing or incomplete leaves every address above undefined, and
/// connecting to one of those fails deep inside proof generation with nothing to say why. It
/// is caught here instead.
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
	transactZkey: '/artifacts/transact_final.zkey',
	// Claiming an invite is the one flow that registers an alias while spending, and it needs
	// the larger circuit. Fetched only when that flow runs — see getArtifacts().
	claimWasm: '/artifacts/transactClaim.wasm',
	claimZkey: '/artifacts/transactClaim_final.zkey'
};

/// What this chain offers, ETH first. Falls back to ETH alone for an unknown chain, which is
/// always correct — the pool holds ETH on every deployment.
export function tokensFor(chainId: number): TokenConfig[] {
	return NETWORKS[chainId]?.tokens ?? [ETH_TOKEN];
}

/// Match a token by address, case-insensitively. Returns ETH for anything unrecognised
/// rather than undefined: every caller is about to denominate an amount, and there is no
/// safe way to do that with no token at all.
export function findToken(chainId: number, address: string): TokenConfig {
	const want = address.toLowerCase();
	return tokensFor(chainId).find((t) => t.address.toLowerCase() === want) ?? ETH_TOKEN;
}
