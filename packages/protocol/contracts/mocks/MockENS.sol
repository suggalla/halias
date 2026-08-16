// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockENS {
    mapping(bytes32 => address) public owners;

    function setOwner(bytes32 node, address owner) external {
        owners[node] = owner;
    }

    function owner(bytes32 node) external view returns (address) {
        return owners[node];
    }
}
