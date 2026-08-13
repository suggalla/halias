<script lang="ts">
	import { formatEther } from 'ethers';
	import { clientState, getClient, run, rescan } from '../sdk/client.js';

	// What this alias has done, reconstructed from chain rather than recorded.
	//
	// Nothing on chain says "alice deposited": the pool sees commitments and nullifiers and
	// deliberately learns nothing else. The SDK infers each entry from what it can decrypt
	// and which of its nullifiers were spent, which is why this list exists only for aliases
	// this wallet holds keys for — and why an observer cannot build it.

	type Entry = {
		kind: 'register' | 'deposit' | 'send' | 'receive' | 'withdraw';
		amount: bigint;
		txHash: string;
		blockNumber: number;
		gasFee: bigint;
		feePayer: string;
		relayed: boolean;
		relayerFee: bigint;
	};

	let entries = $state<Entry[]>([]);
	let loaded = $state(false);
	// Which alias the list currently reflects. The effect below reads $clientState, and
	// loading writes to it — without this guard each load retriggers the effect and it
	// spins forever.
	let loadedFor: string | null = null;

	const alias = $derived($clientState.selected);
	const busy = $derived($clientState.status === 'syncing');

	// Reload whenever the selected alias changes — histories do not merge across aliases.
	$effect(() => {
		const current = alias?.aliasHash ?? null;
		if (current === loadedFor) return;   // already showing this alias
		loadedFor = current;

		if (!current) {
			entries = [];
			loaded = false;
			return;
		}
		loaded = false;
		run(() => getClient().history()).then((r) => {
			if (r) entries = r as Entry[];
			loaded = true;
		});
	});

	const VERB: Record<Entry['kind'], string> = {
		register: 'Registered',
		deposit: 'Deposited',
		send: 'Sent',
		receive: 'Received',
		withdraw: 'Withdrew'
	};
	// Two independent facts, not one guessed from the other.
	//
	// `relayed` comes from the chain: a transfer's publicAmount is exactly zero unless a
	// submitter was paid out of the pool, so the SDK can state it rather than infer it. A
	// payer who is not you is a separate observation with its own meaning — most often a
	// third party funding this alias, which is not a relay at all.
	function payerTag(e: Entry): string | null {
		if (e.relayed) {
			return e.relayerFee > 0n ? `relayed · fee ${formatEther(e.relayerFee)} ETH` : 'relayed';
		}
		if (sameAddr(e.feePayer, $clientState.address)) return null;
		if (e.kind === 'deposit') return 'from another wallet';
		return null;
	}

	// Sign as the alias experiences it, not as the pool does.
	const SIGN: Record<Entry['kind'], string> = {
		register: '',
		deposit: '+',
		receive: '+',
		send: '−',
		withdraw: '−'
	};

	function sameAddr(a: string | null, b: string | null) {
		return !!a && !!b && a.toLowerCase() === b.toLowerCase();
	}

	// Scanning is incremental: each refresh decrypts only what arrived since the last cursor,
	// which is what makes reopening the app quick. That is the wrong tool for a cache that is
	// already wrong — one written before a format change, or truncated when the browser
	// reclaimed storage. This throws the cursor away and reads every note again.
	//
	// Manual and clearly labelled because it is slow, and because needing it means something
	// went wrong rather than something being missing.
	let rescanning = $state(false);
	let rescanned = $state(false);

	async function fullRescan() {
		rescanning = true;
		rescanned = false;
		await rescan();
		const r = await run(() => getClient().history());
		if (r) entries = r as Entry[];
		loaded = true;
		rescanning = false;
		rescanned = true;
		setTimeout(() => (rescanned = false), 4000);
	}

	let copied = $state<string | null>(null);
	async function copyTx(hash: string) {
		try {
			await navigator.clipboard.writeText(hash);
			copied = hash;
			setTimeout(() => (copied = copied === hash ? null : copied), 1200);
		} catch {
			/* clipboard unavailable — the title attribute still carries the full hash */
		}
	}
</script>

<div class="history">
	{#if alias}
		<div class="bar">
			<span class="count">
				{loaded ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : 'Reading…'}
			</span>
			<button class="ghost" disabled={busy || rescanning} onclick={fullRescan}>
				{rescanning ? 'Rescanning…' : 'Rescan from scratch'}
			</button>
		</div>
		{#if rescanned}
			<p class="ok">Rescanned — this list is rebuilt from the chain.</p>
		{/if}
	{/if}

	{#if !alias}
		<p class="empty">Choose an alias to see its history.</p>
	{:else if !loaded && busy}
		<p class="empty">Reading the chain…</p>
	{:else if entries.length === 0}
		<p class="empty">Nothing yet. Deposits, transfers and withdrawals will appear here.</p>
	{:else}
		<ul>
			{#each entries as e}
				<li>
					<span class="kind {e.kind}">{VERB[e.kind]}</span>
					<span class="amt">
						{#if e.kind === 'register'}
							<!-- No amount moves, so this column carries the thing the row is actually
							     about: the name that was registered. An em dash said "nothing here",
							     which is true of the value and wrong about the event. -->
							<span class="nm">{alias?.name ? `${alias.name}.hls` : '—'}</span>
						{:else}
							{SIGN[e.kind]}{formatEther(e.amount)} ETH
						{/if}
					</span>
					<span class="blk">block {e.blockNumber}</span>
					<span class="meta">
						gas {formatEther(e.gasFee)} ETH
						{#if e.feePayer}
							· {e.kind === 'deposit' || e.kind === 'receive' ? 'sent by' : 'paid by'}
							<span class="payer" class:other={!sameAddr(e.feePayer, $clientState.address)}>
								{e.feePayer}
							</span>
							{#if payerTag(e)}
								<span class="tag">{payerTag(e)}</span>
							{/if}
						{/if}
					</span>
					<!-- Full hash in the title and on click: a truncated one is useless for
					     looking a transaction up, which is the only reason to show it. -->
					<button class="tx" title={e.txHash} onclick={() => copyTx(e.txHash)}>
						{copied === e.txHash ? 'copied' : e.txHash}
					</button>
				</li>
			{/each}
		</ul>
		<p class="note">
			Only visible to you — reconstructed from notes this alias can decrypt.
		</p>
	{/if}
</div>

<style>
	.history { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.5rem; }
	ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	li { display: grid; grid-template-columns: 6.5rem 1fr auto; gap: 0.35rem 0.75rem;
		align-items: baseline; padding: 0.55rem 0.7rem; background: var(--bg-input);
		border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; }
	.kind { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.88; }
	.kind.deposit, .kind.receive { color: var(--accent); }
	.kind.send, .kind.withdraw { color: #ffb27a; }
	.kind.register { color: #8fb8ff; }
	.amt { font-variant-numeric: tabular-nums; }
	.blk { color: var(--text-dim); font-size: 0.75rem; }
	.meta { grid-column: 1 / -1; font-size: 0.7rem; color: var(--text-dim);
		font-variant-numeric: tabular-nums; }
	.payer { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
	.payer.other { opacity: 1; color: #8fb8ff; }
	.tag { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.07em;
		border: 1px solid currentColor; border-radius: 3px; padding: 0 0.25rem;
		color: #8fb8ff; opacity: 0.9; }
	/* Spans the row: a full hash does not fit beside the rest and is the thing you copy. */
	.tx { grid-column: 1 / -1; color: var(--text-dim); font-size: 0.7rem;
		font-family: ui-monospace, monospace; overflow-wrap: anywhere; text-align: left;
		background: none; border: none; color: inherit; cursor: pointer; padding: 0; }
	.tx:hover { opacity: 0.9; }
	.dim { color: var(--text-dim); }
	.empty, .note { font-size: 0.8rem; color: var(--text-dim); margin: 0; }
	.nm { font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--text-dim);
		overflow-wrap: anywhere; }
	.bar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
		padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
	.count { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.09em;
		color: var(--text-dim); }
	.bar .ghost { margin-left: auto; padding: 0.35rem 0.7rem; font-size: 0.78rem;
		border: 1px solid var(--border); border-radius: 6px; color: var(--text-dim); }
	.bar .ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
	.ok { color: var(--accent); font-size: 0.8rem; margin: 0; }
</style>
