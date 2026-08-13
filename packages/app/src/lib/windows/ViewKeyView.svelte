<script lang="ts">
	import { clientState, getClient } from '../sdk/client.js';

	// Handing someone the ability to read this alias, and nothing else.
	//
	// The spending key is derived separately from the viewing key, so what leaves here cannot
	// authorise a payment — the SDK refuses every spending operation on a client built from
	// one, and the circuit could not produce a proof regardless.
	//
	// It is still a secret, and a worse one than it looks: it exposes the alias's entire
	// payment history permanently, and cannot be revoked. Changing it means registering the
	// alias again under fresh keys. So this screen asks before it reveals, rather than
	// printing the key the moment the action is opened.

	let revealed = $state(false);
	let key = $state('');
	let copied = $state(false);
	let error = $state<string | null>(null);

	const alias = $derived($clientState.selected);
	const label = $derived(alias ? (alias.name ? `${alias.name}.hls` : alias.aliasHash) : '');

	function reveal() {
		try {
			key = getClient().exportViewKey();
			revealed = true;
			error = null;
		} catch (e: any) {
			error = e?.message ?? 'Could not export a view key for this alias';
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(key);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			/* clipboard unavailable; the key is on screen to select by hand */
		}
	}
</script>

<div class="vk">
	{#if !revealed}
		<p class="say">
			A view-only key lets someone read <strong>{label}</strong> — every note it has
			received, what was spent, and the balance — without being able to spend from it.
		</p>
		<ul class="facts">
			<li><span class="y">Can</span> see the balance and the full history of this alias.</li>
			<li><span class="y">Can</span> keep reading it, indefinitely, as new payments arrive.</li>
			<li><span class="n">Cannot</span> spend, withdraw, transfer the name, or sign anything.</li>
			<li><span class="n">Cannot</span> see your other aliases, or derive them.</li>
		</ul>
		<p class="warn">
			Treat it as a secret. It cannot be revoked or changed — the only way to stop someone
			reading this alias is to register a new one and move to it.
		</p>
		<button class="primary" onclick={reveal}>Show the view-only key</button>
	{:else}
		<p class="say">For <strong>{label}</strong>. Anyone with this can read the alias.</p>
		<textarea readonly rows="4" value={key} onfocus={(e) => e.currentTarget.select()}></textarea>
		<div class="row">
			<button class="primary" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
			<button class="ghost" onclick={() => { revealed = false; key = ''; }}>Hide</button>
		</div>
		<p class="hint">
			It begins <code>hvk1</code> and carries a checksum, so a copy that gets cut short is
			rejected rather than quietly finding nothing.
		</p>
	{/if}

	{#if error}<p class="err">{error}</p>{/if}
</div>

<style>
	.vk { display: flex; flex-direction: column; gap: 0.7rem; }
	.say { margin: 0; font-size: 0.85rem; line-height: 1.55; }
	.say strong { font-family: ui-monospace, monospace; color: var(--accent-bright);
		overflow-wrap: anywhere; }
	.facts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column;
		gap: 0.3rem; font-size: 0.82rem; }
	.facts li { display: flex; gap: 0.5rem; align-items: baseline; }
	.y, .n { flex: none; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em;
		font-weight: 700; width: 3.6rem; }
	.y { color: var(--good); }
	.n { color: var(--bad); }
	.warn { font-size: 0.8rem; line-height: 1.5; margin: 0; color: var(--caution);
		border-left: 2px solid var(--caution); padding-left: 0.6rem; }
	textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.72rem;
		line-height: 1.5; resize: vertical; word-break: break-all; }
	.row { display: flex; gap: 0.5rem; }
	.row .primary { flex: 1; padding: 0.55rem; }
	.hint { font-size: 0.78rem; color: var(--text-dim); margin: 0; line-height: 1.5; }
	code { font-family: ui-monospace, monospace; }
	.err { color: var(--bad); font-size: 0.85rem; margin: 0; }
</style>
