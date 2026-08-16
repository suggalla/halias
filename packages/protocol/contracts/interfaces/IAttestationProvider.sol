// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Attestation provider interface for alias dataHash attestations.
//
// Each implementation handles one attestation type (e.g. Google OAuth ZK proof,
// KYC, Semaphore group membership, EAS attestation). An alias can register any
// number of providers; Halias aggregates all active commitments into dataHash
// automatically.
//
// Implementors are responsible for:
//   - Verifying the proof is valid for the given alias
//   - Tracking and rejecting reused nullifiers (prevents one identity → many aliases)
//   - Returning a deterministic commitment that encodes the attested fact
//
// dataHash = keccak256(sorted provider/commitment pairs) % FIELD_PRIME
// This means each provider's commitment is independently ZK-provable via the SMT.
interface IAttestationProvider {
    /// @notice Issue an attestation commitment for an alias.
    /// @dev    May write state (nullifiers). Reverts if proof is invalid or nullifier reused.
    /// @param  aliasHash   The alias being attested.
    /// @param  proof       Provider-defined proof bytes (ZK proof, EAS UID, signature, etc.)
    /// @return commitment  Deterministic bytes32 encoding the attested fact.
    function attest(bytes32 aliasHash, bytes calldata proof) external returns (bytes32 commitment);
}
