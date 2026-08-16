// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Always-valid verifier for non-ZK contract tests (ERC-20, callTarget, vouchers).
contract MockTransactVerifier {
    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[9] calldata
    ) external pure returns (bool) {
        return true;
    }
}
