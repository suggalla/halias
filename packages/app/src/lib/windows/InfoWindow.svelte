<script lang="ts">
	// What the app is and what it does not do.
	//
	// Written as answers to the questions someone actually has before trusting this with
	// money — what is public, what is not, what breaks — rather than as a feature list.
	// Anything that overstates the privacy here would be worse than saying nothing.
</script>

<div class="info">
	<h1>halias</h1>
	<p class="lede">
		Named private payments. Register a <code>.hls</code> alias, and every transfer provably
		goes between registered identities — without revealing which ones.
	</p>
	<p class="lede">
		The design goal is legibility. Privacy tools usually ask you to verify a hex string
		character by character and then decline to tell you what they leak; this page is the
		other half of that promise, and the list below is exhaustive rather than reassuring.
	</p>

	<section>
		<h2>What is public</h2>
		<dl>
			<dt>Deposits</dt>
			<dd>
				Amount and sending address, like any transaction — but not the alias being funded.
			</dd>
			<dt>Withdrawals</dt>
			<dd>Amount, destination, and timing.</dd>
			<dt>Registrations</dt>
			<dd>
				The alias hash, its keys, and the address that owns it. The plaintext name is
				published only if you chose to.
			</dd>
		</dl>
	</section>

	<section>
		<h2>What is not</h2>
		<dl>
			<dt>Transfers</dt>
			<dd>
				No amount, no sender, no recipient. The proof shows the recipient is a registered
				alias without revealing which one.
			</dd>
			<dt>Balances</dt>
			<dd>Held as notes only you can decrypt. Nobody can total them, including us.</dd>
			<dt>Your keys</dt>
			<dd>
				Derived in your browser from your recovery phrase — never from your Ethereum
				wallet, which only broadcasts and pays gas. They never leave this browser, and no
				server of ours is involved in anything here.
			</dd>
		</dl>
	</section>

	<section>
		<h2>Where privacy is actually lost</h2>
		<p>
			Rarely the cryptography. Almost always the edges:
		</p>
		<ul>
			<li>
				<strong>Timing.</strong> Withdrawing right after depositing links the two, whatever
				the proof hides.
			</li>
			<li>
				<strong>Address reuse.</strong> Withdrawing to an address that has done other things
				links this to all of them.
			</li>
			<li>
				<strong>Amounts.</strong> Depositing 1.337 and withdrawing 1.337 is a fingerprint.
			</li>
			<li>
				<strong>Paying your own gas.</strong> The address that pays for a withdrawal is
				public and yours. A relayer avoids that.
			</li>
			<li>
				<strong>A small pool.</strong> You hide among the other notes. Fewer notes, less
				hiding.
			</li>
		</ul>
	</section>

	<section>
		<h2>Inviting someone with nothing</h2>
		<p>
			An invite is a code worth an amount you choose. Whoever redeems it registers a name and
			receives the remainder — the invite itself pays the registration fee, so they need no
			funds beyond gas. It is the one path here that does not assume the recipient already
			has something.
		</p>
		<p>
			An invite is a bearer secret: no recipient is bound into it, so anyone holding the code
			can redeem it, once. Send it privately and to one person.
		</p>
	</section>

	<section>
		<h2>Anyone can pay an alias</h2>
		<p>
			Funding a name needs no alias of your own, no balance here, and no prior involvement —
			the proof requires the <em>recipient</em> to be registered, never the sender. So a
			plain wallet can pay <code>bob.hls</code> directly.
		</p>
		<p>
			This is also the cheapest privacy you can buy. The deposit publishes the amount and
			the sending address but not the recipient, so funding your own alias from a wallet
			unconnected to it leaves nothing on chain linking you to the name.
		</p>
	</section>

	<section>
		<h2>Multiple aliases</h2>
		<p>
			Each alias derives its own keys, so balances and histories never merge — but the same
			wallet owns both NFTs, and ownership is public. Aliases held by one wallet can be
			linked by anyone reading the chain. Genuinely separating them means holding them from
			different addresses.
		</p>
	</section>

	<section class="caution">
		<h2>Status</h2>
		<p>
			<strong>Unaudited, and the trusted setup is a single self-generated ceremony.</strong>
			Neither is suitable for real funds. This is testnet software; treat anything here as
			an experiment rather than a wallet.
		</p>
	</section>
</div>

<style>
	.info { display: flex; flex-direction: column; gap: 1.75rem; padding: 0.5rem; }
	h1 { margin: 0; font-size: 1.4rem; font-family: var(--font-mono); }
	.lede { margin: 0; opacity: 0.9; line-height: 1.55; max-width: 34rem; }
	h2 { margin: 0 0 0.6rem; font-size: 0.72rem; text-transform: uppercase;
		letter-spacing: 0.09em; color: var(--text-dim); font-weight: 600; }
	section { border-top: 1px solid var(--border); padding-top: 1rem; }
	dl { margin: 0; display: grid; grid-template-columns: 8rem 1fr; gap: 0.45rem 1rem;
		font-size: 0.85rem; line-height: 1.5; }
	dt { opacity: 0.85; }
	dd { margin: 0; opacity: 0.85; }
	ul { margin: 0.5rem 0 0; padding-left: 1.1rem; display: flex; flex-direction: column;
		gap: 0.4rem; font-size: 0.85rem; line-height: 1.5; opacity: 0.88; }
	p { margin: 0; font-size: 0.85rem; line-height: 1.55; opacity: 0.88; }
	strong { opacity: 1; font-weight: 600; }
	code { font-family: var(--font-mono); opacity: 0.9; }
	.caution { border-top-color: var(--caution); }
	.caution strong { color: var(--caution); }
	@media (max-width: 30rem) {
		dl { grid-template-columns: 1fr; gap: 0.15rem; }
		dt { margin-top: 0.5rem; }
	}
</style>
