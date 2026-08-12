pragma circom 2.0.0;

include "poseidon.circom";
include "bitify.circom";

// The note, nullifier and registry-leaf templates, factored out of transact.circom so each
// can be instantiated on its own. That is not cosmetic: transact.circom declares a `main`
// with no output signals, which makes Ecne's and Picus's default verdicts vacuous and
// Picus's --strong mode undecidable at 94k constraints. These templates DO have outputs, so
// wrapping one in a main (see ../verify/) gives an under-constrainedness checker a question
// it can actually answer. See docs/static-analysis.md.

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
    signal input treeNumber;
    signal input pathIndices[levels];
    signal output out;

    // Pack pathIndices bits into leafIndex signal.
    //
    // The binary constraint is here rather than borrowed from elsewhere. Bits2Num does not
    // bound its own inputs, so if pathIndices were free field elements a prover could repack
    // one note's path into a different leafIndex, derive a second nullifier for it, and
    // spend it twice. Today MerkleProof happens to constrain these same signals — but that
    // is a different template, and this one is only sound for as long as MerkleProof stays
    // instantiated unconditionally beside it. Constraining locally costs `levels` constraints
    // per input and makes the nullifier sound on its own terms.
    //
    // Flagged by circomspect (Trail of Bits) as a non-strict binary conversion; the aliasing
    // it warns about cannot occur at levels=32, but the missing input bound was real.
    component leafIndexBits = Bits2Num(levels);
    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        leafIndexBits.in[i] <== pathIndices[i];
    }

    // The nullifier must key on the note's GLOBAL position, not its position within its
    // tree. Pool commitments live in a sequence of trees and `pathIndices` addresses only
    // within one, so leaf 5 of tree 0 and leaf 5 of tree 3 would otherwise hash to the same
    // nullifier — and whichever note was spent second would read as already spent and become
    // permanently unspendable by anyone. Silent, irreversible, and invisible to any test that
    // uses a single tree.
    //
    // `treeNumber` is bounded so globalIndex stays under 2^32 and its decomposition is
    // unique. It is also a PUBLIC signal of the main component, checked on chain against the
    // tree the proof's root belongs to — without that binding a prover could re-spend one
    // note under a different tree number and mint a fresh nullifier every time.
    component treeBits = Num2Bits(32 - levels);
    treeBits.in <== treeNumber;
    signal globalIndex <== treeNumber * (1 << levels) + leafIndexBits.out;

    // 3-input hash so the nullifier sits in a different Poseidon domain than
    // nullifierKeyHash = Poseidon(nullifierKey, 1) — they can never collide,
    // so a spend never reveals a value linkable to the public registry key-hash.
    component hasher = Poseidon(3);
    hasher.inputs[0] <== nullifierKey;
    hasher.inputs[1] <== globalIndex;
    hasher.inputs[2] <== 1314148940; // NULLIFIER_DOMAIN ("NULL" ascii)
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

