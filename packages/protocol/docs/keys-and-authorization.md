# Keys and authorization

Every key in the system, what it authorizes, and how an action is authorized when the person
authorizing it is not the person paying for it.

The governing principle: **authority should be cryptographic, inclusion should be someone
else's problem.** `msg.sender` conflates the two, so it is used only where the two genuinely
coincide.

---

## The keys

There are no elliptic-curve keys in the circuit. A "public key" here is a Poseidon hash of a
secret, and the only curve anywhere is X25519, used off-circuit for note encryption.

### Derivation

One wallet signature produces everything:

```
root            = deriveRoot(signer)            // one EIP-191 personal_sign, cached
seed_i          = Poseidon(root, i, ALIAS_DOMAIN)   // ALIAS_DOMAIN = 1212371027 ("HALS")
spendingPrivKey, viewingPrivKey, encryption keypair  ← seed_i
```

`i` is the alias index. Per-index derivation is why two aliases held by one wallet share no
key material and cannot be linked by their notes — only by the fact that one address owns
both NFTs, which is public regardless.

### What each key does

| Key | Derived as | Authorizes | If compromised |
| --- | --- | --- | --- |
| `spendingPrivKey` | from `seed_i` | spending notes | everything, until the alias is re-keyed |
| `spendingPubkey` | `Poseidon(spendingPrivKey)` | *receiving* — the registry entry | — |
| `viewingPrivKey` | from `seed_i` | deriving the nullifier key | linkability of your spends |
| `nullifierKey` | `Poseidon(viewingPrivKey)` | computing nullifiers | as above |
| `nullifierKeyHash` | `Poseidon(nullifierKey, 1)` | published in the registry | — |
| encryption keypair | X25519 from `seed_i` | finding notes addressed to you | reads incoming amounts |

Spending requires **both** the spending and viewing private keys: the commitment binds
`spendingPubkey` and `nullifierKeyHash`, and the nullifier needs the raw nullifier key. A
compromised viewing key alone loses privacy, not funds.

### Derived values

```
commitment = Poseidon(pubkey, nullifierKeyHash, blinding, amount, tokenAddress)
nullifier  = Poseidon(nullifierKey, leafIndex, NULLIFIER_DOMAIN)   // 1314148940 ("NULL")
registry leaf = Poseidon(pubkey, nullifierKeyHash, dataHash), SMT-hashed at arity 3
```

The nullifier's 3-arity domain separator is what stops it colliding with the 2-arity
`nullifierKeyHash`, so a spend never publishes a value linkable to the public registry entry.

### Invite keys

`deriveInviteKeys(secret)` produces a throwaway set from a single 32-byte secret. The invite
note is encrypted to its X25519 key, so **holding the secret is sufficient** to discover and
decrypt it — nothing else is transmitted, and the code is a bearer instrument.

---

## Authorization mechanisms

Five, and the choice between them is not stylistic.

### 1. Proof only — `HaliasPool.transact`

No sender authority whatsoever. Anyone may submit; the proof establishes everything. This is
why relaying works at all.

### 2. Proof binding — `paramsHash`

`recipient`, `relayerFee` and `externalData` are hashed into a public input, so a submitter
cannot alter the destination or inflate its own fee. Unforgeable rather than merely signed:
no valid proof exists for different values.

### 3. Proof binding, application-level — `externalData` on `claim`

`keccak256(abi.encode(Registration))`. The domain recomputes it from its own arguments, so a
relayer cannot substitute itself for the owner. This is what makes a claim relayable while
still minting the alias to the claimer.

### 4. EIP-712 signature — `acceptAlias`, and the owner actions

Used where **no proof exists to bind into**. Accepting an alias spends nothing, so there is
no proof; a signature is the only mechanism available. Anyone may submit.

Covers the keys (a submitter cannot substitute its own) and a per-alias nonce (no replay
against a later offer of the same alias to the same address). Verified through
`SignatureChecker`, so EOAs and ERC-1271 contracts both work — which is what lets an escrow
be a recipient.

`offerAlias` and `cancelOffer` take the same shape with one addition: an **empty signature
means the owner is submitting for themselves**, and `msg.sender` is read instead. Two modes,
one entry point, because requiring a signature on the ordinary path would cost every owner a
second wallet prompt to protect a case most of them are not in.

The nonce is bumped on **both** paths. That makes the rule a single sentence — *any
authorised action on an alias invalidates every signature outstanding for it* — and closes
the case where an owner signs an offer, changes their mind by acting directly, and leaves the
old signature live for someone else to submit afterwards.

### 5. Commit–reveal — `register`

Not authorization but *secrecy*. Neither a signature nor a proof can protect a name, because
the thing being stolen is the right to occupy a slot, and the hash is the slot key. Only
hiding the name until it is too late to compete works.

### The rule

> **Bind into the proof when one exists. Sign when one does not. Use commit–reveal when the
> problem is secrecy rather than authority.**

Adding a signature to `claim` would replace a free, unforgeable, in-proof binding with an
extra artifact. Adding a proof to `acceptAlias` would invent one for an operation that spends
nothing. They differ because the operations differ.

---

## Where `msg.sender` is still the authority

Audited. Each of these forces the authorizing party to also pay, which the principle above
says to avoid.

| Function | Guard | Relayable? | Correct? |
| --- | --- | --- | --- |
| `register` | `msg.sender` becomes owner, bound in the commitment | no | **moot** — `msg.value` must equal the fee, so the caller is paying regardless |
| `offerAlias` | owner signature, or `msg.sender` | yes | correct |
| `cancelOffer` | owner signature, or `msg.sender` | yes | correct |
| `updateAliasData` | owner signature, or `msg.sender` | yes | correct — though the function itself is a candidate for removal, see below |
| `commit` | none | yes | correct — a commitment reveals nothing |
| `acceptAlias` | signature | yes | correct |
| `claim` | proof binding | yes | correct |
| `transact` | none | yes | correct |
| admin functions | `onlyAdmin` | no | correct — the admin is a specific party, not an arbitrary one |

There is no `updateKeys`. It wrote the nullifier and encryption keys but never the spending
pubkey, so the one compromise that loses funds was the one it could not answer. **Rotation is
a handover to yourself**: offer the alias to your own address, accept with keys derived at a
fresh index, and `reassign` replaces all three. Both halves are signable, so the whole
rotation can be relayed — which matters, because the moment you most need to re-key is after
a compromise, and that is also when you may be least able to pay for a transaction.

---

## The trust boundary

The contract guarantees **the recipient consented**. The client guarantees **the keys are the
recipient's own**.

Nothing on chain can verify the second: a spending pubkey is `Poseidon(spendingPrivateKey)`
derived from a wallet signature, so there is no recoverable relationship between an address
and a pubkey. An EIP-712 signature proves the signer *wanted* a pubkey installed, not that
they *control* it.

A compromised client defeats that guarantee — and also holds your wallet connection and
derives your spending keys, so it can sweep every note and sign anything. It is therefore
**out of scope by construction, not by oversight**: defending against it is unachievable, and
pretending otherwise would add surface without adding safety.

What is *not* acceptable is a **counterparty** making that decision, which is what the old
`transferAlias` allowed — the seller chose the buyer's keys unilaterally, silently, with no
buyer action able to prevent it. Offer/accept moves the decision from the counterparty to the
client. That is the whole change.

The invariant this rests on is **not** that `acceptAlias` hides the keys — it takes all three
as explicit parameters, and could not do otherwise, since deriving them would need a private
key the contract will never have. What holds is narrower and sharper:

> **The keys are inside the recipient's signed digest, so no submitter can substitute them.**

That is what a later change would break — by widening the struct, or by accepting a signature
that covers fewer fields "so the escrow can fill in the rest". Either hands the decision back
to the counterparty while the function still looks correct. `refuses a signature from anyone
but the owner` and `the recipient chooses the keys, and a third party may submit` are the
tests that pin it.
