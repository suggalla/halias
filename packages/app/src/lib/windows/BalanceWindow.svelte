<script lang="ts">
	let notes: { denomination: string; index: number }[] = $state([]);
	let scanning = $state(false);

	function handleScan() {
		console.log('scan for notes');
		scanning = true;
		setTimeout(() => (scanning = false), 1000);
	}

	let total = $derived(
		notes.reduce((sum, n) => sum + parseFloat(n.denomination), 0)
	);
</script>

<div class="balance-view">
	<div class="balance-header">
		<span class="label">Balance</span>
		<span class="total">{total.toFixed(4)} ETH</span>
	</div>

	<button class="btn" onclick={handleScan}>
		{scanning ? 'Scanning...' : 'Scan'}
	</button>

	<div class="notes-list">
		{#if notes.length === 0}
			<p class="empty">No notes found. Connect wallet and scan.</p>
		{:else}
			{#each notes as note}
				<div class="note-row">
					<span>{note.denomination} ETH</span>
					<span class="note-idx">#{note.index}</span>
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	.balance-view {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.balance-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	.total {
		font-size: 20px;
		color: var(--accent);
		font-weight: bold;
	}

	.notes-list {
		border-top: 1px solid var(--border);
		padding-top: 10px;
	}

	.empty {
		color: var(--text-dim);
		font-size: 14px;
	}

	.note-row {
		display: flex;
		justify-content: space-between;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
		font-size: 15px;
	}

	.note-idx {
		color: var(--text-dim);
	}
</style>
