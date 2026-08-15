// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
pragma solidity 0.8.28;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { TreeZeros } from "./base/TreeZeros.sol";

error TreeSpaceExhausted();
error ZeroCommitment();

// A sequence of shallow trees, addressed by (treeNumber, leafIndex).
//
// Depth buys gas, not capacity: an insert costs exactly LEVELS Poseidon hashes whatever the
// split, and capacity comes from the tree counter, which is 32 bits of its own. It costs
// privacy — trees fill in order, so the tree number is a coarse creation timestamp, where a
// single tree leaks nothing.
//
// Roots are never evicted. A stale proof is harmless because nullifiers prevent double
// spends, and a rolled-over tree is frozen, so proofs against it stay valid forever.
contract MerkleTreeWithHistory {
    // 65,536 notes = 32,768 transactions per tree. Deeper costs more gas per insert and
    // buckets creation time more coarsely.
    uint32 public constant LEVELS = 16;

    /// @notice How many trees the circuit can address: 2^32, the width NoteNullifier
    ///         range-checks `treeNumber` to. Total capacity is that times 2^LEVELS — 2^48
    ///         leaves at LEVELS = 16.
    /// @dev    A uint32 counter cannot reach 2^32, so the guard in {_insertPair} is on the
    ///         counter's own maximum rather than on this. Stated as a uint64 so the number is
    ///         readable rather than expressed as an overflow.
    uint64 public constant MAX_TREES = uint64(1) << 32;

    // Shared across trees, never reset. Per-tree slots would cost ~16 zero -> non-zero
    // SSTOREs (~354k gas) on whichever transaction opens a tree. Sharing is safe only because
    // a tree fills sequentially from zero: level i is read on the odd branch, which is always
    // preceded by the even branch that writes it. A resumable or part-full tree would read
    // the previous tree's values and produce a root nobody can prove against.
    bytes32[LEVELS] private filledSubtrees;

    // root => treeNumber + 1, offset so zero reads as unknown. The tree number is a public
    // signal and the nullifier keys on it, so a root that did not name its own tree would let
    // one note be re-spent under a different number for a fresh nullifier each time.
    mapping(bytes32 => uint32) private knownPoolRootTree;

    bytes32 internal lastRoot;
    /// @dev Which tree is filling, and the next free position within it. Internal, and read
    ///      from outside only through {position} — together. A leaf index means nothing
    ///      without its tree, and a tree number means nothing without a root, so neither is
    ///      exposed alone. See {currentAnchor}.
    uint32 internal treeNumber;
    uint32 internal leafIndex;

    constructor() {
        // filledSubtrees is deliberately left unset. Its initial value is unobservable: the
        // invariant above is that no level is read before it is written, and a tree starting
        // at index 0 takes the even branch at every level on its first insert. That was true
        // when the array was seeded with the empty-subtree hashes and it is true now, so the
        // 16 SSTOREs that seeded it bought nothing.
        lastRoot = TreeZeros.zeros(LEVELS);
        // Tree 0's empty root. Every tree's empty root is this same value, which is why
        // roots are only published after an insert — see _commitPoolRoot.
        knownPoolRootTree[lastRoot] = 1;
    }

    // Both outputs in one walk. A transact always adds two leaves, so leafIndex is even and
    // the pair is an aligned (even, odd) slot — their parent is computable directly and the
    // walk starts at level 1, costing LEVELS + 1 hashes rather than 2 * LEVELS. Equivalent to
    // two sequential inserts, which RootHistory pins.
    //
    // Does NOT publish the root; callers follow with _commitPoolRoot(), since the root is
    // only meaningful once both leaves are in.
    function _insertPair(bytes32 left, bytes32 right)
        internal returns (uint32 tree, uint32 indexLeft, uint32 indexRight)
    {
        if (left == bytes32(0) || right == bytes32(0)) revert ZeroCommitment();

        bytes32 currentHash  = _hashLeftRight(left, right);
        uint32  currentIndex = leafIndex >> 1;

        for (uint32 i = 1; i < LEVELS; i++) {
            if (currentIndex % 2 == 0) {
                filledSubtrees[i] = currentHash;
                currentHash = _hashLeftRight(currentHash, TreeZeros.zeros(i));
            } else {
                currentHash = _hashLeftRight(filledSubtrees[i], currentHash);
            }
            currentIndex /= 2;
        }

        lastRoot   = currentHash;
        tree       = treeNumber;
        indexLeft  = leafIndex;
        indexRight = leafIndex + 1;

        // Roll over. A pair can never straddle a boundary: leafIndex is always even and
        // 2^LEVELS is even, so the last pair of a tree fills it exactly.
        unchecked { leafIndex += 2; }
        if (leafIndex >= _treeCapacity()) {
            // The two bounds now coincide: NoteNullifier range-checks treeNumber to 32 bits
            // and the counter is a uint32, so the last addressable tree is the counter's own
            // maximum. Checked rather than left to overflow, because a note past the circuit's
            // bound would sit on chain permanently unprovable — silent and irreversible.
            if (treeNumber == _maxTreeNumber()) revert TreeSpaceExhausted();
            treeNumber += 1;
            leafIndex = 0;
        }
    }

    /// @dev First writer wins, load-bearing rather than an optimisation: overwriting would
    ///      let a later tree steal an earlier root's mapping, permanently freezing every note
    ///      proving against it. Called only after an insert, so a tree's empty root is never
    ///      published under a new number.
    /// @dev Virtual only so tests can reach a rollover, which naturally takes 32,768
    ///      transactions. Only the threshold moves — depth, hashing and root derivation stay
    ///      as in production. LEVELS is deliberately NOT configurable: it must agree with the
    ///      compiled circuit, and a constructor argument would make that a deploy-time
    ///      mistake waiting to happen.
    function _treeCapacity() internal view virtual returns (uint32) {
        return uint32(1) << LEVELS;
    }

    /// @dev The last addressable tree. Virtual for the same reason as {_treeCapacity} and
    ///      with the same limits: only the ceiling moves, and reaching the real one naturally
    ///      takes 2^32 rollovers — so without this the revert below it is unreachable, and an
    ///      unreachable revert is an untested one. It guards the case where a note would land
    ///      past the circuit's 32-bit treeNumber bound and sit on chain permanently
    ///      unprovable, which is exactly the failure worth having a test for.
    function _maxTreeNumber() internal view virtual returns (uint32) {
        return type(uint32).max;
    }

    function _commitPoolRoot(uint32 tree) internal {
        if (knownPoolRootTree[lastRoot] == 0) knownPoolRootTree[lastRoot] = tree + 1;
    }

    function _hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        uint256 result = PoseidonT3.hash([uint256(left), uint256(right)]);
        return bytes32(result);
    }

    /// @notice Whether a root was ever published, and which tree it belongs to.
    /// @dev    Both halves in one answer. A caller checking only membership would still have
    ///         to name a tree when it proves, and naming the wrong one is rejected with
    ///         `PoolRootWrongTree` — so the tree comes back whether or not it was asked for.
    function poolRootTree(bytes32 root) public view returns (bool known, uint32 tree) {
        uint32 v = knownPoolRootTree[root];
        return v == 0 ? (false, 0) : (true, v - 1);
    }

    /// @notice The root to prove against, together with the tree it belongs to.
    /// @dev    The only way to read the current root, deliberately. Pairing a bare
    ///         `getLastRoot()` with a bare `treeNumber()` is a trap: after a rollover the
    ///         first is the tree that just filled and the second is the new empty one, and
    ///         {HaliasPool-transact} rejects that combination. Nothing can be proven against
    ///         an empty tree, so the pair a caller wants is always the last one that received
    ///         leaves — which is what this returns, as one value.
    function currentAnchor() external view returns (bytes32 root, uint32 tree) {
        root = lastRoot;
        tree = knownPoolRootTree[lastRoot] - 1;
    }

    /// @notice How full the pool is: the tree currently filling and the next free leaf in it.
    /// @dev    Not an anchor — `leafIndex` names a position no proof refers to. For proving,
    ///         use {currentAnchor}.
    function position() external view returns (uint32 tree, uint32 leaf) {
        return (treeNumber, leafIndex);
    }
}
