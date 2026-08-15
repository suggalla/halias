// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
pragma solidity 0.8.28;

/// @notice Payment to whoever submits the transaction, taken out of the value leaving
///         the pool and denominated in whatever asset is being withdrawn.
/// @dev    Committed inside `paramsHash`, so the prover fixes both the relayer and the
///         amount. A submitter can only choose to submit or not; it cannot alter the
///         destination, the payout, or its own cut, so relaying is trustless in both
///         directions. This is what lets a user with zero ETH pay for inclusion out of
///         their own shielded funds, with no sponsor and no paymaster.
///
///         `amount == 0` means no relayer, which is the ordinary self-submitted path.
///         Whether a given token is worth accepting is the relayer's call, made off-chain
///         by declining to submit — the pool takes no view on it.
struct RelayerFee {
    address relayer;
    uint256 amount;
}

/// @notice Parameters for a pool transaction.
/// @dev    Every field is fixed-size, so this is static in ABI encoding — no offset
///         pointers. `RelayerFee` is a struct of two static members, which preserves
///         that, and `externalData` is deliberately `bytes32` rather than `bytes` for
///         the same reason. `encryptedOutput0/1` are passed as separate dynamic
///         arguments.
///
///         `externalData` lets a caller bind arbitrary application data to a proof. The
///         pool never reads it — it only hashes it into `paramsHash`, which the prover
///         must commit to — so a submitter cannot pair a valid proof with different data.
///         The domain contract uses this to tie a claim's authorisation to the note being
///         spent. Because `paramsHash` is opaque to the circuit, what goes in here can
///         change without a new ceremony.
struct TransactParams {
    // Per input: two notes may live in different trees. `treeNumber` is checked against the
    // tree each root belongs to — the nullifier keys on a note's global position, so an
    // unbound tree number would let one note be re-spent under a fresh nullifier each time.
    bytes32[2] poolRoot;
    uint32[2]  treeNumber;
    bytes32    registryRoot;
    uint256    publicAmount;   // signed in the field: positive = deposit, negative = withdraw
    // `address(0)` for ETH. This is a circuit public signal and therefore a field element,
    // but it is declared `address` rather than `uint256` deliberately: the ABI decoder
    // rejects a calldata `address` with any of the top 96 bits set, before a line of this
    // contract runs. ETH is the `address(0)` sentinel, so a value that read as non-zero
    // here while truncating to zero at settlement would be a free ETH note. Narrowing the
    // type makes that unrepresentable rather than merely checked. Widened back to a field
    // element only where the verifier wants it — see HaliasPool._verifyTransact.
    address    tokenAddress;
    bytes32[2] inputNullifiers;
    bytes32[2] outputCommitments;
    address    recipient;      // withdrawal destination; may be zero when the fee consumes the payout
    RelayerFee relayerFee;
    bytes32    externalData;   // opaque; bound into paramsHash, never interpreted here
    // The registry insertion this transaction's proof performs, or zero. Public signal, and
    // never the prover's to choose: the pool requires it to equal what the registry armed,
    // which is zero on every path but a claim. See HaliasRegistry.authorizePendingLeaf.
    bytes32    pendingLeaf;
    // Spend the inputs and create nothing. Proven, not asserted: the circuit sets this only
    // when both outputs are zero-amount, so it cannot be used to destroy real change.
    bool       outputsEmpty;
}

// Exactly what {HaliasController} calls, and nothing else. The pool's read API is richer, but a
// member here is a member the domain could call, and the domain has no business reading the
// pool's tree or nullifier set. Clients use the full ABI directly.
interface IHaliasPool {
    function transact(
        TransactParams calldata p,
        bytes calldata encryptedOutput0,
        bytes calldata encryptedOutput1,
        bytes calldata proof
    ) external payable;
}
