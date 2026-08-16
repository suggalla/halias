<div class="info-view">
	<h2 class="logo">halias</h2>
	<p class="tagline">Send to an alias. Privately.</p>

	<div class="divider"></div>

	<div class="steps">
		<div class="step">
			<span class="step-num">1</span>
			<span>Connect your wallet</span>
		</div>
		<div class="step">
			<span class="step-num">2</span>
			<span>Register a .hls name</span>
		</div>
		<div class="step">
			<span class="step-num">3</span>
			<span>Deposit ETH into the pool</span>
		</div>
		<div class="step">
			<span class="step-num">4</span>
			<span>Send privately to any .hls alias</span>
		</div>
	</div>

	<div class="divider"></div>

	<p class="note">
		All proof generation happens in MetaMask (or your local wallet).
		No backend. No tracking. Your keys never leave your device.
	</p>
</div>

<style>
	.info-view {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.logo {
		font-size: 24px;
		font-weight: bold;
		color: var(--accent);
		letter-spacing: 3px;
		text-transform: lowercase;
	}

	.tagline {
		font-size: 15px;
		color: var(--text-dim);
		font-style: italic;
	}

	.divider {
		height: 1px;
		background: var(--border);
		margin: 2px 0;
	}

	.steps {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.step {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 15px;
		color: var(--text);
	}

	.step-num {
		width: 24px;
		height: 24px;
		border: 1px solid var(--accent);
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		color: var(--accent);
		flex-shrink: 0;
	}

	.note {
		font-size: 14px;
		color: var(--text-dim);
		line-height: 1.6;
	}
</style>
