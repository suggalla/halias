pragma circom 2.0.0;

include "poseidon.circom";
include "bitify.circom";
include "comparators.circom";
include "lib/merkleProof.circom";

//
// halias v1.5 — Unified Transact Circuit
//
// Adapted from Tornado Cash Nova's transaction.circom (GPL-3.0)
// Registry membership proof based on Semaphore's pattern (MIT)
//
// 2 inputs, 2 outputs. Handles deposit, transfer, and withdraw
// via publicAmount:
//   deposit:  publicAmount > 0 (ETH in)
//   withdraw: publicAmount < 0 (ETH out)
//   transfer: publicAmount = 0 (in-pool)
//
// Note structure:
//   commitment = Poseidon(pubkey, nullifierKey, blinding, amount, tokenAddress)
//   nullifier  = Poseidon(nullifierKey, leafIndex)  [computed at spend time]
//   pubkey     = Poseidon(spendingPrivateKey)        [no elliptic curve needed]
//   nullifierKey = Poseidon(viewingPrivateKey)       [also the audit/viewing key]
//
// Registry leaf:
//   leaf = Poseidon(pubkey, nullifierKey, dataHash)
//
// Key hierarchy (off-chain, SDK):
//   MetaMask signature
//     ├── spendingPrivateKey  → pubkey      = Poseidon(spendingPrivateKey) [in circuit]
//     ├── viewingPrivateKey   → nullifierKey = Poseidon(viewingPrivateKey)  [in circuit]
//     └── encryptionKeypair   → X25519 (off-chain only, circuit-agnostic)
//
// Encryption (off-chain only):
//   Note data (blinding, amount) is encrypted to the recipient's X25519
//   public key and emitted in contract events. The circuit is agnostic
//   to the encryption scheme — it only proves commitment/nullifier math.
//

// ---------------------------------------------------------------------------
// Note commitment: Poseidon(pubkey, nullifierKeyHash, blinding, amount, tokenAddress)
// pubkey          = Poseidon(spendingPrivateKey), computed in circuit
// nullifierKeyHash = Poseidon(nullifierKey, 1)
//   For inputs:  derived in circuit from viewingPrivateKey → nullifierKey → hash
//   For outputs: provided directly by sender (read from registry; raw key never leaves recipient)
// Hashing nullifierKey before including it in the commitment means the raw nullifierKey
// is never visible on-chain or computable by observers — they cannot enumerate nullifiers
// to trace spending patterns.
// ---------------------------------------------------------------------------
template NoteCommitment() {
    signal input pubkey;
    signal input nullifierKeyHash;
    signal input blinding;
    signal input amount;
    signal input tokenAddress;
    signal output out;

    component hasher = Poseidon(5);
    hasher.inputs[0] <== pubkey;
    hasher.inputs[1] <== nullifierKeyHash;
    hasher.inputs[2] <== blinding;
    hasher.inputs[3] <== amount;
    hasher.inputs[4] <== tokenAddress;
    out <== hasher.out;
}

// ---------------------------------------------------------------------------
// Nullifier: Poseidon(nullifierKey, leafIndex)
// Computed at spend time. nullifierKey = Poseidon(viewingPrivateKey).
// leafIndex is encoded as pathIndices bits packed to a single value.
// ---------------------------------------------------------------------------
template NoteNullifier(levels) {
    signal input nullifierKey;
    signal input pathIndices[levels];
    signal output out;

    // Pack pathIndices bits into leafIndex signal
    component leafIndexBits = Bits2Num(levels);
    for (var i = 0; i < levels; i++) {
        leafIndexBits.in[i] <== pathIndices[i];
    }

    component hasher = Poseidon(2);
    hasher.inputs[0] <== nullifierKey;
    hasher.inputs[1] <== leafIndexBits.out;
    out <== hasher.out;
}

// ---------------------------------------------------------------------------
// Registry leaf: Poseidon(pubkey, nullifierKeyHash, dataHash)
// pubkey          = Poseidon(spendingPrivateKey)
// nullifierKeyHash = Poseidon(nullifierKey, 1) — stored in registry instead of raw key.
//   Binding nullifierKeyHash prevents recipient substitution (wrong hash → wrong leaf → SMT proof fails).
//   Using the hash rather than the raw key means on-chain observers cannot compute nullifiers.
// dataHash is used for attestations/reputation data.
// ---------------------------------------------------------------------------
template RegistryLeaf() {
    signal input pubkey;
    signal input nullifierKeyHash;
    signal input dataHash;
    signal output out;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== pubkey;
    hasher.inputs[1] <== nullifierKeyHash;
    hasher.inputs[2] <== dataHash;
    out <== hasher.out;
}

// ---------------------------------------------------------------------------
// Main Transact circuit
//
// poolLevels:     depth of pool commitment Merkle tree (e.g. 32)
// registryLevels: depth of registry SMT (e.g. 32)
// nIns:           number of inputs (2)
// nOuts:          number of outputs (2)
// ---------------------------------------------------------------------------
template Transact(poolLevels, registryLevels, nIns, nOuts) {

    // === Public inputs ===
    signal input poolRoot;
    signal input registryRoot;
    signal input publicAmount;           // positive = deposit, negative = withdraw, 0 = transfer
    signal input tokenAddress;           // which token (0 for ETH)
    signal input paramsHash;             // hash of transaction params (TransactParams)
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // === Private inputs — spending (per input) ===
    signal input inSpendingPrivateKey[nIns];
    signal input inViewingPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inAmount[nIns];
    signal input inPathIndices[nIns][poolLevels];
    signal input inPathElements[nIns][poolLevels];

    // === Private inputs — outputs ===
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];
    signal input outAmount[nOuts];

    // === Private inputs — registry proofs (per output) ===
    signal input outNullifierKeyHash[nOuts];                         // Poseidon(nullifierKey, 1) — hash stored in registry; raw key stays with recipient
    signal input outDataHash[nOuts];                                 // recipient's dataHash (from registry)
    signal input outAliasHash[nOuts];                                // aliasHash % FIELD_PRIME — private SMT key
    signal input outRegistrySiblings[nOuts][registryLevels];         // SMT sibling hashes
    // Path bits for the SMT are derived internally from outAliasHash via Num2Bits(255).
    // FIELD_PRIME < 2^255, so Num2Bits(255) succeeds for every valid field element.
    // This constrains path indices to exactly match outAliasHash bits, eliminating a
    // separate outRegistryPathIndices input and tightening the path-to-key binding.

    // -----------------------------------------------------------------------
    // INPUT VERIFICATION
    // -----------------------------------------------------------------------

    component inPubKey[nIns];
    component inNullifierKey[nIns];
    component inNullifierKeyHash[nIns];
    component inCommitment[nIns];
    component inNullifier[nIns];
    component inPoolProof[nIns];
    component inCheckRoot[nIns];
    component inAmountCheck[nIns];
    var sumIns = 0;

    for (var i = 0; i < nIns; i++) {
        // 0. Range check inAmount (248 bits) — defense-in-depth.
        // Implicitly bounded by deposit-time outAmount check on the source
        // commitment, but enforcing here removes that cross-tx assumption.
        inAmountCheck[i] = Num2Bits(248);
        inAmountCheck[i].in <== inAmount[i];

        // 1. Derive public key = Poseidon(spendingPrivateKey)
        inPubKey[i] = Poseidon(1);
        inPubKey[i].inputs[0] <== inSpendingPrivateKey[i];

        // 2. Derive nullifier key = Poseidon(viewingPrivateKey)
        inNullifierKey[i] = Poseidon(1);
        inNullifierKey[i].inputs[0] <== inViewingPrivateKey[i];

        // 2b. Hash nullifierKey for commitment: Poseidon(nullifierKey, 1)
        // Raw nullifierKey is kept private; only the hash goes into the commitment.
        inNullifierKeyHash[i] = Poseidon(2);
        inNullifierKeyHash[i].inputs[0] <== inNullifierKey[i].out;
        inNullifierKeyHash[i].inputs[1] <== 1;

        // 3. Compute commitment (uses nullifierKeyHash, not raw nullifierKey)
        inCommitment[i] = NoteCommitment();
        inCommitment[i].pubkey <== inPubKey[i].out;
        inCommitment[i].nullifierKeyHash <== inNullifierKeyHash[i].out;
        inCommitment[i].blinding <== inBlinding[i];
        inCommitment[i].amount <== inAmount[i];
        inCommitment[i].tokenAddress <== tokenAddress;

        // 4. Compute nullifier = Poseidon(nullifierKey, leafIndex)
        inNullifier[i] = NoteNullifier(poolLevels);
        inNullifier[i].nullifierKey <== inNullifierKey[i].out;
        for (var j = 0; j < poolLevels; j++) {
            inNullifier[i].pathIndices[j] <== inPathIndices[i][j];
        }
        inNullifier[i].out === inputNullifier[i];

        // 5. Verify pool Merkle proof
        inPoolProof[i] = MerkleProof(poolLevels);
        inPoolProof[i].leaf <== inCommitment[i].out;
        for (var j = 0; j < poolLevels; j++) {
            inPoolProof[i].pathElements[j] <== inPathElements[i][j];
            inPoolProof[i].pathIndices[j] <== inPathIndices[i][j];
        }

        // Skip Merkle check for zero-amount (dummy) inputs
        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].in[0] <== poolRoot;
        inCheckRoot[i].in[1] <== inPoolProof[i].root;
        inCheckRoot[i].enabled <== inAmount[i];

        sumIns += inAmount[i];
    }

    // Check no duplicate nullifiers
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var idx = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[idx] = IsEqual();
            sameNullifiers[idx].in[0] <== inputNullifier[i];
            sameNullifiers[idx].in[1] <== inputNullifier[j];
            sameNullifiers[idx].out === 0;
            idx++;
        }
    }

    // -----------------------------------------------------------------------
    // OUTPUT VERIFICATION
    // -----------------------------------------------------------------------

    // ForceEqualIfEnabled.enabled must be binary (0 or 1), so we convert outAmount to 0/1.
    component outAmountNz[nOuts];
    signal outRegistryEnabled[nOuts];

    component outCommitment[nOuts];
    component outAmountCheck[nOuts];
    component outAliasHashBits[nOuts];
    component outRegistryLeaf[nOuts];
    component outRegistryLeafHash[nOuts];
    component outRegistryProof[nOuts];
    component outRegistryCheckRoot[nOuts];
    var sumOuts = 0;

    for (var i = 0; i < nOuts; i++) {
        // 1. Convert amount to binary 0/1 for the registry check enable flag
        outAmountNz[i] = IsZero();
        outAmountNz[i].in <== outAmount[i];
        outRegistryEnabled[i] <== 1 - outAmountNz[i].out;

        // 2. Verify output commitment (uses outNullifierKeyHash directly — sender reads hash from registry)
        outCommitment[i] = NoteCommitment();
        outCommitment[i].pubkey <== outPubkey[i];
        outCommitment[i].nullifierKeyHash <== outNullifierKeyHash[i];
        outCommitment[i].blinding <== outBlinding[i];
        outCommitment[i].amount <== outAmount[i];
        outCommitment[i].tokenAddress <== tokenAddress;
        outCommitment[i].out === outputCommitment[i];

        // 3. Range check output amount (248 bits, prevent overflow)
        outAmountCheck[i] = Num2Bits(248);
        outAmountCheck[i].in <== outAmount[i];

        // 4. Compute registry leaf value = Poseidon(pubkey, nullifierKeyHash, dataHash)
        outRegistryLeaf[i] = RegistryLeaf();
        outRegistryLeaf[i].pubkey           <== outPubkey[i];
        outRegistryLeaf[i].nullifierKeyHash <== outNullifierKeyHash[i];
        outRegistryLeaf[i].dataHash         <== outDataHash[i];

        // 5. Fixed-depth registry Merkle proof.
        // The registry uses a fixed-depth tree of depth registryLevels.
        // Key = outAliasHash[i] (aliasHash % FIELD_PRIME). Path bits = key bits.
        // Leaf hash = SMTHash1(key, leafValue) = Poseidon(key, leafValue, 1).
        // Internal node hash = Poseidon(left, right) — matches MerkleProof.circom.
        // Proof skipped for zero-amount (dummy) outputs via enabled=0.
        // outAliasHash is private — does not reveal which alias is receiving.

        // Leaf hash: Poseidon(key, leafValue, 1) — SMTHash1 convention
        outRegistryLeafHash[i] = Poseidon(3);
        outRegistryLeafHash[i].inputs[0] <== outAliasHash[i];
        outRegistryLeafHash[i].inputs[1] <== outRegistryLeaf[i].out;
        outRegistryLeafHash[i].inputs[2] <== 1;

        // Derive path bits from outAliasHash. Bits 0..registryLevels-1 are the SMT path.
        // _strict enforces the canonical (< p) decomposition — non-strict would also admit
        // bits of (outAliasHash + p), unbinding the path from the alias key.
        outAliasHashBits[i] = Num2Bits_strict();
        outAliasHashBits[i].in <== outAliasHash[i];

        // Verify Merkle path from leaf hash to registry root
        outRegistryProof[i] = MerkleProof(registryLevels);
        outRegistryProof[i].leaf <== outRegistryLeafHash[i].out;
        for (var j = 0; j < registryLevels; j++) {
            outRegistryProof[i].pathElements[j] <== outRegistrySiblings[i][j];
            outRegistryProof[i].pathIndices[j]  <== outAliasHashBits[i].out[j];
        }

        // Only enforce root equality for non-dummy (non-zero-amount) outputs
        outRegistryCheckRoot[i] = ForceEqualIfEnabled();
        outRegistryCheckRoot[i].in[0] <== registryRoot;
        outRegistryCheckRoot[i].in[1] <== outRegistryProof[i].root;
        outRegistryCheckRoot[i].enabled <== outRegistryEnabled[i];

        sumOuts += outAmount[i];
    }

    // -----------------------------------------------------------------------
    // PUBLIC AMOUNT RANGE CHECK
    // -----------------------------------------------------------------------
    // publicAmount is a signed value in the BN254 field; positive = deposit,
    // "negative" = p - withdrawAmount = withdrawal. Without a range check a
    // prover could pick a publicAmount near p/2 that satisfies conservation
    // by wrapping the field, making the deposit/withdraw distinction
    // ambiguous on-chain. Bound to balanced range [-2^248, 2^248).
    component publicAmountCheck = Num2Bits(249);
    publicAmountCheck.in <== publicAmount + (1 << 248);

    // -----------------------------------------------------------------------
    // AMOUNT CONSERVATION
    // -----------------------------------------------------------------------
    // sumIns + publicAmount === sumOuts
    // publicAmount > 0: deposit (ETH entering pool)
    // publicAmount < 0: withdrawal (ETH leaving pool)
    // publicAmount = 0: private transfer
    sumIns + publicAmount === sumOuts;

    // -----------------------------------------------------------------------
    // TRANSACTION PARAMETERS BINDING
    // -----------------------------------------------------------------------
    // paramsHash is a public input. The Groth16 verifier checks the proof against the
    // exact value the contract supplies:
    //
    //   paramsHash = keccak256(abi.encode(
    //       block.chainid,
    //       address(this),
    //       params.recipient,
    //       params.encryptedOutput0,
    //       params.encryptedOutput1,
    //       params.externalData
    //   )) % FIELD_PRIME
    //
    // Changing any field changes paramsHash and invalidates the proof, preventing a
    // front-runner from redirecting funds to a different recipient.
    // Note: exact-copy replay (same proof, same params) is still possible and causes
    // griefing (victim's tx fails with NullifierAlreadySpent). Private mempool (EIP-7742
    // / inclusion lists) eliminates this at the infrastructure layer.
    // The squaring below is a circom R1CS requirement — every signal needs ≥1 constraint.
    // All semantic enforcement is on the contract side via _computeParamsHash().
    signal paramsHashSquare <== paramsHash * paramsHash;
}

// Registry uses 32 levels (bits 0-31 of aliasHash % FIELD_PRIME).
// P(collision) ≈ n²/2^33. Acceptable at testnet scale (<10k aliases).
component main {public [
    poolRoot,
    registryRoot,
    publicAmount,
    tokenAddress,
    paramsHash,
    inputNullifier,
    outputCommitment
]} = Transact(32, 32, 2, 2);
