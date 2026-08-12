// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../HaliasPool.sol";

/// @notice A pool whose trees roll over after four leaves instead of 65,536.
/// @dev    Everything else is the real HaliasPool: real depth, real Poseidon, real root
///         derivation, real root/tree bookkeeping. Only the boundary moves, so the tests it
///         enables — stale `filledSubtrees` being overwritten before they are read, and
///         nullifiers keying on the global position rather than the leaf — exercise the
///         production insertion path rather than a copy of it.
///
///         Four is chosen so a couple of transactions span three trees, which is what makes
///         "spend one note from each of two different trees" cheap to set up.
contract MockSmallTreePool is HaliasPool {
    constructor(address verifier, address registry) HaliasPool(verifier, registry) {}

    function _treeCapacity() internal pure override returns (uint32) {
        return 4;
    }
}
