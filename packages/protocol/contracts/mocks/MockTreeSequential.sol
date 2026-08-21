// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";

// The pre-optimisation insertion, kept only so a test can prove the pairwise version
// produces a byte-identical tree. Never deployed outside tests.
contract MockTreeSequential {
    uint32 public constant LEVELS = 16;
    mapping(uint256 => bytes32) public filledSubtrees;
    mapping(uint256 => bytes32) public poolZeros;
    bytes32 public lastRoot;
    uint32 public nextIndex = 0;

    constructor() {
        bytes32 z = bytes32(0);
        for (uint32 i = 0; i < LEVELS; i++) {
            poolZeros[i] = z;
            filledSubtrees[i] = z;
            z = _h(z, z);
        }
        lastRoot = z;
    }

    function insert(bytes32 leaf) public {
        uint32 currentIndex = nextIndex;
        bytes32 currentHash = leaf;
        for (uint32 i = 0; i < LEVELS; i++) {
            if (currentIndex % 2 == 0) {
                filledSubtrees[i] = currentHash;
                currentHash = _h(currentHash, poolZeros[i]);
            } else {
                currentHash = _h(filledSubtrees[i], currentHash);
            }
            currentIndex /= 2;
        }
        lastRoot = currentHash;
        nextIndex += 1;
    }

    function insertPairSequentially(bytes32 a, bytes32 b) external { insert(a); insert(b); }
    function _h(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return bytes32(PoseidonT3.hash([uint256(l), uint256(r)]));
    }
}
