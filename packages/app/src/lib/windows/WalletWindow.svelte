<script lang="ts">
	import { formatEther, keccak256, toUtf8Bytes } from 'ethers';
	// From the alias module, not the package root — see the note in sdk/client.ts. This is pure
	// string handling and has no business loading Poseidon.
	import { normalizeAlias, fullAlias, InvalidAliasError } from 'halias-sdk/alias';
	import {
		clientState,
		run,
		rememberName,
		selectAlias,
		clientFor,
		loadAliases,
		nextFreeIndex,
		offersToMe,
		acceptOfferAt,
		type Offer
	} from '../sdk/client.js';

	// The wallet is a list of identities, not a balance.
	//
	// Each alias has its own keys, so it has its own notes and its own balance — nothing
	// merges. Sending or withdrawing is therefore always *from* a specific alias, which is
	// why those actions live one level down rather than here. There is no "the" balance at
	// this level to act on.

	let name = $state('');
	let msg = $state<string | null>(null);
	// Availability, which only the chain can answer — separate from nameError, which is a
	// shape rule this browser can check on its own. Cleared as soon as the name changes, so
	// it never outlives the name it was about.
	let takenError = $state<string | null>(null);
	let labelError = $state<string | null>(null);

	// Validate as it is typed. The same rule runs in the SDK before the transaction, but a
	// name is rejected for reasons a user can fix — telling them after they have paid gas
	// is the wrong moment.
	const nameError = $derived.by(() => {
		if (!name.trim()) return null;
		try {
			normalizeAlias(name);
			return null;
		} catch (e) {
			return e instanceof InvalidAliasError ? e.message : String(e);
		}
	});
	const preview = $derived.by(() => {
		try {
			return fullAlias(name);
		} catch {
			return null;
		}
	});

	const busy = $derived($clientState.status === 'syncing' || $clientState.status === 'connecting');
	const ready = $derived($clientState.status === 'ready');
	const total = $derived($clientState.aliases.reduce((s, a) => s + a.balance, 0n));

	// No truncation. A partial address or alias hash cannot be verified against anything,
	// and verifying is the entire reason it is on screen — an abbreviated one is decoration
	// that reads as information.
	let copied = $state<string | null>(null);
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = text;
			setTimeout(() => (copied = copied === text ? null : copied), 1200);
		} catch {
			/* clipboard unavailable; the value is fully visible regardless */
		}
	}

	let step = $state<'commit' | 'register' | null>(null);

	async function handleRegister() {
		step = null;
		takenError = null;
		if (nameError) return;
		let clean: string;
		try {
			clean = normalizeAlias(name);
		} catch {
			return;
		}
		msg = null;

		// A new alias takes the next unused derivation index, so it gets its own keys rather
		// than sharing with one already registered.
		//
		// clientFor rather than selectAlias: selecting advances the wizard to the actions
		// screen, which unmounts this form while it is still submitting.
		const index = nextFreeIndex($clientState.aliases);
		const c = await clientFor(index);

		// Asked before the wallet opens. The SDK refuses a taken name too, but reaching it
		// through run() means the wallet has already prompted — and registration prompts
		// twice, so the answer arrives after the reservation is mined and paid for.
		if (await c.isAliasTaken(clean)) {
			takenError = `${clean}.hls is already taken — try another name.`;
			return;
		}
		// Registration is the one action that sends two transactions. Naming the step turns a
		// second unexplained wallet prompt into an expected one — without it the natural read
		// is that the first attempt failed.
		if (await run(() => c.register(clean, (s: 'commit' | 'register') => (step = s)))) {
			step = null;
			// Remembered locally so the name shows before the next scan picks up the
			// NamePublished event the registration just emitted. The chain is the source of
			// truth; this only covers the gap.
			rememberName(keccak256(toUtf8Bytes(clean + '.hls')), clean);
			msg = `Registered ${clean}.hls`;
			name = '';
			await loadAliases();
		}
	}

	// Hashes what is typed and refuses anything that does not reproduce the alias hash, so a
	// wrong guess cannot silently mislabel an alias.
	function labelAlias(aliasHash: string, input: string) {
		let clean: string;
		try {
			clean = normalizeAlias(input);
		} catch (e) {
			labelError = e instanceof InvalidAliasError ? e.message : String(e);
			return;
		}
		if (keccak256(toUtf8Bytes(clean + '.hls')).toLowerCase() !== aliasHash.toLowerCase()) {
			labelError = `"${clean}.hls" is not this alias`;
			return;
		}
		rememberName(aliasHash, clean);
		labelError = null;
		loadAliases();
	}

	// Aliases offered to this wallet.
	//
	// Here rather than with an alias's own actions because you do not own it yet — there is
	// nothing to select. Found rather than typed: AliasOffered indexes the recipient, so the
	// node answers "what have I been offered" directly, and the contract accepts by hash, so
	// an offer can be taken without being told the name behind it. Accepting installs *this*
	// wallet's keys, which is why only the recipient can complete a handover.
	let offers = $state<Offer[]>([]);
	let offersLoaded = $state(false);
	let acceptMsg = $state<string | null>(null);
	let acceptErr = $state<string | null>(null);
	let acceptingHash = $state<string | null>(null);

	const freeIndex = $derived(nextFreeIndex($clientState.aliases));

	// Only aliases this phrase can actually act as.
	//
	// An alias owned by this address whose keys the phrase cannot derive cannot send, and its
	// balance reads zero because nothing decrypts — so listing it beside working ones only
	// made the list look broken.
	const usable = $derived($clientState.aliases.filter((a) => a.index !== null));

	async function loadOffers() {
		try {
			offers = await offersToMe();
		} catch {
			offers = [];   // an offer list failing should not take the wallet down with it
		}
		offersLoaded = true;
	}

	$effect(() => {
		if ($clientState.address) loadOffers();
	});

	async function takeOffer(o: Offer) {
		acceptMsg = null;
		acceptErr = null;
		acceptingHash = o.aliasHash;
		const r = await acceptOfferAt(freeIndex, o.aliasHash);
		acceptingHash = null;
		if (r) {
			acceptMsg = `${o.name ? `${o.name}.hls` : 'The alias'} is yours — it now uses your keys.`;
			await loadOffers();
		} else {
			acceptErr = 'Could not accept it — the offer may have just been withdrawn.';
		}
	}
</script>

<div class="wallet">
	<header>
		<div>
			<span class="label">{$clientState.accountName ?? 'Wallet'}</span>
			<button class="addr" title="Click to copy"
				onclick={() => $clientState.address && copy($clientState.address)}>
				{copied === $clientState.address ? 'copied' : $clientState.address}
			</button>
		</div>
		<!-- Two balances, because they are two different things and conflating them is
		     how the header read "0.0 ETH" to someone holding 100. -->
		<div class="balances">
			<div class="b">
				<span class="k">In wallet</span>
				<span class="v">{formatEther($clientState.walletBalance)} ETH</span>
			</div>
			<div class="b">
				<span class="k">Shielded</span>
				<span class="v accent">{formatEther(total)} ETH</span>
			</div>
		</div>
	</header>

	<section>
		<h3>Aliases</h3>
		{#if usable.length === 0}
			<p class="empty">None yet — register one below to start receiving.</p>
		{:else}
			<ul class="aliases">
				{#each usable as a}
					<li>
						<button class="alias" disabled={busy} onclick={() => selectAlias(a.index!)}>
							<span class="nm">{a.name ? `${a.name}.hls` : a.aliasHash}</span>
							<span class="bal">{formatEther(a.balance)} ETH</span>
						</button>
						{#if !a.name}
							<input
								class="label-in"
								placeholder="Know the name? Type it to label locally"
								onchange={(e) => labelAlias(a.aliasHash, e.currentTarget.value)}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

	</section>

	<section>
		<h3>Register another</h3>
		<div class="row">
			<input
				bind:value={name}
				placeholder="alice"
				disabled={busy}
				aria-invalid={!!nameError || !!takenError}
				oninput={() => (takenError = null)}
			/>
			<span class="suffix">.hls</span>
			<button class="primary" disabled={busy || !ready || !!nameError || !name.trim()}
				onclick={handleRegister}>
				{step === 'commit' ? 'Reserving…' : step === 'register' ? 'Registering…' : 'Register'}
			</button>
		</div>

		<!-- Said before the wallet opens, not after. Two prompts with no warning reads as a
		     failed first attempt, and the natural reaction is to reject the second. -->
		{#if step}
			<ol class="steps">
				<li class:now={step === 'commit'} class:done={step === 'register'}>
					Reserve the name
					<em>Approve in your wallet — this publishes only a hash.</em>
				</li>
				<li class:now={step === 'register'}>
					Register it
					<em>A second transaction, one block later.</em>
				</li>
			</ol>
		{:else}
			<p class="hint">
				Registering takes <strong>two transactions</strong>. The first reserves the name
				without revealing it, so nobody watching can take it before you do; the second
				claims it a block later.
			</p>
		{/if}
		{#if nameError}
			<p class="err">{nameError}</p>
		{:else if takenError}
			<p class="err">{takenError}</p>
		{:else if preview && preview !== `${name.trim().toLowerCase()}.hls`}
			<!-- Shows what will actually be registered when the input was not already
			     canonical, so "Alice.HLS" or "alice.hls.hls" is not a surprise. -->
			<p class="hint">Registers as <code>{preview}</code></p>
		{/if}
		<p class="hint">
			Each alias gets its own keys, so its balance and history stay separate from your others.
		</p>
	</section>

	<!-- The receiving half of a handover. It belongs to the wallet, not to an alias, because
	     until this succeeds the alias is not yours and there is nothing to select. -->
	{#if offers.length > 0}
		<section>
			<h3>Offered to you</h3>
			<ul class="offers">
				{#each offers as o (o.aliasHash)}
					<li>
						<div class="oinfo">
							<span class="nm">{o.name ? `${o.name}.hls` : o.aliasHash}</span>
							<span class="from">from {o.from}</span>
						</div>
						<button
							class="primary"
							disabled={busy || acceptingHash !== null}
							onclick={() => takeOffer(o)}
						>
							{acceptingHash === o.aliasHash ? 'Accepting…' : 'Accept'}
						</button>
					</li>
				{/each}
			</ul>
			<p class="hint">
				Accepting installs <strong>your</strong> keys — the previous owner cannot choose them
				and cannot read anything paid to it afterwards. It arrives at index {freeIndex} with
				its own balance, empty of whatever they held.
			</p>
			{#if offers.some((o) => !o.name)}
				<p class="hint">
					One of these has no published name, so only its hash can be shown. It can be
					accepted regardless — the contract identifies an alias by hash, never by name.
				</p>
			{/if}
			{#if acceptErr}<p class="err">{acceptErr}</p>{/if}
			{#if acceptMsg}<p class="ok">{acceptMsg}</p>{/if}
		</section>
	{:else if offersLoaded && acceptMsg}
		<p class="ok">{acceptMsg}</p>
	{/if}

	{#if msg}<p class="ok">{msg}</p>{/if}
	{#if labelError}<p class="err">{labelError}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.wallet { display: flex; flex-direction: column; gap: 1.25rem; padding: 0.5rem; }
	header { display: flex; justify-content: space-between; align-items: flex-start;
		gap: 1rem; flex-wrap: wrap;
		border-bottom: 1px solid var(--border); padding-bottom: 0.6rem; }
	.label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }
	.addr { margin-left: 0.5rem; font-family: var(--font-mono); font-size: 0.78rem;
		background: none; border: none; color: inherit; padding: 0; cursor: pointer;
		overflow-wrap: anywhere; text-align: left; }
	.addr:hover { color: var(--accent); }
	.balances { display: flex; gap: 1.5rem; }
	.b { display: flex; flex-direction: column; align-items: flex-end; gap: 0.1rem; }
	.k { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }
	.v { font-size: 1rem; font-variant-numeric: tabular-nums; }
	.v.accent { color: var(--accent); }
	h3 { margin: 0 0 0.5rem; font-size: 0.75rem; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-dim); font-weight: 600; }
	.aliases { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
	.alias { width: 100%; display: flex; justify-content: space-between; align-items: center;
		gap: 1rem; flex-wrap: wrap; padding: 0.7rem 0.8rem; background: var(--bg-input);
		border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
		color: inherit; font: inherit; text-align: left; }
	.alias:hover:not(:disabled) { border-color: var(--accent); }
	.alias:disabled { cursor: default; color: var(--text-dim); }
	.nm { font-family: var(--font-mono); overflow-wrap: anywhere; font-size: 0.8rem;
		min-width: 0; }
	.bal { font-variant-numeric: tabular-nums; opacity: 0.85; }
	.row { display: flex; gap: 0.4rem; align-items: center; }
	.row input { flex: 1; min-width: 0; }
	.suffix { color: var(--text-dim); font-family: var(--font-mono); }
	.label-in { width: 100%; margin-top: 0.3rem; font-size: 0.8rem; }
	.hint, .empty { font-size: 0.8rem; color: var(--text-dim); margin: 0.4rem 0 0; }
	.offers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.4rem; }
	.offers li { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
		padding: 0.7rem 0.8rem; background: var(--bg-input); border: 1px solid var(--accent);
		border-radius: 6px; }
	.oinfo { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }
	.from { font-size: 0.7rem; color: var(--text-dim); font-family: var(--font-mono);
		overflow-wrap: anywhere; }
	.offers .primary { padding: 0.4rem 0.9rem; }
	.ok { color: var(--good); font-size: 0.85rem; margin: 0; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; }
	.primary { padding: 0.5rem 0.9rem; }
	.steps { margin: 0.5rem 0 0; padding-left: 1.2rem; display: flex; flex-direction: column;
		gap: 0.35rem; font-size: 0.8rem; color: var(--text-dim); }
	.steps li.now { color: var(--text-bright); }
	.steps li.done { opacity: 0.55; text-decoration: line-through; }
	.steps em { display: block; font-style: normal; font-size: 0.75rem; color: var(--text-dim);
		text-decoration: none; }
</style>
