# Keys and authorization

Every key in the system, what it authorizes, and how an action is authorized when the person
authorizing it is not the person paying for it.

The governing principle: **authority should be cryptographic, inclusion should be someone
else's problem.** `msg.sender` conflates the two, so it authorises nothing a user owns — not
a note, not a name. What remains of it guards contract identity and the admin role.

---

## The keys

There are no elliptic-curve keys in the circuit. A "public key" there is a Poseidon hash of a
secret. Two curves appear off-circuit: X25519 for note encryption, and secp256k1 for the key
that holds the alias itself.

### Derivation

One recovery phrase produces everything:

```
root            = keccak(BIP39_seed(phrase) || "halias root v1")
seed_i          = Poseidon(root, i, ALIAS_DOMAIN)     // ALIAS_DOMAIN = 1212371027 ("HALS")
spendingPrivKey = Poseidon(seed_i, 0)
viewingPrivKey  = Poseidon(seed_i, 1)
encryption key  = keccak(seed_i || 0x02)              // X25519
owner key       = keccak(seed_i || 0x03)              // secp256k1, holds the alias NFT
```

`i` is the alias index. Per-index derivation is why two aliases from one phrase share no key
material — and since the owner key is derived per index too, they do not share an address in
public state either. Nothing on chain links them.

The root does **not** come from a wallet signature. It used to: `keccak(personal_sign(…))`,
which meant any site that persuaded a user to sign one fixed string derived every key they
held. See `key-management.md`.

### What each key does

| Key | Derived as | Authorizes | If compromised |
| --- | --- | --- | --- |
| `spendingPrivKey` | from `seed_i` | spending notes | everything, until the alias is re-keyed |
| `spendingCommitment` | `Poseidon(spendingPrivKey)` | *receiving* — the registry entry | — |
| `viewingPrivKey` | from `seed_i` | deriving the nullifier key | linkability of your spends |
| `nullifierKey` | `Poseidon(viewingPrivKey)` | computing nullifiers | as above |
| `nullifierKeyHash` | `Poseidon(nullifierKey, 1)` | published in the registry | — |
| encryption keypair | X25519 from `seed_i` | finding notes addressed to you | reads incoming amounts |
| owner key | secp256k1 from `seed_i` | the three name operations | the alias can be given away — not spent from |

Spending requires **both** the spending and viewing private keys: the commitment binds
`spendingCommitment` and `nullifierKeyHash`, and the nullifier needs the raw nullifier key. A
compromised viewing key alone loses privacy, not funds.

The owner key is the one key that is an Ethereum key, and it deliberately never sends a
transaction — it holds no ETH, so it cannot. Losing it loses the *name*, not the money;
losing the spending key loses the money but not the name. They are separate because they
protect separate things.

### Derived values

```
commitment = Poseidon(spendingCommitment, nullifierKeyHash, blinding, amount, tokenAddress)
nullifier  = Poseidon(nullifierKey, leafIndex, NULLIFIER_DOMAIN)   // 1314148940 ("NTRL" ascii)
registry leaf = Poseidon(spendingCommitment, nullifierKeyHash, dataHash), SMT-hashed at arity 3
```

The nullifier's 3-arity domain separator is what stops it colliding with the 2-arity
`nullifierKeyHash`, so a spend never publishes a value linkable to the public registry entry.

### Invite keys

`deriveInviteKeys(secret)` produces a throwaway set from a single 32-byte secret, under the
same domain bytes as the wallet path — including `0x03`, so the temporary alias an invite
registers is owned by a key derived from the invite secret rather than by the inviter's
wallet. Otherwise creating an invite would publish who created it.

The invite note is encrypted to its X25519 key, so **holding the secret is sufficient** to
discover and decrypt it — nothing else is transmitted, and the code is a bearer instrument.

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

`offerAlias`, `cancelOffer` and `updateAliasData` take the same shape. There is **no
sender-based alternative**: an empty signature is rejected like any other invalid one.

That is not a hardening choice, it is forced. An alias is owned by a key derived from the
holder's recovery phrase, which holds no ETH and therefore cannot send a transaction at all —
it can only sign, while some funded wallet submits. A sender-based path would have preserved
the assumption that owning a name and paying for gas are the same account, which is the
coupling this design removes. See *Ownership* below.

All four verifications go through one function, `_consumeAuthorization`, which checks the
deadline, checks the signature, and bumps the alias nonce as a single step. Nothing can
verify a signature and skip the bump, which is the property that matters: the bump *is* the
replay protection, and it used to be written out twice.

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

## Ownership

An alias is an ERC-721, and its owner is the `owner key` above: secp256k1, derived per alias
index from the recovery phrase, holding no ETH and sending no transactions. `register` takes
that address as an explicit parameter rather than reading `msg.sender`.

**What this buys.**

- `ownerOf(alias)` returns an address that has never transacted. It no longer places a real,
  fundable wallet beside the alias in public state.
- Aliases from one phrase share no owner address, so `ownerOf` links none of them to each
  other.
- Which wallet you connect is irrelevant. The name travels with the phrase, so switching
  accounts, or paying from a different one each time, changes nothing.
- Separating the paying account from the owning one stops being a discipline and becomes
  structural: the owner key *cannot* pay for gas, so the two can never be conflated.

**What it costs.** Losing the phrase loses the name as well as the money. Previously an EOA
owner could still hand the alias to a fresh phrase; now there is one secret, not two.

**What it does not do.** It removes the link from *state*, not from *history*. Whoever sends
the registration and pays the fee is visible in that transaction. Closing that requires
registering through a relayer, or through `claim`, which pays the fee out of the pool.

**How this differs from ENS.** An ENS name is owned by a funded wallet, publicly, and
Railgun's integration has it resolve to a `0zk` receiving address via a text record. Both
halves are readable, so the chain shows *real wallet → name → private receiving identity*.
Publishing a receiving key against a name is unavoidable if strangers are to pay you by name;
publishing the wallet that controls it is not.

**Not assumed anywhere.** An alias can be transferred to an ordinary EOA or a smart account,
and then that address is the owner. `SignatureChecker` handles ERC-1271, and the client
resolves who actually holds an alias before signing rather than assuming it is the derived
key.

---

## Replay protection, method by method

The question a reviewer asks first about any signature scheme, and the one EIP-712 does not
answer on its own.

**What EIP-712 gives natively.** Its domain separator carries `chainId` and
`verifyingContract`, so a signature cannot be replayed on another chain or against another
deployment. Distinct typehashes stop one message being verified as another.

**What it does not give.** Anything about the *same* message, on *this* contract. A signature
is a static value; verifying it once does not stop it verifying again. This is exactly why
`permit` needs a nonce despite being EIP-712 throughout, and it is application state — not the
standard — that closes it.

| Write method | Authorised by | Replayed submission stopped by |
| --- | --- | --- |
| `acceptAlias` | recipient's signature | `aliasNonce[aliasHash]` + `deadline` |
| `offerAlias` | owner's signature | `aliasNonce[aliasHash]` + `deadline` |
| `cancelOffer` | owner's signature | `aliasNonce[aliasHash]` + `deadline` |
| `updateAliasData` | owner's signature | `aliasNonce[aliasHash]` + `deadline` |
| `register` | commit–reveal | the commitment is deleted on use; the name then reverts as taken |
| `claim` | proof, via `externalData` in `paramsHash` | input nullifiers recorded on spend |
| `transact` | proof, via `paramsHash` | input nullifiers recorded on spend |

Four properties hold across all four signed methods, and each is worth stating because each
was a decision:

1. **`aliasHash` is inside every signed struct**, so a signature cannot be moved to a
   different alias.
2. **The nonce is keyed by alias, not by signer.** OpenZeppelin's `Nonces` is
   `mapping(address => uint256)`, which is the wrong key here twice over: acting on one alias
   would invalidate signatures outstanding for every other alias the same owner holds, and
   after a handover the signer changes, so an address-keyed counter would stop tracking the
   alias it is meant to protect.
3. **One counter covers all four types.** Any authorised action on an alias invalidates every
   signature outstanding for it, across types — signing an offer and then cancelling kills the
   offer signature too. An owner who changes their mind does not leave a live signature behind.
4. **The nonce is read before it is bumped**, so a signature binds the state it was made
   against. Reversing that would verify against a value no signer could have used.

Every signed action also carries a `deadline`, so a signature that is never submitted expires
rather than remaining live indefinitely.

### Why value transfers use nullifiers instead

`transact` has no nonce and needs none. Both input nullifiers are recorded on every
transaction — including deposits, whose dummy inputs carry nullifiers derived from freshly
generated keys — and the spent check is the first thing the function does, before proof
verification, so a replay costs a front-run victim the least possible gas.

Nullifiers are stronger than a counter here, not weaker. A nonce binds to an account in
order, which breaks out-of-order submission and goes stale while a prepared relay blob sits in
someone's inbox. A nullifier binds to *the notes being spent*, so a prepared transaction stays
valid until exactly those notes are gone — which is the condition that actually matters.

One subtlety carries the weight: each input names its tree, and the tree must be the one its
root belongs to. Without that check the nullifier's tree component is unconstrained, and a
note could be re-spent under a different tree number for a fresh unspent nullifier every time.
That is unlimited theft, not a liveness bug.

---

## Where `msg.sender` is still the authority

Audited. Owner authorisation no longer appears here at all.

| Function | Guard | Relayable? | Correct? |
| --- | --- | --- | --- |
| `register` | owner is an explicit parameter, bound in the commitment | no | **moot** — `msg.value` must equal the fee, so the caller is paying regardless |
| `commitRegistration` | none | yes | correct — a commitment reveals nothing |
| `offerAlias` | owner signature | yes | correct |
| `cancelOffer` | owner signature | yes | correct |
| `updateAliasData` | owner signature | yes | correct |
| `acceptAlias` | recipient signature | yes | correct |
| `claim` | proof binding | yes | correct |
| `transact` | nullifiers and proof | yes | correct |
| `receive()` | `msg.sender == pool` | n/a | correct — a contract identity check, not a user authorisation |
| ERC-20 deposit pull | `safeTransferFrom(msg.sender, …)` | n/a | correct — it must debit whoever is paying |
| admin functions | `onlyAdmin` | no | correct — the admin is a specific party, not an arbitrary one |

There is no `updateKeys`. It wrote the nullifier and encryption keys but never the spending
commitment, so the one compromise that loses funds was the one it could not answer. **Rotation is
a handover to yourself at a different index**: offer the alias to the owner address derived at
index `i+1`, accept there, and `reassign` replaces all three keys. Since the owner address is
derived per index, the destination differs from the source — the handover is real on chain
rather than an address offering to itself.

Both halves are signable, so the whole rotation can be relayed — which matters, because the
moment you most need to re-key is after a compromise, and that is also when you may be least
able to pay for a transaction. Neither owner key can pay for one in any case.

---

## The trust boundary

The contract guarantees **the recipient consented**. The client guarantees **the keys are the
recipient's own**.

Nothing on chain can verify the second: a spending commitment is `Poseidon(spendingPrivateKey)`
derived from a recovery phrase, so there is no recoverable relationship between an address
and a spending commitment. An EIP-712 signature proves the signer *wanted* a spending commitment installed, not that
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
