<script lang="ts">
	import { formatEther, parseEther, isAddress } from 'ethers';
	import { wallet } from '../sdk/client.js';

	// What the wallet cannot tell you.
	//
	// MetaMask sees `transact(bytes,bytes,bytes,bytes)` and a blob of calldata. It cannot say
	// whether value is entering or leaving the pool, who the recipient is, or that a transfer
	// publishes no amount at all — the whole point is that none of that is legible on chain.
	// Confirming in the wallet is therefore confirming something you have not been shown,
	// unless it is shown here first.
	//
	// Who broadcasts it is decided here too, rather than on the form. The form is what you are
	// doing; this is how it gets there — and it has to be settled before Confirm either way,
	// because the submitter and the fee are committed inside the proof.

	let {
		mode,
		amount,
		target,
		alias,
		from,
		canDelegate = false,
		delegate = $bindable(false),
		submitter = $bindable(''),
		submitterFee = $bindable('0.01'),
		busy = false,
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
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();

	let quote = $state<{ gasCost: bigint; gasPrice: bigint; suggested: bigint } | null>(null);
	let estimating = $state(false);
	let estimateError = $state<string | null>(null);

	const feeWei = $derived.by(() => {
		try {
			return parseEther(submitterFee.trim() || '0');
		} catch {
			return 0n;
		}
	});
	const relayed = $derived(canDelegate && delegate && feeWei > 0n && isAddress(submitter.trim()));
	// Only a withdrawal splits the total between recipient and submitter; a transfer pays the
	// fee on top, out of the same note.
	const netToRecipient = $derived(
		relayed && mode === 'withdraw' ? formatEther(parseEther(amount || '0') - feeWei) : amount
	);

	// The fee is committed inside the proof, so it has to be picked before the proof exists —
	// which looks circular. It is not: gas for `transact` is fixed work (one Groth16 verify,
	// two Merkle proofs) and does not depend on the fee, so the cost of inclusion is knowable
	// now and only the margin is a judgement call.
	async function estimate() {
		estimateError = null;
		estimating = true;
		try {
			const { suggestRelayFee } = await import('halias-sdk');
			const { provider } = wallet();
			const q = await suggestRelayFee(provider, { marginPct: 20 });
			quote = q;
			submitterFee = formatEther(q.suggested);
		} catch (e: any) {
			estimateError = e?.shortMessage ?? e?.message ?? String(e);
		} finally {
			estimating = false;
		}
	}

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
			<dd>{amount} ETH</dd>
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
			<dd>{amount} ETH</dd>
			{#if relayed}
				<dt>Fee</dt>
				<dd>{formatEther(feeWei)} ETH to <span class="mono">{submitter}</span></dd>
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
			<dd>{amount} ETH</dd>
			{#if relayed}
				<dt>Fee</dt>
				<dd>{formatEther(feeWei)} ETH to <span class="mono">{submitter}</span></dd>
				<dt>Recipient receives</dt>
				<dd>{netToRecipient} ETH</dd>
			{/if}
			<dt>Visibility</dt>
			<dd class="warn">Amount, destination and timing are public</dd>
		{/if}
	</dl>

	{#if canDelegate}
		<section class="delivery">
			<label class="check">
				<input type="checkbox" bind:checked={delegate} disabled={busy} />
				<span>
					Submit with another account
					<em>
						A relayer, or another wallet of your own. Whoever sends it pays the gas and
						collects the fee, so this one needs no ETH — and only their address appears
						on chain.
					</em>
				</span>
			</label>

			{#if delegate}
				<div class="sub">
					<label>
						<span>Submitting address</span>
						<input bind:value={submitter} placeholder="0x…" disabled={busy} />
					</label>
					<label>
						<span>Their fee (ETH)</span>
						<input bind:value={submitterFee} inputmode="decimal" disabled={busy} />
					</label>

					<div class="est">
						<button class="ghost sm" disabled={busy || estimating} onclick={estimate}>
							{estimating ? 'Estimating…' : 'Estimate'}
						</button>
						{#if quote}
							<span class="hint">
								≈{Number(formatEther(quote.gasCost)).toFixed(5)} ETH of gas at
								{Number(formatEther(quote.gasPrice * 1_000_000_000n)).toFixed(2)} gwei,
								plus 20% for whoever submits.
								{#if feeWei > 0n && feeWei < quote.gasCost}
									<strong class="warnText">
										This fee is below cost — a stranger would lose money and refuse.
									</strong>
								{/if}
							</span>
						{:else}
							<span class="hint">
								Gas for this call is a fixed ~2.56M regardless of the amount, so it can be
								priced before the proof exists.
							</span>
						{/if}
					</div>
					{#if estimateError}<p class="err">{estimateError}</p>{/if}
				</div>
			{/if}
		</section>
	{/if}

	{#if relayed}
		<p class="note">
			Nothing is broadcast. This produces a transaction for that address to submit — it is
			worthless to anyone else, because the fee is payable only to them.
		</p>
	{:else}
		<p class="note">
			Your wallet will show a contract call it cannot interpret. The summary above is what
			it actually does.
		</p>
	{/if}

	<div class="actions">
		<button class="ghost" disabled={busy} onclick={oncancel}>Back</button>
		<button class="primary" disabled={busy} onclick={onconfirm}>
			{busy
				? 'Proving…'
				: relayed
					? 'Prepare for submission'
					: mode === 'deposit'
						? `Deposit ${amount} ETH to ${target}`
						: `${VERB[mode]} ${amount} ETH`}
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
	.mono { font-family: ui-monospace, monospace; font-size: 0.8rem; }
	.good { color: var(--accent); }
	.warn { color: #ffb27a; }
	.warnText { color: #ffb27a; display: block; margin-top: 0.3rem; }
	.note { margin: 0; font-size: 0.78rem; color: var(--text-dim); line-height: 1.5; }
	.delivery { display: flex; flex-direction: column; gap: 0.6rem; }
	.check { display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem;
		cursor: pointer; }
	.check input { margin-top: 0.15rem; }
	.check span { font-size: 0.85rem; opacity: 0.9; }
	.check em { display: block; font-style: normal; font-size: 0.78rem; color: var(--text-dim);
		line-height: 1.5; margin-top: 0.15rem; }
	.sub { display: flex; flex-direction: column; gap: 0.6rem; padding-left: 0.8rem;
		border-left: 2px solid var(--border); }
	.sub label { display: flex; flex-direction: column; gap: 0.25rem; }
	.sub label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.est { display: flex; gap: 0.6rem; align-items: flex-start; flex-wrap: wrap; }
	.hint { font-size: 0.78rem; color: var(--text-dim); line-height: 1.5; flex: 1; min-width: 12rem; }
	.actions { display: flex; gap: 0.5rem; }
	.actions .primary { flex: 1; }
	.ghost { padding: 0.55rem 1rem; background: none; color: inherit;
		border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
		font: inherit; }
	.ghost.sm { padding: 0.35rem 0.8rem; font-size: 0.8rem; }
	.ghost:hover:not(:disabled) { border-color: var(--accent); }
	.err { color: #ff8a80; font-size: 0.8rem; margin: 0; }
	@media (max-width: 30rem) {
		dl { grid-template-columns: 1fr; gap: 0.1rem; }
		dt { margin-top: 0.45rem; }
	}
</style>
