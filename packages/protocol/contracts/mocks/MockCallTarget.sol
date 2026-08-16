// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal call target: records last call, optionally reverts.
contract MockCallTarget {
    event Called(bytes data, uint256 value);

    bool   public shouldRevert;
    bytes  public lastData;
    uint256 public lastValue;

    constructor(bool _shouldRevert) {
        shouldRevert = _shouldRevert;
    }

    function setRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    receive() external payable {
        if (shouldRevert) revert("MockCallTarget: reverted");
        lastValue = msg.value;
        emit Called("", msg.value);
    }

    fallback() external payable {
        if (shouldRevert) revert("MockCallTarget: reverted");
        lastData  = msg.data;
        lastValue = msg.value;
        emit Called(msg.data, msg.value);
    }
}
