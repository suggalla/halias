<script lang="ts">
	import { formatEther, keccak256, toUtf8Bytes } from 'ethers';
	import { clientState, getClient, run, rememberName } from '../sdk/client.js';

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
		const r = await run(() => getClient().register(clean));
		if (r) {
			// The chain stores keccak(name), so it can never give the name back. Record the
			// mapping locally; losing it loses the label, not the alias.
			rememberName(keccak256(toUtf8Bytes(full)), full);
			result = `Registered ${full}`;
			name = '';
		}
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
					<!-- Registered from another browser, so the name is not recoverable here. -->
					<p class="empty">Name unknown — registered elsewhere.</p>
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
