<script lang="ts">
	import { keccak256, toUtf8Bytes, parseEther, formatEther, isAddress } from 'ethers';
	import { RELAY_LABEL, RELAY_HINT } from '../copy.js';
	import {
		clientState,
		clientFor,
		run,
		loadAliases,
		rememberName,
		nextFreeIndex,
		wallet
	} from '../sdk/client.js';

	// Redeeming an invite is how someone arrives with nothing.
	//
	// It is deliberately not on the alias screen: a claimer has no alias yet — this is what
	// creates one. The registration was paid for in ETH when the invite was created, so the
	// whole note becomes their shielded balance and the only thing they must bring is gas.

	let code = $state('');
	let name = $state('');
	let msg = $state<string | null>(null);
	let formError = $state<string | null>(null);
	let fromLink = $state(false);

	// Redeeming is the one place where the person genuinely has nothing, so needing gas to
	// get started partly defeats the invite. The relay fee comes out of the invite note itself
	// and is chosen here, at redemption — whoever created it specified nothing, because they
	// could not know gas prices days in advance. The registration is not paid for here at all;
	// it was bought in ETH when the invite was created.
	let delegate = $state(false);
	let submitter = $state('');
	let submitterFee = $state('0.05');
	let blob = $state<string | null>(null);
	let copied = $state<'blob' | 'link' | null>(null);
	let estimate = $state<string | null>(null);

	const relayLink = $derived(
		blob && typeof location !== 'undefined'
			? `${location.origin}${location.pathname}#relay=${encodeURIComponent(blob)}`
			: ''
	);

	async function suggest() {
		try {
			const { suggestRelayFee } = await import('halias-sdk');
			const q = await suggestRelayFee(wallet().provider, { marginPct: 20 });
			submitterFee = formatEther(q.suggested);
			estimate = `≈${Number(formatEther(q.gasCost)).toFixed(5)} ETH of gas, plus 20%.`;
		} catch (e: any) {
			estimate = e?.shortMessage ?? e?.message ?? String(e);
		}
	}

	async function copy(text: string, which: 'blob' | 'link') {
		await navigator.clipboard.writeText(text);
		copied = which;
		setTimeout(() => (copied = null), 2000);
	}

	const busy = $derived($clientState.status === 'syncing');
	const connected = $derived($clientState.address !== null);

	// Arriving by link. The code is a bearer secret, so it rides in the fragment, which
	// browsers never send to a server.
	//
	// The fragment stays until the claim succeeds, and that is the fix rather than an
	// oversight. Clearing it on read meant the code lived only in this component's state:
	// connecting a wallet remounts the panel, `code` came back empty, and the address bar no
	// longer had it either — so arriving by link and then connecting lost the invite with no
	// way to recover it. Redeeming needs a wallet, so that path is the normal one, not an edge
	// case.
	//
	// Re-read whenever `code` is empty, so a remount recovers it. Cleared in `claim()` once the
	// invite is actually spent, at which point the code is worthless anyway.
	$effect(() => {
		if (code || typeof location === 'undefined') return;
		const m = location.hash.match(/[#&]claim=([^&]+)/);
		if (!m) return;
		code = decodeURIComponent(m[1]);
		fromLink = true;
	});

	/// Drop the code from the address bar. Called once it has been redeemed.
	function clearLink() {
		if (typeof location === 'undefined') return;
		if (!/[#&]claim=/.test(location.hash)) return;
		history.replaceState(null, '', location.pathname + location.search);
	}

	async function claim() {
		formError = null;
		msg = null;
		if (!code.trim()) return (formError = 'Paste the invite code');

		let clean: string;
		try {
			const { normalizeAlias } = await import('halias-sdk');
			clean = normalizeAlias(name);
		} catch (e: any) {
			return (formError = e?.message ?? 'That name is not usable');
		}

		let secret: bigint;
		try {
			const { decodeInviteCode } = await import('halias-sdk');
			secret = decodeInviteCode(code.trim());
		} catch {
			return (formError = 'That does not look like an invite code');
		}

		let fee = 0n;
		if (delegate) {
			if (!isAddress(submitter.trim()))
				return (formError = 'Enter the address that will submit this');
			try {
				fee = parseEther(submitterFee.trim() || '0');
			} catch {
				return (formError = 'That fee is not a valid amount');
			}
			if (fee <= 0n) return (formError = 'Whoever submits needs a fee to cover gas');
		}

		// A claim registers a new alias, so it needs its own derivation index rather than
		// sharing keys with one already registered.
		const c = await clientFor(nextFreeIndex($clientState.aliases));
		const opts = delegate
			? { relayerFee: fee, relayer: submitter.trim(), prepare: true }
			: {};
		const r = await run(() => c.claimInvite(secret, clean, opts));
		if (r && delegate) {
			blob = (r as any).relayBlob;
			return;
		}
		if (r) {
			clearLink();
			// Remembered locally so the name shows immediately. The claim publishes it in
			// NamePublished, so the chain answers from the next scan on; this covers the gap.
			rememberName(keccak256(toUtf8Bytes(clean + '.hls')), clean);
			msg = `${clean}.hls is yours, funded from the invite.`;
			code = '';
			name = '';
			fromLink = false;
			await loadAliases();
		}
	}
</script>

<div class="claim">
	<header>
		<h2>Redeem an invite</h2>
		<p class="lede">
			An invite carries both a name and the funds to use it. Pick what you want to be called —
			the name is already paid for, and the whole invite becomes your balance.
		</p>
	</header>

	{#if !connected}
		<!-- Says what to do and where, because this panel cannot do it. Redeeming registers a
		     new alias, so it needs note keys as well as a wallet — "connect a wallet" was
		     understating it, and a reader who connected one and came back to the same message
		     would have no idea what was still missing. The link survives all of it now. -->
		<p class="hint">
			{#if fromLink}Your invite is loaded and will keep.{/if}
			Redeeming needs two things: a wallet to pay gas, and a recovery phrase for the alias
			you are about to register. Close this and set both up — this panel reopens by itself
			when you are done.
		</p>
	{:else}
		{#if fromLink}
			<p class="hint">Invite loaded from a link.</p>
		{/if}

		<label>
			<span>Invite code</span>
			<input class="mono" bind:value={code} placeholder="0x…" disabled={busy} />
		</label>

		<label>
			<span>Choose your name</span>
			<input bind:value={name} placeholder="alice" disabled={busy} />
		</label>
		<p class="hint">
			Letters, numbers and hyphens. <code>.hls</code> is added for you, and the name is
			public once registered.
		</p>

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
					<span>Their fee (ETH)</span>
					<input class="mono" bind:value={submitterFee} inputmode="decimal" disabled={busy} />
				</label>
				<div class="est">
					<button class="ghost sm" disabled={busy} onclick={suggest}>Estimate</button>
					<span class="hint">
						{estimate ?? 'Taken from the invite, so it must be large enough to cover this.'}
					</span>
				</div>
			</div>
		{/if}

		<button class="primary" disabled={busy} onclick={claim}>
			{busy ? 'Working…' : delegate ? 'Prepare for submission' : 'Redeem'}
		</button>

		{#if blob}
			<label>
				<span>Send this to whoever is submitting</span>
				<input class="mono" readonly value={relayLink} onfocus={(e) => e.currentTarget.select()} />
			</label>
			<div class="actions">
				<button class="ghost" onclick={() => copy(blob!, 'blob')}>
					{copied === 'blob' ? 'Copied' : 'Copy text'}
				</button>
				<button class="primary" onclick={() => copy(relayLink, 'link')}>
					{copied === 'link' ? 'Copied' : 'Copy link'}
				</button>
			</div>
			<p class="hint">
				Safe to send in the open: it carries the proof, not your invite code, and the alias
				is bound to you. Anyone who submits it pays gas and collects only the fee.
			</p>
		{/if}

		<aside class="note">
			<strong>One transaction, not two.</strong>
			Registering a name yourself takes two — a reservation, then the claim — because the
			name has to be hidden until it is yours. An invite carries proof of who it is for, so
			there is nothing to hide and nothing to race.
		</aside>

		<aside class="note">
			<strong>An invite can only be redeemed once.</strong>
			Whoever spends it first gets it — so if someone else has seen the code, claim it now
			rather than later.
		</aside>
	{/if}

	{#if formError}<p class="err">{formError}</p>{/if}
	{#if msg}<p class="ok">{msg}</p>{/if}
	{#if $clientState.error}<p class="err">{$clientState.error}</p>{/if}
</div>

<style>
	.claim { display: flex; flex-direction: column; gap: 0.85rem; }
	header { display: flex; flex-direction: column; gap: 0.4rem; }
	h2 { margin: 0; font-size: 1rem; }
	.lede { margin: 0; font-size: 0.85rem; opacity: 0.88; line-height: 1.55; max-width: 34rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	label span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.check { display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem;
		cursor: pointer; }
	.check input { margin-top: 0.15rem; }
	.check span { font-size: 0.85rem; opacity: 0.9; }
	.check em { display: block; font-style: normal; font-size: 0.78rem; color: var(--text-dim);
		line-height: 1.5; margin-top: 0.15rem; }
	.sub { display: flex; flex-direction: column; gap: 0.6rem; padding-left: 0.8rem;
		border-left: 2px solid var(--border); }
	.est { display: flex; gap: 0.6rem; align-items: flex-start; flex-wrap: wrap; }
	.actions { display: flex; gap: 0.5rem; }
	.actions .primary { flex: 1; }
	.ghost.sm { padding: 0.3rem 0.7rem; font-size: 0.8rem; }
	.note { font-size: 0.78rem; line-height: 1.5; padding: 0.7rem 0.8rem;
		border: 1px solid var(--border); border-left-width: 3px;
		border-left-color: var(--accent); border-radius: 4px; }
	strong { font-weight: 600; }
	code { font-family: var(--font-mono); }
	.primary { padding: 0.55rem; }
	.hint { font-size: 0.8rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	.ok { color: var(--good); font-size: 0.85rem; margin: 0; line-height: 1.5; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; line-height: 1.5; }
</style>
