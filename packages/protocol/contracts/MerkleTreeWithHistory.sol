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

    // Updates the tree but does NOT publish the root. A transact inserts twice, and the
    // intermediate root is never observable — the two inserts are atomic and reentrancy
    // is blocked — so publishing it would just pay for a slot nobody can prove against.
    // Callers must follow their inserts with _commitPoolRoot().
    function _insert(bytes32 leaf) internal returns (uint32 index) {
        if (leaf == bytes32(0)) revert ZeroCommitment();
        if (nextIndex >= (1 << LEVELS) - 1) revert PoolFull();
        uint32 currentIndex = nextIndex;

        bytes32 currentHash = leaf;
        for (uint32 i = 0; i < LEVELS; i++) {
            if (currentIndex % 2 == 0) {
                filledSubtrees[i] = currentHash;
                currentHash = _hashLeftRight(currentHash, poolZeros[i]);
            } else {
                currentHash = _hashLeftRight(filledSubtrees[i], currentHash);
            }
            currentIndex /= 2;
        }

        lastRoot = currentHash;
        nextIndex = nextIndex + 1;
        return nextIndex - 1;
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
