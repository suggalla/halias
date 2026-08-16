<script lang="ts">
	import { windowStore } from '../wm/store.js';
	import { walletStore, connectMetaMask, disconnect } from '../wallet/connect.js';

	function handleWalletClick() {
		if ($walletStore.address) {
			disconnect();
		} else {
			connectMetaMask();
		}
	}

	function shortAddr(addr: string): string {
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}
</script>

<div class="taskbar">
	<div class="taskbar-left">
		<span class="taskbar-brand">halias</span>
		{#each $windowStore as win (win.id)}
			<button
				class="taskbar-btn"
				class:active={win.visible}
				onclick={() => windowStore.toggleWindow(win.id)}
			>
				{win.title}
			</button>
		{/each}
	</div>
	<div class="taskbar-right">
		<button class="wallet-pill" onclick={handleWalletClick}>
			<span class="status-dot" class:connected={$walletStore.address}></span>
			{#if $walletStore.connecting}
				connecting...
			{:else if $walletStore.address}
				{shortAddr($walletStore.address)}
			{:else}
				Connect
			{/if}
		</button>
	</div>
</div>

<style>
	.taskbar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: var(--taskbar-h);
		background: var(--bg-dark);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 12px;
		z-index: 999999;
	}

	.taskbar-left {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.taskbar-brand {
		font-size: 14px;
		font-weight: bold;
		color: var(--accent);
		letter-spacing: 2px;
		text-transform: lowercase;
		margin-right: 16px;
	}

	.taskbar-right {
		display: flex;
		align-items: center;
	}

	.taskbar-btn {
		padding: 5px 14px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-dim);
		font-family: inherit;
		font-size: 13px;
		text-transform: uppercase;
		letter-spacing: 1px;
		cursor: pointer;
	}

	.taskbar-btn:hover {
		border-color: var(--border);
		color: var(--text);
	}

	.taskbar-btn.active {
		border-color: var(--accent);
		color: var(--accent);
		box-shadow: 0 0 6px var(--accent-glow);
	}

	.wallet-pill {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 14px;
		border: 1px solid var(--border);
		border-radius: 2px;
		background: var(--bg-input);
		color: var(--text);
		font-family: inherit;
		font-size: 13px;
		cursor: pointer;
	}

	.wallet-pill:hover {
		border-color: var(--accent);
	}

	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-dim);
	}

	.status-dot.connected {
		background: var(--accent);
		box-shadow: 0 0 4px var(--accent);
	}
</style>
