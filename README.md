# halias

**Identity-aware private payments on Ethereum.**

Register an alias. Send and receive ETH. Every transfer provably goes between registered identities — but which identities remain hidden.

*halias = Hal (Finney) + alias*

## Thesis

Privacy protocols (Railgun, Tornado, Aztec) and naming services (ENS, Fluidkey) exist as separate systems. halias integrates both at the circuit level — the ZK proof spans the identity registry and the payment pool. This enables a class of features that neither layer can provide alone:

**Name-verified transfers** — the circuit proves the recipient is a registered `.hls` alias without revealing which one. The pool only allows transfers between registered identities. This is compliance by construction, not after-the-fact attestation.

**Private reputation** — prove statements about your on-chain history ("my alias has been registered >6 months", "I've received >10 transfers") without revealing your alias. Privacy-preserving credit scoring and sybil resistance.

**Private social proof** — prove you've transacted with a specific `.hls` alias without revealing yours. Trust networks and references without deanonymization.

**Private payroll** — prove N registered employees were paid the correct total, without revealing who got what.

No existing protocol can do this. Railgun can't add it without adopting a naming registry into their circuits. Fluidkey can't add it without rebuilding their stealth address model into a ZK pool. The moat is the intersection of identity and money at the proof level.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  .hls Registry (ERC-721)                         │
│  On-chain mapping: aliasHash → pubkeys + data    │
│  Maintained as an SMT for ZK circuit access      │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│  Privacy Pool                                    │
│  UTXO commitments, Poseidon hashing, Groth16     │
│                                                  │
│  Circuit proves:                                 │
│    1. Sender owns the input commitment           │
│    2. Recipient pubkey exists in registry root   │
│    3. Nullifier is valid and unspent             │
│    4. Sum of inputs = sum of outputs             │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│  SDK (ERC-4337 gas abstraction)                  │
│                                                  │
│  Gas paid via:                                   │
│    - HaliasPaymaster (Pool-funded or Vouchers)   │
│    - Direct (privacy tradeoff)                   │
└──────────────────────────────────────────────────┘
```

The registry and pool are tightly coupled at the circuit level but deployed as a single contract. The registry acts as a universal naming layer for private payments, where every `.hls` alias is an NFT that controls a shielded identity.

## How It Works

### Registration
```
halias register alice.hls
```
Registers a `.hls` alias as an ERC-721 token, mapping it to your spending + nullifier + encryption pubkeys. Aliases are hashed (`keccak256`) before storage. A registry Merkle leaf `Poseidon(spendingPubkey, nullifierKey, dataHash)` is inserted.

### Identity Evolution
```
halias update-data alice.hls <newDataHash>
```
Owners can update their `dataHash` to commit to new attestations (e.g., humanity score, KYC tier) without changing their ZK keys. 

**Reset on Transfer:** To maintain identity integrity, the `dataHash` is automatically reset to `0` whenever an alias NFT is transferred. This ensures reputation is soulbound to the user, not the name.

### Deposit
```
halias deposit 0.5
```
Deposits ETH into the shared pool. The commitment is blinded with a random factor, making it impossible for observers to link the deposit to your alias.

### Send
```
halias send bob.hls 0.5
```
Resolves `bob.hls` → pubkeys. Generates a ZK proof that:
1. You own an input commitment of sufficient value
2. Bob's pubkey exists in the registry SMT
3. Sum of inputs = sum of outputs

The proof is bound to a `paramsHash` which covers the recipient, call data, and an `externalData` commitment for future extensibility.

### Withdraw
```
halias withdraw 0xAddress 0.5
```
Generates a ZK proof of ownership and withdraws ETH to any address. Gas can be sponsored by the pool itself via the `HaliasPaymaster`.

## Component Summary

| Component | Status | Purpose |
|---|---|---|
| **Halias.sol** | **Locked-Ready** | Core hub. Manages the UTXO pool, the SMT registry, and the unified `transact` entry point. |
| **transact.circom** | **Locked-Ready** | Unified circuit (2-in/2-out). Spans identity and money layers. |
| **HaliasPaymaster.sol** | **Flexible** | ERC-4337 Paymaster. Supports pool-funded gas and voucher-based onboarding. |
| **SDK** | **Active** | TypeScript library for proof generation, event scanning, and key management. |

## Threat Model & Security

- **ZK-Binding:** All transaction parameters (recipient, encrypted outputs, etc.) are hashed into `paramsHash`, which is a public signal in the ZK proof. This prevents "Relayer Front-running" or tampering with the withdrawal destination.
- **Key Substitution:** The `nullifierKey` is bound into the commitment. A user cannot double-spend a UTXO by deriving a different nullifier with a different viewing key.
- **Identity Integrity:** The "Reset on Transfer" policy prevents "reputation laundering" via NFT sales.
- **Gas Privacy:** Using the `HaliasPaymaster` allows users to pay gas directly from their shielded pool balance, breaking the link between the gas-paying address and the withdrawal recipient.

## Roadmap (v2 & Beyond)

- **Privacy Score:** Warn users about timing correlations or small anonymity sets before they withdraw.
- **DeFi Composability:** ERC-4337 UserOp bundling enables private DeFi interactions (swaps, lending) without embedding call-routing into the circuit — composability happens at the bundler layer, not the protocol layer.
- **Attestation circuits:** Prove attributes about the `dataHash` (e.g., "I am over 18") without revealing the hash or the alias.
- **ENS Integration:** Standalone resolver to make `.hls` names usable across the broader Ethereum ecosystem.

## Built on Audited Foundations

- Transact circuit adapted from [Tornado Cash Nova](https://github.com/tornadocash/tornado-nova) (GPL-3.0)
- Registry membership proof based on [Semaphore](https://github.com/semaphore-protocol/semaphore) (MIT, EF-audited)
- Primitives from [circomlib](https://github.com/iden3/circomlib): Poseidon, BabyJubJub, comparators (GPL-3.0)
