# Key management

How a client obtains the keys that spend and read notes, where they are stored, and what
recovery means. Supersedes the `personal_sign` derivation described in earlier notes.

## The problem this replaces

`deriveRoot()` was `keccak(personal_sign("halias key derivation v1…"))`. Signatures are
deterministic, so **any site that persuaded a user to sign that exact string derived every
key for every alias index**, and could spend everything.

Three properties make it worse than ordinary signature phishing:

- **Silent** — no transaction, no approval, nothing on chain. The victim gets no signal.
- **Total** — spending *and* viewing keys, every index, full balance and full history.
- **Unremediable** — notes bind `spendingCommitment = Poseidon(spendingPrivateKey)`, so the attacker can
  spend every existing note. Rotating via `acceptAlias` protects only *future* receipts.

## Two independent roles

The mistake in the current design is that one secret does both jobs.

| role | source | touches |
|---|---|---|
| **EVM signer** | MetaMask / WalletConnect | signs `transact`, pays gas, broadcasts |
| **note keys** | the seed, below | ZK witnesses and note encryption only |

The seed **never signs an Ethereum transaction**, has no address, and never appears on
chain. So there is no wallet to build: the connected wallet keeps broadcasting, exactly as
Railgun uses MetaMask for shield/unshield while `0zk` keys stand apart. Users with no ETH
use the existing relayer path — relayer and fee bound into `paramsHash`, paid from the note.

## The seed

A 256-bit secret, presented as a BIP-39 mnemonic. Spending and viewing keys derive from it
exactly as they do from the root today, so `deriveKeysFromRoot` and everything downstream is
unchanged — only the source of the root moves.

Both keys come from one seed initially. Splitting their sources later (viewing from a
signature, for wallet-only balance visibility) is a **creation-time choice recorded per
wallet**, never a migration: changing where the viewing key comes from changes the key, and
every note already on chain is encrypted to the old one.

### Why not derive it from the wallet

Three options were evaluated against three properties. None satisfies all three:

| | portable across ecosystems | nothing extra to back up | not phishable |
|---|---|---|---|
| `personal_sign` | yes | yes | **no** |
| generated mnemonic | yes | **no** | yes |
| WebAuthn PRF / MetaMask Snap | **no** | yes | yes |

The mnemonic is the only one that survives a user moving between platforms, which decides
it. The other two become *unlock* mechanisms layered on top (below), where their gaps cost
convenience rather than funds.

Verified constraints behind that table, each of which would otherwise be discovered late:

- **Snaps are MetaMask browser-extension only.** No mobile, and no other wallet implements
  the platform. `snap_getEntropy` is genuinely good — deterministic, namespaced to the snap
  ID, derived from the user's existing recovery phrase so there is nothing new to back up —
  but it reaches a fraction of users.
- **WebAuthn PRF returns different values in Safari's hybrid flow** than on-device (18.2+).
  Cross-device authentication is normal behaviour, so PRF cannot be sole key material or a
  sole wrapping — either would make a keystore unreadable after a QR-scan login.
- **PRF data is bound to one passkey.** Lose it and anything wrapped with it is gone.
- **Apple does not pass extension data to roaming authenticators** on iOS/iPadOS, so
  hardware keys are not a PRF path there.
- **A phone's secure enclave is reachable from the web only through WebAuthn**, and natively
  it signs and decrypts rather than emitting a reproducible seed. It protects a secret; it
  cannot be one.

## Storage: envelope encryption, two wrappings

```
setup    dataKey   = random(32)
         keystore  = AES-GCM(dataKey, mnemonic)        → IndexedDB
         wrap_prf  = AES-GCM(KDF(prfOutput), dataKey)  → stored with credentialId
         wrap_pass = AES-GCM(scrypt(password), dataKey)

unlock   try PRF (biometric prompt) → else password → else re-import mnemonic
```

Both wrappings protect the same data key, so adding PRF costs one wizard field and no
ongoing friction.

**The password wrapping is not optional**, despite PRF being the everyday path. Its job is
narrow but real: unlocking *existing local storage* when PRF is unavailable or inconsistent
— the Safari hybrid case, a deleted passkey, a platform with no authenticator. On a genuinely
new device there is no keystore either, so recovery there is the mnemonic regardless.

IndexedDB rather than localStorage: the latter is a hard ~5 MB per origin, which the scan
cache alone reaches at roughly 2,500 aliases.

## Setup flow

1. **Note keys** — create (show phrase, confirm written down) or import.
2. **Password** — encrypts local storage. Stated plainly as *not* recovery.
3. **Passkey** *(optional)* — second wrapping, so later sessions unlock by biometric.
4. **Connect wallet** — MetaMask/WalletConnect for broadcasting, or the relayer path.

Step 4 is not an alternative to step 1. It is a separate connection that happens either way.

## Recovery

| lost | outcome |
|---|---|
| device, have mnemonic | full recovery anywhere |
| passkey | password unlocks; re-add a passkey |
| password, passkey works | unlock, then set a new password |
| mnemonic, keystore intact | continue on this device; **cannot move or recover elsewhere** |
| mnemonic and keystore | funds unrecoverable |

The wizard must say which of these is the wallet: the password protects local storage, the
passkey is convenience, **the phrase is the wallet**.

## The custody line

Non-custodial turns on control of funds, not on who generated the key — MetaMask generates
seeds client-side and is not a money transmitter. So a client-generated mnemonic preserves
the posture in `legal-considerations.md`.

What would break it: **any server-side escrow, backup, or recovery of the mnemonic or the
keystore** — encrypted or not, opt-in or not. Users will ask for it. It is the single change
that converts this from software into custody, and it must not be built.

Biometrics never reach us; WebAuthn keeps them on the device and returns only a derived
value.

## Interface

One seam, so every source is additive:

```ts
interface SeedSource {
  /// The 256-bit secret. Everything downstream is unchanged.
  root(): Promise<bigint>;
}
```

Implementations today are `MnemonicSource` (a phrase, validated when accepted) and
`RootSource` (a root already in hand — restored from a keystore, or shared between clients so
switching alias does not re-run PBKDF2). `SnapSource` and a view-only source come later.

The `personal_sign` path is **deleted, not deprecated**. Keeping it as an option would keep
the vulnerability: an attacker only needs the derivation a victim's client will accept, and a
retained fallback is exactly that. Nothing had launched, so there was nothing to migrate.

## Phasing

1. ~~The seam, and the mnemonic behind it.~~ **Done.** `SeedSource` in `sdk/src/seed.ts`;
   `personal_sign` derivation removed; CLI takes `HALIAS_MNEMONIC` and has `keys new`.
2. ~~Browser: the wizard above, password wrapping, IndexedDB.~~ **Done** — `app/src/lib/sdk/vault.ts`.
3. ~~PRF wrapping as the everyday unlock.~~ **Done**, in the same place. Both wrappings are
   written at setup; the passkey is offered as a checkbox and its failure is non-fatal,
   because the wallet is already openable by password before it is attempted.
4. CLI keystore — the CLI still takes `HALIAS_MNEMONIC` from the environment, which is
   plaintext at rest. The browser format above is the one to reuse.
5. View-only export — the viewing half alone, for auditors. Already implied by the key
   structure; it needs a format and a client that runs without a spending key.

### What the browser implementation deviates on

- **PBKDF2-SHA256 at 600,000 iterations, not scrypt.** WebCrypto has no scrypt, and shipping
  a JS implementation to get a memory-hard KDF would be slower and easier to get wrong than
  the native primitive. Measured ~90ms outside the browser.
- **Passkeys are unavailable on an IP-address origin**, because a relying-party id must be a
  domain. `localhost` works, `127.0.0.1` does not — which only affects local development, but
  silently, so the client reports passkeys as unsupported there rather than failing at the
  prompt.
- **The PRF output is read from a follow-up assertion, not from creation.** Several platforms
  report `prf.enabled` at creation while returning values only on a later `get()`, so trusting
  creation alone writes a keystore nothing can open.
