// ZK Circuits 
// division in ZK circuits requires you to find the number that when multiplied by 3 gives you itself modulo 7.
// In this case, the number is 5, because 3 * 5 = 15, and 15 mod 7 = 1. this is effective
// basically it's saying that a*b mod p = c where:
//  p - a prime number (in this case, 7)
//  c - the result of the multiplication of a and b modulo p
//  a - the number you want to find (in this case, 5)
//  b - the number you are multiplying by (in this case, 3)

// With circuits you can also do all arithmetic operations. All values in the equation can also be either public or private. For proving that you know the private input, it is usually done by taking the hash of the private input. Only sharing the hash of the private input allows you to prove that you know the private input without revealing it. This is a fundamental concept in ZK proofs, as it allows you to maintain privacy while still proving knowledge of certain information. 

The commitment is one value inside the witness. The witness is everything.
Say the circuit has these signals:
Private (hidden):

spending_key
amount
nullifier_secret
randomness
merkle_path[]

Public (visible):

commitment (the Poseidon hash of the private stuff)
merkle_root
nullifier_hash

The witness is all of these values together — private and public. It's the full assignment that satisfies every constraint in the circuit.
The commitment is just one signal within that witness — specifically the hash that was computed from your secrets and stored on-chain. The circuit proves "these private values in my witness hash to this public commitment, and that commitment lives in the tree."
So: witness = the whole answer sheet. Commitment = one answer on the sheet that also happens to be publicly visible on-chain.


Per-transaction (client-side, every time a user deposits/withdraws):
- Compute witness from inputs
- Generate proof using proving key
- Submit proof + public signals to the contract

## Building 

One-time (at build/deploy):
- Compile Circom circuit
- Powers of tau ceremony
- Phase 2 ceremony
- Generate proving key + verification key
- Export and deploy Solidity verifier contract
## Step 1 - Compile the circuit, the circuit generates the proof and captures the witness (all data of computation)
`circom multiplier.circom --r1cs --wasm --sym --c`

`circom src/circuits/multiplier.circom --r1cs --wasm --sym --c -o src/circuits/out`

>Since version 2.0.8, we can use the option -l to indicate the directory where the directive include should look for the circuits indicated.

## Step 2 - Create input.json to configure the required input values

```json
{"a": "3", "b": "11"}
```

## Step 3 - Generate the witness 

`cd src/circuits/out`

`node generate_witness.js multiplier.wasm input.json witness.wtns`

## Step 4
First, we start a new "powers of tau" ceremony:
- This is used to add entropy to the dapp 
- 



