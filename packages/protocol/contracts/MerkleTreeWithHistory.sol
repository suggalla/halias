// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "poseidon-solidity/PoseidonT3.sol";

error TreeSpaceExhausted();
error ZeroCommitment();

// A sequence of shallow trees, not one deep one.
//
// The insert is the dominant cost of every transaction and it is fixed, not worst case:
// _insertPair hashes exactly once per level with no early exit, so a walk is exactly LEVELS
// Poseidon hashes at ~58,430 gas each. On a single 32-level tree that was ~1.87M gas, about
// 74% of a transact.
//
// Shortening the tree is the only lever with real leverage, and on a single tree it would buy
// that saving with a proportionally smaller ceiling. Rolling over instead keeps the ceiling
// where it was: commitments are addressed by (treeNumber, leafIndex), the walk is 16 hashes
// rather than 32, and total capacity is unchanged at 2^32 leaves — because the nullifier's
// global index is 32 bits either way, however those bits are split between tree and leaf.
// Railgun does the same.
//
// So this buys gas, not capacity. Worth being precise about: "unbounded" is wrong, and
// believing it would invite a depth choice that quietly shrinks MAX_TREES.
//
// What it costs is real and worth stating: trees fill in order, so the tree number is a coarse
// timestamp bucket, and the root is public — a spend therefore reveals roughly when the note
// was created. On a single tree the leaf index is private and nothing about creation time
// leaks. That cuts against timing correlation, which is the dominant deanonymisation vector
// here, and it is the price of this design.
//
// Root history is a set, not a ring buffer. Tornado used a fixed-size ring so each new root
// overwrote an already-nonzero slot (~5k gas) instead of writing a fresh one (~22.1k), and
// scanned it linearly on read. That is a good trade at their ROOT_HISTORY_SIZE of 30, where a
// miss costs ~63k; it stops being one at 500, where the O(n) scan makes a miss cost 1.19M —
// and a miss is simply what happens when a client's view is a block behind.
//
// Pool roots are never evicted. A stale proof is harmless: nullifiers, not root freshness,
// prevent a double spend. Old trees are frozen the moment they roll over, so a proof against
// one stays valid forever.
contract MerkleTreeWithHistory {
    // 16 levels = 65,536 notes = 32,768 transactions per tree. This splits the 32-bit global
    // index between tree and leaf, so it trades gas against how finely the tree number buckets
    // creation time — deeper trees mean fewer, coarser buckets. Total capacity is fixed at
    // 2^32 leaves regardless of where the split falls.
    uint32 public constant LEVELS = 16;

    /// @notice How many trees the circuit can address, from its 32-bit global index.
    /// @dev    Must equal 2^(32 - LEVELS) — see the check in {_insertPair}. Deriving it here
    ///         rather than hard-coding keeps it tied to LEVELS, so changing the depth cannot
    ///         leave the two disagreeing.
    uint32 public constant MAX_TREES = uint32(1) << (32 - LEVELS);

    // Internal scaffolding, not part of the interface: nothing outside the tree reads these,
    // and a public getter is one more thing an auditor has to rule out as a surface.
    // getLastRoot(), isKnownPoolRoot() and poolRootTree() are the read API.
    //
    // filledSubtrees is deliberately NOT keyed by tree number, and is never reset.
    //
    // The obvious design gives each tree its own slots, which costs ~16 zero → non-zero
    // SSTOREs (~354,000 gas) on whichever transaction happens to open a new tree — a lottery
    // that would run every 32,768 transactions. It is unnecessary. filledSubtrees[i] is only
    // ever *read* on the odd branch below, and the odd branch at level i is always preceded
    // by an even branch at level i within the same tree; a tree starting at index 0 takes the
    // even branch at every level on its first insert, writing before anything reads. Stale
    // values from the previous tree are therefore never read, only overwritten.
    //
    // This holds only because a tree fills sequentially from zero. Anything that breaks that —
    // a resumable tree, an out-of-order insert, a tree starting part-full — silently reads the
    // previous tree's values and produces a root nobody can prove against.
    mapping(uint256 => bytes32) private filledSubtrees;
    mapping(uint256 => bytes32) private poolZeros;

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
        bytes32 currentZero = bytes32(0);
        for (uint32 i = 0; i < LEVELS; i++) {
            poolZeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        lastRoot = currentZero;
        // Tree 0's empty root. Every tree's empty root is this same value, which is why
        // roots are only published after an insert — see _commitPoolRoot.
        knownPoolRootTree[currentZero] = 1;
    }

    // Inserts both of a transact's outputs in one walk up the current tree.
    //
    // Inserting them one at a time costs LEVELS hashes each. But a transact always adds
    // exactly two leaves, so leafIndex is always even and the pair always occupies an aligned
    // (even, odd) slot — which means their common parent can be computed directly and the walk
    // starts at level 1. That is LEVELS + 1 hashes instead of 2 * LEVELS.
    //
    // Equivalence, briefly. Sequentially, inserting A at 2k writes filledSubtrees[0] = A and
    // carries H(A, zeros[0]) upward; inserting B at 2k+1 then reads that back and carries
    // H(A, B) upward from level 1 with the same currentIndex = k. Every level above 0
    // therefore sees exactly what it sees here, and the level-0 slot only ever existed to hold
    // A until B arrived. RootHistory pins this against the old behaviour.
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
                currentHash = _hashLeftRight(currentHash, poolZeros[i]);
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
            // 2^(32 - LEVELS). A uint32 counter would happily pass that, and every note
            // inserted beyond it would be permanently unprovable: the tree exists on chain,
            // the note is in it, and no witness can ever satisfy the circuit. Silent and
            // irreversible, exactly like the collision the global index exists to prevent.
            //
            // Total capacity is therefore 2^32 leaves — the same as the single 32-level tree
            // this replaced, because globalIndex is 32 bits either way. Multi-tree buys gas,
            // not capacity.
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
    /// @dev How many leaves fill a tree before it rolls over. Virtual for one reason: reaching
    ///      a rollover naturally takes 32,768 transactions, so the boundary — where stale
    ///      `filledSubtrees` from the previous tree must be overwritten before being read, and
    ///      where nullifiers must stop colliding across trees — is otherwise untestable.
    ///
    ///      Only the threshold moves. Depth, hashing and root derivation stay exactly as in
    ///      production, so a harness that lowers this exercises the real insertion path rather
    ///      than a reimplementation of it. LEVELS itself is deliberately NOT configurable: it
    ///      must agree with the compiled circuit, and a constructor argument would turn that
    ///      into a deployment mistake waiting to happen.
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
