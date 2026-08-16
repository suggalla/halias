// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
pragma solidity 0.8.28;

import { HaliasPool } from "../HaliasPool.sol";

/// @notice A pool with four leaves per tree and only two trees, so the pool can be filled.
/// @dev    Reaching {TreeSpaceExhausted} honestly means 2^32 rollovers. This shrinks both
///         ceilings so the last addressable tree is reached in a handful of transactions,
///         while depth, hashing and root derivation stay exactly as in production.
///
///         The revert it makes reachable is the one that matters most at the boundary: a note
///         inserted past the circuit's 32-bit `treeNumber` bound would sit on chain
///         permanently unprovable — silent, irreversible, and indistinguishable from a
///         successful deposit until its owner tried to spend it. Refusing the insert is what
///         turns that into a revert, and until now nothing checked that it does.
contract MockFullTreePool is HaliasPool {
    constructor(address verifier, address claimVerifier_, address registry)
        HaliasPool(verifier, claimVerifier_, registry) {}

    function _treeCapacity() internal pure override returns (uint32) {
        return 4;
    }

    /// Tree 1 is the last, so the pool holds eight leaves in total.
    function _maxTreeNumber() internal pure override returns (uint32) {
        return 1;
    }
}
