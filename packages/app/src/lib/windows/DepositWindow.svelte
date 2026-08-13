<script lang="ts">
	import { formatEther, parseEther } from 'ethers';
	import { clientState, clientFor, run, refreshWalletBalance, rememberName } from '../sdk/client.js';
	import ReviewStep from './ReviewStep.svelte';

	// Paying an alias is not an alias-owner's action.
	//
	// It used to sit inside the per-alias screen, which implied you could only fund something
	// you own. The circuit never said that: an output needs a registry membership proof, but
	// never one belonging to the sender. So anyone can pay any registered name — no alias, no
	// notes, no prior involvement — and this screen sits outside the wallet → alias → act
	// progression to match.

	// Embedded under an alias, this arrives pointed at that alias; opened from the top bar it
	// starts blank, because the payer may hold no alias at all.
	let { initialTarget = '', embedded = false }: { initialTarget?: string; embedded?: boolean } =
		$props();

	// Seeded once, deliberately: this is a form field, and the component remounts when the
	// action is reopened, so tracking the prop afterwards would overwrite what was typed.
	// svelte-ignore state_referenced_locally
	let target = $state(initialTarget);
	let amount = $state('');
	let phase = $state<'form' | 'review' | 'done'>('form');
	let sent = $state<{ amount: string; target: string; txHash: string } | null>(null);
	let formError = $state<string | null>(null);

	const busy = $derived($clientState.status === 'syncing');
	const mine = $derived($clientState.aliases ?? []);
	// Paying your own alias from the wallet that owns it is the linkable case, and worth
	// pointing out at the moment it is about to happen rather than in a help page.
	const payingSelf = $derived(
		mine.some((a) => a.name && `${a.name}.hls` === target.trim().toLowerCase())
	);

	function toReview() {
		formError = null;
		const amt = amount.trim();
		if (!target.trim()) return (formError = 'Enter the alias to pay, like bob.hls');
		if (!amt || !(Number(amt) > 0)) return (formError = 'Enter an amount greater than zero');
		if (parseEther(amt) > $clientState.walletBalance)
			return (formError =
				`${$clientState.address} holds ${formatEther($clientState.walletBalance)} ETH — ` +
				`not enough to deposit ${amt}, before gas`);
		phase = 'review';
	}

	async function confirm() {
		const amt = amount.trim();
		const to = target.trim();
		// Index 0 derives keys without needing a registration — which is the whole point: the
		// payer may have no alias at all.
		const c = await clientFor(0);
		const r = await run(() => c.depositTo(to, amt));
		if (!r) return (phase = 'form');
		await refreshWalletBalance();
		// Stays put and reports what happened, rather than clearing back to an empty form.
		// A deposit is irreversible and the transaction hash is the only handle on it — a
		// form that resets loses it, and reads as though nothing was sent.
		sent = { amount: amt, target: to, txHash: (r as any).txHash };
		phase = 'done';
	}

	function again() {
		sent = null;
		amount = '';
		target = initialTarget;
		formError = null;
		phase = 'form';
	}
</script>

<div class="deposit">
	{#if !embedded}
		<header>
			<h2>Pay an alias</h2>
			<p class="lede">
				Move ETH from this wallet into the pool, held under any registered
				<code>.hls</code> name. You do not need an alias of your own to pay one.
			</p>
		</header>
	{/if}

	{#if $clientState.address === null}
		<p class="hint">Connect a wallet to deposit.</p>
	{:else if phase === 'form'}
		<label>
			<span>Pay which alias</span>
			<input bind:value={target} placeholder="bob.hls" disabled={busy} />
		</label>
		{#if mine.length > 0}
			<div class="chips">
				<span class="chipLabel">Yours</span>
				{#each mine.filter((a) => a.name) as a}
					<button class="chip" disabled={busy} onclick={() => (target = `${a.name}.hls`)}>
						{a.name}.hls
					</button>
				{/each}
			</div>
		{/if}

		<label>
			<span>Amount (ETH)</span>
			<input bind:value={amount} placeholder="0.1" inputmode="decimal" disabled={busy} />
		</label>

		<dl class="src">
			<dt>Paying from</dt>
			<dd class="mono">{$clientState.address}</dd>
			<dt>Available</dt>
			<dd>{formatEther($clientState.walletBalance)} ETH</dd>
		</dl>

		<!-- The advice that actually matters here, at the moment the choice is live. The
		     deposit itself is public; what you control is whether it points at you. -->
		<aside class="note" class:warn={payingSelf}>
			{#if payingSelf}
				<strong>This wallet owns that alias.</strong>
				Anyone reading the chain can see this address funding it, which ties the two together
				permanently. Paying from a wallet unconnected to the alias avoids that — and the
				recipient sees no difference.
			{:else}
				<strong>Use a wallet that is not linked to the recipient.</strong>
				The amount and this address are public; who receives it is not. So the deposit is
				only as private as the address it comes from — a fresh wallet, or an exchange
				withdrawal, reveals nothing about the alias being funded.
			{/if}
		</aside>

		<button class="primary" disabled={busy} onclick={toReview}>Review</button>
	{:else if phase === 'review'}
		<ReviewStep
			mode="deposit"
			amount={amount.trim()}
			target={target.trim()}
			alias={target.trim()}
			from={$clientState.address ?? ''}
			{busy}
			onconfirm={confirm}
			oncancel={() => (phase = 'form')}
		/>
	{:else if sent}
		<div class="done">
			<h3>Deposited</h3>
			<dl class="src">
				<dt>Amount</dt>
				<dd>{sent.amount} ETH</dd>
				<dt>To</dt>
				<dd class="mono">{sent.target}</dd>
				<dt>Transaction</dt>
				<dd class="mono">{sent.txHash}</dd>
			</dl>
			<p class="hint">
				Only {sent.target} can spend it. The amount and the paying address are public; who
				received it is not.
			</p>
			<button class="ghost" onclick={again}>Deposit again</button>
		</div>
	{/if}

	{#if formError}<p class="err">{formError}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.deposit { display: flex; flex-direction: column; gap: 0.85rem; padding: 0.5rem; }
	header { display: flex; flex-direction: column; gap: 0.4rem; }
	h2 { margin: 0; font-size: 1rem; }
	.lede { margin: 0; font-size: 0.85rem; opacity: 0.85; line-height: 1.55; max-width: 34rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.chips { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
	.chipLabel { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.chip { font-size: 0.75rem; padding: 0.2rem 0.55rem; border-radius: 999px;
		background: none; color: inherit; border: 1px solid var(--border);
		cursor: pointer; font-family: ui-monospace, monospace; }
	.chip:hover:not(:disabled) { border-color: var(--accent); }
	.src { margin: 0; display: grid; grid-template-columns: 8rem 1fr; gap: 0.35rem 1rem;
		font-size: 0.85rem; }
	dt { color: var(--text-dim); }
	dd { margin: 0; overflow-wrap: anywhere; }
	.mono { font-family: ui-monospace, monospace; font-size: 0.8rem; }
	.note { font-size: 0.78rem; line-height: 1.5; padding: 0.7rem 0.8rem;
		border: 1px solid var(--border); border-left-width: 3px;
		border-left-color: var(--accent); border-radius: 4px; opacity: 0.9; }
	.note.warn { border-left-color: var(--caution); }
	strong { font-weight: 600; }
	code { font-family: ui-monospace, monospace; }
	.primary { padding: 0.55rem; }
	.hint { font-size: 0.8rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.done { display: flex; flex-direction: column; gap: 0.7rem; }
	.done h3 { margin: 0; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.09em;
		color: var(--accent); font-weight: 600; }
	.done .ghost { align-self: flex-start; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; line-height: 1.5; }
	@media (max-width: 30rem) {
		.src { grid-template-columns: 1fr; gap: 0.1rem; }
		dt { margin-top: 0.4rem; }
	}
</style>
