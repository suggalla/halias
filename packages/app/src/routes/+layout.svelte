<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { windowStore } from '$lib/wm/store.js';
	import { computeWorkspace, shouldShowWelcome, markWelcomeSeen } from '$lib/wm/layout.js';
	import Desktop from '$lib/components/Desktop.svelte';
	import Taskbar from '$lib/components/Taskbar.svelte';
	import CrtOverlay from '$lib/components/CrtOverlay.svelte';
	import InfoWindow from '$lib/windows/InfoWindow.svelte';
	import WalletWindow from '$lib/windows/WalletWindow.svelte';
	import MoveWindow from '$lib/windows/MoveWindow.svelte';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		const ws = computeWorkspace(window.innerWidth, window.innerHeight);
		const firstVisit = shouldShowWelcome();

		// The working panels open by default. Leaving them hidden is what made the desktop
		// look empty — the user had to assemble a workspace before the app did anything.
		// Welcome is registered first so it gets the lowest z-index. Registering it last
		// put it on top of the whole workspace, which is why nothing else was visible.
		windowStore.register([
			{
				id: 'info',
				title: 'Welcome',
				component: InfoWindow,
				defaultRect: ws.welcome,
				visible: firstVisit
			},
			{
				id: 'wallet',
				title: 'Wallet',
				component: WalletWindow,
				defaultRect: ws.wallet,
				visible: true
			},
			{
				id: 'move',
				title: 'Move',
				component: MoveWindow,
				defaultRect: ws.move,
				visible: true
			}
		]);

		if (firstVisit) markWelcomeSeen();
	});
</script>

<Taskbar />
<Desktop />
<CrtOverlay />
{@render children()}
