# Key rotation, alias transfer, and whether both are needed

> **Status.** Everything above the handover section below was written against
> `transferAlias` and `updateKeys`, both of which have since been removed. The conclusions
> held; the mechanisms named did not. This section has been rewritten to match what exists.

## F7 — resolved by removal

An alias holds three keys in the registry, and they were not equally recoverable:

| Key | If compromised |
| --- | --- |
| `encryptionPubkey` | attacker reads incoming note amounts |
| `nullifierKeyHash` | attacker links your spends |
| `spendingPubkey` | attacker spends everything, forever |

`updateKeys` wrote the first two and never the third — so the tool named "update keys" did
not address the only compromise that loses money, behind a name implying otherwise.

**Removed rather than fixed.** `reassign` already replaces all three in place, keeping the
alias in its slot, so rotation is a **handover to yourself**: offer the alias to your own
address, then accept with keys derived at a fresh index. That is strictly more capable than
what was deleted, and both halves carry signatures, so the whole rotation can be relayed —
which is the case that actually matters, since the moment you most need to re-key is also
when you may be least able to pay.

What removal cost: `reassign` clears `dataHash`, so a rotation loses it. That is free today —
`dataHash` is zero on every alias in existence, reserved for proof-of-innocence and not yet
carrying anything. When it does, the distinction belongs on `reassign`, keyed on whether the
owner actually changed, rather than in a separate function. That is the better shape anyway:
it puts the branch where the semantics genuinely differ.

What removal bought: one fewer mutating function on the domain and on the registry, one fewer
writer of registry leaves — which directly shrinks F1's surface, since every leaf write
invalidates claims in flight — and one fewer control whose name promised more than it did.

### The rotation window, honestly

A sender on a superseded root can still pay your old keys for up to `REGISTRY_ROOT_MAX_AGE`
after you re-key. For a **self**-rotation that is a confidentiality exposure, not fund loss:
you kept the old keys, so those notes are still yours. Whoever holds the compromised viewing
key can read the amounts and link the spends, and cannot spend without the spending key.

For a **transfer between two parties it is fund misdirection**, because the old keys belong
to somebody else. Same window, materially worse consequence — tracked as F8 in the audit.
The window is now 1 hour rather than a day, which shrinks both.

---

## Aliases as a market

Alias transfer is the right primitive for it. The obstacle is that standard ERC-721 movement
is deliberately disabled — `transferFrom`, the 4-argument `safeTransferFrom`, `approve` and
`setApprovalForAll` all revert — because a bare NFT transfer would leave the registry keys
behind, and the previous owner would keep decrypting everything sent to the name afterwards.

That is the correct trade, and it means aliases cannot trade on generic marketplaces: OpenSea
and every other venue works through approvals and `transferFrom`.

### The alternative, and why it is worse

Split ownership from keys: allow standard ERC-721 transfer, and require the new owner to adopt
keys afterwards. This restores marketplace liquidity, but between transfer and adoption the
**previous owner still receives and decrypts every payment**. That is a silent
fund-and-privacy hazard sitting in the gap between two transactions, on the exact path where
money changes hands. It would need the registry to mark unadopted aliases and every sender to
honour that flag — enforcement by convention, on the most valuable target in the system.

Keeping keys and ownership atomic is worth more than marketplace compatibility. If a market
matters, build the escrow — see below, which needs no contract changes.

---

# Alias handover: offer / accept (implemented)

`transferAlias` is gone. It took the new owner *and* the new keys from the **seller**, and
nothing related them:

```solidity
transferAlias(aliasHash, newOwner, newSpendingPubkey, ...)  // seller chose all of it
```

So a seller could hand over the token while installing keys they kept. The buyer would own
the name; every payment to it would arrive for the seller, decryptable only by them. Nothing
in the contract can detect this. A spending pubkey is `Poseidon(spendingPrivateKey)`, where
the private key derives from an EIP-191 wallet signature — no curve, no recoverable
relationship to an address. Recomputing it needs the private key, which the contract will
never have. `newSpendingPubkey` is just 32 bytes the caller picked.

**Only the recipient can assert which keys are theirs, so only the recipient can complete a
transfer.**

## The shape

```
offerAlias(aliasHash, to)          // owner records an intent — nothing else changes
cancelOffer(aliasHash)             // withdraw it
acceptAlias(aliasHash, keys, deadline, signature)   // anyone may submit
```

Until acceptance the seller keeps the token, the registry keeps its keys, and payments keep
arriving for the seller. **There is no in-transit state**, which is what the previous design
got wrong: it created a window where ownership and keys disagreed, and never closed it.

## Why a signature and not `msg.sender`

`msg.sender` would be the obvious authority and is the wrong one: it forces the recipient to
pay for the transaction. A buyer with no ETH — the same person the invite flow exists for —
could not accept.

So acceptance carries an EIP-712 signature from the recipient and **anyone may submit it**.
Identical reasoning to `claim` binding its owner in the proof rather than reading the sender:
authority is cryptographic, inclusion is someone else's problem.

The signature covers the keys, so a submitter cannot substitute their own, and the alias's
nonce, so it cannot be replayed against a later offer of the same alias to the same address.

Verification uses `SignatureChecker`, which accepts EOAs **and ERC-1271 contracts** — that is
what allows an escrow to be a recipient.

## Escrow lives outside these contracts

A marketplace needs no changes here. `offerAlias`/`acceptAlias` compose:

1. Seller offers to the escrow; escrow accepts with keys it controls
2. Buyer pays the escrow
3. Escrow offers to the buyer; buyer accepts with their own keys

Both legs atomic, no approvals, no ERC-721 loosening. The escrow holds working keys while it
holds the alias and can therefore read anything paid to the name mid-sale — short, bounded,
and visible on chain, since the registry shows the escrow as owner.

## Key rotation

Self-handover is the rotation path — see F7 above, which is why `updateKeys` no longer exists.

## What sweeping is and is not

`sweepAndTransfer` became `sweepAndOffer`, and it no longer takes the recipient's keys.

Sweeping first is a courtesy, not a guarantee, and it cannot be made into one. Nothing on
chain can verify an alias is empty: the pool cannot compute an alias's balance without
breaking the privacy that is the point of it, and "no unspent note exists under this pubkey"
is a universal statement over 2^32 leaves that the circuit cannot express.

Notes already under the seller's spending key stay spendable by the seller regardless. So a
buyer is acquiring **the name and everything paid to it from now on, never a balance**, and a
market must price it that way.
