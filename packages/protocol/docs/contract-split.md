# Splitting `Halias.sol`

Status: all four contracts built and tested — 143 protocol tests, mutation-verified,
including real Groth16 proofs end to end. Four security findings, all fixed. SDK ported. Reviewed against the monolith in
[security-audit.md](security-audit.md), and against audited comparable systems in
[prior-art-review.md](prior-art-review.md). `scripts/deploy.ts` is the last piece before
`Halias.sol` can be retired.

| | bytes | mutating fns |
|---|---|---|
| `HaliasPool` | 4,786 | 1 |
| `HaliasRegistry` | 3,429 | 4 |
| `HaliasDomain` | 6,557 | 11 |
| `HaliasDeployer` | 320 | 0 |
| **total** | **15,092** | **16** |

## Why

`Halias.sol` was 15,008 bytes across 47 ABI functions. One contract held custody of every
asset in the system, owned the alias namespace, minted ERC-721s, and carried an admin key
with `withdrawFees` and `rescueToken` on it.

The problem is not size, it is that the admin key and the user funds live at the same
address. An auditor reviewing the withdrawal path cannot bound their reasoning without also
ruling out every admin function, because both operate on the same balance. Splitting is
what lets the pool say *there is no key that can move your money* and have that be checkable
by reading one file.

Secondary benefits: the registry can be read by other contracts without exposing the pool,
and the naming logic can be replaced later without redeploying the pool and fragmenting the
anonymity set.

## Target

```
HaliasPool        custody, notes, nullifiers, transact     no admin, no owner, no upgrade
HaliasRegistry    the alias SMT and its published roots    one authorised writer
HaliasDomain      names, ERC-721 ownership, fees, admin    holds no user funds
```

Dependencies point one way only:

```
HaliasDomain ──writes──> HaliasRegistry <──reads── HaliasPool
     │                                                  ▲
     └───────────────── calls transact ─────────────────┘
```

The Pool never calls anything that mutates registry state. The Registry never calls anyone.

### What moves where

| From `Halias.sol` | To | Note |
|---|---|---|
| `transact`, `_transactCore`, `_checkPayment`, `_settlePayment` | Pool | done |
| `MerkleTreeWithHistory`, `spentNullifiers`, `poolTokenBalance` | Pool | done |
| `computeParamsHash`, `_verifyTransact` | Pool | done |
| `SMTRegistry` base — `_smtUpdate`, `aliasSlot`, root history, `getSmtSiblings` | Registry | |
| `register`, `_doRegister`, `_publishName`, `updateKeys`, `updateAliasData` | Domain | |
| `transferAliasWithKeys`, ERC-721 surface, `_baseURI` | Domain | |
| `registrationFee`, `accumulatedFees`, `withdrawFees` | Domain | `rescueToken` dropped — see [security-audit.md](security-audit.md) |
| `admin`, `transferAdmin`, `acceptAdmin`, `setRegistrationFee`, `setBaseTokenURI` | Domain | |
| `registerWithPoolNote` | Domain | reshaped — see below |

## The claim flow is the hard part

Everything else is a move. This one changes shape, because in the monolith it worked by
keeping the money in the same contract.

`registerWithPoolNote` lets someone with **zero ETH** register an alias by spending a note
they already hold in the pool. Today it sets `recipient == address(this)` so the withdrawn
ETH never leaves, then splits it internally between `accumulatedFees` and the relayer.

`HaliasPool` rejects that outright — `_checkPayee` reverts `BadPayee` when the pool is named
as a payee, because value the pool holds against no note is stranded forever. So the split
version has to actually move the money.

### Reshaped

The Domain contract orchestrates; the Pool's existing settlement does all the paying:

```
HaliasDomain.claim(registration, p, enc0, enc1, proof)
  1. verify keccak(registration) == p.externalData        ← binds the alias to the proof
  2. registry.register(...)                               ← new root published immediately
  3. pool.transact{...}(p, enc0, enc1, proof)             ← proves against that new root
       pool pays relayerFee     -> relayer     (directly, no Domain involvement)
       pool pays recipientPayout -> Domain      (== registrationFee)
  4. accumulatedFees += msg.value received
```

Three things fall out of this that are worth stating explicitly.

**Registration must precede the proof.** The claimer's own output note is a non-zero output,
so the circuit demands a registry membership proof for it — against the root that *includes*
their brand-new leaf. `_smtUpdate` publishes the new root before returning, so
`isKnownRegistryRoot` accepts it. This ordering is already what the monolith does
(`Halias.sol:315-317`); it is not a consequence of the split, and getting it backwards
breaks the flow.

**The Pool pays the relayer directly.** In the monolith the contract retained everything and
forwarded the fee itself. Split apart, `absAmount = registrationFee + relayerFee` settles as
two ordinary payouts — the relayer gets `relayerFee`, the Domain contract gets `recipientPayout`.
The Domain contract needs no relayer logic at all, and no `RelayerPaid` event of its own.

**The Domain contract needs a guarded `receive()`.** It is paid by `sendValue` mid-call. Accept
only from the Pool:

```solidity
receive() external payable {
    if (msg.sender != address(pool)) revert DirectETHNotAllowed();
}
```

### This is also the ownership-bug fix

`_doRegister` currently does `_mint(msg.sender, uint256(aliasHash))` (`Halias.sol:205`).
On the relayed path `msg.sender` is the **relayer**, so a relayer that submits a claim
receives the alias NFT and can call `updateKeys` to redirect every future payment to that
name. `test/Claim.test.ts:317` asserts the submitter as owner — the test encodes the bug as
expected behaviour and must be corrected alongside.

Minting to a proof-bound owner fixes it:

```solidity
externalData = keccak256(abi.encode(
    owner, aliasHash, spendingPubkey, nullifierKeyHash, encryptionPubkey
));
```

`externalData` sits inside `paramsHash`, which is a public signal the prover committed to.
A submitter can choose to submit or not; it cannot substitute itself for `owner` without
invalidating the proof. So `_mint(registration.owner, ...)` is safe on both paths, and
`register()` — where the caller pays their own fee — simply passes `msg.sender`.

This also settles the open question about `externalData` being dead surface. It has exactly
one reader, and this is it. Keep the field; the NatSpec claim that "the domain contract uses this
to tie a claim's authorisation to the note being spent" becomes true rather than aspirational.

## Deployment is circular

Pool needs Registry. Registry needs to name its controller (the Domain contract), which
needs both. Nothing can be deployed first.

**CREATE2 cannot break this**, which an earlier draft of this document got wrong. A CREATE2
address is `keccak(0xff ++ factory ++ salt ++ keccak(initCode))`, and `initCode` is
`creationCode ++ abi.encode(constructorArgs)` — see `scripts/haliasInitCode.ts:27`. So
predicting the Domain requires its constructor arguments, which are the Pool and Registry
addresses, one of which requires the Domain. The prediction is circular in exactly the way
the deployment is.

Plain CREATE is `keccak(rlp([sender, nonce]))`. Constructor arguments are not in it. That is
the escape hatch, and `HaliasDeployer` uses it on-chain:

```solidity
address predicted = _selfCreateAddress(3);                     // the Domain
registry = new HaliasRegistry(predicted);                      // nonce 1
pool     = new HaliasPool(verifier, address(registry));        // nonce 2
domain   = new HaliasDomain(address(pool), address(registry), admin);  // nonce 3
if (address(domain) != predicted) revert PredictionMismatch(predicted, address(domain));
```

A contract's nonce starts at 1 and increments per deployment, so the constructor can compute
its own third CREATE address before making the first.

Doing it on-chain rather than from a script is what makes it atomic, and that is the point
rather than a convenience. A script predicting off-chain from the deployer's nonce is correct
only while nothing else sends a transaction from that account in between. If something does,
the Registry is deployed naming a controller that will never hold code, **nothing reverts**,
and the failure surfaces later as a registration that cannot work. On-chain, either all three
exist and are wired or the transaction reverts.

Every reference stays `immutable`. No `initialize()` setter, so there is no window where the
writer is unset and no permanent function that has to be proven single-shot.

### Vanity addresses still work, and work better

The deployer's own address can be CREATE2-mined — its constructor arguments are just the
verifier and the admin, both known upfront, so there is no cycle to trip over. Every child
address is then a deterministic function of it. Mine the deployer's salt until the child you
care about carries the prefix, rather than being stuck with whichever contract happens to be
minable.

## Open decisions

**ETH has no ledger.** `poolTokenBalance` gives tokens an exact liability figure, so
`_debitPool` rejects any withdrawal exceeding the notes outstanding for that token. ETH is
checked only against `address(this).balance` — every depositor's funds pooled, and
inflatable by a forced send. The ETH branch therefore catches a withdrawal larger than the
whole pool, but not one over-drawing against other users' notes. Symmetry costs an SSTORE on
every ETH transact. The circuit's conservation constraint is the real guarantee either way;
this is defence-in-depth against an unsound circuit, and the question is what that insurance
is worth on the hot path.

**Registry root max age.** `REGISTRY_ROOT_MAX_AGE = 7200` (~1 day) is inherited unexamined.
Long enough that a stale client succeeds; long enough that a revoked alias stays spendable-to
for a day. Worth a deliberate number.

**Does the Registry need to be admin-less?** As designed it has one immutable authorised
writer and no admin, which means a Domain bug is unfixable without migrating the
namespace. That is the same trade the Pool makes deliberately. Confirm it is intended here
too rather than inherited.

## Phasing

| | | Status |
|---|---|---|
| 1 | `HaliasPool` + `IHaliasPool` | done — `Pool.test.ts`, 36 tests |
| 2 | `HaliasRegistry` from the `SMTRegistry` base | done — `HaliasRegistry.test.ts`, 16 tests |
| 3 | `HaliasDomain` — naming, ERC-721, fees, admin, claim | done — `HaliasDomain.test.ts`, 24 tests |
| 4 | Deployment wiring — `HaliasDeployer` | done — `Deployer.test.ts`, 7 tests |
| 5 | SDK: `paramsHash` preimage, split ABIs, three addresses | done — `SdkPreimage.test.ts` (8) + SDK suite (44) |
| 6 | Real-proof E2E against the split | done — `E2E.test.ts`, 5 tests |
| 7 | `scripts/deploy.ts` around `HaliasDeployer` | done — verified on a local node |
| 8 | Delete `Halias.sol` and its suites | done — 9 files deleted, `RootHistory` and `Alignment` ported |
| 9 | SDK ↔ contracts E2E | **not started — see [test-plan.md](test-plan.md)** |

## Next steps

In order, because each unblocks the next.

0. **Close the SDK ↔ contracts gap** — see [test-plan.md](test-plan.md). No proof has ever
   been built by the SDK and accepted by the pool. This comes before the Sepolia deploy
   because it finds bugs locally rather than on a testnet where each iteration costs a
   deployment.
1. ~~**Rewrite `scripts/deploy.ts` around `HaliasDeployer`.**~~ Done — one constructor call,
   wiring read back from chain, `pool`/`registry`/`domain` written to the deployment JSON.
   Original text: One constructor call replaces the
   step-by-step idempotent script; the three addresses come back off the deployer. Vanity
   mining moves to the deployer's CREATE2 salt, chosen so the *child* you care about carries
   the prefix. `deployments/<network>.json` gains `pool` / `registry` / `domain`, which the
   SDK and app already require and already fail loudly without.
2. **Redeploy to Sepolia and re-run the flow through the UI.** The current deployment is the
   monolith and predates every signature change; the app refuses to connect to it by design.
3. **Delete `Halias.sol`** and with it `Halias.test.ts`, `Registry.test.ts`,
   `Alignment.test.ts`, `Claim.test.ts`, `Guards.test.ts`, `Transact.test.ts`,
   `ERC20.test.ts`, `AliasToken.test.ts`, `Deploy.test.ts`, `RootHistory.test.ts`. Port
   anything they cover that the new suites do not — `RootHistory` and `Alignment` are the two
   worth reading carefully before they go. `Claim.test.ts:317` should be deleted rather than
   ported: it asserts the submitter owns the alias, which is the relayer bug written down as
   expected behaviour.
4. **Decide the two open design questions** in this document: whether ETH gets a ledger, and
   whether `REGISTRY_ROOT_MAX_AGE = 7200` is the number you want now that the window is
   measured from supersession rather than creation.
5. **Consider dropping `updateAliasData`.** Two of the four security findings trace to it, it
   has no consumer, and the reputation system it exists for is unbuilt. The `dataHash` field
   must stay — it is an input to the registry leaf and to the circuit's `outDataHash` signal,
   so removing it means a new ceremony — but the setter can go and come back later.
6. **Ceremony and external audit.** Both unchanged, both hard mainnet gates, neither
   addressable by anything above.

`Pool.test.ts` runs against the real `HaliasRegistry`, not a mock — the controller is just an
immutable address, so a test signer holds that role. Nothing in the suite stubs a
dependency.

The three behavioural widenings made during the extraction each have a test that fails if
the widening is reverted: the destination requirement relaxed to apply only when a payout
exists, the `uint96` ceiling on the relayer fee dropped, and relayer fees extended from ETH
to arbitrary tokens. Nine mutations were applied across both contracts — removing the
pool-as-payee guard, the ETH balance check, the fee bound, `relayerFee` from the
`paramsHash` preimage, the `msg.value` expectation, `onlyController`, `AliasTaken`, the
`dataHash` reset on reassignment, and `dataHash` from the leaf — and every one was caught.

`HaliasRegistry` rebuilds its root alongside an independently constructed off-chain SMT
through registration, rotation and a data write. That agreement is what every proof depends
on; if the two implementations diverge, verification stops working before anything else
does.

The ownership fix has its own regression test. `HaliasDomain.test.ts` reverts `_mint` to
`msg.sender` — the exact monolith bug — and *"a relayer submitting a claim does not receive
the alias"* fails. Four further mutations on that contract (dropping the `externalData`
binding, the payout check, the `receive()` guard, and `onlyAliasOwner`) were each caught.

`test/Claim.test.ts:317` still asserts the submitter as owner against the monolith. It is
the test that encoded the bug as correct, and it should be retired with `Halias.sol` rather
than fixed — the split version replaces it.

## Real-proof coverage

`E2E.test.ts` is the file that unblocks deleting the monolith. Every other test of the new
contracts uses `MockTransactVerifier`, which accepts anything — fine for checking where
value goes, useless for whether the circuit still verifies after the contracts were taken
apart. Before it existed, all four real-verifier suites targeted `Halias.sol`, so deleting
the monolith would have deleted 100% of the project's real-proof coverage.

It deploys through `HaliasDeployer` against the real `TransactVerifier` and runs a deposit,
a private transfer, and a relayer-fee withdrawal with genuine Groth16 proofs. The load-bearing
case is the last one: a proof built for one `recipient`, then submitted with another, must be
rejected — and the untampered proof must still work, so the rejection is the tampering rather
than something incidental. That is the only place a `paramsHash` preimage error surfaces at
all; a wrong preimage is not a revert with a name, it is a proof that verifies against
nothing.

Three bugs in the harness itself were worth recording, because each produced a bare circuit
assert with no indication of cause: a dummy input's nullifier must be *derived* from its key
and leaf index rather than random; the nullifier derives from the nullifier key, not from the
key hash the registry stores; and the registry stores `Poseidon(nullifierKey, 1)`, not
`Poseidon(key)`.

Also outstanding from the extraction: `_computeParamsHash` now hashes a `RelayerFee` struct
instead of a packed word. `SdkAbi.test.ts` compares ABI fragments, which will **not** catch
this — a preimage fixture asserting the SDK's computed hash equals `computeParamsHash` is
needed before the SDK can build a valid proof against the new pool.

## What does not change

The circuit. `transact.circom` is frozen at 77,726 constraints and none of this touches it:
`paramsHash` is opaque to the circuit — a single field element it constrains without
interpreting — so the contract may redefine what goes into the preimage freely. No new
ceremony for any phase here.
