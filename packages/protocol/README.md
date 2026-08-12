# Halias Protocol

Halias is a privacy-preserving identity and asset protocol on Ethereum. It combines ERC-721 aliases (names) with a shielded pool to enable private transfers and withdrawals.

## Architecture

Three contracts, deployed wired together in one transaction by `HaliasDeployer`. The split
exists so the contract holding every user's funds has no admin key anywhere near it.

```
HaliasDomain ──writes──> HaliasRegistry <──reads── HaliasPool
     │                                                  ▲
     └───────────────── calls transact ─────────────────┘
```

- **HaliasPool**: custody, note commitments, nullifiers, and `transact`. **One mutating
  function, no admin, no owner, no upgrade path** — once deployed there is no key that can
  pause, drain, redirect or rescue, including for the deployer.
- **HaliasRegistry**: a **Sparse Merkle Tree** of alias keys and the roots the pool proves
  against. Supports in-place key rotation, so a sender holding a proof against an alias's
  position stays valid across rotations. One immutable writer, no admin.
- **HaliasDomain**: names, ERC-721 ownership, the registration fee, and the admin key. Holds
  no user funds — its entire balance is registration revenue.
- **Invite Claims**: `HaliasDomain.claim` registers an alias and pays the fee straight out of
  a funded pool note, so a new user needs no ETH of their own. The registration is bound into
  the proof, so a relayer that submits a claim cannot mint the alias to itself.
- **Relayer Fee**: a first-class field bound inside the proof, reimbursing whoever broadcasts
  a transaction and letting a user with no ETH pay for inclusion out of their own shielded
  funds. No paymaster, sponsor or deposit, and no dependency on any account-abstraction
  standard.
- **Local-First Web App**: A stateless PWA that derives keys and generates ZK proofs entirely in the browser, so no sensitive data reaches a server.

## Status

Implemented: the three-contract split with atomic deployment, the SMT registry with in-place
key rotation, ETH and ERC-20 shielded transfers, invite claims, and the relayer fee. The
`transact` circuit is frozen — none of the split touched it, so no new ceremony is required.

143 protocol tests and 44 SDK tests, including real Groth16 proofs end to end against the
split. Reviewed internally and against audited comparable systems: four findings, all fixed.
See [contract-split.md](docs/contract-split.md),
[security-audit.md](docs/security-audit.md) and
[prior-art-review.md](docs/prior-art-review.md).

`Halias.sol`, the pre-split monolith, is still present and is what the current Sepolia
deployment runs. `scripts/deploy.ts` still targets it and is the last thing blocking its
removal.

Not yet done, and both gate mainnet: the trusted setup is currently a single self-generated
ceremony with a `--dev` phase 2, which must be replaced by a multi-party ceremony over a
public Powers of Tau file; and the contracts have not had an external audit.

## Roadmap

### 1. Stealth Manifestation & Bootstrapping
Halias functions as a **Personal Stealth Network**, allowing users to manifest untraceable on-chain presence.
- **Unlinked EOA Bootstrapping**: Fund brand-new, 0-ETH accounts directly from the shielded pool, breaking public on-chain links. The relayer fee already provides the trustless half of this; the remainder is client work.
- **Hardware-Enclave Onboarding**: Seedless wallet creation using the device's Secure Enclave (WebAuthn/Passkeys), so keys are biometric-locked and unextractable. Today keys derive from an EIP-191 `personal_sign`, which works with any EVM wallet.

### 2. Halias Attestation Toolkit (HAT)
A library of standardized ZK-circuits for common identity and compliance statements:
- **Proof of Humanity**: Integrated attestations for Worldcoin, Gitcoin Passport, etc.
- **Social Binding**: DNS/OAuth-based proofs linking `hls` names to real-world identities.
- **Private Compliance**: Non-membership proofs against community-governed blacklists (PPOI).
- **Financial Status**: Private proofs of on-chain activity (e.g., "Maintains > 1 ETH balance" without revealing exact balance).

### 3. Extensibility & Composability
- **Standardized Public Signals**: Ensuring all verifier versions output consistent identity anchors for 3rd-party contract consumption.
- **Plug-and-Play Verifiers**: Allowing the protocol to support new asset types (NFTs, RWA) and complex identity requirements over time.

## Development

### Open Source & Governance
Halias is committed to being a transparent, community-driven public good. 
- **License**: Core circuits and contracts are GPL-3.0; SDKs and tooling are MIT.
- **Reproducible Builds**: All ZK artifacts (WASM/ZKEY) are deterministically generated from the source code.
- **Public Ceremony**: The production proving key will come from a multi-party ceremony with published transcripts, so no single party can forge proofs.
- **Modular Contribution**: The Halias Attestation Toolkit (HAT) is open for community-designed schemas and verifiers.

### Documents

- [docs/contract-split.md](docs/contract-split.md) — the three-contract design, the
  deployment dependency cycle and how it is broken, phasing, and next steps.
- [docs/security-audit.md](docs/security-audit.md) — standalone and differential review
  against the monolith. Four findings, all fixed.
- [docs/prior-art-review.md](docs/prior-art-review.md) — checked against Semaphore and
  World ID. Both real bugs in the latest review came from there, not from re-reading our
  own contracts.
- [docs/test-plan.md](docs/test-plan.md) — coverage by layer, the one gap that matters
  (SDK ↔ contracts), and the conventions the suites follow.
- [docs/legal-considerations.md](docs/legal-considerations.md) — Tornado Cash and Railgun
  precedent, where Halias differs, and questions for counsel.

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
