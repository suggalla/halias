// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation, IAccount, IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./base/Errors.sol";

// ---------------------------------------------------------------------------
// HaliasAccountImpl — shared EIP-7702 delegation target
//
// Users derive a fresh EOA from their spending key, then EIP-7702-delegate
// it to this contract, making it an ERC-4337 sender. No storage, no factory,
// no proxy — one deployed instance shared by all halias users.
//
// Key derivation (SDK):
//   spendingKey = deriveSpendingPrivateKey(walletSignature)
//   freshEOA    = ethers.Wallet(spendingKey)          // same bytes as secp256k1
//
// The spending key feeds both the circuit (Poseidon(spendingKey) = pubkey)
// and ECDSA (signing UserOps). The freshEOA is the user's halias identity,
// unlinked from their originating wallet.
// ---------------------------------------------------------------------------
contract HaliasAccountImpl is IAccount {
    using ECDSA for bytes32;

    IEntryPoint public immutable entryPoint;

    uint256 constant SIG_VALIDATION_FAILED = 1;

    constructor(address _entryPoint) {
        entryPoint = IEntryPoint(_entryPoint);
    }

    // IAccount: validate UserOp signature.
    // Signer must be address(this) — i.e. the spending key that derived this EOA.
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();

        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        (address signer, ECDSA.RecoverError err,) = hash.tryRecover(userOp.signature);
        validationData = (err == ECDSA.RecoverError.NoError && signer == address(this))
            ? 0
            : SIG_VALIDATION_FAILED;

        if (missingAccountFunds > 0) {
            // Failure intentionally ignored — EntryPoint handles insufficient funds.
            (bool ok,) = address(entryPoint).call{value: missingAccountFunds}("");
            (ok);
        }
    }

    // ERC-4337: execute a call on behalf of this account.
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly { revert(add(result, 32), mload(result)) }
        }
    }

    // ERC-4337: batch execute.
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (targets.length != values.length || values.length != datas.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok, bytes memory result) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) {
                assembly { revert(add(result, 32), mload(result)) }
            }
        }
    }

    receive() external payable {}
}
