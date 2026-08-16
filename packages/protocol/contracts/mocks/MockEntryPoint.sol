// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IPaymaster, IAccount} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

interface IExecutable {
    function execute(address target, uint256 value, bytes calldata data) external;
    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas) external;
}

// Minimal IEntryPoint mock for testing — only implements the functions Halias.sol calls.
contract MockEntryPoint {
    mapping(address => uint256) public balanceOf;

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient EP balance");
        balanceOf[msg.sender] -= amount;
        to.transfer(amount);
    }

    // Unused but needed by HaliasPaymaster.addStakeToEntryPoint
    function addStake(uint32) external payable {}

    // ── Test helpers ──────────────────────────────────────────────────────────

    // Call validatePaymasterUserOp on a paymaster as if we are the EntryPoint.
    function callValidatePaymaster(
        address paymaster,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 result) {
        return IPaymaster(paymaster).validatePaymasterUserOp(userOp, userOpHash, maxCost);
    }

    // Call postOp on a paymaster as if we are the EntryPoint.
    function callPostOp(
        address paymaster,
        uint8 mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external {
        IPaymaster(paymaster).postOp(IPaymaster.PostOpMode(mode), context, actualGasCost, 0);
    }

    // Call validateUserOp on an account as if we are the EntryPoint.
    function callValidateAccount(
        address account,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingFunds
    ) external returns (uint256 validationData) {
        return IAccount(account).validateUserOp(userOp, userOpHash, missingFunds);
    }

    // Call execute on an account as if we are the EntryPoint.
    function callExecute(
        address account,
        address target,
        uint256 value,
        bytes calldata data
    ) external {
        IExecutable(account).execute(target, value, data);
    }

    // Call executeBatch on an account as if we are the EntryPoint.
    function callExecuteBatch(
        address account,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external {
        IExecutable(account).executeBatch(targets, values, datas);
    }

    receive() external payable {}
}
