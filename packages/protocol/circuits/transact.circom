// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
//
// Adapted from Tornado Cash Nova (GPL-3.0) and built on circomlib (GPL-3.0).
pragma circom 2.0.0;

include "lib/transactCore.circom";

// The ordinary circuit: deposit, transfer, withdraw. Everything except a claim.
//
// `pendingLeaf` is present and constrained to zero, so this circuit cannot express a registry
// insertion. Keeping the signal makes both circuits share one calldata shape, one public-signal
// layout and one event — the pool's only branch is which verifier it calls.
//
// Registry slots are assigned sequentially, so 32 levels holds 4.29e9 aliases with no
// possibility of collision — the depth is a capacity bound, not a birthday bound.
component main {public [
    poolRoot,
    treeNumber,
    registryRoot,
    publicAmount,
    tokenAddress,
    paramsHash,
    pendingLeaf,
    outputsEmpty,
    inputNullifier,
    outputCommitment
]} = Transact(16, 32, 4, 2, 0);
