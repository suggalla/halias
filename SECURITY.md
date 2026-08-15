# Security

## The short version

halias is **unaudited** and its trusted setup has **one contributor**. Do not put real money in
it. Anything you deposit today is at risk from bugs nobody has found yet and from a setup that
one person could have subverted.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/suggalla/halias/security/advisories/new)
on this repository. That gives us a private channel with you and a place to coordinate a fix.

Please do not open a public issue for anything that could move or reveal someone's funds.

Include what you have — a description, the affected file or circuit, and a proof of concept if
you built one. A rough report is worth more than a polished one that arrives a month later.

There is no bug bounty. This is an unfunded project and offering a reward we could not honour
would be worse than saying so plainly.

## What is in scope

Anything that breaks one of these:

- **Custody.** `HaliasPool` moves value only against a valid proof. There is no admin, owner,
  upgrade path, pause, or rescue — including for the deployer. Any path that moves value
  otherwise is a critical finding.
- **Soundness.** A proof should be impossible to construct for a transaction the pool ought to
  reject. Under-constrained signals in `transact.circom` are the highest-value target in the
  repo, and the reason is below.
- **Double-spend.** A note is spendable exactly once. Nullifiers are
  `Poseidon(nullifierKey, globalIndex, NULLIFIER_DOMAIN)` and must be unforgeable and unique.
- **Privacy.** A transfer should publish no amount, no sender and no recipient. Anything that
  links a deposit to a withdrawal, or an alias to a note, through the protocol itself.
- **Authorisation.** Signed alias operations — registration, rotation, handover — must not be
  replayable, and a relayer submitting one must not be able to redirect it to itself.
- **Key derivation.** Note keys come from a BIP-39 phrase and never from a wallet signature.
  Anything that makes a key recoverable from something a website can ask you to sign.

## What is out of scope

- The single-contributor ceremony. We know. It is documented, and it gates mainnet.
- Anything requiring a malicious RPC provider to also break TLS.
- Timing and amount correlation by an on-chain observer. That is inherent to a shielded pool,
  and `docs/legal-considerations.md` and the app's About screen both say so.
- Gas costs, unless the cost makes an operation unusable for someone who needs it.
- The Sepolia deployment. It predates the contract split and is dead.

## Why soundness matters more here than in most protocols

When a shielded pool's soundness breaks, **you cannot tell whether it was exploited.** The
property that makes it private is the same property that destroys the audit trail — every
transaction is opaque, so a forged one looks like a real one.

Aztec put this precisely in their July 2026 disclosure: *"The affected system lacks the
information needed to distinguish ordinary accepted transactions from transactions accepted
through the flawed proving path."* That is a well-funded team with serious cryptographers, on
their second critical finding in four months, after internal and external audits had completed.

The one thing that survives is aggregate conservation. `Transact`, `PoolExit` and `Withdrawal`
carry enough to reconstruct the pool's liability from logs and compare it against the live
balance. If the real balance ever falls below the reconstructed liability, value left the pool
that no proof was entitled to move. It is worth more than an on-chain counter would be, because
it is not written by the code path that would be exploited.

## What we have done, and what that is worth

- 180 in-process tests, 86 SDK tests, 133 live-RPC checks, including E2E with real proofs.
- Slither, Aderyn, circomspect and Picus, triaged in `docs/static-analysis.md`.
- A pre-freeze under-constraint audit of `transact.circom`, which found and fixed a nullifier
  domain collision.
- A differential review against Semaphore's audit and World ID's implementation, which found
  two real bugs that two internal passes had missed.

None of that substitutes for an external audit, and the Aztec case above is the argument: their
findings arrived *after* human review had signed off. Treat everything here as unreviewed until
someone independent has said otherwise.
