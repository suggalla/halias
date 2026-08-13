import { get, writable } from 'svelte/store';
import { BrowserProvider, Contract, Interface, ZeroAddress, isAddress, keccak256, toUtf8Bytes } from 'ethers';
import { POOL_ABI, REGISTRY_ABI, CONTROLLER_ABI } from 'halias-sdk';
import { findWallet, soleWallet, legacyWallet } from './wallets.js';

// Errors the contracts can revert with that no ABI fragment above declares — the SDK's ABIs
// list functions and events, not error types.
const ERROR_ABI = [
	'error WrongRegistrationFee()',
	'error AliasTaken()',
	'error AliasKeyTaken()',
	'error AliasNotRegistered()',
	'error InvalidAliasHash()',
	'error InvalidSpendingPubkey()',
	'error InvalidNullifierKeyHash()',
	'error InvalidEncryptionPubkey()',
	'error PubkeyOutOfField()',
	'error NullifierKeyHashOutOfField()',
	'error DataHashOutOfField()',
	'error NotAliasOwner()',
	'error NotController()',
	'error NotAdmin()',
	'error InvalidOwner()',
	'error NameDoesNotMatchAlias()',
	'error ClaimNotAuthorised()',
	'error ClaimMustBeETH()',
	'error ClaimWrongPayout(uint256,uint256)',
	'error OnlyPoolMaySendETH()',
	'error UseTransferAlias()',
	'error AliasApprovalsDisabled()',
	'error InsufficientFees()',
	'error WrongMsgValue(uint256,uint256)',
	'error NullifierAlreadySpent(bytes32)',
	'error DuplicateNullifier()',
	'error PoolRootUnknown()',
	'error RegistryRootNotCurrent()',
	'error InvalidTokenAddress()',
	'error FeeOnTransferToken()',
	'error InvalidProof()',
	'error BadPayee()',
	'error PoolBalanceExceeded()',
	'error RelayerFeeExceedsWithdrawal()',
	'error RelayerFeeRequiresWithdrawal()',
	'error DirectETHNotAllowed()',
	'error ZeroCommitment()',
	'error PoolFull()'
];
import { getNetwork, isSplitDeployment, usableNetworks, ARTIFACT_URLS } from './config.js';
import type { NetworkConfig } from './config.js';

// A single live Halias client, created once a wallet is connected.
//
// Everything the SDK does is client-side: keys derive from a personal_sign, proofs are
// generated in the browser from the wasm and zkey below. Nothing here talks to a server
// of ours, which is the property the whole design exists to preserve.

export type Status = 'idle' | 'connecting' | 'syncing' | 'ready' | 'error';

export interface AliasSummary {
	aliasHash: string;
	slot: number;
	name: string | null;
	/// Which derivation index unlocks it. null means this wallet owns the alias but cannot
	/// currently derive its keys — visible, not spendable.
	index: number | null;
	balance: bigint;
}

export interface ClientState {
	status: Status;
	address: string | null;
	chainId: number | null;
	error: string | null;
	syncProgress: number;
	/// The alias currently being acted as. Null at the wallet level, where you are choosing
	/// one rather than transacting.
	selected: AliasSummary | null;
	aliases: AliasSummary[];
	/// Balance of the selected alias, or zero when none is selected. Balances no longer
	/// merge across aliases — each has its own keys.
	balance: bigint;
	/// The connected EOA's public ETH, which is what funds deposits and gas. Distinct from
	/// anything shielded, and worth showing beside it: reporting only the pool balance
	/// reads as "you have nothing" to someone whose wallet is full.
	walletBalance: bigint;
}

const EMPTY: ClientState = {
	status: 'idle',
	address: null,
	chainId: null,
	error: null,
	syncProgress: 0,
	selected: null,
	aliases: [],
	balance: 0n,
	walletBalance: 0n
};

export const clientState = writable<ClientState>({ ...EMPTY });

// One client per alias index. Each holds its own keys, so a note addressed to one alias is
// invisible to the others — which is the point, and why a single shared client cannot
// represent more than one.
const clients = new Map<number, any>();
let client: any = null;          // the selected alias's client
let baseConfig: any = null;      // enough to build another one on demand
// The secret every alias derives from. Held so switching or enumerating aliases does not
// re-stretch the phrase through PBKDF2 on every client.
//
// It no longer comes from a signature. `personal_sign` derivation meant any site that got a
// user to sign one fixed string owned every key they had — silently, totally, and with no
// way to remediate notes already on chain. See packages/protocol/docs/key-management.md.
let root: bigint | null = null;

// Which wallet the session is connected to, so a wallet event reconnects to that one rather
// than re-running discovery and possibly landing on a different extension.
let connectedRdns: string | null = null;

// The phrase behind that root, held in memory only for this session.
//
// Interim: the wizard in key-management.md replaces this with a keystore in IndexedDB,
// wrapped by a password and a passkey. Until that exists the phrase is entered every time,
// which is inconvenient but honest — nothing here pretends to store it safely.
let seedSource: any = null;

/// Accept a recovery phrase for this session. Throws on a phrase that fails BIP-39's
/// checksum, so a typo is caught while the user is still looking at it.
export async function setSeedPhrase(phrase: string): Promise<void> {
  const { MnemonicSource } = await import('halias-sdk');
  seedSource = new MnemonicSource(phrase);
}

/// A fresh phrase, for someone who has none. It is the wallet: nothing else recovers it.
export async function newSeedPhrase(): Promise<string> {
  const { generateMnemonic } = await import('halias-sdk');
  return generateMnemonic();
}

export function hasSeed(): boolean {
  return seedSource !== null;
}

// aliasHash -> the name it was registered under. Local only, because the contract stores
// a keccak and cannot give the name back. Losing this loses the label, not the alias.
const NAME_MAP_KEY = 'halias.names';

export function readNameMap(): Record<string, string> {
	try {
		const map = JSON.parse(localStorage.getItem(NAME_MAP_KEY) ?? '{}');
		// Earlier builds stored a single bare name under halias.alias with no hash beside
		// it. Fold it in so an alias registered before the map existed keeps its label.
		const legacy = localStorage.getItem('halias.alias');
		if (legacy) {
			const h = keccak256(toUtf8Bytes(legacy)).toLowerCase();
			if (!map[h]) {
				map[h] = legacy;
				localStorage.setItem(NAME_MAP_KEY, JSON.stringify(map));
			}
			localStorage.removeItem('halias.alias');
		}
		return map;
	} catch {
		return {};
	}
}

export function rememberName(aliasHash: string, name: string) {
	const m = readNameMap();
	m[aliasHash.toLowerCase()] = name;
	localStorage.setItem(NAME_MAP_KEY, JSON.stringify(m));
}

export function getClient() {
	if (!client) throw new Error('Select an alias first');
	return client;
}

/// Act as `index`. Builds and initialises a client for it the first time, then caches it —
/// switching alias afterwards costs nothing and never re-prompts, because one signature
/// derives every index.
export async function selectAlias(index: number): Promise<void> {
	if (!baseConfig) throw new Error('Connect a wallet first');
	clientState.update((s) => ({ ...s, status: 'syncing', error: null }));
	try {
		if (!clients.has(index)) {
			const { Halias } = await import('halias-sdk');
			const c = new Halias(baseConfig);
			await c.init(index, root ?? undefined);
			root ??= c.derivationRoot;
			clients.set(index, c);
		}
		client = clients.get(index);
		await refresh();
		clientState.update((s) => ({ ...s, status: 'ready' }));
	} catch (e: any) {
		clientState.update((s) => ({
			...s,
			status: 'error',
			error: describeRevert(e) ?? e?.shortMessage ?? e?.message ?? String(e)
		}));
	}
}

/// A client for `index` without making it the selected alias.
///
/// Registering needs to act as an index while staying on the wallet screen — selecting
/// would advance the wizard mid-flow and unmount the form being submitted.
export async function clientFor(index: number): Promise<any> {
	if (!baseConfig) throw new Error('Connect a wallet first');
	if (!clients.has(index)) {
		const { Halias } = await import('halias-sdk');
		const c = new Halias(baseConfig);
		await c.init(index, root ?? undefined);
		root ??= c.derivationRoot;
		clients.set(index, c);
	}
	return clients.get(index);
}

/// Step back out to the alias list.
// The relayer screen works without an alias: submitting someone else's prepared
// transaction needs a wallet and a chain, nothing of your own.
export function wallet(): { provider: any; signer: any; chainId: number } {
	if (!baseConfig) throw new Error('Connect a wallet first');
	return { provider: baseConfig.provider, signer: baseConfig.signer, chainId: baseConfig.chainId };
}

export function deselectAlias() {
	client = null;
	clientState.update((s) => ({ ...s, selected: null, balance: 0n }));
}

/// The next unused index, for registering an additional alias.
export function nextFreeIndex(aliases: AliasSummary[]): number {
	const used = new Set(aliases.map((a) => a.index).filter((i): i is number => i !== null));
	let i = 0;
	while (used.has(i)) i++;
	return i;
}

export function isConnected(): boolean {
	return client !== null;
}

// Proof artifacts are ~40MB combined, so they are fetched lazily — only when a proof is
// actually needed, not on page load. The browser caches them after the first proof.
function artifactPaths() {
	return { transactWasm: ARTIFACT_URLS.transactWasm, transactZkey: ARTIFACT_URLS.transactZkey };
}

/// Turn a revert into something that names itself.
///
/// A custom error arrives as four bytes of selector and ethers reports "unknown custom
/// error" unless it holds the ABI that declares it. The contracts define around forty
/// between them, each chosen to say exactly what went wrong — none of which reaches the
/// user without this.
function describeRevert(e: any): string | null {
	const data: string | undefined =
		e?.data?.data ?? e?.data ?? e?.info?.error?.data?.data ?? e?.info?.error?.data;
	if (typeof data !== 'string' || data.length < 10) return null;

	for (const abi of [POOL_ABI, REGISTRY_ABI, CONTROLLER_ABI, ERROR_ABI]) {
		try {
			const parsed = new Interface(abi).parseError(data);
			if (!parsed) continue;
			const args = parsed.args.length ? ` (${parsed.args.map(String).join(', ')})` : '';
			return `${parsed.name}${args}`;
		} catch {
			/* try the next ABI */
		}
	}
	return null;
}

/// Ask the wallet to move to `net`, adding it first if the wallet has never seen it.
///
/// A wallet connects on whatever network it happened to be left on, which is usually not
/// the one this build targets. Reporting that as an error puts the work on the user for
/// something the wallet can be asked to do directly.
async function switchTo(ethereum: any, net: NetworkConfig): Promise<void> {
	const chainIdHex = '0x' + net.chainId.toString(16);
	try {
		await ethereum.request({
			method: 'wallet_switchEthereumChain',
			params: [{ chainId: chainIdHex }]
		});
	} catch (e: any) {
		// 4902 is "unrecognized chain" — expected the first time for a local node. Adding
		// it also selects it, so there is no second switch to make.
		if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
		await ethereum.request({
			method: 'wallet_addEthereumChain',
			params: [
				{
					chainId: chainIdHex,
					chainName: net.chainName,
					rpcUrls: [net.rpcUrl],
					nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
					...(net.blockExplorer ? { blockExplorerUrls: [net.blockExplorer] } : {})
				}
			]
		});
	}
}

// Registered once, never removed. Both handlers no-op when `baseConfig` is null, so an
// explicit disconnect stays disconnected instead of being undone by the next wallet event.
//
// Keyed by wallet: connecting to a different wallet has to attach handlers to that wallet's
// provider. A single flag would leave the second wallet's account switches unnoticed.
const watched = new Set<any>();

function watchWallet(ethereum: any): void {
	if (watched.has(ethereum)) return;
	watched.add(ethereum);

	// Switching accounts changes who you are, not just who pays.
	//
	// The signer and the derived key root are both captured at connect. A stale signer sends
	// `from` an account the wallet no longer has selected, which it refuses — but the more
	// serious half is silent: `root` still derives the previous account's spending keys, so a
	// transaction that did go through would act as the wrong identity. Nothing downstream can
	// detect that, which is why this resets rather than patching the signer.
	ethereum.on('accountsChanged', async (accounts: string[]) => {
		if (!baseConfig) return;
		if (accounts.length === 0) return disconnect();
		const same = connectedRdns;
		disconnect();
		await connect(same ?? undefined);
	});

	// Same reasoning: a different chain is a different registry, a different pool, and
	// aliases that do not exist there.
	ethereum.on('chainChanged', async () => {
		if (!baseConfig) return;
		const same = connectedRdns;
		disconnect();
		await connect(same ?? undefined);
	});
}

/// Connect to a wallet.
///
/// `rdns` names which one (EIP-6963 reverse-DNS id). Omitted, it connects to the only wallet
/// present, or to a pre-6963 wallet injected the old way — but never guesses between several,
/// since guessing is the behaviour EIP-6963 exists to end.
export async function connect(rdns?: string): Promise<void> {
	const chosen = rdns ? findWallet(rdns) : soleWallet();
	const ethereum = chosen?.provider ?? (rdns ? undefined : legacyWallet());
	if (!ethereum) {
		clientState.update((s) => ({
			...s,
			status: 'error',
			error: rdns ? `${rdns} is not available` : 'No wallet detected'
		}));
		return;
	}
	// So a wallet event can reconnect to the same wallet rather than re-guessing.
	connectedRdns = chosen?.info.rdns ?? null;
	if (!seedSource) {
		clientState.update((s) => ({
			...s,
			status: 'error',
			error: 'Enter your recovery phrase before connecting'
		}));
		return;
	}
	watchWallet(ethereum);

	clientState.update((s) => ({ ...s, status: 'connecting', error: null }));

	try {
		await ethereum.request({ method: 'eth_requestAccounts' });
		let provider = new BrowserProvider(ethereum);
		let signer = await provider.getSigner();
		let chainId = Number((await provider.getNetwork()).chainId);
		// The wallet arrives on whatever network it was left on. If that is not one this
		// build can use, ask it to move rather than telling the user to.
		let net = getNetwork(chainId);
		if (!net || !isSplitDeployment(net)) {
			const target = usableNetworks()[0];
			if (!target)
				// Two very different causes, and the old message only named one of them. A dev
				// server started while deployments/networks/localhost.json did not exist bakes in
				// an empty glob, so the app keeps reporting this until it is restarted — long
				// after the file has come back.
				throw new Error(
					'No usable deployment in this build. Sepolia still points at the pre-split ' +
						'contracts, and no local deployment was found when this build started. Run ' +
						'`npx hardhat run scripts/deploy.ts --network localhost`, then restart the dev ' +
						'server so it picks the file up.'
				);

			clientState.update((s) => ({ ...s, error: `Switching to ${target.chainName}…` }));
			await switchTo(ethereum, target);

			// Re-read rather than assuming: the user can decline the prompt, and BrowserProvider
			// caches the network it was constructed with.
			provider = new BrowserProvider(ethereum);
			signer = await provider.getSigner();
			chainId = Number((await provider.getNetwork()).chainId);
			net = getNetwork(chainId);
			if (!net || !isSplitDeployment(net))
				throw new Error(`Still on an unusable network (${chainId}) — switch to ${target.chainName} to continue`);
		}
		clientState.update((s) => ({ ...s, error: null }));

		// Check the three addresses before handing them to ethers. A missing one surfaces as
		// "invalid value for contract target", which names neither the field nor the network
		// and sends you looking in the wrong place.
		for (const [field, value] of [
			['poolAddress', net.poolAddress],
			['registryAddress', net.registryAddress],
			['controllerAddress', net.controllerAddress]
		] as const) {
			if (!value || !isAddress(value))
				throw new Error(
					`${net.chainName} (chain ${net.chainId}) has no valid ${field}: ${JSON.stringify(value)} — ` +
						`redeploy and rebuild, or check deployments/networks/${net.chainId === 31337 ? 'localhost' : 'sepolia'}.json`
				);
		}

		const { BrowserCache } = await import('halias-sdk');
		baseConfig = {
			provider,
			signer,
			seed: seedSource,
			chainId,
			poolAddress: net.poolAddress,
			registryAddress: net.registryAddress,
			controllerAddress: net.controllerAddress,
			artifacts: artifactPaths(),
			cache: new BrowserCache(),
			startBlock: net.startBlock,
			rpcChunkSize: 2000,
			onProgress: (pct: number) => clientState.update((s) => ({ ...s, syncProgress: pct }))
		};

		// Read after any network switch, since switching re-derives the signer.
		const address = await signer.getAddress();
		clientState.update((s) => ({ ...s, status: 'syncing', address, chainId }));

		// Derived here, explicitly, rather than as a side effect of whichever code path happens
		// to build a client first — that left it uncached for a wallet with no aliases yet, so
		// every later call re-derived.
		root = await seedSource.root();

		// Connecting lands you at the wallet, not inside an alias.
		await loadAliases();
		clientState.update((s) => ({ ...s, status: 'ready' }));
	} catch (e: any) {
		client = null;
		clientState.update((s) => ({
			...s,
			status: 'error',
			error: describeRevert(e) ?? e?.shortMessage ?? e?.message ?? String(e)
		}));
	}
}

export function disconnect() {
	client = null;
	baseConfig = null;
	root = null;
	seedSource = null;
	connectedRdns = null;
	clients.clear();
	clientState.set({ ...EMPTY });
}

/// The EOA's own ETH — public, spendable for gas, and not in the pool.
export async function refreshWalletBalance(): Promise<void> {
	if (!baseConfig) return;
	try {
		const addr = await baseConfig.signer.getAddress();
		const walletBalance = await baseConfig.provider.getBalance(addr);
		clientState.update((s) => ({ ...s, walletBalance }));
	} catch {
		/* a balance read failing should not break the screen */
	}
}

/// Enumerate the wallet's aliases and each one's balance.
///
/// Balances are per-alias now, so this initialises a client per discovered index. The cost
/// is one event scan per alias; sharing a single scan across them is the obvious follow-up
/// once anyone has more than a handful.
export async function loadAliases(): Promise<void> {
	if (!baseConfig) return;
	await refreshWalletBalance();
	const { Halias } = await import('halias-sdk');
	const found = await Halias.discoverAliases(baseConfig, 32, root ?? undefined);
	// discoverAliases signs once and returns the root, so every client built below reuses it.
	if (found.length > 0) root ??= found[0].root;
	const names = readNameMap();

	const aliases: AliasSummary[] = [];
	for (const a of found) {
		let balance = 0n;
		if (a.index !== null) {
			if (!clients.has(a.index)) {
				const c = new Halias(baseConfig);
				await c.init(a.index, root ?? undefined);
				root ??= c.derivationRoot;
				clients.set(a.index, c);
			} else {
				// An existing client may predate a registration made through another one.
				await clients.get(a.index).refresh();
			}
			balance = (await clients.get(a.index).balance()).total;
		}
		aliases.push({
			aliasHash: a.aliasHash,
			slot: a.slot,
			index: a.index,
			name: names[a.aliasHash.toLowerCase()] ?? null,
			balance
		});
	}
	clientState.update((s) => ({ ...s, aliases }));
}

// Re-reads chain state and refreshes the derived view. Called after every action so the
// UI reflects what actually landed rather than what was optimistically assumed.
export async function refresh(): Promise<void> {
	if (!client) return;
	// Rescan, do not just re-read. balance() goes through ensureSync(), which returns early
	// once a client has synced — so a client's view of the registry is frozen at whenever it
	// first loaded. Register an alias on one client and the others never learn it exists,
	// which surfaces as "Recipient pubkey not found in registry" for a name plainly visible
	// in the UI.
	await client.refresh();
	const balance = (await client.balance()).total;
	const names = readNameMap();

	clientState.update((s) => {
		// The selected alias is the one whose index matches this client. aliasHash is a
		// keccak and cannot be reversed, so names come from what this browser remembers.
		const selected =
			s.aliases.find((a) => a.index === client.index) ?? s.selected;
		return {
			...s,
			balance,
			selected: selected
				? { ...selected, balance, name: names[selected.aliasHash.toLowerCase()] ?? selected.name }
				: null,
			aliases: s.aliases.map((a) => (a.index === client.index ? { ...a, balance } : a))
		};
	});
}

/// Throw away what has been scanned and read the chain again from the alias's first block.
///
/// `refresh()` is incremental: it decrypts only what arrived since the last cursor, which is
/// what makes reopening the app fast. That is the right default and the wrong recovery — a
/// cache written by an older note format, or one truncated by a browser reclaiming storage,
/// stays wrong no matter how many times it is refreshed. This is the way out, and it is
/// manual because it is slow: every note in the pool, trial-decrypted again.
export async function rescan(): Promise<void> {
	if (!client) return;
	await client.rescan();
	await refresh();
}

/// Who this alias is currently offered to, or null if it is not on offer.
export async function pendingOwnerOf(aliasHash: string): Promise<string | null> {
	if (!baseConfig) return null;
	const controller = new Contract(baseConfig.controllerAddress, CONTROLLER_ABI, baseConfig.provider);
	const pending: string = await controller.pendingAliasOwner(aliasHash);
	return pending === ZeroAddress ? null : pending;
}

/// Accept an alias someone has offered to this wallet.
///
/// The keys installed are this wallet's, derived at `index` — the recipient chooses them and
/// nobody else can. That is why accepting is a separate step from offering rather than the
/// sender simply transferring: a seller who picked the new keys could hand over the name and
/// keep receiving everything paid to it.
export async function acceptAliasAt(index: number, name: string): Promise<{ txHash: string } | null> {
	const c = await clientFor(index);
	return run(async () => {
		const r = await c.acceptAlias(name);
		rememberName(keccak256(toUtf8Bytes(name)), name.replace(/\.hls$/i, ''));
		await loadAliases();
		return r;
	});
}

// Wraps an action so the UI gets a consistent busy/error story rather than each window
// inventing its own.
export async function run<T>(fn: () => Promise<T>): Promise<T | null> {
	const prev = get(clientState).status;
	clientState.update((s) => ({ ...s, status: 'syncing', error: null }));
	try {
		const result = await fn();
		await refresh();
		clientState.update((s) => ({ ...s, status: 'ready' }));
		return result;
	} catch (e: any) {
		clientState.update((s) => ({
			...s,
			status: prev === 'ready' ? 'ready' : 'error',
			error: describeRevert(e) ?? e?.shortMessage ?? e?.message ?? String(e)
		}));
		return null;
	}
}
