// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";
import { HaliasRegistry } from "../HaliasRegistry.sol";
import { TreeZeros } from "../base/TreeZeros.sol";
import { FIELD_PRIME } from "../base/Constants.sol";

/// @dev Measurement only, and only the registration half.
///
///      Registrations are already appends — `_smtUpdate` writes to `nextAliasSlot`, in order —
///      so they need no stored node at all: the sibling is either an empty subtree or the
///      completed left subtree the previous appends built. That is the whole difference from
///      the base, which stores a node per position because rotations need arbitrary siblings.
///
///      What this deliberately does NOT model is the other half of that bargain: with no node
///      map, a rotation has to carry its sibling path in calldata and verify it against the
///      root before recomputing, and has to repair any `filled` entry its path runs through.
///      Both are real costs and neither is here. This measures the ceiling.
contract MockAppendRegistry is HaliasRegistry {
    bytes32[32] private filled;

    constructor(address controller_) HaliasRegistry(controller_) {}

    function _smtUpdate(bytes32 aliasHash, bytes32 value) internal override {
        uint256 key  = uint256(aliasHash) % FIELD_PRIME;
        uint32  slot = aliasSlot[aliasHash];
        require(slot == 0, "append path models registration only");
        slot = ++nextAliasSlot;
        aliasSlot[aliasHash] = slot;

        uint256 idx = slot - 1;
        bytes32 current = bytes32(PoseidonT4.hash([key, uint256(value), 1]));
        for (uint256 i = 0; i < REGISTRY_LEVELS; i++) {
            if (idx & 1 == 0) {
                filled[i] = current;
                current = bytes32(PoseidonT3.hash([uint256(current), uint256(TreeZeros.zeros(i))]));
            } else {
                current = bytes32(PoseidonT3.hash([uint256(filled[i]), uint256(current)]));
            }
            idx >>= 1;
        }
        registryRootSeenAt[smtRoot] = block.timestamp;
        smtRoot = current;
    }
}
