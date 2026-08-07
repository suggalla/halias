// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// All fields are fixed-size so TransactParams is static in ABI encoding — no offset pointers.
// encryptedOutput0/1 are separate dynamic args so they don't force an offset pointer here.
struct TransactParams {
    bytes32    poolRoot;
    bytes32    registryRoot;
    uint256    publicAmount;
    uint256    tokenAddress;
    bytes32[2] inputNullifiers;
    bytes32[2] outputCommitments;
    address    recipient;    // unshield destination; address(this) only via registerWithPoolNote
    bytes32    externalData; // relayer fee: address(20) || feeWei(12); zero = no relayer
}

interface IHalias {
    // ── Registration ───────────────────────────────────────────────────────────
    function register(bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, string calldata name) external payable;
    function updateKeys(bytes32 aliasHash, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey) external;
    function updateAliasData(bytes32 aliasHash, bytes32 newDataHash) external;
    function transferAliasWithKeys(bytes32 aliasHash, address newOwner, bytes32 newSpendingPubkey, bytes32 newNullifierKeyHash, bytes32 newEncryptionPubkey) external;

    // ── Transact ───────────────────────────────────────────────────────────────
    function transact(TransactParams calldata core, bytes calldata encryptedOutput0, bytes calldata encryptedOutput1, bytes calldata proof) external payable;
    function computeParamsHash(TransactParams calldata core, bytes calldata encryptedOutput0, bytes calldata encryptedOutput1) external view returns (uint256);

    // ── Invite claim (pool-note model) ─────────────────────────────────────────
    // The inviter funds a pool note held by a temp keypair derived from the invite secret.
    // The claimer derives it and registers a name in one tx, paying registrationFee out of
    // the note. absAmount must equal registrationFee exactly; excess goes to a change output.
    function registerWithPoolNote(TransactParams calldata core, bytes calldata encryptedOutput0, bytes calldata encryptedOutput1, bytes calldata proof, bytes32 aliasHash, bytes32 spendingPubkey, bytes32 nullifierKeyHash, bytes32 encryptionPubkey, string calldata name) external;

    // ── State queries ──────────────────────────────────────────────────────────
    function registrationFee() external view returns (uint256);
    function spentNullifiers(bytes32 nullifier) external view returns (bool);
    function poolTokenBalance(address token) external view returns (uint256);
    function smtRoot() external view returns (bytes32);
    function getRegistryRoot() external view returns (bytes32);
    function getSmtSiblings(uint256 slot) external view returns (bytes32[32] memory);
    function isKnownPoolRoot(bytes32 root) external view returns (bool);
    function isKnownRegistryRoot(bytes32 root) external view returns (bool);
    function getLastRoot() external view returns (bytes32);
}
