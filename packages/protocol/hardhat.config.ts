import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";

// One .env, at the repo root. Loading a second one here would silently lose to this
// first call — dotenv does not override — so a per-package PRIVATE_KEY would be
// ignored while looking authoritative.
dotenv.config({ path: path.join(__dirname, "../../.env") });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  paths: {
    sources:   "./contracts",
    artifacts: "/tmp/halias-artifacts",
    cache:     "/tmp/halias-cache",
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      url: process.env.RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  // Verification is part of deploying, not an afterthought: an unverified privacy
  // contract asks users to trust a bytecode blob.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: true,
  },
};

export default config;
