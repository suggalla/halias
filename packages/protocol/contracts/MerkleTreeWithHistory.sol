// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "poseidon-solidity/PoseidonT3.sol";

error PoolFull();
error ZeroCommitment();

// Root history is a set, not a ring buffer.
//
// Tornado used a fixed-size ring so each new root overwrote an already-nonzero slot
// (~5k gas) instead of writing a fresh one (~22.1k), and scanned it linearly on read.
// That is a good trade at their ROOT_HISTORY_SIZE of 30, where a miss costs ~63k.
// It stops being one at 500: the scan is O(n), so a miss cost 1.19M gas — and a miss is
// simply what happens when a client's view is a block behind. A transact already costs
// ~4.2M gas here, so the extra ~22.1k per write is under 1% of it, while an O(1) lookup
// turns that 1.19M failure into 2.1k.
//
// Pool roots are never evicted. A stale proof is harmless: nullifiers, not root
// freshness, are what prevent a double spend.
contract MerkleTreeWithHistory {
    uint32 public constant LEVELS = 32;

    mapping(uint256 => bytes32) public filledSubtrees;
    mapping(uint256 => bytes32) public poolZeros;
    mapping(bytes32 => bool)    public knownPoolRoots;
    bytes32 public lastRoot;
    uint32  public nextIndex = 0;

    constructor() {
        bytes32 currentZero = bytes32(0);
        for (uint32 i = 0; i < LEVELS; i++) {
            poolZeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        lastRoot = currentZero;
        knownPoolRoots[currentZero] = true;
    }

    // Inserts both of a transact's outputs in one walk up the tree.
    //
    // Inserting them one at a time costs LEVELS hashes each. But a transact always adds
    // exactly two leaves, so nextIndex is always even and the pair always occupies an
    // aligned (even, odd) slot — which means their common parent can be computed
    // directly and the walk starts at level 1. That is LEVELS + 1 hashes instead of
    // 2 * LEVELS: 32 rather than 64, for an identical tree.
    //
    // Equivalence, briefly. Sequentially, inserting A at 2k writes filledSubtrees[0] = A
    // and carries H(A, zeros[0]) upward; inserting B at 2k+1 then reads that back and
    // carries H(A, B) upward from level 1 with the same currentIndex = k. Every level
    // above 0 therefore sees exactly what it sees here, and the level-0 slot only ever
    // existed to hold A until B arrived. RootHistory pins this against the old behaviour.
    //
    // Does NOT publish the root — callers follow with _commitPoolRoot(). The root is
    // only meaningful once both leaves are in.
    function _insertPair(bytes32 left, bytes32 right)
        internal returns (uint32 indexLeft, uint32 indexRight)
    {
        if (left == bytes32(0) || right == bytes32(0)) revert ZeroCommitment();
        if (nextIndex + 1 >= (1 << LEVELS) - 1) revert PoolFull();

        // Level 0 is skipped: with both leaves in hand their parent is direct, and
        // filledSubtrees[0] has no reader once single insertion is gone.
        bytes32 currentHash  = _hashLeftRight(left, right);
        uint32  currentIndex = nextIndex >> 1;

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
        indexLeft  = nextIndex;
        indexRight = nextIndex + 1;
        nextIndex  = nextIndex + 2;
    }

    function _commitPoolRoot() internal {
        knownPoolRoots[lastRoot] = true;
    }

    function _hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        uint256 result = PoseidonT3.hash([uint256(left), uint256(right)]);
        return bytes32(result);
    }

    function isKnownPoolRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        return knownPoolRoots[root];
    }

    function getLastRoot() public view returns (bytes32) {
        return lastRoot;
    }
}
