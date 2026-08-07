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
	import SendWindow from '$lib/windows/SendWindow.svelte';
	import DepositWindow from '$lib/windows/DepositWindow.svelte';
	import BalanceWindow from '$lib/windows/BalanceWindow.svelte';
	import RegistryWindow from '$lib/windows/RegistryWindow.svelte';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		const ws = computeWorkspace(window.innerWidth, window.innerHeight);
		const firstVisit = shouldShowWelcome();

		// The working panels open by default. Leaving them hidden is what made the desktop
		// look empty — the user had to assemble a workspace before the app did anything.
		windowStore.register([
			{
				id: 'balance',
				title: 'Balance',
				component: BalanceWindow,
				defaultRect: ws.balance,
				visible: true
			},
			{
				id: 'registry',
				title: 'Registry',
				component: RegistryWindow,
				defaultRect: ws.registry,
				visible: true
			},
			{
				id: 'deposit',
				title: 'Deposit',
				component: DepositWindow,
				defaultRect: ws.deposit,
				visible: true
			},
			{
				id: 'send',
				title: 'Send',
				component: SendWindow,
				defaultRect: ws.send,
				visible: true
			},
			{
				id: 'info',
				title: 'Welcome',
				component: InfoWindow,
				defaultRect: ws.welcome,
				visible: firstVisit
			}
		]);

		if (firstVisit) markWelcomeSeen();
	});
</script>

<Taskbar />
<Desktop />
<CrtOverlay />
{@render children()}
