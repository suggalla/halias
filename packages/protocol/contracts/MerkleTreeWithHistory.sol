// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "poseidon-solidity/PoseidonT3.sol";
import "./base/TreeZeros.sol";

error TreeSpaceExhausted();
error ZeroCommitment();

// A sequence of shallow trees, not one deep one.
//
// The insert dominates the cost of every transaction and it is fixed, not worst case:
// _insertPair hashes exactly once per level with no early exit, so a walk is exactly LEVELS
// Poseidon hashes at ~58,430 gas each.
//
// Commitments are addressed by (treeNumber, leafIndex). Total capacity is 2^32 leaves, since
// the nullifier's global index is 32 bits however those bits are split between tree and leaf —
// so depth trades gas against nothing except the split itself. This buys gas, not capacity.
//
// The cost is real: trees fill in order, so the tree number is a coarse timestamp bucket, and
// the root is public — a spend therefore reveals roughly when the note was created. That cuts
// against timing correlation, the dominant deanonymisation vector here, and it is the price of
// this design.
//
// Roots are never evicted, so root history is a set rather than a ring buffer. A stale proof is
// harmless: nullifiers, not root freshness, prevent a double spend, and a tree is frozen the
// moment it rolls over, so a proof against one stays valid forever. A miss would otherwise be
// the ordinary case of a client's view being a block behind.
contract MerkleTreeWithHistory {
    // 16 levels = 65,536 notes = 32,768 transactions per tree. This splits the 32-bit global
    // index between tree and leaf: deeper trees cost more gas per insert but bucket creation
    // time more coarsely. Total capacity is 2^32 leaves wherever the split falls.
    uint32 public constant LEVELS = 16;

    /// @notice How many trees the circuit can address, from its 32-bit global index.
    /// @dev    Must equal 2^(32 - LEVELS) — see the check in {_insertPair}. Deriving it here
    ///         rather than hard-coding keeps it tied to LEVELS, so changing the depth cannot
    ///         leave the two disagreeing.
    uint32 public constant MAX_TREES = uint32(1) << (32 - LEVELS);

    // Internal scaffolding: getLastRoot(), isKnownPoolRoot(), poolRootTree() and
    // currentAnchor() are the read API.
    //
    // filledSubtrees is deliberately NOT keyed by tree number, and is never reset. Per-tree
    // slots would cost ~16 zero → non-zero SSTOREs (~354,000 gas) on whichever transaction
    // opens a new tree, a lottery running every 32,768 transactions. Sharing them is safe
    // because filledSubtrees[i] is only ever *read* on the odd branch below, and the odd
    // branch at level i is always preceded by an even branch at the same level within the
    // same tree — a tree starting at index 0 takes the even branch everywhere on its first
    // insert, writing before anything reads.
    //
    // That holds only because a tree fills sequentially from zero. Anything breaking it — a
    // resumable tree, an out-of-order insert, a tree starting part-full — silently reads the
    // preceding tree's values and produces a root nobody can prove against.
    //
    // A fixed array rather than a mapping: it is dense, indexed only by level, and LEVELS is
    // a compile-time constant, so the index space IS the array and no keccak is needed to
    // reach a slot the compiler can compute directly. The empty-subtree hashes it used to sit
    // beside are constants now — see {TreeZeros}.
    bytes32[LEVELS] private filledSubtrees;

    // root => treeNumber + 1. Zero means unknown, which is why it is offset.
    //
    // Carrying the tree is not bookkeeping: the nullifier keys on a note's global position,
    // so the tree number is a public signal, and without checking it against the tree the
    // root actually belongs to a holder could re-spend one note under a different tree number
    // and mint a fresh nullifier each time. See HaliasPool.transact.
    mapping(bytes32 => uint32) public knownPoolRootTree;

    bytes32 internal lastRoot;
    /// @notice Which tree is currently filling.
    uint32 public treeNumber;
    /// @notice Next free position within that tree.
    uint32 public leafIndex;

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

    // Inserts both of a transact's outputs in one walk up the current tree.
    //
    // A transact always adds exactly two leaves, so leafIndex is always even and the pair
    // occupies an aligned (even, odd) slot. Their common parent is therefore computable
    // directly and the walk starts at level 1 — LEVELS + 1 hashes instead of 2 * LEVELS.
    //
    // This is equivalent to two sequential inserts: A at 2k would write filledSubtrees[0] = A
    // and carry H(A, zeros[0]) upward, then B at 2k+1 would read it back and carry H(A, B)
    // from level 1 with the same currentIndex = k. Every level above 0 sees the same values
    // either way; the level-0 slot only ever held A until B arrived. RootHistory pins it.
    //
    // Does NOT publish the root — callers follow with _commitPoolRoot(). The root is only
    // meaningful once both leaves are in.
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
            // The bound is the CIRCUIT's, not the uint32's, and the two are not the same.
            //
            // The nullifier keys on globalIndex = treeNumber * 2^LEVELS + leafIndex, which
            // NoteNullifier holds to 32 bits — so it range-checks treeNumber to
            // 2^(32 - LEVELS). A uint32 counter passes that happily, and every note inserted
            // beyond it would be permanently unprovable: the tree exists on chain, the note is
            // in it, and no witness can ever satisfy the circuit. Silent and irreversible.
            if (treeNumber + 1 >= MAX_TREES) revert TreeSpaceExhausted();
            treeNumber += 1;
            leafIndex = 0;
        }
    }

    /// @dev First writer wins, and that is load-bearing rather than an optimisation.
    ///      Overwriting would let a later tree steal an earlier root's mapping, after which
    ///      every note proving against that root fails the tree check — funds frozen, not
    ///      stolen, but frozen permanently.
    ///
    ///      Only called after an insert, so a tree's empty root is never published under a new
    ///      number. Nothing can be proven against an empty tree anyway.
    /// @dev How many leaves fill a tree before it rolls over. Virtual so tests can reach a
    ///      rollover, which naturally takes 32,768 transactions — the boundary is where stale
    ///      `filledSubtrees` must be overwritten before being read and where nullifiers must
    ///      stop colliding across trees.
    ///
    ///      Only the threshold moves; depth, hashing and root derivation stay as in
    ///      production, so a harness lowering this exercises the real insertion path. LEVELS
    ///      itself is deliberately NOT configurable: it must agree with the compiled circuit,
    ///      and a constructor argument would make that a deployment mistake waiting to happen.
    function _treeCapacity() internal view virtual returns (uint32) {
        return uint32(1) << LEVELS;
    }

    function _commitPoolRoot(uint32 tree) internal {
        if (knownPoolRootTree[lastRoot] == 0) knownPoolRootTree[lastRoot] = tree + 1;
    }

    function _hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        uint256 result = PoseidonT3.hash([uint256(left), uint256(right)]);
        return bytes32(result);
    }

    function isKnownPoolRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        return knownPoolRootTree[root] != 0;
    }

    /// @notice The tree a published root belongs to. Reverts nothing; returns false if unknown.
    function poolRootTree(bytes32 root) public view returns (bool known, uint32 tree) {
        uint32 v = knownPoolRootTree[root];
        return v == 0 ? (false, 0) : (true, v - 1);
    }

    function getLastRoot() public view returns (bytes32) {
        return lastRoot;
    }

    /// @notice The most recent published root together with the tree it belongs to.
    /// @dev    Use this rather than pairing {getLastRoot} with {treeNumber}, which is a trap:
    ///         after a rollover the former is the tree that just filled while the latter is
    ///         the new empty one, and {HaliasPool-transact} rejects that combination with
    ///         `PoolRootWrongTree`. Nothing can be proven against an empty tree anyway, so the
    ///         pair a caller actually wants is always the last one that received leaves.
    function currentAnchor() external view returns (bytes32 root, uint32 tree) {
        root = lastRoot;
        tree = knownPoolRootTree[lastRoot] - 1;
    }
}
