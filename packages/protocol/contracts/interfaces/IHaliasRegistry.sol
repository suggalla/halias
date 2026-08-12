// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The only thing the pool needs from the registry. Kept minimal deliberately: the pool
// holds every note in the system and must never gain a reason to call anything that
// mutates registry state, so this interface exposes reads alone.
interface IHaliasRegistry {
    // Every non-zero output in a transact proof carries a registry membership proof, so
    // the pool has to confirm the root that was proven against is one the registry has
    // actually published. Accepts recent historical roots, not just the current one.
    function isKnownRegistryRoot(bytes32 root) external view returns (bool);
    /// The registry insertion armed for this transaction, or zero on every ordinary path.
    function pendingLeaf() external view returns (bytes32);

    function getRegistryRoot() external view returns (bytes32);
}
