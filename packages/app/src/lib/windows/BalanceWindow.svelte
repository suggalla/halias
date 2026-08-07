<script lang="ts">
	import { formatEther } from 'ethers';
	import { clientState, getClient, run, connect } from '../sdk/client.js';

	let notes = $state<{ amount: bigint; leafIndex: number; spent: boolean }[]>([]);

	const busy  = $derived($clientState.status === 'syncing' || $clientState.status === 'connecting');
	const ready = $derived($clientState.status === 'ready');

	async function handleScan() {
		const r = await run(() => getClient().scan());
		if (r) notes = r.filter((n: any) => !n.spent);
	}
</script>

<div class="balance-view">
	<div class="balance-header">
		<span class="label">Balance</span>
		<span class="total">{formatEther($clientState.balance)} ETH</span>
	</div>

	{#if $clientState.alias}
		<p class="alias">{$clientState.alias}</p>
	{:else if ready}
		<p class="empty">No alias yet — register one to receive.</p>
	{/if}

	{#if !ready}
		<button class="btn btn-primary" onclick={connect} disabled={busy}>
			{busy ? 'Connecting…' : 'Connect wallet'}
		</button>
	{:else}
		<button class="btn" onclick={handleScan} disabled={busy}>
			{busy ? 'Scanning…' : 'Scan for notes'}
		</button>
	{/if}

	<div class="notes-list">
		{#if notes.length === 0}
			<p class="empty">{ready ? 'No unspent notes.' : 'Connect a wallet to see your notes.'}</p>
		{:else}
			{#each notes as note}
				<div class="note-row">
					<span>#{note.leafIndex}</span>
					<span>{formatEther(note.amount)} ETH</span>
				</div>
			{/each}
		{/if}
	</div>

	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.balance-view   { display: flex; flex-direction: column; gap: 10px; }
	.balance-header { display: flex; justify-content: space-between; align-items: baseline; }
	.total          { font-size: 18px; font-weight: 600; }
	.alias          { font-size: 12px; margin: 0; opacity: 0.85; }
	.notes-list     { display: flex; flex-direction: column; gap: 4px; }
	.note-row       { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.85; }
	.empty          { font-size: 11px; opacity: 0.6; margin: 0; }
	.err            { font-size: 11px; color: #c33; margin: 0; word-break: break-word; }
</style>
