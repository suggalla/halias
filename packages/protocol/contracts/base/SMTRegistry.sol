// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "poseidon-solidity/PoseidonT3.sol";
import "poseidon-solidity/PoseidonT4.sol";
import "./Constants.sol";

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
// The previous ring buffer expired by COUNT of registry updates, which made the real
// window depend on registry traffic — minutes on a busy registry, years on a quiet one.
// Recording the moment a root was superseded gives a window in time, which is what the
// freshness property actually needs, and makes the lookup O(1) instead of a 300-slot
// scan that cost 726k gas to miss.
abstract contract SMTRegistry {
    // Slots are assigned in registration order, so depth is a capacity bound rather than
    // a birthday bound: 32 levels holds 4.29e9 aliases and two can never contend for one
    // position. Deriving the position from aliasHash instead needed 64 levels purely to
    // make collisions expensive to grind, and cost twice the hashing to get there.
    // A full registry would stop new signups and nothing else: the guard below sits inside
    // the "no slot yet" branch, so existing aliases keep receiving, spending, re-keying and
    // changing hands on the slot they already hold. At 32 levels it is unreachable anyway.
    uint32 public constant REGISTRY_LEVELS = 32;

    // How long a superseded root stays acceptable. A sender must refresh their registry
    // view at least this often; keys replaced by a rotation or a handover stop receiving
    // after at most this long.
    //
    // Seconds, not blocks. The property being bounded is time — how long a replaced key
    // remains payable — and a block count only expresses that on one chain: 7200 blocks is
    // a day on mainnet and four hours on a two-second L2, so the guarantee would quietly
    // change meaning with the deployment target. Miner drift of a few seconds is irrelevant
    // at this scale.
    //
    // An hour, matching World ID, rather than the day this used to be. The window's only
    // job is to cover the gap between reading a root and being included — proving takes
    // seconds to minutes even in a browser — and everything it costs is paid on the far
    // side: for that long after a handover, a sender on a superseded root pays the previous
    // owner's keys. Whatever exceeds proving time is exposure bought for nothing. What it
    // does cost is prepared-but-unsubmitted transactions: a relay blob older than this is
    // rejected and has to be rebuilt, which is a retry rather than a loss.
    uint256 public constant REGISTRY_ROOT_MAX_AGE = 1 hours;

    bytes32 internal smtRoot;   // read via getRegistryRoot()
    // root => the timestamp it stopped being current. 0 means never seen.
    mapping(bytes32 => uint256) public registryRootSeenAt;

    // alias => its slot, stored offset by one so that zero reads as "not yet assigned".
    // uint32 is deliberate: the counter cannot exceed the tree without overflowing first,
    // so capacity is enforced by the type rather than by a check that can be forgotten.
    mapping(bytes32 => uint32) public aliasSlot;
    uint32 public nextAliasSlot;

    // _smtNodes[level][nodePath] = node hash (0 = empty/unset, use _smtZeros[level])
    mapping(uint256 => mapping(uint256 => bytes32)) private _smtNodes;
    bytes32[REGISTRY_LEVELS + 1] private _smtZeros;

    function _initSMT() internal {
        bytes32 z = bytes32(0);
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            _smtZeros[i] = z;
            z = bytes32(PoseidonT3.hash([uint256(z), uint256(z)]));
        }
        _smtZeros[REGISTRY_LEVELS] = z;
        smtRoot = z;
        // Not stamped: the genesis root is accepted as the current root, and is stamped
        // like any other when something supersedes it.
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
            if (sibling == bytes32(0)) sibling = _smtZeros[i];
            _smtNodes[i][nodePath] = current;
            if (isRight) {
                current = bytes32(PoseidonT3.hash([uint256(sibling), uint256(current)]));
            } else {
                current = bytes32(PoseidonT3.hash([uint256(current), uint256(sibling)]));
            }
        }
        // Stamp the OUTGOING root with the moment it stopped being current, not the
        // incoming one with the moment it was created.
        //
        // Stamping at creation means the window is consumed while the root is still
        // current — which is free grace nobody needs, since `root == smtRoot` accepts it
        // unconditionally — and leaves nothing for afterwards. On a quiet registry a root
        // current for longer than REGISTRY_ROOT_MAX_AGE is born already expired: a sender
        // who read it, built a proof, and submitted seconds later fails the moment anyone
        // else registers. Proof generation takes seconds to minutes, so that window has to
        // start when the root is superseded. World ID's requireValidRoot does the same.
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
    function getSmtSiblings(uint256 pathKey) external view returns (bytes32[REGISTRY_LEVELS] memory siblings) {
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
