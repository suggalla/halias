<script lang="ts">
	import { clientState, getClient } from '../sdk/client.js';

	// Guidance where the decision is made, not in a help page nobody opens.
	//
	// Each action leaks something different, and the leak is rarely the amount — it is timing
	// and destination. Saying so at the moment someone is about to withdraw is worth more
	// than a privacy FAQ, because that is when the choice is still open.

	let { mode }: { mode: 'transfer' | 'withdraw' } = $props();

	type Ctx = {
		anonymitySet: number;
		myNotes: number;
		blocksSinceLastNote: number;
		othersSinceLastNote: number;
	};
	let ctx = $state<Ctx | null>(null);
	let loadedFor: string | null = null;

	$effect(() => {
		const key = `${mode}:${$clientState.selected?.aliasHash ?? ''}`;
		if (key === loadedFor || !$clientState.selected || mode !== 'withdraw') {
			if (mode !== 'withdraw') ctx = null;
			return;
		}
		loadedFor = key;
		getClient()
			.privacyContext()
			.then((c: Ctx) => (ctx = c))
			.catch(() => (ctx = null));
	});

	// Deliberately not a score. The inputs are legible; a single number would imply a
	// precision nobody can justify yet.
	const weak = $derived(ctx !== null && (ctx.othersSinceLastNote === 0 || ctx.anonymitySet < 8));
</script>

{#if mode === 'transfer'}
	<aside class="note good">
		<strong>This is the private one.</strong> Nothing leaves the pool, no amount is published,
		and the recipient is proven to be a registered alias without revealing which.
	</aside>
{:else}
	<aside class="note" class:warn={weak}>
		<strong>Withdrawing is where privacy is won or lost.</strong>
		The proof hides which notes you spent, but timing and the destination address are public.
		{#if ctx}
			<ul>
				<li>
					<span>Notes in the pool</span>
					<span class="v">{ctx.anonymitySet}</span>
				</li>
				<li>
					<span>Activity since your last note</span>
					<span class="v">{ctx.othersSinceLastNote}</span>
				</li>
				<li>
					<span>Blocks since your last note</span>
					<span class="v">{ctx.blocksSinceLastNote}</span>
				</li>
			</ul>
			{#if ctx.othersSinceLastNote === 0}
				<p class="advice">
					Nothing has entered the pool since your last note, so a withdrawal now is linkable
					to it by ordering alone. Waiting for other activity costs nothing.
				</p>
			{:else if ctx.anonymitySet < 8}
				<p class="advice">
					The pool is small, so the set you are hiding within is small. This improves on its
					own as others use it.
				</p>
			{/if}
			<p class="advice">
				Withdraw to a fresh address — reusing one links this to everything else it has done.
				A relayer helps too: paying gas from an address of your own ties the two together.
			</p>
		{:else}
			<p class="advice">Reading pool activity…</p>
		{/if}
	</aside>
{/if}

<style>
	.note {
		font-size: 0.78rem;
		line-height: 1.5;
		padding: 0.7rem 0.8rem;
		border: 1px solid var(--border);
		border-left-width: 3px;
		border-radius: 4px;
		opacity: 0.9;
	}
	.note.good { border-left-color: var(--accent); }
	.note.warn { border-left-color: var(--caution); }
	strong { font-weight: 600; }
	ul { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex;
		flex-direction: column; gap: 0.2rem; }
	li { display: flex; justify-content: space-between; gap: 1rem; opacity: 0.88; }
	.v { font-variant-numeric: tabular-nums; }
	.advice { margin: 0.6rem 0 0; opacity: 0.88; }
</style>
