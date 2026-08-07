<script lang="ts">
	import { formatEther, keccak256, toUtf8Bytes } from 'ethers';
	import { clientState, getClient, run, rememberName, refresh } from '../sdk/client.js';

	let name = $state('');
	let lookupName = $state('');
	let result = $state<string | null>(null);
	let fee = $state<bigint | null>(null);

	const busy  = $derived($clientState.status === 'syncing');
	const ready = $derived($clientState.status === 'ready');

	$effect(() => {
		if (ready && fee === null) {
			getClient().registrationFee().then((f: bigint) => (fee = f)).catch(() => {});
		}
	});

	async function handleRegister() {
		result = null;
		const clean = name.trim().toLowerCase().replace(/\.hls$/, '');
		if (!clean) return;
		const full = `${clean}.hls`;
		// Recorded before the call, not after: run() refreshes the alias list as soon as the
		// transaction lands, and that refresh reads this map. Writing it afterwards meant the
		// freshly registered alias always appeared unnamed until the next refresh. A stale
		// entry from a failed registration is harmless — it labels a hash nobody owns.
		rememberName(keccak256(toUtf8Bytes(full)), full);
		const r = await run(() => getClient().register(clean));
		if (r) {
			result = `Registered ${full}`;
			name = '';
		}
	}

	let labelError = $state<string | null>(null);

	// Verifies before saving: hashing the supplied name must reproduce the alias hash,
	// so a wrong guess is rejected rather than silently mislabelling someone's alias.
	function labelAlias(aliasHash: string, input: string) {
		labelError = null;
		const clean = input.trim().toLowerCase().replace(/\.hls$/, '');
		if (!clean) return;
		const full = `${clean}.hls`;
		if (keccak256(toUtf8Bytes(full)).toLowerCase() !== aliasHash.toLowerCase()) {
			labelError = `${full} is not this alias`;
			return;
		}
		rememberName(aliasHash, full);
		refresh();
	}

	async function handleLookup() {
		result = null;
		const q = lookupName.trim();
		const r = await run(() => getClient().lookup(q));
		result = r ? `${q} is registered` : `${q} is not registered`;
	}
</script>

<div class="registry-form">
	<section>
		<span class="label">My aliases</span>
		{#if !ready}
			<p class="empty">Connect a wallet to see your aliases.</p>
		{:else if $clientState.aliases.length === 0}
			<p class="empty">None yet.</p>
		{:else}
			{#each $clientState.aliases as a}
				<div class="alias-row">
					<span class="alias-name">{a.name ?? a.aliasHash.slice(0, 16) + '…'}</span>
					<span class="alias-slot">slot {a.slot}</span>
				</div>
				{#if !a.name}
					<!-- Registered in another browser: the chain stores keccak(name), so the name
					     cannot be recovered. It can only be re-supplied and checked. -->
					<div class="name-row">
						<input class="input" type="text" placeholder="name it: alice"
							onkeydown={(e) => e.key === 'Enter' && labelAlias(a.aliasHash, (e.currentTarget as HTMLInputElement).value)} />
						<span class="suffix">.hls</span>
					</div>
					{#if labelError}<p class="err">{labelError}</p>{/if}
				{/if}
			{/each}
		{/if}
	</section>

	<hr />

	<label class="label" for="reg-name">Register an alias</label>
	<div class="name-row">
		<input id="reg-name" class="input" type="text" placeholder="alice" bind:value={name} disabled={busy} />
		<span class="suffix">.hls</span>
	</div>
	<div class="fee-line">
		<span class="label">Fee</span>
		<span>{fee !== null ? formatEther(fee) + ' ETH' : '—'}</span>
	</div>
	<button class="btn btn-primary" onclick={handleRegister} disabled={busy || !ready || !name}>
		{busy ? 'Working…' : 'Register'}
	</button>

	<hr />

	<label class="label" for="lk-name">Look up an alias</label>
	<div class="name-row">
		<input id="lk-name" class="input" type="text" placeholder="bob.hls" bind:value={lookupName} disabled={busy} />
	</div>
	<button class="btn" onclick={handleLookup} disabled={busy || !ready || !lookupName}>Look up</button>

	{#if result}<p class="ok">{result}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.registry-form { display: flex; flex-direction: column; gap: 10px; }
	section        { display: flex; flex-direction: column; gap: 4px; }
	.name-row      { display: flex; align-items: center; gap: 6px; }
	.suffix        { font-size: 12px; opacity: 0.7; }
	.fee-line      { display: flex; justify-content: space-between; font-size: 11px; }
	.alias-row     { display: flex; justify-content: space-between; font-size: 12px; }
	.alias-name    { font-weight: 600; }
	.alias-slot    { opacity: 0.6; font-size: 11px; }
	hr             { border: 0; border-top: 1px solid currentColor; opacity: 0.2; margin: 4px 0; }
	.empty         { font-size: 11px; opacity: 0.6; margin: 0; }
	.ok            { font-size: 11px; color: #2b7; margin: 0; }
	.err           { font-size: 11px; color: #c33; margin: 0; word-break: break-word; }
</style>
