# Security review: the split, against `Halias.sol`

Internal review, not a substitute for an external audit. Two passes, because they find
different things.

**Differential** — read every guard in the monolith, find its counterpart in the split, and
account for each one that has none. This catches regressions, and nothing else: a bug
present in both implementations is invisible to it, as is anything in code with no monolith
counterpart.

**Standalone** — audit the split on its own terms, assuming nothing about the monolith
being correct. This is where `HaliasDeployer`, the reshaped claim, the payee and ledger
helpers, and the circuit/contract boundary get examined, and where the one property below
that both implementations share was found.

Covered: `HaliasPool`, `HaliasRegistry`, `HaliasDomain`, `HaliasDeployer` against
`Halias.sol`.

**Result: four findings, all fixed.** Two were real and demonstrated — an out-of-field
`dataHash` silently collapsing distinct records onto one leaf, and registry roots born
already expired. Neither was a fund-loss vulnerability; both quietly corrupt assumptions
other things get built on. The other two were hardening. Notably, neither real finding came
from re-reading our own code — see [prior-art-review.md](prior-art-review.md).

## The result that matters

| | monolith | split |
|---|---|---|
| Mutating functions on the contract holding user funds | 13 | **1** |
| Admin functions reachable from user funds | 6 | **0** |
| Guards needed to keep admin away from collateral | 1 (`RescueExceedsAvailable`) | **0 — structurally impossible** |

The monolith's `rescueToken` is the whole argument in one function:

```solidity
uint256 available = IERC20(token).balanceOf(address(this)) - poolTokenBalance[token];
if (amount > available) revert RescueExceedsAvailable();
```

That subtraction is the only thing standing between the admin and every user's ERC-20
collateral, because both sat at the same address. It is correct — and it is a runtime check
that had to be written, reviewed, and kept correct forever.

In the split there is nothing to check. `rescueToken` lives on `HaliasDomain`, which never
holds collateral; `HaliasPool` has no rescue function, no admin, and no owner. The guard did
not move, it stopped being necessary. That is the difference between "the admin is
restricted from taking user funds" and "the admin cannot address them."

## Guard-by-guard accounting

Every monolith guard with no same-named counterpart:

| Monolith guard | Disposition |
|---|---|
| `InvalidVerifier`, `InvalidAdmin` | renamed → `ZeroAddress`, `ZeroDependency` |
| `WithdrawCannotHaveValue`, `TransferCannotHaveValue`, `WrongDepositValue`, `ERC20CannotHaveETH` | merged → `WrongMsgValue(expected, actual)`, which reports both figures |
| `NoDestination`, `RelayerCannotBePool` | merged → `BadPayee`, applied once in `_checkPayee` |
| `RelayerFeeOnNonWithdrawal` | renamed → `RelayerFeeRequiresWithdrawal` (it was a form requirement, not a capability limit) |
| `NoFeesToWithdraw` | renamed → `InsufficientFees` |
| `MustWithdrawToSelf`, `PoolNoteWrongFee`, `NotAWithdrawal` | replaced by `ClaimWrongPayout(expected, received)` — the claim measures what arrived instead of re-deriving what should have |
| `PoolNoteMustBeETH` | renamed → `ClaimMustBeETH` |
| `RetainRequiresRegistration` | **deliberately removed.** The pool now refuses itself as a payee unconditionally; the claim's money actually moves to the domain rather than being retained |
| `RescueExceedsAvailable` | **structurally unnecessary** — see above |
| `UseTransferAliasWithKeys` | renamed → `UseTransferAlias` |

No monolith guard is unaccounted for.

## Standalone findings

### Every submitter-variable field is bound

The check worth doing once, explicitly. `TransactParams` has nine members. Six are direct
public signals — `poolRoot`, `registryRoot`, `publicAmount`, `tokenAddress`, and both
nullifiers and commitments. The other three — `recipient`, `relayerFee`, `externalData` —
are inside `paramsHash`, which is `pubSignals[4]`. `msg.value` is bound indirectly, since
`_checkPayment` derives what it must equal from `publicAmount`. `block.chainid` and
`address(this)` are in the preimage as replay boundaries across chains and across pools.

Nothing a submitter controls is unconstrained. A relayer can decide whether to submit and
nothing else.

### Informational — `aliasHash` was not injective into the tree — FIXED

The SMT key is `uint256(aliasHash) % FIELD_PRIME`, while `AliasTaken` is checked against the
full `bytes32`. `FIELD_PRIME` is about 0.189 of 2^256, so roughly 81% of keccak outputs
already reduce — and `h` and `h + FIELD_PRIME` are two distinct aliases that both register,
take different slots, and commit the *same* circuit-visible key.

Not practically reachable and not a theft vector. Colliding with a chosen name means finding
a string whose keccak is congruent to it mod p, around 2^254 work, and the note commitment
binds the spending pubkey regardless, so a collision confers no ability to receive or spend
another alias's funds.

Fixed anyway, because it is an invariant that did not hold and is easy to assume does.
Anything built later that treats the circuit's `outAliasHash` as a unique identity — a
reputation system, a uniqueness constraint, an off-chain index keyed on it — would have
inherited a false premise.

Storing the raw hash does not help, and the registry already did: `aliases` and `aliasSlot`
are both keyed on the full 32 bytes. The loss happens at the conversion, and the circuit
only ever sees the converted side — it is proving a statement about one field element, not
reading storage. So the fix has to make the conversion injective:

```solidity
mapping(uint256 => bytes32) public aliasByKey;   // field key -> the raw hash holding it

uint256 key = uint256(aliasHash) % FIELD_PRIME;
if (aliasByKey[key] != bytes32(0)) revert AliasKeyTaken();
aliasByKey[key] = aliasHash;
```

One SSTORE, on registration only. Name derivation, the SDK, the circuit and the ceremony are
untouched. The alternative — canonicalising `aliasHash` to `keccak(name) % p` and rejecting
anything above `p` — is free at runtime but rejects about 81% of names unless every client
changes how it derives the hash.

**This changes the failure mode, which is worth stating plainly.** Congruent aliases used to
both register and both work; now the second is refused permanently, and the registry is
immutable. Coincidental collision is a birthday problem over a 2^253.6 key space: 2^127
registrations for even odds, and about 2.3e-59 at a billion. The registrant loses nothing but
that particular string. At those odds the trade is right, but it is a trade.

Present in the monolith too, which is exactly why the differential pass could not see it.

## Differential findings

### Nothing exploitable found

Checked and cleared:

- **Cross-contract reentrancy.** `HaliasDomain.claim` → `pool.transact` → `sendValue` to a
  relayer-controlled contract hands an attacker control mid-claim. Both contracts carry
  `nonReentrant`, the pool's checks all complete before any transfer, and the domain's
  `accumulatedFees` is credited from a measured balance delta afterwards. See the low
  finding below for the one soft edge.
- **Relayer as the claim recipient.** If `relayerFee.relayer == domain`, the domain receives
  both payouts. `received` then equals `absAmount`, and the equality check against
  `registrationFee` still holds only for the correct total. No gain.
- **`rescueToken` — since removed.** It was cleared here (ERC-721 exposes no
  `transfer(address,uint256)`, so rescuing the alias tokens out was impossible), then deleted
  outright before release: it insured against tokens sent to a contract that never holds any,
  in exchange for an admin-reachable path an auditor has to rule out. Tokens sent to
  `HaliasDomain` are now stuck, which is the right outcome for value it was never meant to
  receive.
- **Deployment front-running.** `HaliasDeployer`'s initcode includes `admin`, so an attacker
  redeploying it verbatim produces identical, correctly-wired contracts; changing the admin
  changes the initcode hash and therefore the address. Nothing is gained by racing it.
- **Slot exhaustion.** `nextAliasSlot` is `uint32` and `++` reverts before the 32-level tree
  can overflow — capacity is enforced by the type, not by a check that could be forgotten.
- **Claim replay.** Nullifiers stop it at the pool; the domain adds nothing that needs its own
  replay guard.

### Low — `updateKeys` / `updateAliasData` / `transferAlias` were not `nonReentrant` — FIXED

A malicious relayer, holding control during a claim's payout, can call
`domain.updateKeys()` or `domain.transferAlias()` on an alias it owns. This is **not
currently exploitable**: the pool has already verified the registry root before any transfer
occurs, so a mid-flight registry write cannot affect the executing transaction, and every
path that touches `accumulatedFees` (`register`, `claim`) is guarded. The effect is limited
to publishing a new registry root, which anyone can do at any time by registering.

Guarded anyway, because the reasoning that makes it safe depends on the ordering inside
`transact` — a property of a different contract. Keeping the argument local is worth the
2,100 gas.

### Informational — three behaviours changed, all intentional, all tested

1. `NoDestination` relaxed to apply only when a payout actually exists, so a withdrawal
   consumed entirely by the fee need not name a recipient who receives nothing.
2. The `uint96` fee ceiling is gone. It was an artefact of packing the fee beside an address
   in one word; the real bound was always `fee <= absAmount`.
3. Relayer fees extended from ETH to any token, closing the hole where a token-only holder
   had no way to pay for inclusion at all.

Each has a test that fails if the change is reverted.

### Informational — `dataHash` was not field-bounded on the update path — FIXED

Found by checking published findings against comparable systems rather than by reading our
own code; see [prior-art-review.md](prior-art-review.md). `register` and `reassign` write a
zero `dataHash` and `_checkKeys` bounds both pubkeys, so registration was clean —
`setDataHash` took an arbitrary `bytes32` into the Poseidon leaf with no bound, and Poseidon
reduces silently rather than reverting, so `p + 5` and `5` committed the identical leaf.
Two internal passes missed it because the only way in is the update path.

### Medium — a registry root could be born already expired — FIXED

Found by diffing `isKnownRegistryRoot` against World ID's audited `requireValidRoot`, which
solves the same problem; see [prior-art-review.md](prior-art-review.md).

Both accept the current root unconditionally and window historical ones. The difference was
what the stamp means: World ID records when a root *stops* being current, we recorded when
it *became* current.

Stamping at creation spends the window while the root is still current — where no grace is
needed, since `root == smtRoot` short-circuits — and leaves none for afterwards. On a quiet
registry a root current for longer than `REGISTRY_ROOT_MAX_AGE` was born expired: a sender
who read it, spent a minute generating a proof, and submitted would fail the moment anyone
else registered.

Liveness, not fund loss. Fixed by stamping the outgoing root in `_smtUpdate`:

```solidity
registryRootBlock[smtRoot] = block.number;   // superseded now
smtRoot = current;
```

A root that becomes current again is re-stamped when it is next superseded. That is correct
rather than an extension of staleness: while it was current it committed to the live state,
and a sender who read it then is owed the same grace as any other.

This reduces the claim-race problem below but does not remove it — a claimer's proof still
targets one specific post-registration root.

## Residual risks, unchanged by this review

**ETH has no ledger.** `poolTokenBalance` gives tokens an exact liability figure, so
`_debitPool` rejects a withdrawal exceeding the notes outstanding for that token. ETH is
checked only against `address(this).balance`. If the circuit were unsound, the ETH branch
catches a withdrawal larger than the entire pool but not one over-drawing against other
users' notes. Closing it costs an SSTORE on every ETH transact. Open decision.

**Claims race every other registration.** A claimer's change note must prove membership
against the root that includes their own new leaf, so any registration landing in between
invalidates the proof. Inherited from the monolith. Eased by the root-window fix above —
ordinary sends now get their full grace — but claims are unaffected, because they target one
specific post-registration root rather than any recent one. Still a liveness problem that
worsens with adoption.

**Admin can invalidate in-flight claims** via `setRegistrationFee`. Griefing only, no fund
loss, but it is admin power over user transactions that the function name does not suggest.

**Excess ETH at the domain is stranded.** `withdrawFees` is bounded by `accumulatedFees`, so
force-sent ETH cannot be withdrawn. The alternative — withdrawing by balance — is worse.

**The two hard gates are untouched by any of this.** The ceremony is still a self-generated
`--dev` setup, and there has been no external audit. Neither is addressable by code review.
