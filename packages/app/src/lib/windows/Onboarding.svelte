<script lang="ts">
	import { clientState, connect, setSeedPhrase, newSeedPhrase, hasSeed } from '../sdk/client.js';
	import { wallets, legacyWallet } from '../sdk/wallets.js';

	// Getting in takes two separate things, and conflating them is the whole reason this
	// screen exists rather than a single Connect button.
	//
	//   the phrase  — holds the note keys. Never signs. Never leaves this browser.
	//   the wallet  — broadcasts and pays gas. Never sees the phrase.
	//
	// They used to be one secret: the keys were derived from a signature, so any site that
	// got you to sign one fixed string owned everything. Splitting them is what removed that,
	// and a user who does not understand the split will back up the wrong thing — so the two
	// steps are numbered and named rather than merged into one flow.

	let step = $state<1 | 2>(hasSeed() ? 2 : 1);
	let phrase = $state('');
	let generated = $state(false);
	let error = $state<string | null>(null);
	let revealed = $state(false);

	const connecting = $derived($clientState.status === 'connecting');
	// A wallet from before EIP-6963 announces nothing, so it is offered only when nothing
	// announced — never beside a named wallet, where it would duplicate one of them.
	const legacyOnly = $derived($wallets.length === 0 && !!legacyWallet());

	async function generate() {
		phrase = await newSeedPhrase();
		generated = true;
		revealed = true;
		error = null;
	}

	async function useSeed() {
		try {
			await setSeedPhrase(phrase);
			error = null;
			phrase = '';
			generated = false;
			revealed = false;
			step = 2;
		} catch {
			error = 'That is not a valid recovery phrase — check for typos or missing words.';
		}
	}
</script>

<div class="onboard">
	<ol class="steps">
		<li class:on={step === 1} class:done={step === 2}>
			<span class="num">{step === 2 ? '✓' : '1'}</span>
			<div class="body">
				<h2>Your recovery phrase</h2>
				{#if step === 2}
					<p class="sum">Loaded for this session.</p>
				{:else}
					<p class="say">
						This holds your note keys — your balance and your history. It is
						<strong>not</strong> your Ethereum wallet, and no wallet can recreate it.
					</p>

					<textarea
						bind:value={phrase}
						rows="3"
						spellcheck="false"
						autocomplete="off"
						class:masked={generated && !revealed}
						placeholder="Enter your 24-word phrase, or generate a new one"
					></textarea>

					{#if generated}
						<p class="warn">
							Write this down offline <em>now</em>. Nothing else can recover it, and anyone
							who has it can spend every note you hold.
						</p>
					{/if}
					{#if error}<p class="err">{error}</p>{/if}

					<div class="row">
						<button class="primary" disabled={!phrase.trim()} onclick={useSeed}>Continue</button>
						<button class="ghost" onclick={generate}>Generate new</button>
					</div>

					<p class="note">
						Typed each time for now — encrypted local storage, unlocked by passkey or
						password, is coming.
					</p>
				{/if}
			</div>
		</li>

		<li class:on={step === 2} class:pending={step === 1}>
			<span class="num">2</span>
			<div class="body">
				<h2>Your wallet</h2>
				{#if step === 1}
					<p class="say pending">Broadcasts your transactions and pays gas.</p>
				{:else}
					<p class="say">
						Only broadcasts and pays gas. It never sees the phrase above and cannot spend
						your notes.
					</p>

					{#if $wallets.length > 0}
						<ul class="wlist">
							{#each $wallets as w (w.info.uuid)}
								<li>
									<button class="w" disabled={connecting} onclick={() => connect(w.info.rdns)}>
										<img src={w.info.icon} alt="" width="22" height="22" />
										<span>{w.info.name}</span>
										<span class="go">→</span>
									</button>
								</li>
							{/each}
						</ul>
					{:else if legacyOnly}
						<button class="primary" disabled={connecting} onclick={() => connect()}>
							Connect wallet
						</button>
					{:else}
						<p class="err">
							No wallet detected. Install MetaMask, Rabby, or another EVM wallet, then
							reload.
						</p>
					{/if}

					<button class="back" onclick={() => (step = 1)}>← Use a different phrase</button>
				{/if}
			</div>
		</li>
	</ol>
</div>

<style>
	.onboard { width: 100%; max-width: 34rem; margin: 0 auto; text-align: left; }
	.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.5rem; }
	.steps > li { display: flex; gap: 0.9rem; padding: 1rem; border: 1px solid var(--border);
		border-radius: 10px; background: var(--bg-window);
		transition: border-color 0.15s, opacity 0.15s; }
	.steps > li.on { border-color: var(--accent); }
	.steps > li.pending { opacity: 0.55; }
	.steps > li.done { opacity: 0.8; }

	/* The step number carries the state, so the card does not need a second signal. */
	.num { flex: none; width: 1.6rem; height: 1.6rem; border-radius: 50%;
		display: grid; place-items: center; font-size: 0.8rem; font-weight: 700;
		border: 1px solid var(--border); color: var(--text-dim); }
	.on .num { background: var(--accent); color: var(--bg-dark); border-color: var(--accent); }
	.done .num { color: var(--accent); border-color: var(--accent); }

	.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.55rem; }
	h2 { margin: 0; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.1em;
		color: var(--text-dim); font-weight: 600; }
	.on h2 { color: var(--text-bright); }
	.say { margin: 0; font-size: 0.85rem; line-height: 1.55; color: var(--text); }
	.say.pending, .sum { color: var(--text-dim); font-size: 0.8rem; }
	.sum { margin: 0; }
	.say strong { color: var(--accent-bright); font-weight: 700; }

	textarea { font-family: ui-monospace, monospace; font-size: 0.82rem; line-height: 1.6;
		resize: vertical; }
	/* A freshly generated phrase should not sit legible on screen while someone finds a pen. */
	textarea.masked { -webkit-text-security: disc; }

	.warn { margin: 0; font-size: 0.8rem; line-height: 1.5; color: var(--accent-bright);
		border-left: 2px solid var(--accent); padding-left: 0.6rem; }
	.warn em { font-style: normal; text-decoration: underline; }
	.note { margin: 0; font-size: 0.75rem; color: var(--text-dim); }
	.err { margin: 0; font-size: 0.8rem; color: #ff8a80; }

	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.row .primary { flex: 1; min-width: 8rem; padding: 0.55rem 1rem; }

	.wlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.4rem; }
	.w { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem 0.75rem;
		background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px;
		text-align: left; transition: border-color 0.15s, background 0.15s; }
	.w:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-titlebar); }
	.w img { border-radius: 5px; flex: none; }
	.w .go { margin-left: auto; color: var(--text-dim); }
	.w:hover:not(:disabled) .go { color: var(--accent); }

	.back { align-self: flex-start; font-size: 0.78rem; color: var(--text-dim); padding: 0; }
	.back:hover { color: var(--accent); }
</style>
