<script lang="ts">
	import { clientState, getClient, run } from '../sdk/client.js';

	let recipient = $state('');
	let amount = $state('');
	let result = $state<string | null>(null);

	const busy = $derived($clientState.status === 'syncing');
	const ready = $derived($clientState.status === 'ready');

	async function handleSend() {
		result = null;
		const r = await run(() => getClient().send(recipient.trim(), amount.trim()));
		if (r) result = `Sent. ${r.txHash.slice(0, 14)}…`;
	}
</script>

<div class="send-form">
	{#if !ready && !busy}
		<p class="hint">Connect a wallet to send.</p>
	{/if}

	<label class="label" for="send-to">Recipient</label>
	<input id="send-to" class="input" type="text" placeholder="alice.hls" bind:value={recipient} disabled={busy} />

	<label class="label" for="send-amt">Amount (ETH)</label>
	<input id="send-amt" class="input" type="text" placeholder="0.1" bind:value={amount} disabled={busy} />

	<button class="btn btn-primary" onclick={handleSend} disabled={busy || !ready || !recipient || !amount}>
		{busy ? 'Proving…' : 'Send'}
	</button>

	<!-- Proving runs in this tab and takes several seconds; saying so beats a frozen button. -->
	{#if busy}<p class="hint">Generating a zero-knowledge proof in your browser. This takes a few seconds.</p>{/if}
	{#if result}<p class="ok">{result}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.send-form { display: flex; flex-direction: column; gap: 12px; }
	.hint { font-size: 11px; opacity: 0.7; margin: 0; }
	.ok   { font-size: 11px; color: #2b7; margin: 0; }
	.err  { font-size: 11px; color: #c33; margin: 0; word-break: break-word; }
</style>
