// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IAttestationProvider.sol";

// Returns keccak256(aliasHash, callIndex) so each call produces a distinct, deterministic commitment.
contract MockAttestationProvider is IAttestationProvider {
    mapping(bytes32 => uint256) public callCount;
    bool public shouldRevert;

    constructor(bool _shouldRevert) {
        shouldRevert = _shouldRevert;
    }

    function setShouldRevert(bool _revert) external {
        shouldRevert = _revert;
    }

    function attest(bytes32 aliasHash, bytes calldata) external override returns (bytes32) {
        if (shouldRevert) revert("MockAttestationProvider: reverted");
        uint256 idx = callCount[aliasHash]++;
        return keccak256(abi.encodePacked(aliasHash, idx));
    }

    function expectedCommitment(bytes32 aliasHash, uint256 callIndex) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(aliasHash, callIndex));
    }
}
