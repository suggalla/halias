<script lang="ts">
	import { formatEther, parseEther, isAddress } from 'ethers';
	import { clientState, getClient, run, deselectAlias } from '../sdk/client.js';
	import PrivacyNote from './PrivacyNote.svelte';
	import InviteWindow from './InviteWindow.svelte';
	import ReviewStep from './ReviewStep.svelte';
	import OwnershipView from './OwnershipView.svelte';

	// Everything here acts as one alias.
	//
	// That is the reason this screen sits below the wallet rather than beside it: a send
	// spends notes belonging to a specific alias, using keys only that alias has. With
	// several registered there is no "current" balance to act on until one is chosen, and
	// guessing would spend from the wrong identity.
	//
	// Every action passes through a review before the wallet opens. The wallet shows
	// `transact(bytes,bytes,bytes,bytes)` and calldata — it cannot say which direction the
	// value moves or who receives it, because on chain that is precisely what is hidden.
	// Signing without a summary means confirming something nobody has shown you.

	type Mode = 'transfer' | 'withdraw' | 'invite' | 'ownership';
	type Phase = 'form' | 'review' | 'handoff';

	let mode = $state<Mode>('transfer');
	let phase = $state<Phase>('form');
	let amount = $state('');
	let target = $state('');
	let msg = $state<string | null>(null);
	let formError = $state<string | null>(null);

	// Who broadcasts lives on the review step, not here. The form is what you are doing; the
	// review is how it gets there. Both are bound through to ReviewStep, which owns the
	// controls but not the state — this component still has to read them to build the call.
	let delegate = $state(false);
	let submitter = $state('');
	let submitterFee = $state('0.01');
	let blob = $state<string | null>(null);
	let copied = $state<'blob' | 'link' | null>(null);

	const alias = $derived($clientState.selected);
	const busy = $derived($clientState.status === 'syncing');
	const ready = $derived($clientState.status === 'ready' && alias !== null);
	const relaying = $derived(delegate && submitterFee.trim() !== '' && submitter.trim() !== '');
	// Inviting has no review step and no privacy note of its own, so the two components that
	// take a mode only ever see the two that move value out of this alias.
	const txMode = $derived<'transfer' | 'withdraw'>(mode === 'withdraw' ? 'withdraw' : 'transfer');

	// Full hash when unnamed — a truncated one cannot be checked against anything.
	const label = $derived(alias ? (alias.name ? `${alias.name}.hls` : alias.aliasHash) : '');

	const targetLabel = $derived(
		mode === 'transfer' ? 'Recipient alias' : mode === 'withdraw' ? 'Destination address' : ''
	);
	const targetPlaceholder = $derived(mode === 'transfer' ? 'bob.hls' : '0x…');

	function reset() {
		phase = 'form';
		amount = '';
		target = '';
		blob = null;
		copied = null;
	}

	function setMode(m: Mode) {
		mode = m;
		phase = 'form';
		msg = null;
		formError = null;
		blob = null;
	}

	// Catch what is checkable here rather than after a proof has been generated — the proof
	// costs seconds, and a mistyped address is knowable now.
	function toReview() {
		formError = null;
		const amt = amount.trim();
		if (!amt || !(Number(amt) > 0)) return (formError = 'Enter an amount greater than zero');
		if (!target.trim())
			return (formError = `Enter a ${mode === 'transfer' ? 'recipient alias' : 'destination address'}`);
		if (mode === 'withdraw' && !isAddress(target.trim()))
			return (formError = 'That is not a valid address');
		phase = 'review';
	}

	// Checked here rather than on the way in, because the delegation choice is made on the
	// review step itself. Still before the proof, which is the part worth not wasting.
	function delegationError(amt: string): string | null {
		if (!delegate) return null;
		if (!isAddress(submitter.trim())) return 'Enter the address that will submit this';
		let fee: bigint;
		try {
			fee = parseEther(submitterFee.trim() || '0');
		} catch {
			return 'That fee is not a valid amount';
		}
		if (fee <= 0n) return 'Whoever submits needs a fee to cover gas';
		// A withdrawal splits its total between recipient and submitter; a transfer pays the
		// fee on top, so what it has to fit inside is the note, not the amount.
		if (mode === 'withdraw' && fee >= parseEther(amt))
			return 'The fee is the whole withdrawal — nothing would reach the recipient';
		if (mode === 'transfer' && alias && parseEther(amt) + fee > alias.balance)
			return 'The amount plus the fee is more than this alias holds';
		return null;
	}

	async function confirm() {
		msg = null;
		const c = getClient();
		const amt = amount.trim();
		const to = target.trim();

		formError = delegationError(amt);
		if (formError) return;

		const relayOpts = delegate
			? { relayerFee: parseEther(submitterFee.trim()), relayer: submitter.trim(), prepare: true }
			: {};
		const r = await run(() =>
			mode === 'transfer'
				? c.send(to, amt, undefined, relayOpts)
				: c.withdraw(to, amt, undefined, undefined, relayOpts)
		);
		if (!r) return (phase = 'form'); // the error is already on clientState

		if (delegate) {
			blob = (r as any).relayBlob;
			phase = 'handoff';
			return;
		}
		msg =
			mode === 'transfer'
				? `Transferred ${amt} ETH to ${to}`
				: `Withdrew ${amt} ETH to ${to}`;
		reset();
	}

	// A link rather than a wall of base64. The blob rides in the fragment, which browsers
	// never send to a server — so pasting this into a chat reveals it to that chat and to
	// nobody else, and no host of ours could log it even if one existed. It is safe to send
	// in the open regardless: the fee is payable only to the named submitter, so the link is
	// worthless to anyone who intercepts it.
	const relayLink = $derived(
		blob && typeof location !== 'undefined'
			? `${location.origin}${location.pathname}#relay=${encodeURIComponent(blob)}`
			: ''
	);

	async function copy(text: string, which: 'blob' | 'link') {
		await navigator.clipboard.writeText(text);
		copied = which;
		setTimeout(() => (copied = null), 2000);
	}
</script>

<div class="transact">
	{#if !alias}
		<p class="empty">Choose an alias in the wallet to transfer or withdraw.</p>
	{:else}
		<header>
			<button class="back" onclick={deselectAlias}>← Wallet</button>
			<div class="who">
				<span class="nm">{label}</span>
				<span class="bal" title="Shielded balance of this alias">
					{formatEther(alias.balance)} ETH shielded
				</span>
			</div>
		</header>

		{#if phase === 'form'}
			<!-- What this alias can do. Inviting spends a note exactly as transfer and withdraw
			     do, which is why it belongs here rather than in a global panel — redeeming, which
			     needs no alias at all, stays in the top bar. Ownership moves the name rather than
			     any value, and sits here because only this alias's owner can offer it. -->
			<div class="tabs" role="tablist">
				{#each ['transfer', 'withdraw', 'invite', 'ownership'] as const as m}
					<button role="tab" aria-selected={mode === m} class:active={mode === m}
						onclick={() => setMode(m)}>{m}</button>
				{/each}
			</div>

			{#if mode === 'invite'}
				<InviteWindow />
			{:else if mode === 'ownership'}
				<OwnershipView />
			{:else}
			<div class="form">
				<label>
					<span>{targetLabel}</span>
					<input bind:value={target} placeholder={targetPlaceholder} disabled={busy} />
				</label>
				<label>
					<span>Amount (ETH)</span>
					<input bind:value={amount} placeholder="0.1" inputmode="decimal" disabled={busy} />
				</label>

				<!-- The choice can be made here, but only as a choice. Address and fee live on the
				     review step, where the estimate and the resulting numbers are in view. -->
				<label class="check">
					<input type="checkbox" bind:checked={delegate} disabled={busy} />
					<span>
						Submit with another account
						<em>Set the address and fee on the next step.</em>
					</span>
				</label>

				<button class="primary" disabled={busy || !ready} onclick={toReview}>Review</button>

				<p class="hint">
					To add funds, use <strong>Deposit</strong> in the top bar — anyone can pay an
					alias, so it is not tied to the one you are acting as.
				</p>

				<PrivacyNote mode={txMode} />
			</div>
				{/if}
		{:else if phase === 'review'}
			<ReviewStep
				mode={txMode}
				amount={amount.trim()}
				target={target.trim()}
				alias={label}
				from={$clientState.address ?? ''}
				canDelegate
				bind:delegate
				bind:submitter
				bind:submitterFee
				{busy}
				onconfirm={confirm}
				oncancel={() => (phase = 'form')}
			/>
		{:else}
			<div class="handoff">
				<h3>Ready to submit</h3>
				<p class="hint">
					Nothing has been broadcast and your notes are not yet spent. Hand this to
					<span class="mono">{submitter}</span> — from another browser, another wallet, or a
					relayer. They open <strong>Relay</strong>, paste it, simulate, and submit. It stays
					valid until the notes behind it are spent some other way.
				</p>
				<label class="linkRow">
					<span>Link</span>
					<input readonly value={relayLink} onfocus={(e) => e.currentTarget.select()} />
				</label>
				<p class="hint">
					Opening it lands them on the Relay screen with this already loaded. The transaction
					travels in the part of the URL browsers never send to a server.
				</p>

				<details>
					<summary>Or copy the raw transaction</summary>
					<textarea readonly rows="6" value={blob}></textarea>
				</details>

				<div class="actions">
					<button class="ghost" onclick={reset}>Done</button>
					<button class="ghost" onclick={() => copy(blob!, 'blob')}>
						{copied === 'blob' ? 'Copied' : 'Copy text'}
					</button>
					<button class="primary" onclick={() => copy(relayLink, 'link')}>
						{copied === 'link' ? 'Copied' : 'Copy link'}
					</button>
				</div>
			</div>
		{/if}

		{#if formError}<p class="err">{formError}</p>{/if}
		{#if msg}<p class="ok">{msg}</p>{/if}
		{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
	{/if}
</div>

<style>
	.transact { display: flex; flex-direction: column; gap: 1rem; padding: 0.5rem; }
	header { display: flex; align-items: flex-start; gap: 0.75rem; flex-wrap: wrap;
		border-bottom: 1px solid var(--border); padding-bottom: 0.6rem; }
	.back { background: none; border: none; color: inherit; opacity: 0.85; cursor: pointer;
		font: inherit; padding: 0; }
	.back:hover { opacity: 1; }
	.who { margin-left: auto; display: flex; gap: 0.75rem; align-items: baseline;
		flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
	.nm { font-family: ui-monospace, monospace; overflow-wrap: anywhere; font-size: 0.8rem; }
	.bal { font-variant-numeric: tabular-nums; opacity: 0.9; }
	.form { display: flex; flex-direction: column; gap: 0.6rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.handoff { display: flex; flex-direction: column; gap: 0.7rem; }
	.handoff h3 { margin: 0; font-size: 0.75rem; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-dim); font-weight: 600; }
	textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.72rem;
		resize: vertical; background: var(--bg-input); color: inherit;
		border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem;
		word-break: break-all; }
	.actions { display: flex; gap: 0.5rem; }
	.actions .primary { flex: 1; }
	.primary { padding: 0.55rem; }
	.hint, .empty { font-size: 0.8rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.mono { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
	.check { display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem;
		cursor: pointer; }
	.check input { margin-top: 0.15rem; }
	.check span { text-transform: none; letter-spacing: 0; font-size: 0.85rem; opacity: 0.9; }
	.check em { display: block; font-style: normal; font-size: 0.78rem; color: var(--text-dim); }
	.linkRow input { width: 100%; font-family: ui-monospace, monospace; font-size: 0.72rem;
		background: var(--bg-input); color: inherit;
		border: 1px solid var(--border); border-radius: 6px; padding: 0.55rem; }
	details { font-size: 0.8rem; opacity: 0.88; }
	summary { cursor: pointer; opacity: 0.85; }
	details textarea { margin-top: 0.5rem; }
	.ok { color: var(--accent); font-size: 0.85rem; margin: 0; }
	.err { color: #ff8a80; font-size: 0.85rem; margin: 0; }
</style>
