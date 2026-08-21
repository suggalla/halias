<script lang="ts">
	import { formatEther } from 'ethers';
	import { clientState, getClient, run } from '../sdk/client.js';

	// Giving someone an alias and the funds to use it, in one code.
	//
	// The claimer needs no wallet balance, no alias and no prior involvement — the fee for the
	// name they pick was paid here, in ETH, and the whole note becomes their own shielded
	// change. It is the only onboarding path that does not assume they already have something.
	//
	// Creating sits with the alias's other actions because it spends the same thing they do —
	// a note. The wallet pays only the registration fee, which is a fixed public amount that
	// says nothing about the invite; the value itself moves privately, so nothing on chain
	// says what an invite is worth. Redeeming is the opposite: it needs no alias and no
	// balance, so it lives in the top bar where someone holding only a code can reach it.

	let amount = $state('');
	let created = $state<{ inviteCode: string; amount: bigint } | null>(null);
	let copied = $state<'code' | 'link' | null>(null);
	let formError = $state<string | null>(null);

	// Which phase createInvite is in. One transaction now, but the longest stretch — fetching
	// the proving key and generating against it — prompts for nothing at all, so a single
	// "Working…" across the whole of it reads as a hang, which is what it was doing.
	//
	// No reservation and no block to wait out: an invite registers no name, so there is
	// nothing front-runnable and nothing to commit to first.
	type Step = 'proving' | 'funding';
	let step = $state<Step | null>(null);
	const STEP_TEXT: Record<Step, string> = {
		proving:  'Building the proof — this fetches a 39MB key the first time…',
		funding:  'Creating the invite…'
	};

	// Invites already outstanding, and what can still be done about them.
	//
	// Listable at all only because the secret is derived from this wallet's root rather than
	// generated randomly — see inviteSecretAt in the SDK. A random secret exists only in the
	// screen that first displayed it, so closing this window used to strand the funds behind
	// any invite whose code had not been saved. Recomputed, they can be found again on any
	// device holding the phrase, and taken back if nobody redeemed them.
	type Pending = {
		index: number;
		inviteCode: string;
		entryHash: string;
		amount: bigint | null;
		claimable: boolean;
	};
	let pending = $state<Pending[]>([]);
	let loading = $state(false);
	let reclaiming = $state<number | null>(null);

	async function loadPending() {
		loading = true;
		const r = await run(() => getClient().listInvites());
		if (r) pending = (r as Pending[]).filter((i) => i.claimable);
		loading = false;
	}

	// Re-read whenever the alias changes, since invites belong to a wallet's root and the
	// screen is reachable from any of its aliases.
	//
	// Guarded on the alias, not merely on `selected` being set. `$clientState` is a store
	// subscription, so the effect depends on the whole object and reruns on every emission —
	// and `loadPending` goes through `run`, which emits twice and calls `refresh` in between.
	// Unguarded, the effect fed itself: `loading` never cleared, `status` never left 'syncing',
	// and the rescan behind it locked the rest of the UI. Same shape as HistoryView.
	let loadedFor: string | null = null;
	$effect(() => {
		const current = $clientState.selected?.aliasHash ?? null;
		if (current === loadedFor) return;
		loadedFor = current;
		if (current) loadPending();
	});

	async function reclaim(index: number) {
		reclaiming = index;
		const r = await run(() => getClient().reclaimInvite(index));
		reclaiming = null;
		if (r) await loadPending();
	}

	const busy = $derived($clientState.status === 'syncing');
	// Rendered inside the alias screen, so the alias is settled before this mounts.
	const source = $derived($clientState.selected);

	// Short enough to be a real link — the code is one 32-byte secret, not a proof.
	const claimLink = $derived(
		created && typeof location !== 'undefined'
			? `${location.origin}${location.pathname}#claim=${created.inviteCode}`
			: ''
	);

	async function create() {
		formError = null;
		const amt = amount.trim();
		if (!amt || !(Number(amt) > 0)) return (formError = 'Enter an amount greater than zero');
		if (!source) return (formError = 'No alias selected');
		if (parseFloat(amt) > parseFloat(formatEther(source.balance)))
			return (formError =
				`${source.name ? source.name + '.hls' : 'That alias'} holds ${formatEther(source.balance)} ETH`);

		step = null;
		const r = await run(() => getClient().createInvite(amt, (s: Step) => (step = s)));
		step = null;
		if (r) {
			created = { inviteCode: (r as any).inviteCode, amount: (r as any).amount };
			amount = '';
			await loadPending();
		}
	}

	async function copy(text: string, which: 'code' | 'link') {
		await navigator.clipboard.writeText(text);
		copied = which;
		setTimeout(() => (copied = null), 2000);
	}
</script>

<div class="invite">
	{#if !source || source.balance === 0n}
		<p class="empty">
			An invite is funded from this alias's shielded balance, and there is none yet. Deposit
			first — or, if someone sent <em>you</em> a code, use <strong>Redeem</strong> in the top
			bar, which needs nothing.
		</p>
	{:else if created}
		<h3>Invite created</h3>
		<p class="lede">
			{formatEther(created.amount)} ETH is held for whoever redeems this. They pick a name —
			already paid for — and the whole amount becomes their balance.
		</p>

		<!-- Unlike a prepared relay transaction — which is worthless to anyone but its named
		     submitter — this is a bearer secret. Whoever holds it can take the funds. The
		     distinction has to be stated, not implied, because the two flows look alike. -->
		<aside class="note warn">
			<strong>Anyone holding this code can redeem it.</strong>
			There is no recipient bound into it, so treat it like cash: send it through something
			private, and to one person. It cannot be revoked, only spent.
		</aside>

		<label>
			<span>Link</span>
			<input readonly value={claimLink} onfocus={(e) => e.currentTarget.select()} />
		</label>
		<label>
			<span>Or the code alone</span>
			<input readonly value={created.inviteCode} onfocus={(e) => e.currentTarget.select()} />
		</label>

		<div class="actions">
			<button class="ghost" onclick={() => (created = null)}>Create another</button>
			<button class="ghost" onclick={() => copy(created!.inviteCode, 'code')}>
				{copied === 'code' ? 'Copied' : 'Copy code'}
			</button>
			<button class="primary" onclick={() => copy(claimLink, 'link')}>
				{copied === 'link' ? 'Copied' : 'Copy link'}
			</button>
		</div>
	{:else}
		<h3>Invite someone</h3>
		<p class="lede">
			Creates a code worth the amount you choose. Whoever redeems it registers a
			<code>.hls</code> name — paid for by you, here — and receives the full amount, without
			needing funds of their own first.
		</p>

		<label>
			<span>Amount (ETH)</span>
			<input class="mono" bind:value={amount} placeholder="0.2" inputmode="decimal" disabled={busy} />
		</label>
		<p class="hint">
			From this alias's shielded balance of {formatEther(source.balance)} ETH, so the amount
			never appears on chain. Your wallet pays only the registration fee. A relay fee — if
			they have no ETH and need someone to submit for them — comes out of the invite, so
			leave room for it. They choose it at redemption, not you.
		</p>

		<button class="primary" disabled={busy} onclick={create}>
			{busy ? 'Working…' : 'Create invite'}
		</button>
		{#if step}<p class="hint">{STEP_TEXT[step]}</p>{/if}
	{/if}

	<!-- Shown alongside creating rather than behind a tab, because an outstanding invite is
	     money that has left this balance and not yet arrived anywhere. Only unclaimed ones are
	     listed: a redeemed invite is finished, and nothing on chain says who redeemed it — the
	     claimer's change is addressed to their own alias and is indistinguishable from any
	     other output, which is the point. -->
	{#if pending.length > 0}
		<!-- Wallet-scoped, and said so. Invite secrets come from the wallet's derivation root
		     rather than from any one alias, so every alias lists the same invites — which read
		     as one alias's invites leaking into another until the heading says otherwise. The
		     destination is named for the same reason: reclaiming pays the alias selected now,
		     not the one that funded it. -->
		<section class="pending">
			<h3>Waiting to be redeemed — this wallet</h3>
			<p class="hint">
				Invites belong to the wallet, not to one alias, so every alias of yours lists the
				same ones. Still yours until someone spends them. Taking one back pays
				{$clientState.selected?.name ?? 'the alias selected now'} — whichever alias funded
				it — so it can move value between your own aliases. The registration fee it
				already paid is not recoverable, and whoever holds the code can still redeem it
				first.
			</p>
			<ul>
				{#each pending as p (p.index)}
					<li>
						<div class="who">
							<span class="amt">{p.amount === null ? '—' : formatEther(p.amount)} ETH</span>
							<span class="nm">{p.inviteCode.slice(0, 10)}…{p.inviteCode.slice(-6)}</span>
						</div>
						<div class="row">
							<button
								class="ghost sm"
								disabled={reclaiming !== null}
								onclick={() => copy(p.inviteCode, 'code')}
							>
								{copied === 'code' ? 'Copied' : 'Copy code'}
							</button>
							<button
								class="ghost sm danger"
								disabled={busy || reclaiming !== null}
								onclick={() => reclaim(p.index)}
							>
								{reclaiming === p.index ? 'Taking back…' : 'Take back'}
							</button>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{:else if loading}
		<p class="hint">Checking for outstanding invites…</p>
	{/if}

	{#if formError}<p class="err">{formError}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.invite { display: flex; flex-direction: column; gap: 0.85rem; }
	h3 { margin: 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); font-weight: 600; }
	.lede { margin: 0; font-size: 0.85rem; opacity: 0.88; line-height: 1.55; max-width: 34rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	input[readonly] { width: 100%; font-family: var(--font-mono); font-size: 0.72rem;
		background: var(--bg-input); color: inherit; border: 1px solid var(--border);
		border-radius: 6px; padding: 0.55rem; }
	.note { font-size: 0.78rem; line-height: 1.5; padding: 0.7rem 0.8rem;
		border: 1px solid var(--border); border-left-width: 3px; border-radius: 4px; }
	.note.warn { border-left-color: var(--caution); }
	strong { font-weight: 600; }
	code { font-family: var(--font-mono); }
	.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.actions .primary { flex: 1; min-width: 8rem; }
	.primary { padding: 0.55rem; }
	.hint, .empty { font-size: 0.8rem; color: var(--text-dim); margin: 0; line-height: 1.5; }

	/* Outstanding invites. Separated by a rule rather than a heading weight, because this is a
	   different subject from the form above it, not a subsection of it. */
	.pending { display: flex; flex-direction: column; gap: 0.6rem; padding-top: 0.9rem;
		border-top: 1px solid var(--border); }
	.pending ul { list-style: none; margin: 0; padding: 0; display: flex;
		flex-direction: column; gap: 0.4rem; }
	.pending li { display: flex; align-items: center; justify-content: space-between;
		gap: 0.75rem; flex-wrap: wrap; padding: 0.55rem 0.7rem; background: var(--bg-input);
		border: 1px solid var(--border); border-radius: 8px; }
	.who { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
	.amt { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
		font-size: 0.85rem; color: var(--text-bright); }
	.nm { font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-dim);
		overflow-wrap: anywhere; }
	.row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
	.sm { font-size: 0.72rem; padding: 0.3rem 0.6rem; }
	.danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; line-height: 1.5; }
</style>
