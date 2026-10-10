<script lang="ts">
	import { formatEther, formatUnits } from 'ethers';
	import { ETH_TOKEN, findToken } from '../sdk/config.js';
	import { clientState, wallet } from '../sdk/client.js';
	import type { RelayQuote, RelayPayload } from 'halias-sdk/relay';

	// The relayer's side: simulate before committing gas.
	//
	// A prepared transaction can be dead on arrival — its notes already spent, its root aged
	// out, its chain wrong. Submitting blind means paying gas to discover that. So nothing is
	// submittable here until it has been simulated against the live chain, and the quote is
	// re-taken immediately before sending, because the fee is fixed inside the proof while
	// gas is not: a spike between deciding and submitting is what turns a profitable relay
	// into a loss.

	let raw = $state('');
	let fromLink = $state(false);
	let quote = $state<RelayQuote | null>(null);

	// What the fee is actually denominated in. A relayer is paid out of the note, so the fee is
	// in whatever that note holds — while the gas it spends is always ETH. Labelling both "ETH"
	// is right only for an ETH fee and silently wrong for any other, which is the failure this
	// screen is least able to notice: the numbers still look like money.
	const feeToken = $derived(
		quote ? findToken($clientState.chainId ?? 0, quote.tokenAddress) : ETH_TOKEN
	);
	const feeSym = $derived(feeToken.symbol);
	const fmtFee = (v: bigint) => formatUnits(v, feeToken.decimals);
	// Null when the two sides are different assets. Nothing here can bridge them.
	const comparable = $derived(quote?.profit ?? null);
	let payload = $state<RelayPayload | null>(null);
	let checking = $state(false);
	let sending = $state(false);
	let error = $state<string | null>(null);
	let sent = $state<string | null>(null);

	const connected = $derived($clientState.address !== null);

	// Arriving by link. The transaction rides in the fragment, which never reaches a server,
	// so the first thing that touches it is this page. Simulating straight away is the whole
	// point of the link: the useful question — would this succeed, and what does it pay — is
	// answered before they have to do anything.
	$effect(() => {
		if (raw || !$clientState.address || typeof location === 'undefined') return;
		const m = location.hash.match(/[#&]relay=([^&]+)/);
		if (!m) return;
		raw = decodeURIComponent(m[1]);
		fromLink = true;
		// Clear it: a reload should not silently re-arm a transaction that may already be
		// spent, and the address bar is not where a pending payment should live.
		history.replaceState(null, '', location.pathname + location.search);
		check();
	});
	// Bound in the proof. If it is not us, the fee is not ours to earn.
	const forUs = $derived(
		quote !== null &&
			$clientState.address !== null &&
			quote.relayer.toLowerCase() === $clientState.address.toLowerCase()
	);

	async function check() {
		error = null;
		quote = null;
		sent = null;
		if (!raw.trim()) return;
		checking = true;
		try {
			const { decodeRelayBlob, quoteRelay } = await import('halias-sdk');
			const { provider, signer, chainId } = wallet();
			const p = decodeRelayBlob(raw.trim());
			if (p.chainId !== chainId)
				throw new Error(
					`This was prepared for chain ${p.chainId}, and you are on ${chainId}. It cannot be submitted here.`
				);
			payload = p;
			quote = await quoteRelay(provider, p, await signer.getAddress());
		} catch (e: any) {
			error = e?.shortMessage ?? e?.message ?? String(e);
		} finally {
			checking = false;
		}
	}

	async function submit() {
		if (!payload) return;
		error = null;
		sending = true;
		try {
			const { submitRelay } = await import('halias-sdk');
			const { signer } = wallet();
			// Zero, not the quoted profit: gas moves between blocks and a hard floor at
			// break-even is the honest bar. Refusing a relay that got 5% less profitable
			// would be theatre.
			const { txHash } = await submitRelay(signer, payload, { minProfit: 0n });
			sent = txHash;
			quote = null;
			payload = null;
			raw = '';
		} catch (e: any) {
			error = e?.shortMessage ?? e?.message ?? String(e);
		} finally {
			sending = false;
		}
	}
</script>

<div class="relay">
	<header>
		<h2>Submit for someone else</h2>
		<p class="lede">
			Paste a prepared transaction. You pay the gas and collect the fee; the sender stays
			off the chain entirely. You learn nothing about them beyond what the withdrawal
			already publishes.
		</p>
	</header>

	{#if !connected}
		<p class="hint">Connect a wallet to simulate and submit.</p>
	{:else}
		{#if fromLink}
			<p class="hint">Loaded from a link. Simulated against the chain below.</p>
		{/if}
		<label>
			<span>Prepared transaction</span>
			<textarea class="mono" bind:value={raw} rows="5" placeholder="Paste here…" disabled={sending}></textarea>
		</label>
		<button class="primary" disabled={checking || sending || !raw.trim()} onclick={check}>
			{checking ? 'Simulating…' : 'Simulate'}
		</button>

		{#if quote}
			<dl class:bad={!quote.valid || !forUs}>
				<dt>Type</dt>
				{#if quote.kind === 'claim'}
					<dd>
						Invite claim
						<em>Registers an alias and funds it from the invite it spends.</em>
					</dd>
					<dt>Registers</dt>
					<dd class="mono">{payload?.claim?.name}</dd>
					<dt>Owner</dt>
					<dd class="mono">{payload?.claim?.registration.owner}</dd>
				{:else if quote.kind === 'transfer'}
					<dd>
						Private transfer
						<em>Between two aliases. Neither the amount nor the parties are visible to you.</em>
					</dd>
				{:else}
					<dd>Withdrawal</dd>
					<dt>Leaving the pool</dt>
					<dd>{fmtFee(quote.withdrawing)} {feeSym}</dd>
					<dt>Recipient</dt>
					<dd class="mono">{quote.recipient}</dd>
				{/if}
				<dt>Fee to</dt>
				<dd class="mono">{quote.relayer}</dd>
				<dt>You earn</dt>
				<dd>{fmtFee(quote.fee)} {feeSym}</dd>
				<dt>Gas</dt>
				<dd>
					{quote.gasEstimate.toLocaleString()} @ {formatUnits(quote.gasPrice, 'gwei')} gwei
					· {formatEther(quote.gasCost)} ETH
				</dd>
				<dt>Net</dt>
				{#if comparable === null}
					<!-- Stated rather than computed. Subtracting a gas cost in wei from a fee in a
					     token's base units produces a number, and showing it as money would be a
					     lie with two decimal places. -->
					<dd class="warn">
						Not comparable — the fee is in {feeSym} and the gas is in ETH.
						Price it yourself before submitting.
					</dd>
				{:else}
					<dd class:good={comparable > 0n} class:warn={comparable <= 0n}>
						{comparable > 0n ? '+' : ''}{formatEther(comparable)} ETH
					</dd>
				{/if}
			</dl>

			{#if quote.kind === 'claim'}
				<p class="hint">
					The owner above is fixed inside the proof — submitting this cannot mint the alias
					to you, only earn the fee.
				</p>
			{/if}

			{#if !quote.valid}
				<p class="err">
					This would fail: {quote.reason}. The notes behind it were most likely already
					spent. Nothing to submit — and nothing spent finding out.
				</p>
			{:else if !forUs}
				<p class="err">
					The fee is payable to {quote.relayer}, not to you. The proof fixes that address,
					so submitting this would cost you gas and pay you nothing.
				</p>
			{:else if comparable !== null && comparable <= 0n}
				<p class="warn">
					Gas currently costs more than the fee. Submitting would lose you
					{formatEther(-comparable)} ETH — worth waiting for gas to fall, or asking for more.
				</p>
			{/if}

			<button
				class="primary"
				disabled={sending || !quote.valid || !forUs}
				onclick={submit}
			>
				{sending
					? 'Submitting…'
					: comparable === null
						? `Submit and earn ${fmtFee(quote.fee)} ${feeSym}`
						: comparable > 0n
							? `Submit and earn ${fmtFee(quote.fee)} ${feeSym}`
							: 'Submit at a loss'}
			</button>
		{/if}

		{#if sent}
			<p class="ok">Submitted. <span class="mono">{sent}</span></p>
		{/if}
		{#if error}<p class="err">{error}</p>{/if}
	{/if}
</div>

<style>
	.relay { display: flex; flex-direction: column; gap: 0.9rem; padding: 0.5rem; }
	header { display: flex; flex-direction: column; gap: 0.4rem; }
	h2 { margin: 0; font-size: 1rem; }
	.lede { margin: 0; font-size: 0.85rem; opacity: 0.85; line-height: 1.55; max-width: 34rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	textarea { width: 100%; font-family: var(--font-mono); font-size: 0.72rem;
		resize: vertical; background: var(--bg-input); color: inherit;
		border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem;
		word-break: break-all; }
	dl { margin: 0; display: grid; grid-template-columns: 8rem 1fr; gap: 0.4rem 1rem;
		font-size: 0.85rem; padding: 0.8rem; border: 1px solid var(--border);
		border-left-width: 3px; border-left-color: var(--accent); border-radius: 6px; }
	dl.bad { border-left-color: var(--bad); }
	dt { color: var(--text-dim); }
	dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
	.mono { font-family: var(--font-mono); font-size: 0.78rem; }
	dd em { display: block; font-style: normal; font-size: 0.75rem; color: var(--text-dim);
		margin-top: 0.15rem; }
	.good { color: var(--accent); }
	.warn { color: var(--caution); }
	.primary { padding: 0.55rem; }
	.hint { font-size: 0.8rem; color: var(--text-dim); margin: 0; }
	.ok { color: var(--good); font-size: 0.85rem; margin: 0; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; line-height: 1.5; }
	p.warn { font-size: 0.85rem; margin: 0; line-height: 1.5; }
	@media (max-width: 30rem) {
		dl { grid-template-columns: 1fr; gap: 0.1rem; }
		dt { margin-top: 0.45rem; }
	}
</style>
