<script lang="ts">
	let name = $state('');

	function handleRegister() {
		console.log('register', { name: name + '.hls' });
	}
</script>

<div class="registry-form">
	<label class="label" for="reg-name">Choose your alias</label>
	<div class="name-row">
		<input
			id="reg-name"
			class="input"
			type="text"
			placeholder="alice"
			bind:value={name}
		/>
		<span class="suffix">.hls</span>
	</div>

	<div class="fee-line">
		<span class="label">Registration fee</span>
		<span class="fee-value">0.01 ETH</span>
	</div>

	<button class="btn btn-primary" onclick={handleRegister}>Register</button>
</div>

<style>
	.registry-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.name-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.name-row .input {
		flex: 1;
	}

	.suffix {
		color: var(--text-dim);
		font-size: 15px;
		white-space: nowrap;
	}

	.fee-line {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	.fee-value {
		color: var(--accent);
		font-size: 15px;
	}
</style>
