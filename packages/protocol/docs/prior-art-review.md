# Checking the registry against audited implementations

Reviewing our own code finds the bugs we thought to look for. This pass took published
findings against comparable systems, and diffed our mechanisms against audited
implementations of the same mechanisms. It found **two real bugs that two internal passes
had missed** — one from each approach.

## What is comparable

**Private payments with a name layer: one dead predecessor, no live one.** Railgun, Penumbra
and Namada all have shielded value and no name registry — recipients are keys or addresses.

Aztec's **zk.money is direct prior art** and the earlier version of this section was wrong to
say otherwise. It had aliases, and they were proven in-circuit: from Aztec's own documentation,
*"during account registration a zero-knowledge proof is created which links encryption keys to
spending keys and registers your alias."* Unique, twenty characters, lowercase alphanumeric —
very nearly the constraint we arrived at independently. It shut down in March 2023 for
[commercial reasons the founders were explicit about](https://www.coindesk.com/consensus-magazine/2023/03/24/founders-deny-regulatory-pressure-forced-aztec-connect-zkmoney-shutdown),
not regulatory ones, with the rollup switched off in March 2024.

Three differences survive that, and they are the ones worth defending:

- **Theirs was a lookup convenience; ours is a spend condition.** A zk.money alias let a sender
  find your encryption key. Here the circuit *requires* the recipient to be in the registry —
  the pool cannot pay an unregistered key at all. Different in kind, not degree.
- Their aliases were not NFTs, not transferable, and carried no attestation hook. Ours are
  ERC-721 with a `dataHash` bound into the registry leaf.
- Theirs ran on a rollup with a sequencer. This is an L1 contract with no operator.

The useful lesson from zk.money is not architectural. It died of insufficient usage, with
funding, a team and DeFi integrations behind it — and a shielded pool's privacy is monotonic in
its user count. That is the risk this project actually carries.

**A tree of identity commitments proven in-circuit: plenty.** Semaphore is the closest
structural analogue — commitments in an incremental Merkle tree, membership proven by a
circuit — and World ID is Semaphore-derived, running at scale, audited repeatedly. Those are
the right comparison for `SMTRegistry`.

## Semaphore, via the Veridise audit

### Their bug 1 — field size validated on the original leaf, not on the replacement

`update()` checked the existing leaf but not `newLeaf`, so a member could set a commitment
above the bn128 field. Fixed with `require(newLeaf < SNARK_SCALAR_FIELD)`.

**This applies to us, and we had it.** `register` and `reassign` write `dataHash = 0`, and
`_checkKeys` bounds the spending commitment and the nullifier key hash — so registration was clean. `setDataHash` took an
arbitrary `bytes32` straight into the Poseidon leaf with no bound.

Measured rather than assumed, because severity depends entirely on what Poseidon does with
an out-of-field input:

```
leaf(dataHash = p + 5) = 0x0d28252b…44b09d31
leaf(dataHash = 5)     = 0x0d28252b…44b09d31   ← identical
```

**It reduces silently rather than reverting.** So the registry stored one value and
committed another, and two distinct records collapsed onto one leaf — the same injectivity
break as the `aliasHash` finding, on the update path instead of the registration path.

Fixed:

```solidity
if (uint256(newDataHash) >= FIELD_PRIME) revert DataHashOutOfField();
```

It was reachable and it was being reached: `HaliasRegistry.test.ts` had been passing raw
keccaks as `dataHash`, which exceed `p` about 81% of the time, and silently getting reduced
leaves. Three tests started failing the moment the guard went in. Registration writing a
zero `dataHash` is exactly why neither internal pass caught it — the only way in is the
update path, which is the same shape as the Semaphore finding.

### Their bug 2 — group creator controls the tree's zero value

A creator could pick a zero value whose nullifier and trapdoor they knew, giving themselves
irrevocable membership, since removal writes the zero value rather than deleting.

**Does not apply.** `_initSMT` derives zeros from `0` by repeated hashing with no caller
input, and aliases are never removed.

Their fix is worth noting anyway: `uint256(keccak256(abi.encodePacked(groupId))) >> 8`.
Truncation, not modular reduction — the audited convention for getting a keccak into the
field, and the same approach as the "canonicalise `aliasHash`" alternative recorded in
[security-audit.md](security-audit.md). Shifting keeps the map injective on its range;
`% p` does not, which is the whole reason `aliasByKey` has to exist.

## World ID — checked, and it found a second bug

Their audits report a high-severity finding around roots expiring and DoS'ing verification
when submission gaps approach `ROOT_HISTORY_EXPIRY`. Reading their implementation against
ours found a variant we had.

`requireValidRoot` is structurally identical to `isKnownRegistryRoot` — current root
unconditionally valid, historical roots windowed:

```solidity
// World ID
if (root == _latestRoot) return;
uint128 rootTimestamp = rootHistory[root];
if (rootTimestamp == 0) revert NonExistentRoot();
if (block.timestamp - rootTimestamp > rootHistoryExpiry) revert ExpiredRoot();
```

The difference is **what the stamp means**. `rootHistory[root]` is the moment a root was
*superseded*. Ours was the block a root *became current*:

```solidity
smtRoot = current;
if (registryRootBlock[current] == 0) registryRootBlock[current] = block.number;   // wrong
```

Stamping at creation spends the window while the root is still current — where no grace is
needed, because `root == smtRoot` short-circuits — and leaves none for afterwards. On a
quiet registry a root current for longer than `REGISTRY_ROOT_MAX_AGE` was **born already
expired**: a sender reads it, spends a minute proving, and fails the instant anyone else
registers.

Fixed by stamping the outgoing root instead. A regression test mines past `MAX_AGE` while
idle, then registers, and asserts the superseded root still has its full window.

Their comment names the property directly — the window exists to "prevent proofs getting
invalidated in the mempool by another tx modifying the group." Ours had the window and
pointed it at the wrong interval.

One difference left deliberate: World ID makes expiry settable (`setRootHistoryExpiry`),
where `REGISTRY_ROOT_MAX_AGE` is a constant. Settable means an admin key over proof
validity, which the split exists to avoid.

## What this pass is worth repeating for

Two real bugs, neither from re-reading our own code. Two internal passes — one differential
against the monolith, one standalone — had already missed both.

The method generalises, in two forms:

1. **Take a published finding and ask whether its *shape* applies**, not whether the code
   looks similar. "Validated on create, not on update" found the `dataHash` bug in one
   reading.
2. **Diff a mechanism against an audited implementation of the same mechanism.** Our root
   window and World ID's are the same design; the bug was in what the stamp measured, which
   is invisible unless you have something correct to compare against.

Worth repeating against the Aztec and Railgun audits before any external review — anything
found this way is something a paid auditor no longer has to find.

### Still worth checking

- **Aztec** — note/nullifier lifecycle, and how they handle a note being spent against a
  stale tree root.
- **Railgun** — the closest thing to a production shielded pool with relayers; their fee
  handling is the nearest analogue to `_checkPayee` / `_payOut`.
- **LeanIMT** — Semaphore v4's tree takes the left child's value when the right is missing,
  rather than hashing against a zero. Our `_insertPair` always has both leaves, so it does
  not apply directly, but their zero-value handling is worth reading against `poolZeros`.

## Sources

- [Veridise — Breaking the Tree: Violating Invariants in Semaphore](https://medium.com/veridise/breaking-the-tree-violating-invariants-in-semaphore-4be73be3858d)
- [Semaphore v4.0.0 audit (PSE, March 2024)](https://semaphore.pse.dev/Semaphore_4.0.0_Audit.pdf)
- [SemaphoreGroups.sol](https://github.com/semaphore-protocol/semaphore/blob/main/packages/contracts/contracts/base/SemaphoreGroups.sol)
- [LeanIMT paper](https://zkkit.org/leanimt-paper.pdf)
- [WorldIDIdentityManagerImplV1.sol](https://github.com/worldcoin/world-id-contracts/blob/main/src/WorldIDIdentityManagerImplV1.sol)
- [Ackee — Wormhole/Worldcoin World ID State Root Bridge audit](https://ackee.xyz/blog/wormhole-worldcoin-world-id-state-root-bridge/)
- [zk.money account FAQ](https://aztec-protocol.gitbook.io/zk-money/faq/faq-account) — aliases,
  spending keys, and what registration proved
- [Founders deny regulatory pressure forced the Aztec Connect shutdown](https://www.coindesk.com/consensus-magazine/2023/03/24/founders-deny-regulatory-pressure-forced-aztec-connect-zkmoney-shutdown)
