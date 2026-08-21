<script lang="ts">
	import { formatEther, formatUnits, parseUnits, isAddress } from 'ethers';
	import {
		clientState, getClient, run, deselectAlias, wallet, setToken, addToken
	} from '../sdk/client.js';
	import { POOL_INPUTS } from 'halias-sdk';
	// From the alias module, not the package root — pure string handling, and the root
	// re-exports the proving stack. See the note in sdk/client.ts.
	import { fullAlias } from 'halias-sdk/alias';

	// How many merges take a wallet from `n` notes to fully sendable. Each merge spends
	// POOL_INPUTS notes and leaves one, so it removes POOL_INPUTS - 1; once the balance fits in
	// POOL_INPUTS notes there is nothing left worth merging.
	const mergesNeeded = (n: number) =>
		Math.max(0, Math.ceil((n - POOL_INPUTS) / (POOL_INPUTS - 1)));
	import PrivacyNote from './PrivacyNote.svelte';
	import InviteWindow from './InviteWindow.svelte';
	import ReviewStep from './ReviewStep.svelte';
	import { RELAY_LABEL, RELAY_HINT } from '../copy.js';
	import OwnershipView from './OwnershipView.svelte';
	import DepositWindow from './DepositWindow.svelte';
	import ViewKeyView from './ViewKeyView.svelte';

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

	type Mode = 'transfer' | 'withdraw' | 'deposit' | 'invite' | 'ownership' | 'viewkey' | 'notes';
	type Phase = 'form' | 'review' | 'handoff';

	// A list, not a tab strip. Five actions squeezed into one row lost the labels, and these
	// are not views of one thing to flick between — they are separate operations, most of them
	// irreversible. A list has room to say what each one does before it is chosen.
	//
	// null means the list itself, which is where the screen opens: landing pre-armed on
	// "transfer" put the most destructive action under the cursor by default.
	const ACTIONS: { id: Mode; label: string; blurb: string; needsOwner?: boolean }[] = [
		{ id: 'transfer',  label: 'Send',      blurb: 'Pay another alias from this one. Amounts stay hidden.' },
		{ id: 'deposit',   label: 'Add funds', blurb: 'Move funds from a wallet into this alias.' },
		{ id: 'withdraw',  label: 'Withdraw',  blurb: 'Move funds out to an ordinary address.' },
		{ id: 'notes',     label: 'Combine notes',
		  blurb: 'Merge this balance into fewer notes, so more of it can be sent at once.' },
		{ id: 'invite',    label: 'Invite',    blurb: 'Create a funded link for someone with no alias yet.' },
		{ id: 'ownership', label: 'Transfer alias ownership',
		  blurb: 'Hand this alias to a new owner, or sell it.',
		  // The only action that needs the name's owner. Spending never does — the pool checks
		  // a proof, not an NFT — so an alias held by another of your addresses still sends and
		  // receives here.
		  needsOwner: true },
		{ id: 'viewkey',   label: 'View-only key',
		  blurb: 'Let someone read this alias without being able to spend from it.' },
	];

	let mode = $state<Mode | null>(null);
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

	// The amount asked for is more than one transaction's notes can cover — held here rather than reported
	// as an error, because it is not one. The money is present and the wallet can reach it;
	// it just takes a transaction first. Null when the amount is spendable as it stands.
	let blocked = $state<bigint | null>(null);
	let merging = $state<{ step: number; of: number } | null>(null);

	// Priced before the proof exists: gas for transact is fixed regardless of the amount, so a
	// fee can be chosen up front rather than discovered afterwards.
	let quote = $state<{ gasCost: bigint; gasPrice: bigint; suggested: bigint } | null>(null);
	let estimating = $state(false);
	let estimateError = $state<string | null>(null);
	// The submitter's fee comes out of the same notes, so it is denominated in the token
	// being moved — not in ETH, even though what the submitter spends is gas.
	const feeWei = $derived.by(() => {
		try { return parseAmt(submitterFee.trim() || '0'); } catch { return 0n; }
	});

	async function estimate() {
		estimateError = null;
		estimating = true;
		try {
			const { suggestRelayFee } = await import('halias-sdk');
			const q = await suggestRelayFee(wallet().provider, { marginPct: 20 });
			quote = q;
			submitterFee = formatEther(q.suggested);
		} catch (e: any) {
			estimateError = e?.shortMessage ?? e?.message ?? String(e);
		} finally {
			estimating = false;
		}
	}

	// Adding an asset this build was never told about. The pool takes any token address, so a
	// curated list is a suggestion rather than a limit — and a token someone was paid in but
	// cannot see is money they cannot spend.
	let adding = $state(false);
	let newToken = $state('');
	let addError = $state<string | null>(null);

	async function addAsset() {
		addError = null;
		try {
			const added = await addToken(newToken.trim());
			newToken = '';
			adding = false;
			// Select it. Someone who just typed an address wants to act on that asset, and
			// leaving the selection where it was makes the new button look inert.
			await setToken(added.address);
		} catch (e: any) {
			addError = e?.shortMessage ?? e?.message ?? 'Could not read that token';
		}
	}

	// The asset everything on this screen is denominated in. A note names exactly one, so
	// there is no combined balance and no conversion — switching re-reads at the other token.
	// `dec` is the whole reason this is threaded rather than assumed: parseEther on a
	// 6-decimal token computes a million times the intended amount.
	const token = $derived($clientState.token);
	const sym = $derived(token.symbol);
	const dec = $derived(token.decimals);
	const isEth = $derived(token.address === '0x0000000000000000000000000000000000000000');
	const parseAmt = (v: string) => parseUnits(v, dec);
	const fmt = (v: bigint) => formatUnits(v, dec);

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

	// What will actually be paid, not what was typed.
	//
	// A transfer normalises before it resolves — "GG" and "gg" and "gg.hls" are one alias —
	// so a review showing the raw input asks for confirmation of a string the system will not
	// use. The suffix is the visible half; case folding is the half nobody would notice.
	//
	// Withdrawals pass straight through: the target is an address, and appending .hls to one
	// would be worse than showing it unchanged. Falls back to the raw text when it does not
	// normalise, since the form has already refused to advance in that case.
	const reviewTarget = $derived.by(() => {
		const t = target.trim();
		if (mode !== 'transfer') return t;
		try {
			return fullAlias(t);
		} catch {
			return t;
		}
	});

	function reset() {
		phase = 'form';
		amount = '';
		target = '';
		blob = null;
		copied = null;
		blocked = null;
		merging = null;
	}

	function setMode(m: Mode | null) {
		mode = m;
		phase = 'form';
		msg = null;
		formError = null;
		blob = null;
		blocked = null;
		merging = null;
		// The gas quote prices ETH. Carrying one into a form denominated in something else would
		// compare a token fee against a wei cost and call it "below cost" — cleared here because
		// switching asset means leaving the form, so this is the only way back in.
		quote = null;
		estimateError = null;
	}

	// Catch what is checkable here rather than after a proof has been generated — the proof
	// costs seconds, and a mistyped address is knowable now.
	function toReview() {
		formError = null;
		// The last failure was about the last amount. Leaving it on screen beside a corrected
		// one reads as though the correction was rejected too.
		clientState.update((s) => ({ ...s, error: null }));
		const amt = amount.trim();
		if (!amt || !(Number(amt) > 0)) return (formError = 'Enter an amount greater than zero');
		if (!target.trim())
			return (formError = `Enter a ${mode === 'transfer' ? 'recipient alias' : 'destination address'}`);
		if (mode === 'withdraw' && !isAddress(target.trim()))
			return (formError = 'That is not a valid address');

		// Stopped before the proof, and separately from the errors above, because the answer is
		// a button rather than a correction. A balance held as three or more notes cannot leave
		// in one transaction — the proof takes two note inputs — so an amount can be entirely
		// affordable and still unsendable until the notes are combined.
		const wei = parseAmt(amt);
		if (wei > $clientState.sendableNow && wei <= $clientState.balance) {
			blocked = wei;
			return;
		}
		phase = 'review';
	}

	/// Merge until the whole balance can leave in one transaction.
	///
	/// Targeted at the full balance, not at a single note. The circuit takes POOL_INPUTS inputs,
	/// so that many notes is already completely sendable — merging further costs another proof
	/// and another fee to reach a number nobody can spend any harder.
	async function combineAll() {
		const c = getClient();
		merging = { step: 0, of: 1 };
		await run(() =>
			c.consolidate(BigInt(token.address), {
				target: $clientState.balance,
				onProgress: ({ step, of }: { step: number; of: number }) =>
					(merging = { step: step + 1, of })
			})
		);
		merging = null;
	}

	/// Combine notes until the pending amount can be sent, then carry on into the review.
	///
	/// Targeted at the amount rather than merging everything: each merge is its own proof and
	/// its own gas, and the goal is this payment, not a tidy wallet.
	async function combine() {
		const target_ = blocked!;
		const c = getClient();
		merging = { step: 0, of: 1 };
		const r = await run(() =>
			c.consolidate(BigInt(token.address), {
				target: target_,
				onProgress: ({ step, of }: { step: number; of: number }) => (merging = { step: step + 1, of })
			})
		);
		merging = null;
		if (!r) return; // the error is already on clientState
		blocked = null;
		phase = 'review';
	}

	// Checked here rather than on the way in, because the delegation choice is made on the
	// review step itself. Still before the proof, which is the part worth not wasting.
	function delegationError(amt: string): string | null {
		if (!delegate) return null;
		if (!isAddress(submitter.trim())) return 'Enter the address that will submit this';
		let fee: bigint;
		try {
			fee = parseAmt(submitterFee.trim() || '0');
		} catch {
			return 'That fee is not a valid amount';
		}
		if (fee <= 0n) return 'Whoever submits needs a fee to cover gas';
		// A withdrawal splits its total between recipient and submitter; a transfer pays the
		// fee on top, so what it has to fit inside is the note, not the amount.
		if (mode === 'withdraw' && fee >= parseAmt(amt))
			return 'The fee is the whole withdrawal — nothing would reach the recipient';
		// Against the shielded balance of this token, not the alias summary — that one is the
		// wallet-level ETH figure and says nothing about what this alias holds in a token.
		if (mode === 'transfer' && parseAmt(amt) + fee > $clientState.balance)
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
			? { relayerFee: parseAmt(submitterFee.trim()), relayer: submitter.trim(), prepare: true }
			: {};
		const tok = BigInt(token.address);
		const r = await run(() =>
			mode === 'transfer'
				? c.send(to, amt, tok, relayOpts)
				: c.withdraw(to, amt, tok, undefined, relayOpts)
		);
		if (!r) return (phase = 'form'); // the error is already on clientState

		if (delegate) {
			blob = (r as any).relayBlob;
			phase = 'handoff';
			return;
		}
		// `reviewTarget`, not the raw input — the same string the review asked you to confirm.
		// Reporting "sent to gg" when the payment went to gg.hls describes a different thing
		// from what happened, and read before `reset()` clears the field it derives from.
		msg =
			mode === 'transfer'
				? `Transferred ${amt} ${sym} to ${reviewTarget}`
				: `Withdrew ${amt} ${sym} to ${reviewTarget}`;
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
			<!-- One back button, not two. Inside an action it returns to the action list; at the
				     list it leaves for the wallet. Two of them stacked meant the visible one at the
				     top of the screen always left the alias entirely. -->
				<button class="back" onclick={() => (mode === null ? deselectAlias() : setMode(null))}>
					{mode === null ? '← Wallet' : '← Actions'}
				</button>
			<div class="who">
				<span class="nm">{label}</span>
				<span class="bal" title="Shielded balance of this alias, in {sym}">
					{fmt($clientState.balance)} {sym} shielded
					<!-- Per token, like the balance beside it — a note holds exactly one asset, so
					     these count only the notes backing the figure shown. Worth being visible
					     rather than discovered: it is what decides whether the whole balance can
					     leave at once, and three or more is the case where it cannot. -->
					{#if $clientState.noteCount > 0}
						<span class="notecount" class:split={$clientState.sendableNow < $clientState.balance}>
							· {$clientState.noteCount} note{$clientState.noteCount === 1 ? '' : 's'}
						</span>
					{/if}
				</span>
			</div>
		</header>

		{#if phase === 'form' && mode === null}
			<!-- What this alias can do. Inviting spends a note exactly as transfer and withdraw
			     do, which is why it belongs here rather than in a global panel — redeeming, which
			     needs no alias at all, stays in the top bar. Ownership moves the name rather than
			     any value, and sits here because only this alias's owner can offer it. Adding
			     funds is here too: anyone can pay any alias, but funding the one you are acting
			     as is the common case and made you leave the screen to do it. -->
			<!-- Which asset the actions below operate on. Shown only when there is a choice:
			     one token means the selector is a control with a single option, which reads as
			     something being unavailable rather than as a setting. Every balance, amount and
			     note count on this screen belongs to whichever is picked — they never merge,
			     because a note names exactly one token. -->
			<div class="assets" role="group" aria-label="Asset">
				{#each $clientState.tokens as t (t.address)}
					<button
						class="asset"
						class:on={t.address === token.address}
						disabled={busy}
						onclick={() => setToken(t.address)}
					>{t.symbol}</button>
				{/each}
				<!-- Always available, even when ETH is the only entry. The list a deployment ships
				     says what is suggested, not what the pool accepts. -->
				<button class="asset add" disabled={busy} onclick={() => (adding = !adding)}>
					{adding ? '×' : '+'}
				</button>
			</div>

			{#if adding}
				<div class="addToken">
					<label>
						<span>Token address</span>
						<input
							class="mono"
							bind:value={newToken}
							placeholder="0x…"
							disabled={busy}
							onkeydown={(e) => e.key === 'Enter' && addAsset()}
						/>
					</label>
					<p class="hint">
						Its symbol and decimals are read from the contract, never assumed — getting
						decimals wrong is how an amount ends up a million times too large.
					</p>
					{#if addError}<p class="err">{addError}</p>{/if}
					<div class="row">
						<button class="primary" disabled={busy || !newToken.trim()} onclick={addAsset}>
							Add
						</button>
						<button class="ghost" onclick={() => { adding = false; addError = null; }}>
							Cancel
						</button>
					</div>
				</div>
			{/if}

			<ul class="actions">
				{#each ACTIONS as a (a.id)}
					<li>
						<button
							class="action"
							disabled={busy || (a.needsOwner && !alias?.ownedHere)}
							onclick={() => setMode(a.id)}
						>
							<span class="an">{a.label}</span>
							<span class="ab">
								{a.needsOwner && !alias?.ownedHere
									? `The name is held by ${alias?.owner ?? 'another address'}, so only that account can hand it on. Sending and receiving still work here.`
									: a.blurb}
							</span>
						</button>
					</li>
				{/each}
			</ul>

		{:else if phase === 'form'}
			{#if mode === 'invite'}
				<InviteWindow />
			{:else if mode === 'ownership'}
				<OwnershipView />
			{:else if mode === 'notes'}
				<!-- Reachable on its own, not only after a send has already been refused. The circuit
				     takes two note inputs, so a balance spread over three or more cannot leave in one
				     transaction — which is a thing to fix deliberately, rather than a wall you find at
				     the moment you are trying to pay someone. -->
				<div class="notes">
					<dl>
						<dt>Balance</dt>
						<dd>{fmt($clientState.balance)} {sym}</dd>
						<dt>Held as</dt>
						<dd>{$clientState.noteCount} note{$clientState.noteCount === 1 ? '' : 's'}</dd>
						<dt>Sendable at once</dt>
						<dd class:warn={$clientState.sendableNow < $clientState.balance}>
							{fmt($clientState.sendableNow)} {sym}
						</dd>
					</dl>

					{#if $clientState.noteCount <= 1}
						<p class="hint">Nothing to combine — the whole balance is already one note.</p>
					{:else if $clientState.sendableNow >= $clientState.balance}
						<p class="hint">
							A transaction spends up to {POOL_INPUTS} notes at once, and this balance is held
							in {$clientState.noteCount}. All of it can already leave in one transaction —
							combining further would still cost a proof and gas for each merge, and buy
							nothing.
						</p>
					{:else}
						<p class="hint">
							{$clientState.noteCount} notes, and a transaction spends at most {POOL_INPUTS} — so
							{fmt($clientState.balance - $clientState.sendableNow)} {sym} of this cannot move
							until they are merged. This needs {mergesNeeded($clientState.noteCount)} merge{mergesNeeded($clientState.noteCount) === 1 ? '' : 's'},
							not {$clientState.noteCount - 1}: each merge spends {POOL_INPUTS} notes and leaves one,
							so it removes {POOL_INPUTS - 1} at a time, and {POOL_INPUTS} notes is already fully
							sendable. Each stops safely part-way.
						</p>
					{/if}

					{#if merging}
						<p class="hint">Combining… {merging.step} of {merging.of}</p>
					{/if}

					<div class="row">
						<!-- Disabled on the same condition the hint above is written from. `noteCount <= 1`
						     alone left the button live whenever the balance was already sendable in one
						     transaction — the hint said combining would buy nothing, the button invited it
						     anyway, and `consolidate` correctly returned without doing a thing. An enabled
						     control that no-ops reads as a broken button. -->
						<button
							class="primary"
							disabled={busy ||
								merging !== null ||
								$clientState.noteCount <= 1 ||
								$clientState.sendableNow >= $clientState.balance}
							onclick={combineAll}
						>
							{merging ? 'Combining…' : 'Combine'}
						</button>
						<button class="ghost" disabled={merging !== null} onclick={() => setMode(null)}>
							Back
						</button>
					</div>
				</div>
			{:else if mode === 'viewkey'}
				<ViewKeyView />
			{:else if mode === 'deposit'}
				<DepositWindow embedded initialTarget={alias?.name ? `${alias.name}.hls` : ''} />
			{:else}
			<div class="form">
				<label>
					<span>{targetLabel}</span>
					<input bind:value={target} placeholder={targetPlaceholder} disabled={busy} />
				</label>
				<label>
					<span>Amount ({sym})</span>
					<input class="mono" bind:value={amount} placeholder="0.1" inputmode="decimal"
						disabled={busy} />
				</label>

				<!-- Decided here, in full: the checkbox and the address and fee that go with it. Split
				     across this form and the review, the review becomes a form itself — and one that
				     still takes input cannot be read in one pass and confirmed. -->
				<!-- Offered for ETH only, and the reason is that there is no exchange rate here.
				     Whoever submits spends gas in ETH and is paid out of the note, which is
				     denominated in whatever is being moved. For ETH those are the same unit and a
				     fee can be quoted from the gas estimate. For a token they are not, and pricing
				     one against the other needs an oracle this has no business carrying — so
				     rather than suggest a number that could be off by any factor, the option is
				     withdrawn and says why. -->
				<label class="check">
					<input type="checkbox" bind:checked={delegate} disabled={busy} />
					<span>
						{RELAY_LABEL}
						<em>{RELAY_HINT}</em>
					</span>
				</label>

				{#if delegate}
					<div class="sub">
						<label>
							<span>Submitting address</span>
							<input class="mono" bind:value={submitter} placeholder="0x…" disabled={busy} />
						</label>
						<label>
							<span>Their fee ({sym})</span>
							<input class="mono" bind:value={submitterFee} inputmode="decimal" disabled={busy} />
						</label>
						<div class="est">
							<!-- Offered only for ETH, and the reason is that there is no exchange rate
							     here. The estimate prices gas, which is always ETH; the fee is paid out
							     of the note, which is in whatever is being moved. For ETH those are one
							     unit and the estimate is a real answer. For a token they are not, and a
							     suggested number would be off by whatever the token happens to be
							     worth — so the control is withdrawn rather than made to guess. -->
							{#if isEth}
								<button class="ghost sm" disabled={busy || estimating} onclick={estimate}>
									{estimating ? 'Estimating…' : 'Estimate'}
								</button>
							{:else}
								<span class="hint">
									Gas is paid in ETH and this fee is paid in {sym}, so nothing here can
									suggest an amount — agree one with whoever submits.
								</span>
							{/if}
							{#if quote}
								<span class="hint">
									≈{formatEther(quote.gasCost).slice(0, 7)} ETH of gas, plus 20% for whoever
									submits. <!-- gas is always ETH, whatever is being moved -->
									{#if feeWei > 0n && feeWei < quote.gasCost}
										<strong class="belowCost">
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

				<button class="primary" disabled={busy || !ready} onclick={toReview}>Review</button>

				<PrivacyNote mode={txMode} />
			</div>
				{/if}
		{:else if phase === 'review'}
			<ReviewStep
				mode={txMode}
				{token}
				amount={amount.trim()}
				target={reviewTarget}
				alias={label}
				from={$clientState.address ?? ''}
				canDelegate
				{delegate}
				{submitter}
				{submitterFee}
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
					<input class="mono" readonly value={relayLink} onfocus={(e) => e.currentTarget.select()} />
				</label>
				<p class="hint">
					Opening it lands them on the Relay screen with this already loaded. The transaction
					travels in the part of the URL browsers never send to a server.
				</p>

				<details>
					<summary>Or copy the raw transaction</summary>
					<textarea class="mono" readonly rows="6" value={blob}></textarea>
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

		{#if blocked !== null}
			<div class="blocked">
				<p class="lead">This alias holds {fmt($clientState.balance)} {sym} across
					{$clientState.noteCount} notes, and one transaction can spend {POOL_INPUTS} of them.</p>
				<p>That caps a single payment at {fmt($clientState.sendableNow)} {sym} until the
					notes are combined. Combining is private and moves nothing — it pays you, from you.</p>
				{#if merging}
					<p class="progress">Combining… {merging.step} of {merging.of}</p>
				{:else}
					<div class="actions">
						<button class="ghost" onclick={() => (blocked = null)}>Change amount</button>
						<button class="primary" onclick={combine}>Combine notes</button>
					</div>
				{/if}
			</div>
		{/if}

		{#if formError}<p class="err">{formError}</p>{/if}
		{#if msg}<p class="ok">{msg}</p>{/if}
		{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
	{/if}
</div>

<style>
	.transact { display: flex; flex-direction: column; gap: 1rem; padding: 0.5rem; }
	.blocked { display: flex; flex-direction: column; gap: 0.5rem;
		border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; }
	.blocked .lead { font-weight: 600; }
	.blocked p { margin: 0; }
	.blocked .progress { opacity: 0.8; }
	header { display: flex; align-items: flex-start; gap: 0.75rem; flex-wrap: wrap;
		border-bottom: 1px solid var(--border); padding-bottom: 0.6rem; }
	.back { background: none; border: none; color: inherit; opacity: 0.85; cursor: pointer;
		font: inherit; padding: 0; }
	.back:hover { opacity: 1; }
	.who { margin-left: auto; display: flex; gap: 0.75rem; align-items: baseline;
		flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
	.nm { font-family: var(--font-mono); overflow-wrap: anywhere; font-size: 0.8rem; }
	.bal { font-variant-numeric: tabular-nums; opacity: 0.9; }
	/* The asset the actions below operate on. A segmented row rather than a dropdown: with
	   two or three options every one is visible, and which is current is legible without
	   opening anything. */
	.assets { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.9rem; }
	.asset { font-size: 0.78rem; padding: 0.3rem 0.75rem; border-radius: 999px;
		border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
		transition: border-color 0.15s, background 0.15s, color 0.15s; }
	.asset:hover:not(:disabled) { border-color: var(--accent); color: var(--text-bright); }
	.asset.on { background: var(--accent); border-color: var(--accent); color: var(--bg-dark);
		font-weight: 700; }
	/* Reads as an affordance rather than another asset — same shape, no label of its own. */
	.asset.add { font-family: var(--font-mono); padding: 0.3rem 0.7rem; }
	.addToken { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.9rem;
		padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;
		background: var(--bg-input); }

	/* Quiet beside the balance until it matters — three or more notes means part of the balance
	   cannot move, and that is the moment it should catch the eye. */
	.notecount { color: var(--text-dim); font-size: 0.78rem; }
	.notecount.split { color: var(--caution); }

	/* The notes panel: a summary anyone can act on, rather than an error they ran into. */
	.notes { display: flex; flex-direction: column; gap: 0.9rem; }
	.notes dl { margin: 0; display: grid; grid-template-columns: 10rem 1fr; gap: 0.4rem 1rem;
		font-size: 0.85rem; padding: 0.8rem; border: 1px solid var(--border);
		border-radius: 6px; }
	.notes dt { color: var(--text-dim); }
	.notes dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
	.notes dd.warn { color: var(--caution); }

	.actions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.4rem; }
	/* A column, so the title reads first and its description sits under it. The hover border
	   carries the affordance — an arrow on every row was five arrows saying the same thing. */
	.action { width: 100%; display: flex; flex-direction: column; gap: 0.15rem;
		padding: 0.7rem 0.85rem; background: var(--bg-input);
		border: 1px solid var(--border); border-radius: 8px; text-align: left;
		transition: border-color 0.15s, background 0.15s; }
	.action:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-titlebar); }
	.action:disabled { opacity: 0.55; }
	.action:disabled .ab { overflow-wrap: anywhere; }
	.an { font-size: 0.9rem; font-weight: 700; color: var(--text-bright); }
	.ab { font-size: 0.76rem; color: var(--text-dim); line-height: 1.45; }
	.form { display: flex; flex-direction: column; gap: 0.6rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.handoff { display: flex; flex-direction: column; gap: 0.7rem; }
	.handoff h3 { margin: 0; font-size: 0.75rem; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-dim); font-weight: 600; }
	textarea { width: 100%; font-family: var(--font-mono); font-size: 0.72rem;
		resize: vertical; background: var(--bg-input); color: inherit;
		border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem;
		word-break: break-all; }
	.actions { display: flex; gap: 0.5rem; }
	.actions .primary { flex: 1; }
	.primary { padding: 0.55rem; }
	.hint, .empty { font-size: 0.8rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.mono { font-family: var(--font-mono); overflow-wrap: anywhere; }
	.check { display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem;
		cursor: pointer; }
	.check input { margin-top: 0.15rem; }
	.check span { text-transform: none; letter-spacing: 0; font-size: 0.85rem; opacity: 0.9; }
	.sub { display: flex; flex-direction: column; gap: 0.5rem; padding-left: 0.75rem;
		border-left: 2px solid var(--border); }
	.est { display: flex; gap: 0.6rem; align-items: flex-start; flex-wrap: wrap; }
	.ghost.sm { padding: 0.3rem 0.7rem; font-size: 0.78rem; }
	.belowCost { display: block; color: var(--caution); margin-top: 0.25rem; }
	.check em { display: block; font-style: normal; font-size: 0.78rem; color: var(--text-dim); }
	.linkRow input { width: 100%; font-family: var(--font-mono); font-size: 0.72rem;
		background: var(--bg-input); color: inherit;
		border: 1px solid var(--border); border-radius: 6px; padding: 0.55rem; }
	details { font-size: 0.8rem; opacity: 0.88; }
	summary { cursor: pointer; opacity: 0.85; }
	details textarea { margin-top: 0.5rem; }
	.ok { color: var(--good); font-size: 0.85rem; margin: 0; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; }
</style>
