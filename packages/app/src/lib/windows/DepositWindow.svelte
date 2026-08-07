<script lang="ts">
	import { clientState, getClient, run } from '../sdk/client.js';

	let amount = $state('');
	let result = $state<string | null>(null);

	const busy = $derived($clientState.status === 'syncing');
	const ready = $derived($clientState.status === 'ready');

	async function handleDeposit() {
		result = null;
		const r = await run(() => getClient().deposit(amount.trim()));
		if (r) result = `Deposited. ${r.txHash.slice(0, 14)}…`;
	}
</script>

<div class="form">
	{#if !ready && !busy}<p class="hint">Connect a wallet to deposit.</p>{/if}

	<label class="label" for="dep-amt">Amount (ETH)</label>
	<input id="dep-amt" class="input" type="text" placeholder="0.01" bind:value={amount} disabled={busy} />

	<button class="btn btn-primary" onclick={handleDeposit} disabled={busy || !ready || !amount}>
		{busy ? 'Proving…' : 'Deposit'}
	</button>

	<p class="hint">Shields ETH into the pool. The amount is public on this step and private thereafter.</p>
	{#if result}<p class="ok">{result}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.form { display: flex; flex-direction: column; gap: 12px; }
	.hint { font-size: 11px; opacity: 0.7; margin: 0; }
	.ok   { font-size: 11px; color: #2b7; margin: 0; }
	.err  { font-size: 11px; color: #c33; margin: 0; word-break: break-word; }
</style>
