<script lang="ts">
	import {
		clientState, connect, connectViewOnly, setSeedPhrase, newSeedPhrase, setViewKey
	} from '../sdk/client.js';
	import { wallets, legacyWallet } from '../sdk/wallets.js';
	import {
		listVault,
		createVault,
		addPasskey,
		unlockWithPassword,
		unlockWithPasskey,
		deleteVault,
		passkeySupported,
		nextLabel,
		type VaultEntry,
		type VaultKind
	} from '../sdk/vault.js';
	// From the seed module, not the package root — see the note in sdk/client.ts. Validating a
	// mnemonic is ethers only; it must not drag the proving stack into the first load.
	import { isValidMnemonic } from 'halias-sdk/seed';

	// Getting in takes two separate things, and conflating them is why this screen exists
	// rather than a single Connect button.
	//
	//   the phrase  — holds the note keys. Never signs. Never leaves this browser.
	//   the wallet  — broadcasts and pays gas. Never sees the phrase.
	//
	// They must never collapse into one. Deriving note keys from a wallet signature would mean
	// any site that got you to sign one fixed string owned everything you hold — so that is a
	// standing prohibition, not a design preference. A user who does not understand the split
	// will back up the wrong thing, which is why the two steps stay numbered and named.
	//
	// The phrase is stored encrypted rather than retyped each session — see vault.ts. The
	// password protects *this browser's copy*; the phrase is what recovers the wallet
	// anywhere, and the wording below has to keep those apart.

	type Stage = 'choose' | 'pick' | 'unlock' | 'phrase' | 'viewkey' | 'protect' | 'wallet';

	// Which path is being walked, which decides how many steps there are.
	//
	// Unlocking a stored wallet is one step before connecting; adding one is two, because the
	// phrase and the password are different things protecting different things. Numbering
	// them together is what made a single step appear to change identity halfway through.
	let mode = $state<'unlock' | 'create'>('create');

	// What is being added, when adding. A full wallet holds a phrase and can spend; a
	// view-only one holds a key that reads a single alias and can do nothing else. They are
	// stored and encrypted identically — a view key exposes an alias's whole history and
	// cannot be revoked, so leaving it in the clear would give away exactly what this protocol
	// is for.
	let kind = $state<VaultKind>('wallet');
	let viewCode = $state('');

	let entries = $state<VaultEntry[]>([]);
	let ready = $state(false);
	let stage = $state<Stage>('choose');
	let selected = $state<VaultEntry | null>(null);

	let phrase = $state('');
	let generated = $state(false);
	let revealed = $state(false);
	let confirmedWritten = $state(false);

	// Pre-filled rather than required, and doubles as the account name a password manager
	// saves against.
	//
	// One wallet needs no name — "Halias Wallet 1" says everything true about it, and
	// demanding one there is a field filled in for nothing. Several wallets need a name badly,
	// and that is not an edge case here: the point of holding a second is that it is not
	// linkable to the first, which "Halias Wallet 2" describes about as well as "the other
	// one". So it arrives with a default in it and is skipped by ignoring it.
	let label = $state('');
	let password = $state('');
	let password2 = $state('');
	let wantPasskey = $state(passkeySupported());
	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const connecting = $derived($clientState.status === 'connecting');
	const legacyOnly = $derived($wallets.length === 0 && !!legacyWallet());
	const canPasskey = passkeySupported();

	$effect(() => {
		listVault().then((e) => {
			entries = e;
			ready = true;
			if (stage !== 'choose') return;
			if (e.length > 0) {
				mode = 'unlock';
				selected = e[0];
				stage = 'unlock';
			} else {
				stage = 'pick';
			}
		});
	});

	/// Leave the saved wallets and add another.
	function startCreate() {
		mode = 'create';
		stage = 'pick';
		error = null;
		phrase = '';
		viewCode = '';
		label = '';
	}

	function pick(k: VaultKind) {
		kind = k;
		error = null;
		stage = k === 'wallet' ? 'phrase' : 'viewkey';
	}

	/// Accept a view key and move on to protecting it.
	async function toProtectView() {
		try {
			const { decodeViewKey } = await import('halias-sdk');
			decodeViewKey(viewCode);
		} catch (e: any) {
			error = e?.message ?? 'That is not a valid view-only key';
			return;
		}
		error = null;
		if (!label.trim()) label = nextLabel(entries, 'view');
		stage = 'protect';
	}

	async function refreshEntries() {
		entries = await listVault();
	}

	// ── unlock an existing wallet ──────────────────────────────────────────────

	async function useSecret(entry: VaultEntry, secret: string) {
		if (entry.kind === 'view') {
			await setViewKey(secret, entry.label);
			await connectViewOnly();   // a viewer needs no wallet, so this is the whole flow
		} else {
			await setSeedPhrase(secret, entry.label);
			stage = 'wallet';
		}
	}

	async function unlockPasskey(entry: VaultEntry) {
		busy = true;
		error = null;
		try {
			await useSecret(entry, await unlockWithPasskey(entry.id));
		} catch (e: any) {
			error = e?.message?.includes('dismissed')
				? 'Passkey prompt was dismissed.'
				: 'That passkey could not unlock this wallet — use your password instead.';
		}
		busy = false;
	}

	async function unlockPassword(entry: VaultEntry) {
		// Checked here rather than by disabling the button. A greyed-out "Unlock with password"
		// is the first thing on the screen and it reads as broken — it says the action is
		// unavailable without saying why, and the reason is only that a field above it is
		// empty. Enabled and answering is clearer than disabled and silent.
		if (!password) return (error = 'Enter your password.');
		busy = true;
		error = null;
		try {
			await useSecret(entry, await unlockWithPassword(entry.id, password));
			password = '';
		} catch (e: any) {
			error = /view|checksum/i.test(e?.message ?? '') ? e.message : 'Wrong password.';
		}
		busy = false;
	}

	async function forget(entry: VaultEntry) {
		if (!confirm(`Remove ${entry.label} from this browser? Only your recovery phrase can bring it back.`))
			return;
		await deleteVault(entry.id);
		await refreshEntries();
		selected = entries[0] ?? null;
		// Removing the last one leaves nothing to unlock. The effect that chose this path has
		// already run and will not run again, so without this the screen sits on an unlock step
		// with no wallet in it — a dead end reachable by a button we put there.
		if (!selected) startCreate();
	}

	// ── add a new one ──────────────────────────────────────────────────────────

	async function generate() {
		phrase = await newSeedPhrase();
		generated = true;
		revealed = true;
		confirmedWritten = false;
		error = null;
	}

	function toProtect() {
		if (!isValidMnemonic(phrase)) {
			error = 'That is not a valid recovery phrase — check for typos or missing words.';
			return;
		}
		if (generated && !confirmedWritten) {
			error = 'Confirm you have written the phrase down first.';
			return;
		}
		error = null;
		if (!label.trim()) label = nextLabel(entries);
		stage = 'protect';
	}

	async function saveAndUnlock() {
		if (password.length < 8) return (error = 'Use at least 8 characters.');
		if (password !== password2) return (error = 'The two passwords do not match.');
		busy = true;
		error = null;
		try {
			const chosen = label.trim() || nextLabel(entries, kind);
			const secret = kind === 'view' ? viewCode.trim() : phrase;
			const id = await createVault(secret, password, chosen, kind);
			if (wantPasskey && canPasskey) {
				try {
					await addPasskey(id, password);
				} catch (e: any) {
					// The wallet is already saved and openable by password; a passkey that could
					// not be created is a missing convenience, not a failure worth discarding it.
					notice = `Saved, but the passkey could not be added: ${e?.message ?? 'dismissed'}. You can still unlock with your password.`;
				}
			}
			await refreshEntries();
			if (kind === 'view') {
				await setViewKey(secret, chosen);
				viewCode = '';
				password = '';
				password2 = '';
				await connectViewOnly();
			} else {
				await setSeedPhrase(phrase, chosen);
				phrase = '';
				password = '';
				password2 = '';
				generated = false;
				stage = 'wallet';
			}
		} catch (e: any) {
			error = e?.message ?? 'Could not save this wallet.';
		}
		busy = false;
	}
</script>
<div class="onboard">
	<ol class="steps">
		{#if !ready}
			<li class="on">
				<span class="num">1</span>
				<div class="body"><p class="say pending">Checking this browser…</p></div>
			</li>

		{:else if mode === 'unlock'}
			<!-- Unlocking is one step, not two. There is nothing to protect that is not already
			     protected, so numbering a second step here would count an action nobody takes. -->
			<li class:on={stage === 'unlock'} class:done={stage === 'wallet'}>
				<span class="num">{stage === 'wallet' ? '✓' : '1'}</span>
				<div class="body">
					<h2>Unlock your wallet</h2>

					{#if stage === 'wallet'}
						<p class="sum">Unlocked.</p>
					{:else if selected}
						<!-- Naming one entry only works when there is one. With several stored, this
						     said "Halias Wallet 1 is stored on this browser" directly above a list
						     of three, which reads as though the sentence and the list disagree.
						     "These" points at the list instead, and needs no count and no noun —
						     entries are wallets or view keys, and the two carry different labels. -->
						{#if entries.length > 1}
							<p class="say">
								These are stored on this browser, encrypted. Choose one to unlock.
							</p>
						{:else}
							<p class="say">
								<strong>{selected.label}</strong> is stored on this browser, encrypted.
								{selected.kind === 'view'
									? 'It reads one alias and cannot spend from it.'
									: 'Unlock it to continue.'}
							</p>
						{/if}

						{#if entries.length > 1}
							<!-- A list, not a tab strip. These are separate stored secrets of two
							     different kinds, not views of one thing, and a row has room to say
							     which kind each is — which a tab label cannot. -->
							<ul class="stored">
								{#each entries as e (e.id)}
									<li>
										<button
											class="entry"
											class:on={selected?.id === e.id}
											aria-current={selected?.id === e.id}
											onclick={() => { selected = e; error = null; password = ''; }}
										>
											<span class="en">{e.label}</span>
											<span class="ek">
												{e.kind === 'view' ? 'Reads one alias' : 'Recovery phrase'}
												{e.hasPasskey ? ' · passkey' : ''}
											</span>
										</button>
									</li>
								{/each}
							</ul>
							{#if selected.kind === 'view'}
								<!-- Carried over from the single-entry sentence above. The row says
								     "Reads one alias"; that it cannot spend is the part worth stating
								     in full before someone unlocks it expecting a wallet. -->
								<p class="sum">
									<strong>{selected.label}</strong> reads one alias and cannot spend from it.
								</p>
							{/if}
						{/if}

						{#if selected.hasPasskey}
							<button class="primary" disabled={busy} onclick={() => unlockPasskey(selected!)}>
								{busy ? 'Waiting…' : 'Unlock with passkey'}
							</button>
							<p class="or">or</p>
						{/if}

						<!-- A real form with an account-name field, so a password manager can keep one
						     password per wallet instead of offering the same one for all of them. A saved
						     credential is keyed on that field; with only a password there is nothing to
						     key on, and the second wallet silently overwrites the first's entry.
						     Readonly and visible rather than hidden — hidden ones are widely ignored, and
						     it doubles as saying which wallet is about to open.
						     `autocomplete="username"` is the spec's token for this field and has to stay
						     that literal string; only what the reader sees is an account name. -->
						<form onsubmit={(e) => { e.preventDefault(); unlockPassword(selected!); }}>
							<label>
								<span>Account name</span>
								<input value={selected.label} readonly autocomplete="username" name="username" />
							</label>
							<label>
								<span>Password</span>
								<input type="password" bind:value={password} autocomplete="current-password"
									name="password" disabled={busy} />
							</label>
							<button class="ghost" type="submit" disabled={busy}>
								{busy ? 'Unlocking…' : 'Unlock with password'}
							</button>
						</form>

						{#if error}<p class="err">{error}</p>{/if}

						<!-- Second divider, matching the passkey/password one above. Without it the two
						     buttons below sit flush against the unlock form and read as part of it, when
						     they are in fact the alternatives to unlocking this wallet at all. -->
						<p class="or">or</p>

						<!-- The way to the mode picker for anyone who already has something stored. The
						     label names both halves: this adds a full wallet *or* a view-only key, and a
						     label mentioning only the phrase would hide the second entirely. -->
						<!-- Outlined rather than bare text: these two are the only actions on this card
						     besides unlocking, and as 0.78rem links they read as footnotes to the form
						     above rather than as things you can do. -->
						<div class="alt">
							<button class="ghost" onclick={startCreate}>+ Add a wallet or view-only key</button>
							<button class="ghost danger" onclick={() => forget(selected!)}>
								Remove {selected.label} from this browser
							</button>
						</div>
					{/if}
				</div>
			</li>

		{:else}
			<!-- Creating is two: the phrase is the wallet and exists whatever this device does
			     with it; the password only protects the copy kept here. Collapsing them into one
			     step is what made the form appear to change identity halfway through. -->
			<li class:on={stage === 'pick' || stage === 'phrase' || stage === 'viewkey'}
				class:done={stage === 'protect' || stage === 'wallet'}>
				<span class="num">{stage === 'protect' || stage === 'wallet' ? '✓' : '1'}</span>
				<div class="body">
					<h2>
						{stage === 'pick' ? 'What you are adding'
							: kind === 'view' ? 'Your view-only key'
							: 'Your recovery phrase'}
					</h2>

					{#if stage === 'pick'}
						<!-- The choice that decides everything after it: one of these can spend and
						     the other is structurally unable to. Asked once, up front, rather than
						     discovered when an action turns out to be missing. -->
						<p class="say">What are you setting up?</p>
						<ul class="kinds">
							<li>
								<button class="action" onclick={() => pick('wallet')}>
									<span class="an">Full wallet</span>
									<span class="ab">
										A recovery phrase. Registers names, receives, and spends. Every alias you
										hold derives from it.
									</span>
								</button>
							</li>
							<li>
								<button class="action" onclick={() => pick('view')}>
									<span class="an">View-only</span>
									<span class="ab">
										A key someone shared with you. Reads one alias — its balance and its whole
										history — and cannot spend, or reach any other alias.
									</span>
								</button>
							</li>
						</ul>
						{#if entries.length > 0}
							<button class="link" onclick={() => { mode = 'unlock'; stage = 'unlock'; error = null; }}>
								← Back to saved wallets
							</button>
						{/if}

					{:else if stage === 'viewkey'}
						<p class="say">
							Paste the view-only key you were given. It reads one alias and cannot spend
							from it — and it is still a secret: it exposes that alias's entire history.
						</p>
						<textarea
							bind:value={viewCode}
							rows="3"
							spellcheck="false"
							autocomplete="off"
							placeholder="hvk1…"
						></textarea>
						{#if error}<p class="err">{error}</p>{/if}
						<div class="row">
							<button class="primary" disabled={!viewCode.trim()} onclick={toProtectView}>
								Continue
							</button>
							<button class="ghost" onclick={() => (stage = 'pick')}>Back</button>
						</div>

					{:else if stage !== 'phrase'}
						<p class="sum">Held for this session.</p>
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
							<label class="check">
								<input type="checkbox" bind:checked={confirmedWritten} />
								<span>I have written it down</span>
							</label>
							<button class="link" onclick={() => (revealed = !revealed)}>
								{revealed ? 'Hide' : 'Show'} phrase
							</button>
						{/if}

						{#if error}<p class="err">{error}</p>{/if}

						<div class="row">
							<button class="primary" disabled={!phrase.trim()} onclick={toProtect}>Continue</button>
							<button class="ghost" onclick={generate}>Generate new</button>
						</div>

						{#if entries.length > 0}
							<button class="link" onclick={() => { mode = 'unlock'; stage = 'unlock'; error = null; }}>
								← Back to saved wallets
							</button>
						{/if}
					{/if}
				</div>
			</li>

			<li class:on={stage === 'protect'} class:done={stage === 'wallet'}
				class:pending={stage === 'phrase'}>
				<span class="num">{stage === 'wallet' ? '✓' : '2'}</span>
				<div class="body">
					<h2>Protect it on this device</h2>

					{#if stage === 'pick' || stage === 'phrase' || stage === 'viewkey'}
						<p class="say pending">
							A password, so you do not retype {kind === 'view' ? 'the key' : 'the phrase'}
							every time.
						</p>
					{:else if stage === 'wallet'}
						<p class="sum">Saved and encrypted.</p>
					{:else}
						<p class="say">
							Choose a password. It encrypts <strong>this browser's copy</strong>.
							{#if kind === 'view'}
								A view key cannot be recovered if you lose it — ask whoever shared it for
								another.
							{:else}
								It is not your recovery phrase, and it cannot recover the wallet anywhere
								else.
							{/if}
						</p>
						<!-- The account name is what a password manager saves this password against,
						     which lets it hold one password per wallet rather than offering the first
						     wallet's for all of them. -->
						<form onsubmit={(e) => { e.preventDefault(); saveAndUnlock(); }}>
							<label>
								<span>Account name</span>
								<input bind:value={label} maxlength="40" autocomplete="username" name="username"
									disabled={busy} placeholder={nextLabel(entries)} />
							</label>
							<p class="note">
								Tells wallets apart on this device, in your passkey list, and in your password
								manager. Not a secret, and not part of any key.
							</p>
							<label>
								<span>Password</span>
								<input type="password" bind:value={password} autocomplete="new-password"
									name="new-password" disabled={busy} />
							</label>
							<label>
								<span>Confirm password</span>
								<input type="password" bind:value={password2} autocomplete="new-password"
									disabled={busy} />
							</label>

							{#if canPasskey}
								<label class="check">
									<input type="checkbox" bind:checked={wantPasskey} disabled={busy} />
									<span>
										Also add a passkey
										<em>Unlock with your fingerprint or face next time. The password keeps
											working — some devices cannot use a passkey.</em>
									</span>
								</label>
							{/if}

							{#if error}<p class="err">{error}</p>{/if}
							<div class="row">
								<button class="ghost" type="button" disabled={busy}
									onclick={() => (stage = 'phrase')}>Back</button>
								<button class="primary" type="submit" disabled={busy}>
									{busy ? 'Encrypting…' : 'Save and continue'}
								</button>
							</div>
						</form>
					{/if}
				</div>
			</li>
		{/if}

		{#if !(mode === 'create' && kind === 'view')}
		<li class:on={stage === 'wallet'} class:pending={stage !== 'wallet'}>
			<span class="num">{mode === 'unlock' ? '2' : '3'}</span>
			<div class="body">
				<h2>Your wallet</h2>
				{#if stage !== 'wallet'}
					<p class="say pending">Broadcasts your transactions and pays gas.</p>
				{:else}
					<p class="say">
						Only broadcasts and pays gas. It never sees your phrase and cannot spend your
						notes.
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
							No wallet detected. Install MetaMask, Rabby, or another EVM wallet, then reload.
						</p>
					{/if}
				{/if}
			</div>
		</li>
		{/if}
	</ol>

	{#if notice}<p class="warn notice">{notice}</p>{/if}
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
	/* Sits under the list rather than inside a step, since it reports on the whole setup. */
	.notice { margin-top: 0.6rem; }
	.say strong { color: var(--accent-bright); font-weight: 700; }

	/* The forms wrap what .body used to lay out directly, so they carry the same column. */
	form { display: flex; flex-direction: column; gap: 0.55rem; }
	label { display: flex; flex-direction: column; gap: 0.25rem; }
	input[readonly] { cursor: default; }
	label > span { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
		color: var(--text-dim); }
	.check { flex-direction: row; align-items: flex-start; gap: 0.5rem; cursor: pointer; }
	.check input { margin-top: 0.2rem; width: auto; }
	.check > span { text-transform: none; letter-spacing: 0; font-size: 0.82rem;
		color: var(--text); }
	.check em { display: block; font-style: normal; font-size: 0.76rem; color: var(--text-dim);
		margin-top: 0.15rem; }

	textarea { font-family: var(--font-mono); font-size: 0.82rem; line-height: 1.6;
		resize: vertical; }
	/* A freshly generated phrase should not sit legible on screen while someone finds a pen. */
	textarea.masked { -webkit-text-security: disc; }

	.warn { margin: 0; font-size: 0.8rem; line-height: 1.5; color: var(--caution);
		border-left: 2px solid var(--caution); padding-left: 0.6rem; }
	.warn em { font-style: normal; text-decoration: underline; }
	.err { margin: 0; font-size: 0.8rem; color: var(--bad); }
	.or { margin: 0; text-align: center; font-size: 0.72rem; color: var(--text-dim);
		text-transform: uppercase; letter-spacing: 0.1em; }

	.stored { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.35rem; }
	.entry { width: 100%; display: flex; flex-direction: column; gap: 0.1rem;
		padding: 0.55rem 0.7rem; background: var(--bg-input);
		border: 1px solid var(--border); border-radius: 8px; text-align: left;
		transition: border-color 0.15s, background 0.15s; }
	.entry:hover { border-color: var(--accent); }
	.entry.on { border-color: var(--accent); background: var(--bg-titlebar); }
	.en { font-size: 0.85rem; font-weight: 700; color: var(--text-bright); }
	.ek { font-size: 0.72rem; color: var(--text-dim); }
	.kinds { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.45rem; }
	.action { width: 100%; display: flex; flex-direction: column; gap: 0.2rem;
		padding: 0.75rem 0.85rem; background: var(--bg-input);
		border: 1px solid var(--border); border-radius: 8px; text-align: left;
		transition: border-color 0.15s, background 0.15s; }
	.action:hover { border-color: var(--accent); background: var(--bg-titlebar); }
	.an { font-size: 0.9rem; font-weight: 700; color: var(--text-bright); }
	.ab { font-size: 0.76rem; color: var(--text-dim); line-height: 1.45; }
	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.row .primary { flex: 1; min-width: 8rem; padding: 0.55rem 1rem; }
	/* Stacked full-width rather than a left-packed row. Everything above these — both inputs
	   and the unlock button — stretches edge to edge, because .body and form are column flex
	   containers. Content-width buttons under that left a ragged right edge, which is what
	   made the alignment look wrong; centring them would have broken the left axis the whole
	   card is set on instead of fixing it. */
	.alt { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.4rem; }
	.alt .ghost { font-size: 0.82rem; width: 100%; }
	.ghost.danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); }
	.link { font-size: 0.78rem; color: var(--text-dim); padding: 0; align-self: flex-start; }
	.link:hover { color: var(--accent); }

	.wlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
		gap: 0.4rem; }
	.w { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem 0.75rem;
		background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px;
		text-align: left; transition: border-color 0.15s, background 0.15s; }
	.w:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-titlebar); }
	.w img { border-radius: 5px; flex: none; }
	.w .go { margin-left: auto; color: var(--text-dim); }
	.w:hover:not(:disabled) .go { color: var(--accent); }
</style>
