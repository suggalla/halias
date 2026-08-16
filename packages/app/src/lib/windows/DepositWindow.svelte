<script lang="ts">
	const denominations = ['0.001', '0.01', '0.1', '1', '10'];
	let selected = $state('0.1');

	function handleDeposit() {
		console.log('deposit', { denomination: selected });
	}
</script>

<div class="deposit-form">
	<span class="label">Denomination (ETH)</span>
	<div class="denom-row">
		{#each denominations as d}
			<button
				class="denom-btn"
				class:active={selected === d}
				onclick={() => (selected = d)}
			>
				{d}
			</button>
		{/each}
	</div>

	<button class="btn btn-primary" onclick={handleDeposit}>Deposit</button>
</div>

<style>
	.deposit-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.denom-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.denom-btn {
		padding: 8px 14px;
		border: 1px solid var(--border);
		background: var(--bg-input);
		color: var(--text);
		font-family: inherit;
		font-size: 14px;
		cursor: pointer;
	}

	.denom-btn:hover {
		border-color: var(--accent);
	}

	.denom-btn.active {
		border-color: var(--accent);
		color: var(--accent);
		box-shadow: 0 0 6px var(--accent-glow);
	}
</style>
