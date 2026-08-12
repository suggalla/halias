# Legal exposure: what actually happened to Tornado Cash, and how Halias differs

**This is engineering analysis, not legal advice.** I am not a lawyer. Everything below is
a reading of public court records and published guidance, assembled so you can have a
productive first conversation with counsel rather than a blank-page one. Get a real opinion
from someone who does FinCEN money-services and OFAC work before launch — the questions
here are the ones to bring them.

## What happened

### Tornado Cash

| | |
|---|---|
| Aug 2022 | OFAC adds Tornado Cash contract addresses to the SDN list |
| Aug 2023 | DOJ indicts Roman Storm and Roman Semenov — conspiracy to commit money laundering, conspiracy to violate IEEPA sanctions, conspiracy to operate an unlicensed money transmitting business |
| May 2024 | Alexey Pertsev convicted of money laundering in the Netherlands, 64 months |
| Nov 2024 | Fifth Circuit, *Van Loon v. Treasury*: OFAC exceeded its authority — immutable smart contracts are not "property" of a foreign national, because nobody can own or control them |
| Mar 2025 | OFAC delists Tornado Cash |
| Aug 2025 | Storm trial: convicted on the unlicensed money transmitting count; jury hung on money laundering and sanctions |

The pattern worth internalising: **the sanctions theory lost, the money-transmitting theory
landed.** *Van Loon* is now the strongest authority protecting genuinely uncontrolled code.
It did nothing for the operators personally.

### Railgun

Never sanctioned, no prosecutions. Shipped Private Proofs of Innocence in January 2024 —
users can prove their funds are not in a published set of illicit deposits, without
revealing which funds are theirs. Notably the pool does not enforce it; relayers and
counterparties choose to demand it. That is repeatedly cited as the good-faith
differentiator.

## What the government actually leaned on

None of it was the cryptography. The Storm case was built on **control and conduct**:

- The developers retained control of the router and could have added screening — the
  argument that they *could* act and chose not to.
- A fee mechanism and a token, i.e. revenue from operating the service.
- Communications showing awareness that Lazarus Group funds were moving through, and
  continuing anyway.
- Continued influence over the DAO and the front end.

The distinction that matters most is in **FinCEN's 2019 guidance on convertible virtual
currencies**: an *anonymizing software provider* is not a money transmitter — supplying
software is not accepting and transmitting value. An *anonymizing service provider* is. The
line is whether value passes through your hands.

## Where Halias sits

### Favourable

**`HaliasPool` is the *Van Loon* fact pattern, precisely.** No admin, no owner, no upgrade
path, one mutating function, and no key that can pause, drain, redirect or rescue —
including for you. That is the property the split was built to make checkable by reading
one file, and it is now also the property that a court found dispositive.

**Named aliases cut against "designed for anonymity."** The registry is a public, on-chain,
permanent identity layer. Tornado had no equivalent — the entire point was that the
recipient was unknowable. Here the recipient is a registered name with a public key record
and a fee-gated registration. The product is *named* private payments, and the naming is
not decorative.

**Non-custodial throughout.** Keys derive client-side from a signature; no server of yours
ever holds funds or keys.

### Unfavourable

**You take a fee, and you can withdraw it.** `registrationFee` → `accumulatedFees` →
`withdrawFees`, gated by an admin key you hold. That is revenue from operating the service,
paid to an identified person. It was a fact the government used, and it is the single
clearest way in which Halias is not "just published software."

**`HaliasDomain` has an admin key.** *Van Loon* protected contracts nobody controls. The
Pool qualifies; the Domain explicitly does not, by design. Anything reachable from that key
is arguably yours to answer for.

**Running a relayer would be the highest-risk thing you could do.** A relayer accepts a
transaction on someone's behalf and is paid a fee out of the value moving. Under the FinCEN
line above that is much closer to *accepting and transmitting value* than to publishing
software — and it is the count Storm was actually convicted on. The architecture supports
third-party relayers precisely because it does not need you to be one.

**No proof-of-innocence layer yet.** The one thing Railgun has that Tornado did not.
Already on the roadmap; the gap is currently open.

**Hosting the front end is a nexus.** An IPFS-pinned static build is a materially different
posture from a domain you operate.

## Verified in code

The factors above are only worth anything if the code matches. Checked against the split:

**No relayer is operated, and none is defaulted to.** The SDK's `relayer` is a caller-supplied
*address*, defaulting to `ethers.ZeroAddress` — i.e. self-submission. There is no URL, no
endpoint, no service, and nothing in the app or SDK points at one. Under FinCEN's
software-provider / service-provider line, nothing here accepts or transmits value on
anyone's behalf. This is the highest-risk item in the analysis above and it is cleanly
absent — which is a property to keep deliberately, not to discover later.

**The pool cannot screen, freeze, pause, or blocklist.** Zero admin modifiers in
`HaliasPool.sol`; the only match for any of those words is a comment saying no such key
exists. That inability is a legal asset, not a gap — see the closing section.

**The admin is confined to the contract holding no user funds.** Six `onlyAdmin` functions,
all on `HaliasDomain`. `HaliasPool` and `HaliasRegistry` have none; the registry's
`onlyController` names the domain contract, not a person. Nothing reachable from the admin
key can address a user's collateral.

## Proof of innocence layers on without touching any of this

The one remaining gap against Railgun is a provenance proof, and the architecture already
admits one without weakening anything above.

`transact.circom` binds an alias's `dataHash` into its registry leaf —
`Poseidon(pubkey, nullifierKeyHash, dataHash)`, hashed again as
`Poseidon(aliasHash, leafValue, 1)` and proven against a published registry root. The leaf
commits to the alias itself, so a prover cannot point at another alias's slot. That means a
**separate** circuit can prove statements about `dataHash` and have them bind to a specific
alias, with its own small ceremony, without `transact` changing at all.

So the PPOI shape is available exactly as recommended: lists published by independent
parties, honoured by relayers and counterparties, consumed by a circuit the pool never
calls. The pool stays unable to discriminate, which is the property worth protecting.

## Questions for counsel

1. Does `registrationFee` collected by an admin key make me a money services business under
   FinCEN's 2019 guidance, given the pool itself is non-custodial and the fee buys a name
   rather than a transfer?
2. Does *Van Loon* protection extend to `HaliasPool` specifically, given `HaliasDomain` —
   which I do control — is the contract that calls it?
3. Is there a structure that separates me from the fee revenue (burn, DAO, foundation)
   without creating worse problems?
4. What is the exposure difference between publishing relayer software and operating one?
5. Does the public registry help — does a named, fee-gated, permanent identity record
   distinguish this from a mixer in a way that matters legally, or only rhetorically?
6. Front-end: what does hosting versus IPFS-only actually change?

## Things that reduce exposure, in rough order of impact

1. **Do not run a relayer.** Publish the software; let others operate. The design already
   assumes this.
2. **Ship proof-of-innocence before launch**, not after an incident. Retrofitting it in
   response to abuse is exactly the sequence that looked bad for Tornado.
3. **Reconsider the fee and the admin key.** They are the strongest facts against you and
   they buy comparatively little. Burning the fee, or removing it, would make
   `HaliasDomain` nearly as defensible as the pool.
4. **Do not host the front end yourself.** Static build, IPFS, no operated domain.
5. **Write the compliance posture down before launch** — screening at the front end, a
   published policy, a documented response process. Contemporaneous records that you thought
   about abuse are worth far more than the same reasoning offered afterwards.
6. **Never build a screening capability into the pool.** Counter-intuitive but important:
   the ability to act creates the argument that failing to act was a choice. The pool's
   inability to discriminate is a legal asset, which is another reason proof-of-innocence
   belongs outside it, in a contract the pool does not consult.

## The one that is easy to get wrong

Point 6 is worth restating because it cuts against the instinct to be helpful, and because
the code currently has the right property by construction rather than by policy. Building an
allow-list into `transact` would look responsible and would be strictly worse on every axis:
it would hand you a freeze key over user funds, destroy the *Van Loon* posture the pool
currently has, and establish that you can control the contract. Railgun's design — lists
published by independent parties, honoured by relayers and counterparties, never enforced by
the pool — is the shape that is both more useful and more defensible.

## Relaying: what the app does and what it deliberately does not

The app now has both halves of the relay flow — a *Prepare* step that produces a signed-but-
unbroadcast transaction, and a *Relay* screen that simulates one and submits it. Both are
pure client-side tooling over a public contract. Neither touches anyone's funds and neither
involves us at runtime.

Two things are excluded on purpose, and the distinction is the whole point:

**No relayer directory.** The app never lists, ranks, suggests, or defaults to a relayer.
The user types an address. A curated list is the step from *publishing a tool* to *brokering
a service* — it makes us the party choosing who handles the transaction, which is exactly the
role FinCEN's 2019 guidance treats as money transmission when combined with control. Typing
an address you obtained elsewhere leaves the choice, and the relationship, entirely outside
this software.

**We do not run one.** Operating a relayer means accepting other people's transactions and
paying out from an address we control. That is the closest thing in this system to custody,
and there is no version of it that is worth the exposure for a fee measured in gas.

The property that makes the prepared transaction safe to hand over is also what keeps this
narrow: the fee is bound to a specific relayer address inside `paramsHash`, so a prepared
transaction is worthless to anyone but its named recipient. There is nothing to intercept,
so no infrastructure is needed to protect it — and therefore no infrastructure for us to run.
