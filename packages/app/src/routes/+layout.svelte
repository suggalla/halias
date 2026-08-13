<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { clientState, disconnect, deselectAlias } from '$lib/sdk/client.js';
	import { getNetwork } from '$lib/sdk/config.js';
	import WalletWindow from '$lib/windows/WalletWindow.svelte';
	import TransactWindow from '$lib/windows/TransactWindow.svelte';
	import HistoryView from '$lib/windows/HistoryView.svelte';
	import InfoWindow from '$lib/windows/InfoWindow.svelte';
	import RelayWindow from '$lib/windows/RelayWindow.svelte';
	import DepositWindow from '$lib/windows/DepositWindow.svelte';
	import ClaimWindow from '$lib/windows/ClaimWindow.svelte';
	import Onboarding from '$lib/windows/Onboarding.svelte';

	let { children }: { children: Snippet } = $props();

	// One thing on screen at a time, in the order the model actually works:
	//
	//     wallet  →  alias  →  actions | history
	//
	// The tiled-window version put those side by side, which implied you could act without
	// choosing an alias first. You cannot: every alias has its own keys, so a send spends
	// from one specific identity and there is no shared balance to act on. Making the step
	// explicit removes the ambiguity rather than papering over it.

	type Tab = 'actions' | 'history';
	let tab = $state<Tab>('actions');
	// Two panels that sit outside the wallet → alias → act progression. Relaying in
	// particular needs no alias of your own: you are submitting someone else's transaction.
	let panel = $state<'none' | 'about' | 'relay' | 'deposit' | 'redeem'>('none');
	// Redeeming is the only half of invites that belongs out here: it needs no alias, no
	// balance and no prior involvement. Creating one spends a note, so it sits with the
	// alias's other actions.
	const PANEL_LABEL = { about: 'About', relay: 'Relay', deposit: 'Deposit',
		redeem: 'Redeem', none: '' };

	// A viewer has no address — it signs nothing — so connectedness cannot be read off one.
	const viewing = $derived($clientState.viewOnly && $clientState.status !== 'idle');
	const connected = $derived(
		viewing || ($clientState.status !== 'idle' && $clientState.address !== null)
	);
	const alias = $derived($clientState.selected);
	// A view key covers exactly one alias and is bound to it on unlock, so there is no wallet
	// level to stand at: it opens directly on that alias.
	const step = $derived(!connected ? 1 : viewing ? 3 : alias === null ? 2 : 3);
	// Which chain this is talking to. Worth being permanently visible rather than implied:
	// the same alias name on a testnet and on mainnet are unrelated identities.
	const net = $derived($clientState.chainId !== null ? getNetwork($clientState.chainId) : undefined);

	// A relay link opens on the relay screen, connected or not — RelayWindow asks for a wallet
	// itself. Landing on the connect page instead would look like the link had failed.
	$effect(() => {
		if (typeof location === 'undefined') return;
		if (/[#&]relay=/.test(location.hash)) panel = 'relay';
		else if (/[#&]claim=/.test(location.hash)) panel = 'redeem';
	});
</script>

<div class="app">
	<header class="bar">
		<a class="brand" href="/" onclick={(e) => { e.preventDefault(); panel = 'none'; }}>
			halias
		</a>
		<!-- Breadcrumb rather than a progress meter: these are places you can be, and you can go
		     back to one — which it now actually does. It was inert, and it also carried both
		     "Wallet" and "Aliases" for what is one screen; the wallet view *is* the alias list,
		     so a crumb that cannot be distinguished from its neighbour is just noise. -->
		<nav class="crumbs" aria-label="Where you are">
			{#if step === 1}
				<span class="now">Connect</span>
			{:else}
				<!-- Named, not just "Wallet". Which of several stored wallets is open is not
				     derivable from anything else on screen — they can share an address, and the
				     alias list below is exactly what differs between them — so an unlabelled crumb
				     leaves the one question this level answers unanswered. -->
				<button class="crumb" class:now={step === 2 && panel === 'none'}
					disabled={step === 2 && panel === 'none'}
					title={$clientState.accountName ? 'Back to this wallet' : undefined}
					onclick={() => { panel = 'none'; deselectAlias(); }}>
					{$clientState.accountName ?? 'Wallet'}
				</button>
				{#if alias}
					<span class="sep">/</span>
					<button class="crumb" class:now={panel === 'none'} disabled={panel === 'none'}
						onclick={() => (panel = 'none')}>
						{alias.name ? `${alias.name}.hls` : 'Alias'}
					</button>
				{/if}
				<!-- A panel is somewhere you are, so it belongs in the trail — otherwise opening
				     Deposit looks like it left the app. -->
				{#if panel !== 'none'}
					<span class="sep">/</span>
					<span class="now">{PANEL_LABEL[panel]}</span>
				{/if}
			{/if}
		</nav>
		<div class="right">
			{#if connected}
				<span class="net" title="Chain {$clientState.chainId}">
					<span class="dot" class:local={$clientState.chainId === 31337}></span>
					{net?.chainName ?? `Chain ${$clientState.chainId}`}
				</span>
			{/if}
			<!-- The label has to say what the click does. As a fixed "About" it toggled with no
			     indication it would, so the panel looked like a dead end. -->
			{#if connected && !viewing}
				<button class="link" class:on={panel === 'deposit'}
					onclick={() => (panel = panel === 'deposit' ? 'none' : 'deposit')}>Deposit</button>
				<button class="link" class:on={panel === 'redeem'}
					onclick={() => (panel = panel === 'redeem' ? 'none' : 'redeem')}>Redeem</button>
				<button class="link" class:on={panel === 'relay'}
					onclick={() => (panel = panel === 'relay' ? 'none' : 'relay')}>Relay</button>
			{/if}
			<button class="link" class:on={panel === 'about'}
				onclick={() => (panel = panel === 'about' ? 'none' : 'about')}>
				{panel === 'about' ? 'Close' : 'About'}
			</button>
			{#if connected}
				<button class="link" onclick={disconnect}>Disconnect</button>
			{/if}
		</div>
	</header>

	<main>
		{#if step === 1}
			<section class="panel center">
				<h1>Private payments with trust</h1>
				<p class="lede">
					Register a name, send and receive ETH. Every transfer provably goes between
					registered identities — but which identities stay hidden.
				</p>
				<Onboarding />
				{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
			</section>
		{:else if step === 2}
			<section class="panel"><WalletWindow /></section>
		{:else}
			<section class="panel">
				<!-- No Actions tab for a view key: there are no actions it can take, and a tab
				     leading only to refusals is worse than its absence. History is the whole
				     point of one, so it is shown directly rather than behind a lone tab. -->
				{#if viewing}
					<div class="viewbar">
						<span class="vtag">View only</span>
						<span class="vname">{alias?.name ? `${alias.name}.hls` : 'Alias'}</span>
					</div>
					<HistoryView />
				{:else}
					<div class="tabs" role="tablist">
						<button role="tab" aria-selected={tab === 'actions'} class:active={tab === 'actions'}
							onclick={() => (tab = 'actions')}>Actions</button>
						<button role="tab" aria-selected={tab === 'history'} class:active={tab === 'history'}
							onclick={() => (tab = 'history')}>History</button>
					</div>
					{#if tab === 'actions'}
						<TransactWindow />
					{:else}
						<HistoryView />
					{/if}
				{/if}
			</section>
		{/if}

		<!-- Overlay, not replacement. Clicking the backdrop or pressing Escape returns you to
		     exactly what you left, which a replaced screen could not promise. -->
		{#if panel !== 'none'}
			<div
				class="scrim"
				role="button"
				tabindex="-1"
				aria-label="Close"
				onclick={() => (panel = 'none')}
				onkeydown={(e) => e.key === 'Escape' && (panel = 'none')}
			></div>
			<div class="sheet" role="dialog" aria-modal="true" aria-label={PANEL_LABEL[panel]}>
				<header class="sheetBar">
					<span class="sheetTitle">{PANEL_LABEL[panel]}</span>
					<button class="link" onclick={() => (panel = 'none')}>Close</button>
				</header>
				<div class="sheetBody">
					{#if panel === 'about'}
						<InfoWindow />
					{:else if panel === 'deposit'}
						<DepositWindow />
					{:else if panel === 'redeem'}
						<ClaimWindow />
					{:else}
						<RelayWindow />
					{/if}
				</div>
			</div>
		{/if}

		{@render children()}
	</main>
</div>

<style>
	.app { min-height: 100vh; display: flex; flex-direction: column; }
	.bar { display: flex; align-items: center; gap: 1.25rem; padding: 0.7rem 1.25rem;
		border-bottom: 1px solid var(--border); font-size: 0.85rem; }
	.brand { font-family: ui-monospace, monospace; letter-spacing: 0.02em; font-weight: 600;
		color: inherit; text-decoration: none; }
	/* Breadcrumb. Levels you can return to, so the navigable ones look pressable and the
	   current one does not. */
	.crumbs { display: flex; gap: 0.5rem; align-items: center; min-width: 0; }
	.crumbs span { color: var(--text-dim); white-space: nowrap; overflow: hidden;
		text-overflow: ellipsis; }
	.crumbs .now { color: var(--text-bright); }
	/* --border is a boundary colour and vanished as text. */
	.crumbs .sep { color: var(--text-dim); opacity: 0.7; }
	.crumb { color: var(--text-dim); white-space: nowrap; padding: 0.25rem 0.5rem;
		border: 1px solid transparent; border-radius: 6px; font-size: 0.8rem;
		/* A wallet name is user-supplied and up to 40 characters; the bar has to survive one. */
		max-width: 14rem; overflow: hidden; text-overflow: ellipsis; }
	.crumb:hover:not(:disabled) { color: var(--accent); border-color: var(--border);
		background: var(--bg-window); }
	.crumb.now { color: var(--text-bright); }
	.right { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; }
	.net { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.75rem;
		color: var(--text-dim); padding: 0.3rem 0.6rem; border: 1px solid var(--border);
		border-radius: 999px; }
	.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
	/* Local is not the network anyone should mistake for the real one. */
	.dot.local { background: #ffb27a; }
	.viewbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem;
		padding-bottom: 0.6rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
	.vtag { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em;
		color: var(--bg-dark); background: var(--accent); padding: 0.15rem 0.45rem;
		border-radius: 999px; font-weight: 700; }
	.vname { font-family: ui-monospace, monospace; font-size: 0.85rem;
		overflow-wrap: anywhere; }
	/* Boxed, not bare text. These sit beside a network pill and a breadcrumb, and without a
	   boundary there was nothing to tell a reader they were controls at all. */
	.link { color: var(--text-dim); font-size: 0.8rem; padding: 0.3rem 0.7rem;
		border: 1px solid var(--border); border-radius: 6px; background: var(--bg-window);
		transition: color 0.15s, border-color 0.15s; }
	.link:hover:not(:disabled) { color: var(--text-bright); border-color: var(--accent); }
	.link.on { color: var(--bg-dark); background: var(--accent); border-color: var(--accent);
		font-weight: 700; }
	main { flex: 1; display: flex; justify-content: center; padding: 2rem 1.25rem; }
	/* Content sits on the window mauve, not on the near-black behind it. The palette carries
	   three depths for a reason — using only the darkest left every panel floating with no
	   edge, which is most of why the wallet read as unfinished. */
	.panel { width: 100%; max-width: 34rem; background: var(--bg-window);
		border: 1px solid var(--border); border-radius: 8px; padding: 1.1rem; }
	.center { background: none; border: none; padding: 0; }
	.center { display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;
		margin-top: 3rem; }
	h1 { margin: 0; font-size: 1.6rem; line-height: 1.2; text-wrap: balance; }
	.lede { margin: 0; opacity: 0.85; max-width: 30rem; line-height: 1.5; }
	/* Look lives in app.css — this only places it. */
	.tabs { margin-bottom: 1rem; }
	.err { color: #ff8a80; font-size: 0.85rem; }

	.scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); border: none;
		padding: 0; z-index: 10; cursor: default; }
	.sheet { position: fixed; z-index: 11; top: 50%; left: 50%;
		transform: translate(-50%, -50%); width: min(36rem, calc(100vw - 2rem));
		max-height: calc(100vh - 4rem); display: flex; flex-direction: column;
		background: var(--bg-window); border: 1px solid var(--border); border-radius: 8px;
		box-shadow: 0 18px 48px var(--shadow); }
	.sheetBar { display: flex; align-items: center; justify-content: space-between;
		gap: 1rem; padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--border);
		background: var(--bg-titlebar); border-radius: 8px 8px 0 0; }
	.sheetTitle { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); font-weight: 700; }
	.sheetBody { overflow-y: auto; padding: 1rem; }
</style>
