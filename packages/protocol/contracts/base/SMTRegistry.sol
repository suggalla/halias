// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";
import { FIELD_PRIME } from "./Constants.sol";
import { TreeZeros } from "./TreeZeros.sol";

error RegistryFull();

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
// Recording the moment a root was superseded expresses that window in time, which is what
// the freshness property needs, and makes the lookup O(1).
abstract contract SMTRegistry {
    // Slots are assigned in registration order, so depth is a capacity bound rather than
    // a birthday bound: 32 levels holds 4.29e9 aliases and two can never contend for one
    // position. Deriving the position from aliasHash instead needed 64 levels purely to
    // make collisions expensive to grind, and cost twice the hashing to get there.
    // A full registry would stop new signups and nothing else: the guard below sits inside
    // the "no slot yet" branch, so existing aliases keep receiving, spending, re-keying and
    // changing hands on the slot they already hold. At 32 levels it is unreachable anyway.
    uint32 public constant REGISTRY_LEVELS = 32;

    // How long a superseded root stays acceptable, and so how long replaced keys keep
    // receiving after a handover.
    //
    // Seconds, not blocks: a block count means a day on mainnet and four hours on a
    // two-second L2, so the guarantee would change meaning with the deployment target.
    //
    // An hour, matching World ID. Its only job is to cover reading a root and being included,
    // and proving takes seconds to minutes; anything beyond that is exposure bought for
    // nothing. It also bounds prepared relay blobs, which are rejected once older and must be
    // rebuilt — a retry, not a loss.
    uint256 public constant REGISTRY_ROOT_MAX_AGE = 1 hours;

    bytes32 internal smtRoot;   // read via getRegistryRoot()
    // root => the timestamp it stopped being current. 0 means never seen.
    mapping(bytes32 => uint256) public registryRootSeenAt;

    // alias => its slot, stored offset by one so that zero reads as "not yet assigned".
    // uint32 is deliberate: the counter cannot exceed the tree without overflowing first,
    // so capacity is enforced by the type rather than by a check that can be forgotten.
    mapping(bytes32 => uint32) public aliasSlot;
    uint32 public nextAliasSlot;

    // _smtNodes[level][nodePath], 0 meaning empty — use TreeZeros.zeros(level).
    //
    // An array of mappings, not a mapping of mappings: the level is dense and bounded at
    // compile time, so only nodePath needs hashing. A nested mapping would keccak twice per
    // access, on two reads per level of every registration.
    mapping(uint256 => bytes32)[REGISTRY_LEVELS] private _smtNodes;

    function _initSMT() internal {
        // The empty-subtree hashes are constants — see {TreeZeros}. They were a storage array
        // seeded here, which cost 33 SSTOREs once and a cold SLOAD at nearly every level of
        // every update afterwards: in a sparse tree most siblings are empty, so the fallback
        // below is the common path rather than the rare one.
        smtRoot = TreeZeros.zeros(REGISTRY_LEVELS);
        // Not stamped: the genesis root is accepted as the current root, and is stamped
        // like any other when something supersedes it.
    }

    // Leaf: Poseidon(aliasKey, value, 1) — circomlib SMTHash1. Node: Poseidon(left, right).
    //
    // Identity and position are separate: the leaf commits to aliasKey while the path follows
    // the slot assigned at first registration, which makes collisions impossible rather than
    // merely expensive. A rotation reuses the alias's slot and updates in place.
    function _smtUpdate(bytes32 aliasHash, bytes32 value) internal {
        uint256 key = uint256(aliasHash) % FIELD_PRIME;

        uint32 slot = aliasSlot[aliasHash];
        if (slot == 0) {
            slot = ++nextAliasSlot;
            // Dormant at REGISTRY_LEVELS = 32, where a uint32 slot cannot exceed the tree
            // without overflowing first — the width IS the bound. It is written anyway, and
            // widened to uint256 so the shift cannot overflow, because that equivalence
            // silently stops holding the moment the depth is reduced: a slot past
            // 2^REGISTRY_LEVELS still fits a uint32, and `pathKey >> i` would alias an
            // existing path, corrupting the tree rather than reverting.
            if (uint256(slot) > (uint256(1) << REGISTRY_LEVELS)) revert RegistryFull();
            aliasSlot[aliasHash] = slot;
        }
        uint256 pathKey = slot - 1;

        bytes32 current = bytes32(PoseidonT4.hash([key, uint256(value), 1]));
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            uint256 nodePath    = pathKey >> i;
            uint256 siblingPath = nodePath ^ 1;
            bool    isRight     = (nodePath & 1) == 1;
            bytes32 sibling     = _smtNodes[i][siblingPath];
            if (sibling == bytes32(0)) sibling = TreeZeros.zeros(i);
            _smtNodes[i][nodePath] = current;
            if (isRight) {
                current = bytes32(PoseidonT3.hash([uint256(sibling), uint256(current)]));
            } else {
                current = bytes32(PoseidonT3.hash([uint256(current), uint256(sibling)]));
            }
        }
        // Stamp the OUTGOING root, not the incoming one. Stamping at creation spends the
        // window while the root is still current — which needs no grace, since `root ==
        // smtRoot` is accepted unconditionally — so on a quiet registry a root would be born
        // already expired. World ID's requireValidRoot does the same.
        registryRootSeenAt[smtRoot] = block.timestamp;
        smtRoot = current;
    }

    function isKnownRegistryRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        // The current root is always acceptable, however long the registry has been
        // idle — it is not stale, it is simply unchanged.
        if (root == smtRoot) return true;
        uint256 seen = registryRootSeenAt[root];
        if (seen == 0) return false;
        return block.timestamp - seen <= REGISTRY_ROOT_MAX_AGE;
    }

    // Siblings for a given slot (for off-chain proof construction). Takes the slot, not
    // the alias — resolve it with aliasSlot(aliasHash) - 1.
    function getSmtSiblings(uint32 pathKey) external view returns (bytes32[REGISTRY_LEVELS] memory siblings) {
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            uint256 siblingPath = (uint256(pathKey) >> i) ^ 1;
            bytes32 s = _smtNodes[i][siblingPath];
            siblings[i] = s == bytes32(0) ? TreeZeros.zeros(i) : s;
        }
    }

    function getRegistryRoot() external view returns (bytes32) {
        return smtRoot;
    }
}
