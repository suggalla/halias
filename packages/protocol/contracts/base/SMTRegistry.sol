// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "poseidon-solidity/PoseidonT3.sol";
import "poseidon-solidity/PoseidonT4.sol";
import "./Constants.sol";

// ---------------------------------------------------------------------------
// SMTRegistry — abstract Sparse Merkle Tree registry base
//
// 64-level SMT. Key = aliasHash % FIELD_PRIME. Value = RegistryLeaf hash.
// Supports in-place updates (key rotation, alias transfer) so the root always
// reflects the *latest* keys — unlike an append-only Merkle tree.
//
// Leaf hash:     SMTHash1(key, value) = Poseidon(key, value, 1)  [PoseidonT4]
// Internal node: SMTHash2(L, R)       = Poseidon(L, R)           [PoseidonT3]
// Empty subtree: zeros[i], pre-computed from zeros[0] = 0
//
// Birthday collision at 64 levels: P ≈ n²/2^65 — negligible at any realistic scale.
// ---------------------------------------------------------------------------
abstract contract SMTRegistry {
    uint32 public constant REGISTRY_LEVELS = 64;
    uint32  public constant REGISTRY_HISTORY_SIZE = 300;

    error SMTCollision();

    bytes32 public smtRoot;
    mapping(uint256 => bytes32) public smtRoots;
    mapping(uint256 => bytes32) public smtKeyToAliasHash;
    uint32 public currentSmtRootIndex = 0;

    // _smtNodes[level][nodePath] = node hash (0 = empty/unset, use _smtZeros[level])
    mapping(uint256 => mapping(uint256 => bytes32)) private _smtNodes;
    bytes32[65] private _smtZeros;

    function _initSMT() internal {
        bytes32 z = bytes32(0);
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            _smtZeros[i] = z;
            z = bytes32(PoseidonT3.hash([uint256(z), uint256(z)]));
        }
        _smtZeros[REGISTRY_LEVELS] = z;
        smtRoot = z;
        smtRoots[0] = z;
    }

    // Leaf hash: Poseidon(key, value, 1) — circomlib SMTHash1.
    // Internal node hash: Poseidon(left, right) — circomlib SMTHash2.
    // key = uint256(aliasHash) % FIELD_PRIME.
    function _smtUpdate(bytes32 aliasHash, bytes32 value) internal {
        uint256 key = uint256(aliasHash) % FIELD_PRIME;

        // Prevent collisions in the fixed-depth tree (32-bit key space).
        uint256 smtKey = key & ((1 << REGISTRY_LEVELS) - 1);
        if (smtKeyToAliasHash[smtKey] != bytes32(0) && smtKeyToAliasHash[smtKey] != aliasHash) {
            revert SMTCollision();
        }
        smtKeyToAliasHash[smtKey] = aliasHash;

        // Use lower REGISTRY_LEVELS bits for tree navigation (matches circuit pathIndices).
        // Full key stays in the leaf hash, binding the specific alias identity.
        uint256 pathKey = smtKey;
        bytes32 current = bytes32(PoseidonT4.hash([key, uint256(value), 1]));
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            uint256 nodePath    = pathKey >> i;
            uint256 siblingPath = nodePath ^ 1;
            bool    isRight     = (nodePath & 1) == 1;
            bytes32 sibling     = _smtNodes[i][siblingPath];
            if (sibling == bytes32(0)) sibling = _smtZeros[i];
            _smtNodes[i][nodePath] = current;
            if (isRight) {
                current = bytes32(PoseidonT3.hash([uint256(sibling), uint256(current)]));
            } else {
                current = bytes32(PoseidonT3.hash([uint256(current), uint256(sibling)]));
            }
        }
        smtRoot = current;
        currentSmtRootIndex = (currentSmtRootIndex + 1) % REGISTRY_HISTORY_SIZE;
        smtRoots[currentSmtRootIndex] = current;
    }

    function isKnownRegistryRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        uint32 i = currentSmtRootIndex;
        do {
            if (smtRoots[i] == root) return true;
            if (i == 0) i = REGISTRY_HISTORY_SIZE;
            i--;
        } while (i != currentSmtRootIndex);
        return false;
    }

    // Returns all 32 SMT siblings for a given key (for off-chain proof construction).
    function getSmtSiblings(uint256 key) external view returns (bytes32[64] memory siblings) {
        uint256 pathKey = key & ((1 << REGISTRY_LEVELS) - 1);
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            uint256 siblingPath = (pathKey >> i) ^ 1;
            bytes32 s = _smtNodes[i][siblingPath];
            siblings[i] = s == bytes32(0) ? _smtZeros[i] : s;
        }
    }

    // Alias for getSmtSiblings — returns the current SMT root.
    function getRegistryRoot() external view returns (bytes32) {
        return smtRoot;
    }
}
