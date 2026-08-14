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
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  HaliasController (ERC-721)     │ writes │  HaliasRegistry                  │
│  Names, ownership, fee      ├───────►│  aliasHash → pubkeys + dataHash  │
│  The only admin key         │        │  An SMT the circuit proves into  │
│  Holds no user funds        │        │  One writer, no admin            │
└──────────┬──────────────────┘        └──────────────▲───────────────────┘
           │                                          │ reads roots
           │ calls transact                           │
┌──────────▼──────────────────────────────────────────┴───────────────────┐
│  HaliasPool                                                             │
│  UTXO commitments, Poseidon hashing, Groth16                            │
│  ONE mutating function. No admin, no owner, no upgrade path.            │
│                                                                         │
│  Circuit proves:                                                        │
│    1. Sender owns the input commitment                                  │
│    2. Recipient pubkey exists in registry root                          │
│    3. Nullifier is valid and unspent                                    │
│    4. Sum of inputs = sum of outputs                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

Registry and pool are tightly coupled at the *circuit* level and deliberately separate at the
*contract* level. The circuit spans both; the addresses do not. That is what lets the pool
say there is no key that can move your money, and have it be checkable by reading one file —
the admin lives on `HaliasController`, which holds nothing but registration revenue.

All three are deployed already wired by `HaliasDeployer`, in one transaction. Their
dependencies form a cycle — the pool reads the registry, the domain writes to it, and the
registry must name its controller before that contract exists — which CREATE2 cannot break,
because a CREATE2 address depends on the constructor arguments. Plain CREATE does not, so the
deployer computes its own third address, closes the loop, and asserts it was right.

The registry acts as a universal naming layer for private payments, where every `.hls` alias
is an NFT that controls a shielded identity.

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
Generates a ZK proof of ownership and withdraws ETH to any address. A user with no ETH can
name a relayer in the proof and pay for inclusion out of the withdrawal itself — the pool
settles both destinations, so no paymaster, sponsor, or deposit is involved.

## Component Summary

| Component | Status | Purpose |
|---|---|---|
| **HaliasPool.sol** | **Locked-Ready** | Custody, note commitments, nullifiers, `transact`. One mutating function, no admin, no owner, no upgrade path. |
| **HaliasRegistry.sol** | **Locked-Ready** | The alias SMT and the roots the pool proves against. In-place key rotation. One immutable writer, no admin. |
| **HaliasController.sol** | **Locked-Ready** | Names, ERC-721 ownership, registration fee, admin. Holds no user funds. |
| **HaliasDeployer.sol** | **Locked-Ready** | Brings all three up wired in one transaction, breaking their dependency cycle without a post-deploy setter. |
| **transact.circom** | **Locked-Ready** | Unified circuit (2-in/2-out). Spans identity and money layers. Untouched by the split — no new ceremony. |
| **SDK** | **Active** | TypeScript library for proof generation, event scanning, and key management. |

> `Halias.sol`, the pre-split monolith, is still in the tree and is what the current Sepolia
> deployment runs. `scripts/deploy.ts` still targets it and is the last thing blocking its
> removal.

## Threat Model & Security

- **ZK-Binding:** All transaction parameters (recipient, encrypted outputs, etc.) are hashed into `paramsHash`, which is a public signal in the ZK proof. This prevents "Relayer Front-running" or tampering with the withdrawal destination.
- **Key Substitution:** The `nullifierKey` is bound into the commitment. A user cannot double-spend a UTXO by deriving a different nullifier with a different viewing key.
- **Identity Integrity:** The "Reset on Transfer" policy prevents "reputation laundering" via NFT sales.
- **Gas Privacy:** The relayer fee is bound inside `paramsHash`, so a user with no ETH can pay for inclusion out of their own shielded funds — breaking the link between the gas-paying address and the withdrawal recipient. No paymaster, sponsor, or account-abstraction dependency.
- **Custody Separation:** The contract holding every user's funds has no admin key at all. In the pre-split monolith a single subtraction in `rescueToken` was the only thing between the admin and user collateral; now there is nothing to check, because the admin cannot address it.
- **Claim Authorisation:** A claim's registration — including its owner — is hashed into `externalData` and committed inside `paramsHash`. A relayer that submits a claim cannot mint the alias to itself.

## Roadmap (v2 & Beyond)

- **Privacy Score:** Warn users about timing correlations or small anonymity sets before they withdraw.
- **DeFi Composability:** account-abstraction bundling enables private DeFi interactions (swaps, lending) without embedding call-routing into the circuit — composability happens at the bundler layer, not the protocol layer.
- **Proof of Innocence:** a Railgun-style provenance proof, published by independent parties and honoured by relayers rather than enforced by the pool. Building the enforcement into `transact` would hand the deployer a freeze key over user funds, which is the opposite of what the split just bought.
- **Attestation circuits:** Prove attributes about the `dataHash` (e.g., "I am over 18") without revealing the hash or the alias.
- **ENS Integration:** Standalone resolver to make `.hls` names usable across the broader Ethereum ecosystem.

## Built on Audited Foundations

- Transact circuit adapted from [Tornado Cash Nova](https://github.com/tornadocash/tornado-nova) (GPL-3.0)
- Registry membership proof based on [Semaphore](https://github.com/semaphore-protocol/semaphore) (MIT, EF-audited)
- Primitives from [circomlib](https://github.com/iden3/circomlib): Poseidon, BabyJubJub, comparators (GPL-3.0)

Reviewed against those foundations rather than only alongside them: published findings from
the Semaphore audit and World ID's root-history implementation were checked against this
code, and both real bugs found in the most recent review came from that comparison rather
than from re-reading our own contracts. See
[docs/prior-art-review.md](packages/protocol/docs/prior-art-review.md).

**Not yet audited externally, and the trusted setup is still a single self-generated
ceremony with a `--dev` phase 2.** Both gate mainnet.
