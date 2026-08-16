// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
pragma circom 2.0.0;

include "lib/transactCore.circom";

// The claim circuit: a transaction that registers an alias and spends in the same proof.
//
// Identical to the single circuit that preceded the split — deliberately, and checked. Its
// r1cs is byte-identical to the pre-split transact.circom, which is what makes the existing
// zkey and the deployed verifier still valid for this path. Only the ordinary circuit is new.
//
// Used only when the registry has armed a pending leaf. `HaliasPool` selects the verifier from
// that armed value, which is contract state rather than prover input, so nothing here is a
// choice the prover gets to make.
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
]} = Transact(16, 32, 4, 2, 1);
