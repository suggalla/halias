import {
	getNetwork as getNetworkConfig,
	getContractAddress,
	type NetworkConfig as BaseNetworkConfig,
} from 'halias-deployments';

export type NetworkConfig = BaseNetworkConfig & { contractAddress: string };

export const DEFAULT_CHAIN_ID = 11155111;

export function getNetwork(chainId: number): NetworkConfig {
	const base = getNetworkConfig(chainId);
	const rpcUrl = import.meta.env.VITE_RPC_URL || base.rpcUrl;
	return { ...base, rpcUrl, contractAddress: getContractAddress(chainId) };
}

export const ARTIFACT_URLS = {
	withdrawWasm: '/artifacts/withdraw.wasm',
	withdrawZkey: '/artifacts/withdraw_final.zkey',
	transferWasm: '/artifacts/transfer.wasm',
	transferZkey: '/artifacts/transfer_final.zkey',
};
