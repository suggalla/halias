<script lang="ts">
	import { formatUnits, parseUnits, isAddress } from 'ethers';
	import { ETH_TOKEN, type TokenConfig } from '../sdk/config.js';

	// What the wallet cannot tell you.
	//
	// MetaMask sees `transact(bytes,bytes,bytes,bytes)` and a blob of calldata. It cannot say
	// whether value is entering or leaving the pool, who the recipient is, or that a transfer
	// publishes no amount at all — the whole point is that none of that is legible on chain.
	// Confirming in the wallet is therefore confirming something you have not been shown,
	// unless it is shown here first.
	//
	// It reads and does not ask. Every choice — including who broadcasts and what they are
	// paid — is made on the form, so this is a summary that can be checked in one pass and
	// confirmed. A review that still takes input is not a review: the reader has to go back up
	// and re-check what the numbers above meant after changing one below them.

	let {
		mode,
		amount,
		target,
		alias,
		from,
		canDelegate = false,
		delegate = false,
		submitter = '',
		submitterFee = '0.01',
		busy = false,
		token = ETH_TOKEN,
		onconfirm,
		oncancel
	}: {
		mode: 'deposit' | 'transfer' | 'withdraw';
		amount: string;
		target: string;
		alias: string;
		from: string;
		canDelegate?: boolean;
		delegate?: boolean;
		submitter?: string;
		submitterFee?: string;
		busy?: boolean;
		/// What `amount` and `submitterFee` are denominated in. Passed rather than read off the
		/// client, because a deposit chooses its asset on its own form — the payer may hold no
		/// alias, so there is no per-alias selection to inherit — and a review showing the wrong
		/// unit is the one thing this screen exists to prevent.
		token?: TokenConfig;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();


	// Denominated in whatever is moving, not in ETH. The fee comes out of the same note, so
	// a withdrawal of a token pays its submitter in that token — even though what the
	// submitter actually spends is ETH gas.
	const sym = $derived(token.symbol);
	const fmt = (v: bigint) => formatUnits(v, token.decimals);

	const feeWei = $derived.by(() => {
		try {
			return parseUnits(submitterFee.trim() || '0', token.decimals);
		} catch {
			return 0n;
		}
	});
	const relayed = $derived(canDelegate && delegate && feeWei > 0n && isAddress(submitter.trim()));
	// Only a withdrawal splits the total between recipient and submitter; a transfer pays the
	// fee on top, out of the same note.
	const netToRecipient = $derived(
		relayed && mode === 'withdraw'
			? fmt(parseUnits(amount || '0', token.decimals) - feeWei)
			: amount
	);

	// The fee is committed inside the proof, so it has to be picked before the proof exists —
	// which looks circular. It is not: gas for `transact` is fixed work (one Groth16 verify,
	// two Merkle proofs) and does not depend on the fee, so the cost of inclusion is knowable
	// now and only the margin is a judgement call.

	const VERB = { deposit: 'Deposit', transfer: 'Transfer', withdraw: 'Withdraw' } as const;
</script>

<div class="review">
	<h3>Confirm {VERB[mode].toLowerCase()}</h3>

	<dl>
		<!-- A deposit runs the other way round: the wallet is the sender and the alias is the
		     destination, so leading with "From <alias>" would name the recipient as the payer. -->
		{#if mode === 'deposit'}
			<dt>From</dt>
			<dd class="mono">{from}</dd>
			<dt>To</dt>
			<dd class="mono">{target}</dd>
			<dt>Amount</dt>
			<dd>{amount} {sym}</dd>
			<dt>Visibility</dt>
			<dd class="warn">
				That address and this amount are public. Who can spend it is not — only
				{target} can.
			</dd>
		{:else if mode === 'transfer'}
			<dt>From</dt>
			<dd class="mono">{alias}</dd>
			<dt>To</dt>
			<dd class="mono">{target}</dd>
			<dt>Amount</dt>
			<dd>{amount} {sym}</dd>
			{#if relayed}
				<dt>Fee</dt>
				<dd>{fmt(feeWei)} {sym} to <span class="mono">{submitter}</span></dd>
				<dt>Visibility</dt>
				<dd class="warn">
					The amount and both aliases stay hidden, but the fee leaving the pool is public —
					an unrelayed transfer publishes nothing at all
				</dd>
			{:else}
				<dt>Visibility</dt>
				<dd class="good">Nothing published — no amount, no sender, no recipient</dd>
			{/if}
		{:else}
			<dt>From</dt>
			<dd class="mono">{alias}</dd>
			<dt>To</dt>
			<dd class="mono">{target}</dd>
			<dt>Leaving the pool</dt>
			<dd>{amount} {sym}</dd>
			{#if relayed}
				<dt>Fee</dt>
				<dd>{fmt(feeWei)} {sym} to <span class="mono">{submitter}</span></dd>
				<dt>Recipient receives</dt>
				<dd>{netToRecipient} {sym}</dd>
			{/if}
			<dt>Visibility</dt>
			<dd class="warn">Amount, destination and timing are public</dd>
		{/if}
	</dl>

	<div class="actions">
		<button class="ghost" disabled={busy} onclick={oncancel}>Back</button>
		<button class="primary" disabled={busy} onclick={onconfirm}>
			{busy
				? 'Proving…'
				: relayed
					? 'Prepare for submission'
					: mode === 'deposit'
						? `Deposit ${amount} ${sym} to ${target}`
						: `${VERB[mode]} ${amount} ${sym}`}
		</button>
	</div>

	{#if busy}
		<p class="note">Generating a zero-knowledge proof in your browser. A few seconds.</p>
	{/if}
</div>

<style>
	.review { display: flex; flex-direction: column; gap: 0.9rem; }
	h3 { margin: 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); font-weight: 600; }
	dl { margin: 0; display: grid; grid-template-columns: 9rem 1fr; gap: 0.4rem 1rem;
		font-size: 0.85rem; padding: 0.8rem; border: 1px solid var(--border);
		border-radius: 6px; }
	dt { color: var(--text-dim); }
	dd { margin: 0; overflow-wrap: anywhere; }
	.mono { font-family: var(--font-mono); font-size: 0.8rem; }
	.good { color: var(--accent); }
	.warn { color: var(--caution); }
	.note { margin: 0; font-size: 0.78rem; color: var(--text-dim); line-height: 1.5; }
	.actions { display: flex; gap: 0.5rem; }
	.actions .primary { flex: 1; }
	.ghost:hover:not(:disabled) { border-color: var(--accent); }
	@media (max-width: 30rem) {
		dl { grid-template-columns: 1fr; gap: 0.1rem; }
		dt { margin-top: 0.45rem; }
	}
</style>
