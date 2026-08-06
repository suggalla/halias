// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// All fields are fixed-size so TransactParams is static in ABI encoding — no offset pointers.
// The paymaster reads it with a single abi.decode at a known position.
// encryptedOutput0/1 are separate dynamic args so they don't force an offset pointer here.
struct TransactParams {
    bytes32    poolRoot;
    bytes32    registryRoot;
    uint256    publicAmount;
    uint256    tokenAddress;
    bytes32[2] inputNullifiers;
    bytes32[2] outputCommitments;
    address    recipient;    // unshield destination; address(this) = retain for paymaster gas
    bytes32    externalData; // general-purpose commitment hook
}

interface IHalias {
    // ── Registration ───────────────────────────────────────────────────────────
    function register(bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey) external payable;
    function updateKeys(bytes32 aliasHash, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey) external;
    function updateAliasData(bytes32 aliasHash, bytes32 newDataHash) external;
    function transferAliasWithKeys(bytes32 aliasHash, address newOwner, bytes32 newSpendingPubkey, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey) external;

    // ── Transact ───────────────────────────────────────────────────────────────
    function transact(TransactParams calldata core, bytes calldata encryptedOutput0, bytes calldata encryptedOutput1, bytes calldata proof) external payable;
    function computeParamsHash(TransactParams calldata core, bytes calldata encryptedOutput0, bytes calldata encryptedOutput1) external view returns (uint256);

    // ── Vouchers (pool-note model) ─────────────────────────────────────────────
    // Voucher creation: call transact() with a standard ETH deposit, output note assigned
    // to a temp keypair. Circuit enforces committed amount == msg.value.
    // absAmount in registerWithPoolNote is capped at registrationFee + MAX_VOUCHER_GAS_BUDGET.
    function registerWithPoolNote(TransactParams calldata core, bytes calldata encryptedOutput0, bytes calldata encryptedOutput1, bytes calldata proof, bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey) external;
    function MAX_VOUCHER_GAS_BUDGET() external view returns (uint256);

    // ── State queries ──────────────────────────────────────────────────────────
    function registrationFee() external view returns (uint256);
    function spentNullifiers(bytes32 nullifier) external view returns (bool);
    function poolTokenBalance(address token) external view returns (uint256);
    function smtRoot() external view returns (bytes32);
    function getRegistryRoot() external view returns (bytes32);
    function getSmtSiblings(uint256 key) external view returns (bytes32[64] memory);
    function isKnownPoolRoot(bytes32 root) external view returns (bool);
    function isKnownRegistryRoot(bytes32 root) external view returns (bool);
    function getLastRoot() external view returns (bytes32);
}
