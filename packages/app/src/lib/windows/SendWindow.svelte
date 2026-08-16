<script lang="ts">
	let recipient = $state('');
	let amount = $state('');

	function handleSend() {
		console.log('send', { recipient, amount });
	}
</script>

<div class="send-form">
	<label class="label" for="send-to">Recipient</label>
	<input
		id="send-to"
		class="input"
		type="text"
		placeholder="alice.hls"
		bind:value={recipient}
	/>

	<label class="label" for="send-amt">Amount (ETH)</label>
	<input
		id="send-amt"
		class="input"
		type="text"
		placeholder="0.1"
		bind:value={amount}
	/>

	<button class="btn btn-primary" onclick={handleSend}>Send</button>
</div>

<style>
	.send-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
