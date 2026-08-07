// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "poseidon-solidity/PoseidonT3.sol";
import "poseidon-solidity/PoseidonT4.sol";
import "./Constants.sol";

// ---------------------------------------------------------------------------
// SMTRegistry — abstract Sparse Merkle Tree registry base
//
// 32-level SMT. Position = the slot assigned at registration. Value = RegistryLeaf hash.
// Supports in-place updates (key rotation, alias transfer) so the root always
// reflects the *latest* keys — unlike an append-only Merkle tree.
//
// Leaf hash:     SMTHash1(aliasKey, value) = Poseidon(aliasKey, value, 1)  [PoseidonT4]
// Internal node: SMTHash2(L, R)            = Poseidon(L, R)               [PoseidonT3]
// Empty subtree: zeros[i], pre-computed from zeros[0] = 0
// ---------------------------------------------------------------------------
// Registry roots expire, unlike pool roots. The window bounds how stale a sender's view
// of a recipient's keys may be: once someone rotates keys, a sender proving against an
// old root would still pay the superseded (possibly compromised) key.
//
// The previous ring buffer expired by COUNT of registry updates, which made the real
// window depend on registry traffic — minutes on a busy registry, years on a quiet one.
// Recording the block a root was created gives a window in time, which is what the
// freshness property actually needs, and makes the lookup O(1) instead of a 300-slot
// scan that cost 726k gas to miss.
abstract contract SMTRegistry {
    // Slots are assigned in registration order, so depth is a capacity bound rather than
    // a birthday bound: 32 levels holds 4.29e9 aliases and two can never contend for one
    // position. Deriving the position from aliasHash instead needed 64 levels purely to
    // make collisions expensive to grind, and cost twice the hashing to get there.
    uint32 public constant REGISTRY_LEVELS = 32;

    // ~1 day at 12s blocks. A sender must refresh their registry view at least this
    // often; a rotated key stops receiving after at most this long.
    uint256 public constant REGISTRY_ROOT_MAX_AGE = 7200;

    bytes32 internal smtRoot;   // read via getRegistryRoot()
    // root => block it became current. 0 means never seen.
    mapping(bytes32 => uint256) public registryRootBlock;

    // alias => its slot, stored offset by one so that zero reads as "not yet assigned".
    // uint32 is deliberate: the counter cannot exceed the tree without overflowing first,
    // so capacity is enforced by the type rather than by a check that can be forgotten.
    mapping(bytes32 => uint32) public aliasSlot;
    uint32 public nextAliasSlot;

    // _smtNodes[level][nodePath] = node hash (0 = empty/unset, use _smtZeros[level])
    mapping(uint256 => mapping(uint256 => bytes32)) private _smtNodes;
    bytes32[33] private _smtZeros;

    function _initSMT() internal {
        bytes32 z = bytes32(0);
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            _smtZeros[i] = z;
            z = bytes32(PoseidonT3.hash([uint256(z), uint256(z)]));
        }
        _smtZeros[REGISTRY_LEVELS] = z;
        smtRoot = z;
        registryRootBlock[z] = block.number;
    }

    // Leaf hash: Poseidon(aliasKey, value, 1) — circomlib SMTHash1.
    // Internal node hash: Poseidon(left, right) — circomlib SMTHash2.
    //
    // Identity and position are separate. The leaf commits to aliasKey, so the circuit
    // still proves "this alias holds these keys"; the path follows the slot assigned on
    // first registration, which is what makes collisions impossible rather than merely
    // expensive. A rotation reuses the alias's existing slot and updates in place.
    function _smtUpdate(bytes32 aliasHash, bytes32 value) internal {
        uint256 key = uint256(aliasHash) % FIELD_PRIME;

        uint32 slot = aliasSlot[aliasHash];
        if (slot == 0) {
            slot = ++nextAliasSlot;   // uint32: reverts before the tree can overflow
            aliasSlot[aliasHash] = slot;
        }
        uint256 pathKey = slot - 1;

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
        // Only record the first sighting: re-recording would silently extend the
        // freshness window of a root that reappears after a rotate-and-revert.
        if (registryRootBlock[current] == 0) registryRootBlock[current] = block.number;
    }

    function isKnownRegistryRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        // The current root is always acceptable, however long the registry has been
        // idle — it is not stale, it is simply unchanged.
        if (root == smtRoot) return true;
        uint256 seen = registryRootBlock[root];
        if (seen == 0) return false;
        return block.number - seen <= REGISTRY_ROOT_MAX_AGE;
    }

    // Siblings for a given slot (for off-chain proof construction). Takes the slot, not
    // the alias — resolve it with aliasSlot(aliasHash) - 1.
    function getSmtSiblings(uint256 pathKey) external view returns (bytes32[32] memory siblings) {
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            uint256 siblingPath = (pathKey >> i) ^ 1;
            bytes32 s = _smtNodes[i][siblingPath];
            siblings[i] = s == bytes32(0) ? _smtZeros[i] : s;
        }
    }

    function getRegistryRoot() external view returns (bytes32) {
        return smtRoot;
    }
}
