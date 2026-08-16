// SPDX-License-Identifier: GPL-3.0
// Copyright 2026 halias contributors.
//
// Adapted from Tornado Cash Nova (GPL-3.0) and built on circomlib (GPL-3.0).
pragma circom 2.0.0;

include "poseidon.circom";
include "bitify.circom";
include "comparators.circom";
include "merkleProof.circom";
include "notes.circom";

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
//   commitment = Poseidon(spendingCommitment, nullifierKey, blinding, amount, tokenAddress)
//   nullifier  = Poseidon(nullifierKey, leafIndex)  [computed at spend time]
//   spendingCommitment     = Poseidon(spendingPrivateKey)        [no elliptic curve needed]
//   nullifierKey = Poseidon(viewingPrivateKey)       [also the audit/viewing key]
//
// Registry leaf:
//   leaf = Poseidon(spendingCommitment, nullifierKey, dataHash)
//
// Key hierarchy (off-chain, SDK):
//   MetaMask signature
//     ├── spendingPrivateKey  → spendingCommitment      = Poseidon(spendingPrivateKey) [in circuit]
//     ├── viewingPrivateKey   → nullifierKey = Poseidon(viewingPrivateKey)  [in circuit]
//     └── encryptionKeypair   → X25519 (off-chain only, circuit-agnostic)
//
// Encryption (off-chain only):
//   Note data (blinding, amount) is encrypted to the recipient's X25519
//   public key and emitted in contract events. The circuit is agnostic
//   to the encryption scheme — it only proves commitment/nullifier math.
//

// ---------------------------------------------------------------------------
// Main Transact circuit
//
// poolLevels:     depth of pool commitment Merkle tree (e.g. 32)
// registryLevels: depth of registry SMT (e.g. 32)
// nIns:           number of inputs (2)
// nOuts:          number of outputs (2)
// ---------------------------------------------------------------------------
template Transact(poolLevels, registryLevels, nIns, nOuts, withClaim) {

    // === Public inputs ===
    // Per input, because two notes may legitimately live in different trees and forcing them
    // to share one would mean a holder could not spend a note from tree 3 alongside one from
    // tree 5. A dummy (zero-amount) input skips the Merkle check, so its pair is unconstrained
    // here — but the pool still checks the root it names, so it must name a real one.
    signal input poolRoot[nIns];
    signal input treeNumber[nIns];
    signal input registryRoot;
    signal input publicAmount;           // positive = deposit, negative = withdraw, 0 = transfer
    signal input tokenAddress;           // which token (0 for ETH)
    signal input paramsHash;             // hash of transaction params (TransactParams)
    signal input pendingLeaf;            // registry insertion this transaction performs; 0 for ordinary
    signal input outputsEmpty;           // 1 iff both outputs are zero-amount — the exit path
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
    signal input outSpendingCommitment[nOuts];
    signal input outBlinding[nOuts];
    signal input outAmount[nOuts];

    // === Private inputs — registry proofs (per output) ===
    signal input outNullifierKeyHash[nOuts];                         // Poseidon(nullifierKey, 1) — hash stored in registry; raw key stays with recipient
    signal input outDataHash[nOuts];                                 // recipient's dataHash (from registry)
    signal input outAliasHash[nOuts];                                // aliasHash % FIELD_PRIME — identity bound into the leaf
    signal input outRegistryIndex[nOuts];                            // registration slot — the tree position
    signal input outRegistrySiblings[nOuts][registryLevels];         // SMT sibling hashes
    // Position and identity are separate. The leaf hashes outAliasHash, so membership
    // still proves "this alias holds these keys"; the path follows outRegistryIndex, the
    // slot the contract assigned at registration.
    //
    // Deriving the path from outAliasHash instead would let two aliases contend for one
    // slot, which at any depth cheap enough to be worth having is a grindable way to
    // block a name permanently. Assigned slots cannot collide at all, so the tree can be
    // half as deep. It also removes the need for Num2Bits_strict: an index below
    // 2^registryLevels has only one decomposition, whereas a full field element has two.

    // === Private inputs — the pending registration (claim path only) ===
    signal input pendingSlot;                            // slot the insertion occupies
    signal input pendingSiblings[registryLevels];        // its siblings in the tree at registryRoot

    // -----------------------------------------------------------------------
    // INPUT VERIFICATION
    // -----------------------------------------------------------------------

    component inSpendingCommitment[nIns];
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
        inSpendingCommitment[i] = Poseidon(1);
        inSpendingCommitment[i].inputs[0] <== inSpendingPrivateKey[i];

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
        inCommitment[i].spendingCommitment <== inSpendingCommitment[i].out;
        inCommitment[i].nullifierKeyHash <== inNullifierKeyHash[i].out;
        inCommitment[i].blinding <== inBlinding[i];
        inCommitment[i].amount <== inAmount[i];
        inCommitment[i].tokenAddress <== tokenAddress;

        // 4. Compute nullifier = Poseidon(nullifierKey, leafIndex)
        inNullifier[i] = NoteNullifier(poolLevels);
        inNullifier[i].nullifierKey <== inNullifierKey[i].out;
        inNullifier[i].treeNumber   <== treeNumber[i];
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
        inCheckRoot[i].in[0] <== poolRoot[i];
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
    // PENDING REGISTRATION — the root outputs are actually checked against
    // -----------------------------------------------------------------------
    //
    // A claim is the one operation whose outputs must prove membership in a tree that does
    // not exist yet: the claimer's own alias has to be registered before their change note
    // can prove against it, so the client used to *predict* the post-registration root. Any
    // other registry write landing in between changed the tree, the prediction was wrong,
    // and the claim reverted — which made blocking someone's onboarding cheap and repeatable.
    //
    // Instead the proof does the insertion itself. `registryRoot` is the root *before* the
    // registration — a root that already exists on chain and is inside the freshness window —
    // and the circuit derives the tree that results from adding `pendingLeaf` at
    // `pendingSlot`. Nothing is predicted, so nothing another party does can invalidate it.
    //
    // Two properties make this safe, and both are load-bearing:
    //
    //   1. `pendingLeaf` is PUBLIC and set by the contract, never by the prover. A prover who
    //      could set it would insert their own unregistered keys into a tree of their
    //      choosing and pay themselves, destroying "you can only send to a registered alias"
    //      — the entire reason the registry proof exists. `HaliasPool` requires it to equal
    //      the value the registry armed, which is zero on every path except a claim.
    //
    //   2. `pendingSiblings` is proved against `registryRoot` before being reused. Deriving
    //      the post-root from unconstrained siblings would let a prover fabricate ANY tree
    //      whenever `pendingLeaf` is non-zero, which makes membership vacuous on exactly the
    //      path that mints new aliases. Proving the slot currently holds the empty leaf ties
    //      those siblings to the real tree, and has a second effect worth having: the
    //      insertion can only land on a free slot, so it can never overwrite someone else's.
    //
    // The slot needing to match the one the registry actually assigned is NOT required. A
    // registry proof establishes "these keys belong to a registered alias"; the slot appears
    // nowhere in a note commitment, so the change note stays spendable later against the real
    // tree at its real position. Only the root value is load-bearing.
    // Split out of the ordinary path, because R1CS enforces every constraint on every
    // proof. With one circuit, a plain transfer paid for two full registry Merkle proofs and
    // a mux that did nothing — 33,322 constraints, 35% of the circuit, spent on machinery
    // that only a claim uses.
    //
    // `withClaim` is a template parameter, so the branch is taken at compile time and each
    // circuit gets only the constraints it needs. One source of truth rather than two files
    // that drift: transactClaim.circom compiles this with 1 and its r1cs is byte-identical to
    // the single circuit that preceded it, which is what proves the claim path unchanged.
    signal effectiveRoot;
    if (withClaim == 1) {
        component pendingIsZero = IsZero();
        pendingIsZero.in <== pendingLeaf;
        signal isOrdinary <== pendingIsZero.out;

        component pendingBits = Num2Bits(registryLevels);
        pendingBits.in <== pendingSlot;

        // The slot is empty in the tree at registryRoot. Empty subtrees are built from
        // zeros[0] = 0 (see SMTRegistry._initSMT), so an unoccupied leaf hashes as 0.
        component pendingEmpty = MerkleProof(registryLevels);
        pendingEmpty.leaf <== 0;
        for (var j = 0; j < registryLevels; j++) {
            pendingEmpty.pathElements[j] <== pendingSiblings[j];
            pendingEmpty.pathIndices[j]  <== pendingBits.out[j];
        }
        component pendingEmptyCheck = ForceEqualIfEnabled();
        pendingEmptyCheck.in[0] <== registryRoot;
        pendingEmptyCheck.in[1] <== pendingEmpty.root;
        pendingEmptyCheck.enabled <== 1 - isOrdinary;

        // The same slot and siblings, now holding the pending leaf: the post-insertion root.
        component pendingInsert = MerkleProof(registryLevels);
        pendingInsert.leaf <== pendingLeaf;
        for (var j = 0; j < registryLevels; j++) {
            pendingInsert.pathElements[j] <== pendingSiblings[j];
            pendingInsert.pathIndices[j]  <== pendingBits.out[j];
        }

        // effectiveRoot = isOrdinary ? registryRoot : pendingInsert.root.
        // Written as an offset from registryRoot so it stays one multiplication: R1CS allows a
        // single product per constraint, and the direct form has two.
        signal pendingDelta <== pendingInsert.root - registryRoot;
        effectiveRoot <== registryRoot + (1 - isOrdinary) * pendingDelta;
    } else {
        // Nothing is being inserted, so the tree a proof checks against is the current one.
        //
        // `pendingLeaf` stays a public signal here, forced to zero, rather than being removed.
        // Dropping it would give the two circuits different public-signal layouts, and the pool
        // would need two params structs, two pubSignals arrays and two events — three places to
        // get an index wrong, on a value whose whole job is to stop an unproved registry
        // insertion. Keeping it costs one public input and one constraint, and buys a stack
        // where the ONLY difference between an ordinary transaction and a claim is which
        // verifier address is called.
        //
        // Forced rather than merely unused: an ordinary proof cannot express an insertion at
        // all, so the pool's existing `pendingLeaf == armed` check is sufficient on its own.
        pendingLeaf === 0;
        effectiveRoot <== registryRoot;
    }

    // -----------------------------------------------------------------------
    // OUTPUT VERIFICATION
    // -----------------------------------------------------------------------

    // ForceEqualIfEnabled.enabled must be binary (0 or 1), so we convert outAmount to 0/1.
    component outAmountNz[nOuts];
    signal outRegistryEnabled[nOuts];

    component outCommitment[nOuts];
    component outAmountCheck[nOuts];
    component outIndexBits[nOuts];
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
        outCommitment[i].spendingCommitment <== outSpendingCommitment[i];
        outCommitment[i].nullifierKeyHash <== outNullifierKeyHash[i];
        outCommitment[i].blinding <== outBlinding[i];
        outCommitment[i].amount <== outAmount[i];
        outCommitment[i].tokenAddress <== tokenAddress;
        outCommitment[i].out === outputCommitment[i];

        // 3. Range check output amount (248 bits, prevent overflow)
        outAmountCheck[i] = Num2Bits(248);
        outAmountCheck[i].in <== outAmount[i];

        // 4. Compute registry leaf value = Poseidon(spendingCommitment, nullifierKeyHash, dataHash)
        outRegistryLeaf[i] = RegistryLeaf();
        outRegistryLeaf[i].spendingCommitment           <== outSpendingCommitment[i];
        outRegistryLeaf[i].nullifierKeyHash <== outNullifierKeyHash[i];
        outRegistryLeaf[i].dataHash         <== outDataHash[i];

        // 5. Fixed-depth registry Merkle proof.
        // Leaf hash = SMTHash1(aliasKey, leafValue) = Poseidon(aliasKey, leafValue, 1).
        // Internal node hash = Poseidon(left, right) — matches MerkleProof.circom.
        // Proof skipped for zero-amount (dummy) outputs via enabled=0.
        // Both the alias and its slot stay private, so nothing reveals who is receiving.

        // The leaf commits to the alias itself. That is what makes the index safe to take
        // as an input: only one leaf in the tree hashes this aliasHash, so a prover cannot
        // point at some other alias's slot and still satisfy this.
        outRegistryLeafHash[i] = Poseidon(3);
        outRegistryLeafHash[i].inputs[0] <== outAliasHash[i];
        outRegistryLeafHash[i].inputs[1] <== outRegistryLeaf[i].out;
        outRegistryLeafHash[i].inputs[2] <== 1;

        // Path bits come from the slot. Num2Bits(registryLevels) both decomposes and
        // bounds it: a value >= 2^registryLevels has no satisfying decomposition, and
        // below that the representation is unique, so no aliasing is possible.
        outIndexBits[i] = Num2Bits(registryLevels);
        outIndexBits[i].in <== outRegistryIndex[i];

        // Verify Merkle path from leaf hash to registry root
        outRegistryProof[i] = MerkleProof(registryLevels);
        outRegistryProof[i].leaf <== outRegistryLeafHash[i].out;
        for (var j = 0; j < registryLevels; j++) {
            outRegistryProof[i].pathElements[j] <== outRegistrySiblings[i][j];
            outRegistryProof[i].pathIndices[j]  <== outIndexBits[i].out[j];
        }

        // Only enforce root equality for non-dummy (non-zero-amount) outputs.
        // Against effectiveRoot, not registryRoot: on a claim that is the tree including the
        // claimer's own brand-new registration, which is what lets their change note prove
        // membership without anyone having to predict a root.
        outRegistryCheckRoot[i] = ForceEqualIfEnabled();
        outRegistryCheckRoot[i].in[0] <== effectiveRoot;
        outRegistryCheckRoot[i].in[1] <== outRegistryProof[i].root;
        outRegistryCheckRoot[i].enabled <== outRegistryEnabled[i];

        sumOuts += outAmount[i];
    }

    // -----------------------------------------------------------------------
    // EXIT PATH
    // -----------------------------------------------------------------------
    // Public, so the pool can skip inserting anything when this is set.
    //
    // A full pool does not degrade — every transact inserts two output commitments, so once
    // the tree cannot accept them, deposits, transfers AND withdrawals all revert and every
    // note in the pool becomes permanently unspendable, with no admin to rescue it. This is
    // the valve: a transaction that spends its inputs and creates nothing. Conservation then
    // forces `publicAmount = -sumIns`, which is exactly a total withdrawal.
    //
    // It has to be proven rather than asserted by the caller. If the pool simply skipped
    // insertion on request, a client could ask for it while holding non-zero outputs and
    // destroy its own change — the value would stay in the pool with no note able to claim
    // it. Deriving the flag from the amounts makes that unrepresentable.
    //
    // The implication is deliberately ONE-WAY: setting the flag requires empty outputs, but
    // empty outputs do not require the flag.
    //
    // Equality would make the exit path mandatory rather than optional, because a full
    // withdrawal already has both outputs at zero — so every "take everything out" would
    // become publicly distinguishable, which is a privacy regression, not a feature. Leaving
    // it one-way means a caller with nothing to keep can still take the ordinary path and
    // insert two dummy commitments, exactly as before, and pay for the uniformity. The cheap
    // path is then a choice with a stated cost rather than something the amounts force.
    //
    // Nearly free: outAmountNz[i] is already computed above for the registry enable flag,
    // so this is one multiplication per output plus two constraints here.
    signal emptyAcc[nOuts + 1];
    emptyAcc[0] <== 1;
    for (var i = 0; i < nOuts; i++) {
        emptyAcc[i + 1] <== emptyAcc[i] * outAmountNz[i].out;
    }
    // Binary, because it is a public input the prover supplies rather than a derived signal.
    outputsEmpty * (1 - outputsEmpty) === 0;
    // Set ⇒ empty. Unset ⇒ unconstrained, which is the ordinary path.
    outputsEmpty * (1 - emptyAcc[nOuts]) === 0;

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
    // TOKEN ADDRESS RANGE CHECK
    // -----------------------------------------------------------------------
    // tokenAddress is an EVM address (0 = ETH). Bounding it to 160 bits keeps a
    // token's note-namespace canonical — high-bit variants can't alias the same
    // uint160 token on-chain. (Sound: 160 < 254, so the decomposition is unique.)
    component tokenAddressCheck = Num2Bits(160);
    tokenAddressCheck.in <== tokenAddress;

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
    //       params.relayerFee,         // struct: (address relayer, uint256 amount)
    //       params.externalData        // opaque application data, uninterpreted
    //   )) % FIELD_PRIME
    //
    // This preimage is opaque to the circuit — paramsHash arrives as a single field
    // element and is never decomposed here, which is why the contract can change what it
    // commits to without a new ceremony. Nothing in the circuit can detect a mismatch, so
    // the only thing keeping prover and verifier in agreement is that both derive it from
    // HaliasPool.computeParamsHash(). Clients must call it rather than reimplement it,
    // and the SDK parity test is what enforces that.
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

