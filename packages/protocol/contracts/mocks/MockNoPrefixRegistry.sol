// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import { HaliasRegistry } from "../HaliasRegistry.sol";

/// @dev Measurement only: what the prefix index costs a registration.
contract MockNoPrefixRegistry is HaliasRegistry {
    constructor(address controller_) HaliasRegistry(controller_) {}
    function _indexPrefix(bytes32) internal override {}
}
