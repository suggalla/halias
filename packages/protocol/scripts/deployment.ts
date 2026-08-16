import fs from "fs";
import path from "path";

// packages/deployments/networks/ — the canonical deployment registry for the monorepo
const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments", "networks");

function getNetwork(): string {
  return process.env.HARDHAT_NETWORK || "localhost";
}

function getPath(): string {
  return path.join(DEPLOYMENTS_DIR, `${getNetwork()}.json`);
}

export function loadDeployment(): Record<string, any> {
  const filePath = getPath();
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }
  return {};
}

export function saveDeployment(data: Record<string, any>): void {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  const existing = loadDeployment();
  const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
  const filePath = getPath();
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nSaved to ${path.relative(process.cwd(), filePath)}`);
}
