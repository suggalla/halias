// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Re-export standard ERC-4337 types from OpenZeppelin.
// Use these imports instead of defining PackedUserOperation / IPaymaster / IAccount locally.
import {PackedUserOperation, IPaymaster, IAccount, IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
