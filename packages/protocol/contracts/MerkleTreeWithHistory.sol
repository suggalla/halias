// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "poseidon-solidity/PoseidonT3.sol";

error PoolFull();
error ZeroCommitment();

contract MerkleTreeWithHistory {
    uint32 public constant LEVELS = 32;
    uint32 public constant POOL_HISTORY_SIZE = 500;

    mapping(uint256 => bytes32) public filledSubtrees;
    mapping(uint256 => bytes32) public poolZeros;
    mapping(uint256 => bytes32) public roots;
    uint32 public currentRootIndex = 0;
    uint32 public nextIndex = 0;

    constructor() {
        bytes32 currentZero = bytes32(0);
        for (uint32 i = 0; i < LEVELS; i++) {
            poolZeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = _hashLeftRight(currentZero, currentZero);
        }
        roots[0] = currentZero;
    }

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

        currentRootIndex = (currentRootIndex + 1) % POOL_HISTORY_SIZE;
        roots[currentRootIndex] = currentHash;
        nextIndex = nextIndex + 1;
        return nextIndex - 1;
    }

    function _hashLeftRight(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        uint256 result = PoseidonT3.hash([uint256(left), uint256(right)]);
        return bytes32(result);
    }

    function isKnownPoolRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        uint32 i = currentRootIndex;
        do {
            if (roots[i] == root) return true;
            if (i == 0) i = POOL_HISTORY_SIZE;
            i--;
        } while (i != currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (bytes32) {
        return roots[currentRootIndex];
    }
}
