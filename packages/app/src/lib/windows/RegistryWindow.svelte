<script lang="ts">
	import { formatEther } from 'ethers';
	import { clientState, getClient, run } from '../sdk/client.js';

	let name = $state('');
	let lookupName = $state('');
	let result = $state<string | null>(null);
	let fee = $state<bigint | null>(null);

	const busy  = $derived($clientState.status === 'syncing');
	const ready = $derived($clientState.status === 'ready');

	$effect(() => {
		if (ready && fee === null) {
			getClient().contract.registrationFee().then((f: bigint) => (fee = f)).catch(() => {});
		}
	});

	async function handleRegister() {
		result = null;
		const clean = name.trim().toLowerCase().replace(/\.hls$/, '');
		const r = await run(() => getClient().register(clean));
		if (r) {
			// The chain cannot tell us the name back — aliasHash is a keccak — so remember it.
			localStorage.setItem('halias.alias', `${clean}.hls`);
			result = `Registered ${clean}.hls`;
		}
	}

	async function handleLookup() {
		result = null;
		const r = await run(() => getClient().lookup(lookupName.trim()));
		result = r ? `${lookupName.trim()} is registered` : null;
	}
</script>

<div class="registry-form">
	<label class="label" for="reg-name">Choose your alias</label>
	<div class="name-row">
		<input id="reg-name" class="input" type="text" placeholder="alice" bind:value={name} disabled={busy} />
		<span class="suffix">.hls</span>
	</div>

	<div class="fee-line">
		<span class="label">Registration fee</span>
		<span class="fee-value">{fee !== null ? formatEther(fee) + ' ETH' : '—'}</span>
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
	.name-row      { display: flex; align-items: center; gap: 6px; }
	.suffix        { font-size: 12px; opacity: 0.7; }
	.fee-line      { display: flex; justify-content: space-between; font-size: 11px; }
	hr             { border: 0; border-top: 1px solid currentColor; opacity: 0.2; margin: 4px 0; }
	.ok            { font-size: 11px; color: #2b7; margin: 0; }
	.err           { font-size: 11px; color: #c33; margin: 0; word-break: break-word; }
</style>
