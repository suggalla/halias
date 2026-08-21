// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

import { HaliasRegistry } from "../HaliasRegistry.sol";

/// @notice A registry that fills after four aliases instead of 4,294,967,296.
/// @dev    Everything else is the real HaliasRegistry: real depth 32, real Poseidon, real
///         zeros, real leaf and root derivation. Only the ceiling moves, so the test it
///         enables exercises the production insertion path rather than a copy of it — the
///         same arrangement as {MockSmallTreePool}.
///
///         Without it {RegistryFull} is unreachable, since hitting it honestly means 2^32
///         registrations. An unreachable revert is an untested one, and this is the revert
///         that fires when the registry is permanently out of room — the registry has no
///         rollover, so its depth is a hard ceiling and filling it means a new registry,
///         which by the immutability cascade means a new everything.
///
///         Four rather than one so the failure lands on a boundary rather than immediately:
///         several registrations must succeed before the next is refused, which is what
///         distinguishes "the bound works" from "registration is broken".
contract MockSmallRegistry is HaliasRegistry {
    constructor(address _controller) HaliasRegistry(_controller) {}

    function _registryCapacity() internal pure override returns (uint256) {
        return 4;
    }
}
