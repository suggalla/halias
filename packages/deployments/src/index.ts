import fs from "fs";
import path from "path";
import networksJson from "../networks.json";

export interface NetworkConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  blockExplorer: string;
}

/// One asset the app is willing to offer, recorded by the deploy script.
///
/// Decimals are here so a UI can render before it has read the token contract. The SDK reads
/// the real ones on chain and those win — this is a hint, never the authority.
export interface TokenRecord {
  address: string;
  symbol: string;
  decimals: number;
}

export interface Deployment {
  deployer: string;
  poseidonT3: string;
  poseidonT4: string;
  verifier: string;
  claimVerifier?: string;
  /// The three the SDK and app read, and only those three. A fourth contract address recorded
  /// here would let a client silently point at something that is not the live pool.
  pool: string;
  registry: string;
  controller: string;
  admin?: string;
  startBlock?: number;
  updatedAt?: string;
  /// Local chains only. Adding an asset splits the anonymity set, so it is a deliberate
  /// per-deployment decision rather than something a script does by default.
  tokens?: TokenRecord[];
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

// Every deployment carries three addresses. One that does not predates the contract split and
// throws here rather than silently handing back the wrong contract — the pool hashes its own
// address into paramsHash, so a wrong one produces proofs that verify against nothing.
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
