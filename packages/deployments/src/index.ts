import fs from "fs";
import path from "path";
import networksJson from "../networks.json";

export interface NetworkConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  blockExplorer: string;
}

export interface Deployment {
  deployer: string;
  factory: string;
  poseidonT3: string;
  poseidonT4: string;
  transactVerifier: string;
  halias: string;
  vanitySalt?: string;
  predictedAddress?: string;
  deployTxHash?: string;
  startBlock?: number;
  updatedAt?: string;
}

const networks = networksJson as Record<string, NetworkConfig>;
const NETWORKS_DIR = path.join(__dirname, "..", "networks");

const CHAIN_NAMES: Record<number, string> = {
  1: "mainnet",
  11155111: "sepolia",
  31337: "localhost",
};

export function getNetwork(chainId: number): NetworkConfig {
  const config = networks[String(chainId)];
  if (!config) throw new Error(`Unknown chain ID: ${chainId}`);
  return config;
}

export function getDeployment(chainId: number): Deployment {
  const name = CHAIN_NAMES[chainId];
  if (!name) throw new Error(`Unknown chain ID: ${chainId}`);

  const filePath = path.join(NETWORKS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No deployment found for ${name} (chain ${chainId})`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// The monolith. Kept for deployments made before the pool/registry/domain split.
export function getContractAddress(chainId: number): string {
  return getDeployment(chainId).halias;
}

// Post-split deployments carry three addresses. A deployment JSON that still only has
// `halias` will throw here rather than silently hand back the wrong contract — the pool
// hashes its own address into paramsHash, so a wrong one produces proofs that verify
// against nothing.
function requireAddress(chainId: number, key: "pool" | "registry" | "controller"): string {
  const addr = (getDeployment(chainId) as Record<string, any>)[key];
  if (!addr) {
    throw new Error(
      `Deployment for chain ${chainId} has no "${key}" address — it predates the contract split`,
    );
  }
  return addr as string;
}

export function getPoolAddress(chainId: number): string {
  return requireAddress(chainId, "pool");
}

export function getRegistryAddress(chainId: number): string {
  return requireAddress(chainId, "registry");
}

export function getControllerAddress(chainId: number): string {
  return requireAddress(chainId, "controller");
}

export function getStartBlock(chainId: number): number {
  return getDeployment(chainId).startBlock ?? 0;
}

export function listDeployments(): { chainId: number; name: string }[] {
  return Object.entries(CHAIN_NAMES)
    .filter(([, name]) => {
      return fs.existsSync(path.join(NETWORKS_DIR, `${name}.json`));
    })
    .map(([id, name]) => ({ chainId: Number(id), name }));
}
