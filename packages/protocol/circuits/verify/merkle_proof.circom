pragma circom 2.0.0;
include "../lib/merkleProof.circom";
// Pool depth. The registry SMT walks the same template at 32.
component main = MerkleProof(16);
