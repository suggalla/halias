// Encrypted-at-rest storage for the recovery phrase.
//
// The phrase used to be typed every session and held only in memory. That stored nothing,
// which was honest but unusable. This stores it encrypted, and the shape is the one in
// packages/protocol/docs/key-management.md:
//
//     dataKey   = random(32)
//     keystore  = AES-GCM(dataKey, mnemonic)
//     wrap_prf  = AES-GCM(KDF(prfOutput), dataKey)
//     wrap_pass = AES-GCM(PBKDF2(password), dataKey)
//
// Envelope encryption, so the two unlock paths protect the same data key rather than two
// copies of the phrase. Adding or removing a passkey rewraps 32 bytes and never re-encrypts
// the phrase itself.
//
// **The password wrapping is not optional**, even though the passkey is the everyday path.
// WebAuthn PRF returns different values in Safari's hybrid (QR) flow than it does on-device,
// passkeys get deleted, and some platforms have no authenticator at all — so a passkey-only
// keystore is one cross-device login away from being unreadable. The password is what makes
// the local copy recoverable; the phrase is what makes the *wallet* recoverable, and nothing
// here changes that.
//
// Deviation from the spec worth naming: it says scrypt, and this uses PBKDF2-SHA256 at
// 600,000 iterations. WebCrypto has no scrypt, and shipping a KDF in JS to obtain a
// memory-hard one would run slower and be easier to get wrong than the native primitive.

const DB_NAME = 'halias-vault';
const DB_VERSION = 1;
const STORE = 'entries';

// OWASP's floor for PBKDF2-SHA256. Measured at ~90ms here and several times that in a
// browser, which is the intended trade: paid once per unlock, multiplied across every guess
// an attacker makes.
const PBKDF2_ITERATIONS = 600_000;

export interface VaultEntry {
	id: string;
	label: string;
	createdAt: number;
	hasPasskey: boolean;
}

interface Wrapped {
	iv: number[];
	data: number[];
}

interface StoredEntry {
	id: string;
	label: string;
	createdAt: number;
	/// AES-GCM(dataKey, mnemonic)
	phrase: Wrapped;
	/// AES-GCM(PBKDF2(password, salt), dataKey)
	pass: Wrapped & { salt: number[]; iterations: number };
	/// AES-GCM(HKDF(prfOutput), dataKey), plus what is needed to reproduce that output.
	prf: (Wrapped & { credentialId: number[]; salt: number[] }) | null;
}

// ── IndexedDB ────────────────────────────────────────────────────────────────
//
// Not localStorage: that is a hard ~5MB per origin which the scan cache alone approaches,
// and evicting the keystore to make room for a cache would lose the phrase.

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDb().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(STORE, mode);
				const req = fn(t.objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
				t.oncomplete = () => db.close();
			})
	);
}

// ── Primitives ───────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;
const dec = new TextDecoder();
// Explicitly backed by ArrayBuffer, not ArrayBufferLike. TypeScript 5.7 made Uint8Array
// generic over its buffer, and the SharedArrayBuffer case does not satisfy BufferSource —
// so pinning it here keeps every WebCrypto and WebAuthn call below cast-free.
type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (a: number[]): Bytes => new Uint8Array(a);
const arr = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b));

function randomBytes(n: number): Bytes {
	return crypto.getRandomValues(new Uint8Array(n));
}

async function aesKey(raw: ArrayBuffer | Bytes): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

async function seal(key: CryptoKey, plaintext: Bytes): Promise<Wrapped> {
	const iv = randomBytes(12);
	const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	return { iv: arr(iv), data: arr(data) };
}

async function open(key: CryptoKey, w: Wrapped): Promise<Bytes> {
	const out = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: bytes(w.iv) },
		key,
		bytes(w.data)
	);
	return new Uint8Array(out);
}

/// Password → AES key. The salt is per-entry, so the same password on two wallets does not
/// produce the same wrapping key.
async function keyFromPassword(password: string, salt: Bytes, iterations: number) {
	const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/// PRF output → AES key, through HKDF so the raw authenticator output is never used directly
/// as a key.
async function keyFromPrf(prfOutput: ArrayBuffer): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('halias vault v1') },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

// ── Passkeys ─────────────────────────────────────────────────────────────────

export function passkeySupported(): boolean {
	if (typeof window === 'undefined') return false;
	// An IP address is not a valid relying-party id, so passkeys cannot be created on
	// http://127.0.0.1 — even though it *is* a secure context and everything else works
	// there. `localhost` is a domain and is fine. Reported as unsupported rather than left
	// to fail at the prompt, where it reads as a broken passkey rather than a wrong URL.
	if (/^\[?[0-9a-fA-F:.]+\]?$/.test(location.hostname) && location.hostname !== 'localhost') {
		return false;
	}
	return !!window.PublicKeyCredential && !!navigator.credentials && window.isSecureContext;
}

/// Create a passkey that can produce a PRF output, and return that output.
///
/// The PRF result is read with a follow-up assertion rather than from creation: several
/// platforms report `enabled` at creation but only return values on a later get(), so
/// treating creation as sufficient produces a keystore nothing can open.
///
/// `rp.id` is deliberately unset so the browser uses the current origin. Setting it by hand
/// is what breaks on an IP address, which is not a valid relying-party id.
async function createPasskeyPrf(
	label: string,
	salt: Bytes
): Promise<{ credentialId: Bytes; output: ArrayBuffer }> {
	const cred = (await navigator.credentials.create({
		publicKey: {
			challenge: randomBytes(32),
			rp: { name: 'halias' },
			user: { id: randomBytes(16), name: label, displayName: label },
			pubKeyCredParams: [
				{ type: 'public-key', alg: -7 },     // ES256
				{ type: 'public-key', alg: -257 }    // RS256
			],
			authenticatorSelection: {
				residentKey: 'required',
				userVerification: 'required'
			},
			extensions: { prf: {} } as AuthenticationExtensionsClientInputs
		}
	})) as PublicKeyCredential | null;

	if (!cred) throw new Error('Passkey creation was dismissed');
	const ext = cred.getClientExtensionResults() as any;
	if (!ext?.prf?.enabled) {
		throw new Error('This authenticator cannot derive a key (no PRF support)');
	}

	const credentialId = new Uint8Array(cred.rawId);
	const output = await evaluatePrf(credentialId, salt);
	return { credentialId, output };
}

/// Ask an existing passkey for its PRF output. Prompts for biometry or a PIN.
async function evaluatePrf(credentialId: Bytes, salt: Bytes): Promise<ArrayBuffer> {
	const assertion = (await navigator.credentials.get({
		publicKey: {
			challenge: randomBytes(32),
			allowCredentials: [{ id: credentialId, type: 'public-key' }],
			userVerification: 'required',
			extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs
		}
	})) as PublicKeyCredential | null;

	if (!assertion) throw new Error('Passkey was dismissed');
	const results = (assertion.getClientExtensionResults() as any)?.prf?.results;
	if (!results?.first) throw new Error('This authenticator returned no PRF output');
	return results.first as ArrayBuffer;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listVault(): Promise<VaultEntry[]> {
	if (typeof indexedDB === 'undefined') return [];
	try {
		const all = (await tx('readonly', (s) => s.getAll())) as StoredEntry[];
		return all
			.map((e) => ({ id: e.id, label: e.label, createdAt: e.createdAt, hasPasskey: !!e.prf }))
			.sort((a, b) => a.createdAt - b.createdAt);
	} catch {
		return [];
	}
}

/// Store a phrase, wrapped by a password. Returns the entry id.
///
/// `label` is just a name to tell several apart. It is not a secret and not part of any key.
export async function createVault(
	mnemonic: string,
	password: string,
	label: string
): Promise<string> {
	const dataKeyRaw = randomBytes(32);
	const dataKey = await aesKey(dataKeyRaw);
	const phrase = await seal(dataKey, utf8(mnemonic));

	const salt = randomBytes(16);
	const passKey = await keyFromPassword(password, salt, PBKDF2_ITERATIONS);
	const wrappedPass = await seal(passKey, dataKeyRaw);

	const entry: StoredEntry = {
		id: crypto.randomUUID(),
		label,
		createdAt: Date.now(),
		phrase,
		pass: { ...wrappedPass, salt: arr(salt), iterations: PBKDF2_ITERATIONS },
		prf: null
	};
	await tx('readwrite', (s) => s.put(entry));
	return entry.id;
}

/// Add a passkey to an existing entry, so later unlocks are a biometric prompt.
///
/// Needs the password, because wrapping the data key requires having it — which is the point
/// of envelope encryption: the phrase is not re-encrypted and never leaves its own wrapping.
export async function addPasskey(id: string, password: string): Promise<void> {
	const entry = (await tx('readonly', (s) => s.get(id))) as StoredEntry | undefined;
	if (!entry) throw new Error('No such wallet');

	const passKey = await keyFromPassword(password, bytes(entry.pass.salt), entry.pass.iterations);
	const dataKeyRaw = await open(passKey, entry.pass);   // throws on a wrong password

	const salt = randomBytes(32);
	const { credentialId, output } = await createPasskeyPrf(entry.label, salt);
	const prfKey = await keyFromPrf(output);
	const wrapped = await seal(prfKey, dataKeyRaw);

	entry.prf = { ...wrapped, credentialId: arr(credentialId), salt: arr(salt) };
	await tx('readwrite', (s) => s.put(entry));
}

export async function unlockWithPassword(id: string, password: string): Promise<string> {
	const entry = (await tx('readonly', (s) => s.get(id))) as StoredEntry | undefined;
	if (!entry) throw new Error('No such wallet');
	const passKey = await keyFromPassword(password, bytes(entry.pass.salt), entry.pass.iterations);
	const dataKeyRaw = await open(passKey, entry.pass);   // AES-GCM tag failure = wrong password
	return dec.decode(await open(await aesKey(dataKeyRaw), entry.phrase));
}

export async function unlockWithPasskey(id: string): Promise<string> {
	const entry = (await tx('readonly', (s) => s.get(id))) as StoredEntry | undefined;
	if (!entry?.prf) throw new Error('No passkey on this wallet');
	const output = await evaluatePrf(bytes(entry.prf.credentialId), bytes(entry.prf.salt));
	const dataKeyRaw = await open(await keyFromPrf(output), entry.prf);
	return dec.decode(await open(await aesKey(dataKeyRaw), entry.phrase));
}

export async function deleteVault(id: string): Promise<void> {
	await tx('readwrite', (s) => s.delete(id));
}

const LABEL_PREFIX = 'Halias Wallet';

/// "Halias Wallet 1", "Halias Wallet 2", … — a default, not a requirement.
///
/// Counted from the numbers already in use rather than from how many entries there are.
/// Those differ the moment one is removed: with 1 and 2 stored, deleting the first leaves a
/// count of one, and a count-based name would hand out "2" a second time. Names are not keys
/// — entries are addressed by uuid — so a collision would not corrupt anything, it would just
/// leave two identical rows in the picker that exists to tell them apart.
///
/// Only auto-generated names are counted. Someone who calls a wallet "DeFi" has not used up
/// a number, and the next default is unaffected.
export function nextLabel(existing: VaultEntry[]): string {
	const used = existing
		.map((e) => new RegExp(`^${LABEL_PREFIX} (\\d+)$`).exec(e.label.trim()))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => parseInt(m[1], 10));
	return `${LABEL_PREFIX} ${used.length === 0 ? 1 : Math.max(...used) + 1}`;
}
