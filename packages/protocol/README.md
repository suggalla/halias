# Halias Protocol

Halias is a privacy-preserving identity and asset protocol on Ethereum. It combines ERC-721 aliases (names) with a shielded pool to enable private transfers and withdrawals.

## Architecture

- **Halias.sol**: The core contract managing alias registration (ERC-721) and the shielded pool.
- **Registry**: A **Sparse Merkle Tree (SMT)** that tracks authorized spending keys and identity attestations, indexed by `aliasHash`.
- **Shielded Pool**: An append-only Merkle tree (UTXO model) for note commitments, ensuring maximum privacy for transfers.
- **Self-Sponsoring Paymaster**: An integrated ERC-4337 Paymaster role allowing the protocol to "bootstrap" brand-new EOAs with gas and funds directly from the shielded pool.
- **Local-First Web App**: A stateless PWA that performs all ZK-proof generation and key derivation locally using WebAuthn and client-side SNARKs, ensuring no sensitive data ever touches a server.

## Current Goals

### 1. Sparse Merkle Tree (SMT) Registry
Transition the Registry to an SMT to enable strict identity binding.
- **Identity Binding**: Fixed `aliasHash` indexing ensures the registry root always reflects the *latest* authorized keys.
- **ZK Ownership Proofs**: Enable proof of ownership for specific aliases, supporting EOA-less transfers and account recovery.

### 2. Stealth Manifestation & Bootstrapping
Halias functions as a **Personal Stealth Network**, allowing users to manifest untraceable on-chain presence.
- **Unlinked EOA Bootstrapping**: Utilizing EIP-7702 and Paymasters to fund brand-new, 0-ETH Externally Owned Accounts (EOAs) directly from the shielded pool, breaking all public on-chain links.
- **Hardware-Enclave Onboarding**: Seedless wallet creation using the device's Secure Enclave (WebAuthn/Passkeys), ensuring keys are biometric-locked and unextractable.
- **Shielded Registration**: Support for "Waiver Notes" that allow new users to register aliases without an existing ETH balance, enabling 100% isolated identity creation.

### 3. Halias Attestation Toolkit (HAT)
A library of standardized ZK-circuits for common identity and compliance statements:
- **Proof of Humanity**: Integrated attestations for Worldcoin, Gitcoin Passport, etc.
- **Social Binding**: DNS/OAuth-based proofs linking `hls` names to real-world identities.
- **Private Compliance**: Non-membership proofs against community-governed blacklists (PPOI).
- **Financial Status**: Private proofs of on-chain activity (e.g., "Maintains > 1 ETH balance" without revealing exact balance).

### 4. Extensibility & Composability
- **Standardized Public Signals**: Ensuring all verifier versions output consistent identity anchors for 3rd-party contract consumption.
- **Plug-and-Play Verifiers**: Allowing the protocol to support new asset types (NFTs, RWA) and complex identity requirements over time.

## Development

### Open Source & Governance
Halias is committed to being a transparent, community-driven public good. 
- **License**: Core circuits and contracts are GPL-3.0; SDKs and tooling are MIT.
- **Reproducible Builds**: All ZK artifacts (WASM/ZKEY) are deterministically generated from the source code.
- **Modular Contribution**: The Halias Attestation Toolkit (HAT) is open for community-designed schemas and verifiers.

### Build
```bash
npx hardhat compile
```

### Test
```bash
npx hardhat test
```

### ZK Setup
See [src/README.md](src/README.md) for details on running the ceremony and exporting verifiers.
