import { HardhatUserConfig } from "hardhat/config";
// The plugins this repo actually uses, rather than @nomicfoundation/hardhat-toolbox.
// The toolbox is a meta-package that also pulls in typechain, ignition, gas-reporter and
// solidity-coverage — none of which anything here imports, all of which load on every
// hardhat invocation. On a repo living on a Windows drive under WSL that module loading is
// I/O-bound and dominates the startup of even a no-op run.
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";   // etherscan/sourcify config below, and deploy-time verification
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
      // Must match the compiler's evmVersion above. The registry arms a claim's pending
      // insertion in transient storage, and TLOAD/TSTORE are invalid opcodes before Cancun —
      // which reverts with no reason string and looks like a contract bug rather than a
      // network setting.
      hardfork: "cancun",
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
