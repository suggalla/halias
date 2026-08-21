// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 Halias contributors.
pragma solidity 0.8.28;

// BN254 scalar field prime — used for ZK circuit compatibility.
// All public signals must be < FIELD_PRIME.
uint256 constant FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

// Maximum absolute value of publicAmount (2^248).
// publicAmount is signed in the field: positive = deposit, field-negative = withdraw.
// Bounds the withdraw range to [-2^248, 0) and deposit range to (0, 2^248].
uint256 constant MAX_ABS_AMOUNT = 1 << 248;
