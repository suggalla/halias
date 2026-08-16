// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
pragma solidity 0.8.28;

interface ITransactVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[20] calldata _pubSignals
    ) external view returns (bool);
}
