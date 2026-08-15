<script lang="ts">
	import { formatEther, isAddress } from 'ethers';
	import { clientState, getClient, run, pendingOwnerOf } from '../sdk/client.js';

	// Handing an alias to someone else.
	//
	// This is an offer, never a transfer. The sender cannot choose the recipient's keys —
	// only the recipient can say which keys are theirs — so nothing moves until they accept.
	// The version that let the sender set both handed over the name while installing keys the
	// seller kept, and every payment to that name kept arriving for them.
	//
	// Whether the balance leaves first is not a choice — see mustSweep below.

	let newOwner = $state('');
	let sweepTo = $state('');
	let msg = $state<string | null>(null);
	let formError = $state<string | null>(null);
	let confirming = $state(false);
	let pending = $state<string | null>(null);
	let pendingFor: string | null = null;

	const alias = $derived($clientState.selected);
	const busy = $derived($clientState.status === 'syncing');
	const label = $derived(alias ? (alias.name ? `${alias.name}.hls` : alias.aliasHash) : '');
	// An alias with no known name cannot be handed over here: every SDK call takes the name,
	// and the contract stores only its hash. Saying so beats a failure at signing time.
	const nameless = $derived(!!alias && !alias.name);

	// Whether the balance has to leave first is decided by the balance, not by the user.
	//
	// A handover replaces the registry entry with the new owner's keys, and every spend that
	// needs a change output proves the *sender's* spending commitment is registered — under this alias,
	// which it no longer is. So notes left behind are not merely forgotten, they are stranded:
	// only an exact-amount withdrawal producing no change could still move them.
	const mustSweep = $derived((alias?.balance ?? 0n) > 0n);

	// Read the outstanding offer straight from the contract rather than tracking it locally.
	// An offer made from another browser is just as real, and a local flag would deny it.
	$effect(() => {
		const hash = alias?.aliasHash ?? null;
		if (hash === pendingFor) return;
		pendingFor = hash;
		pending = null;
		if (hash) pendingOwnerOf(hash).then((p) => { if (pendingFor === hash) pending = p; });
	});

	async function reloadPending() {
		if (alias) pending = await pendingOwnerOf(alias.aliasHash);
	}

	function validate(): string | null {
		if (nameless) return 'This alias has no known name — label it in the wallet first.';
		if (!isAddress(newOwner.trim())) return 'Enter the new owner’s Ethereum address';
		if (mustSweep && !isAddress(sweepTo.trim()))
			return 'Enter an address to receive this alias’s balance';
		return null;
	}

	async function doOffer() {
		formError = validate();
		if (formError) return;
		msg = null;
		const c = getClient();
		const r = await run(() => c.offerAlias(`${alias!.name}.hls`, newOwner.trim()));
		confirming = false;
		if (r) {
			msg = `${label} is offered. It stays yours until they accept.`;
			newOwner = '';
			await reloadPending();
		}
	}

	async function doSweepAndOffer() {
		formError = validate();
		if (formError) return;
		msg = null;
		const c = getClient();
		const r = await run(() =>
			c.sweepAndOffer(`${alias!.name}.hls`, sweepTo.trim(), newOwner.trim())
		);
		confirming = false;
		if (r) {
			const n = (r as any).sweepTxHashes?.length ?? 0;
			msg = `Swept ${n} note${n === 1 ? '' : 's'} and offered ${label}.`;
			newOwner = '';
			sweepTo = '';
			await reloadPending();
		}
	}

	async function doCancel() {
		msg = null;
		const c = getClient();
		if (await run(() => c.cancelOffer(`${alias!.name}.hls`))) {
			msg = 'Offer withdrawn.';
			await reloadPending();
		}
	}
</script>

<div class="own">
	{#if pending}
		<!-- The single most important thing on this screen when it applies: the alias is
		     already promised to someone, and a second offer would silently replace it. -->
		<div class="pending">
			<div>
				<span class="k">Offered to</span>
				<span class="mono">{pending}</span>
			</div>
			<p class="hint">
				Still yours, and still receiving, until they accept. Offering it to someone else
				replaces this.
			</p>
			<button class="ghost" disabled={busy} onclick={doCancel}>Withdraw offer</button>
		</div>
	{/if}

	{#if !confirming}
		<div class="form">
			<label>
				<span>New owner’s address</span>
				<input class="mono" bind:value={newOwner} placeholder="0x…" disabled={busy} />
			</label>

			{#if mustSweep}
				<label>
					<span>Send this alias’s balance to</span>
					<input class="mono" bind:value={sweepTo} placeholder="0x…" disabled={busy} />
				</label>
				<p class="warn">
					This alias holds {formatEther(alias?.balance ?? 0n)} ETH — plus anything it holds in
					other assets, which the sweep empties too — so it is cleared out before it
					changes hands. That is not a courtesy — a handover installs the new owner's keys,
					and afterwards nothing left behind can be spent, because every spend has to prove
					the sender's key is the one registered here.
				</p>
				<p class="hint">
					Every note is withdrawn separately, so expect several wallet prompts before the
					offer itself.
				</p>
			{:else}
				<p class="hint">
					This alias is empty, so there is nothing to move out first. The new owner gets the
					name and everything paid to it from now on.
				</p>
			{/if}

			<button class="primary" disabled={busy || nameless} onclick={() => { formError = validate(); if (!formError) confirming = true; }}>
				Review
			</button>

			{#if nameless}
				<p class="warn">
					This alias has no known name in this browser, and a handover needs it. Label it in
					the wallet first.
				</p>
			{/if}
		</div>
	{:else}
		<div class="review">
			<h3>Confirm</h3>
			<dl>
				<div><dt>Alias</dt><dd class="mono">{label}</dd></div>
				<div><dt>New owner</dt><dd class="mono">{newOwner.trim()}</dd></div>
				{#if mustSweep}
					<div><dt>Balance to</dt><dd class="mono">{sweepTo.trim()}</dd></div>
					<div><dt>Emptying</dt><dd>{formatEther(alias?.balance ?? 0n)} ETH, and every other
						asset held under this name</dd></div>
				{/if}
			</dl>

			<p class="warn">
				Once they accept, the name and every future payment to it are theirs. Nothing on
				chain can prove an alias is empty, so a buyer is acquiring the name and its future
				payments — never a balance.
			</p>

			<div class="actions">
				<button class="ghost" disabled={busy} onclick={() => (confirming = false)}>Back</button>
				<button class="primary" disabled={busy}
					onclick={mustSweep ? doSweepAndOffer : doOffer}>
					{busy ? 'Working…' : mustSweep ? 'Empty and offer' : 'Offer it'}
				</button>
			</div>
		</div>
	{/if}

	{#if formError}<p class="err">{formError}</p>{/if}
	{#if msg}<p class="ok">{msg}</p>{/if}
</div>

<style>
	.own { display: flex; flex-direction: column; gap: 0.85rem; }
	.pending { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem;
		border: 1px solid var(--accent); border-radius: 8px; background: var(--bg-titlebar); }
	.pending > div { display: flex; flex-direction: column; gap: 0.15rem; }
	.k { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.09em;
		color: var(--text-dim); }
	.pending .ghost { align-self: flex-start; }

	.form, .review { display: flex; flex-direction: column; gap: 0.6rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	h3 { margin: 0; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.09em;
		color: var(--text-dim); font-weight: 600; }

	dl { margin: 0; display: flex; flex-direction: column; gap: 0.4rem;
		border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem;
		background: var(--bg-input); }
	dl > div { display: flex; gap: 1rem; align-items: baseline; }
	dt { flex: none; width: 7rem; font-size: 0.68rem; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-dim); }
	dd { margin: 0; min-width: 0; font-size: 0.85rem; overflow-wrap: anywhere; }

	.mono { font-family: var(--font-mono); font-size: 0.78rem; overflow-wrap: anywhere; }
	.hint { font-size: 0.8rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.warn { font-size: 0.8rem; line-height: 1.5; margin: 0; color: var(--caution);
		border-left: 2px solid var(--caution); padding-left: 0.6rem; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; }
	.ok { color: var(--good); font-size: 0.85rem; margin: 0; }

	.actions { display: flex; gap: 0.5rem; }
	.actions .primary { flex: 1; }
	.primary { padding: 0.55rem; }
</style>
