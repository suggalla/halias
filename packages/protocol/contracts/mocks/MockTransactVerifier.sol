// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Always-valid verifier for tests that exercise contract logic rather than the circuit.
// Never use it for anything that must prove a real constraint holds — see Claim.test.ts.
contract MockTransactVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[14] calldata
    ) external pure returns (bool) {
        return true;
    }
}
