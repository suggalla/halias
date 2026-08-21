// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

import { TreeZeros } from "../base/TreeZeros.sol";

/// Exposes the internal table so TreeZeros.test.ts can pin every entry against a recomputed
/// Poseidon chain. The library is `internal`, so it is inlined and has no address of its own.
contract TreeZerosHarness {
    function at(uint256 i) external pure returns (bytes32) { return TreeZeros.zeros(i); }
}
