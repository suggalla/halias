<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { windowStore } from '$lib/wm/store.js';
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
		const vw = window.innerWidth;
		const vh = window.innerHeight - 42; // minus taskbar

		// Welcome centered
		const infoW = Math.min(480, vw - 40);
		const infoH = Math.min(460, vh - 40);
		const infoX = Math.floor((vw - infoW) / 2);
		const infoY = Math.floor((vh - infoH) / 2);

		windowStore.register([
			{
				id: 'info',
				title: 'Welcome',
				component: InfoWindow,
				defaultRect: { x: infoX, y: infoY, w: infoW, h: infoH },
				visible: true
			},
			{
				id: 'send',
				title: 'Send',
				component: SendWindow,
				defaultRect: { x: 0, y: 0, w: 380, h: 300 },
				visible: false
			},
			{
				id: 'deposit',
				title: 'Deposit',
				component: DepositWindow,
				defaultRect: { x: 0, y: 0, w: 380, h: 260 },
				visible: false
			},
			{
				id: 'balance',
				title: 'Balance',
				component: BalanceWindow,
				defaultRect: { x: 0, y: 0, w: 380, h: 320 },
				visible: false
			},
			{
				id: 'registry',
				title: 'Registry',
				component: RegistryWindow,
				defaultRect: { x: 0, y: 0, w: 380, h: 280 },
				visible: false
			}
		]);
	});
</script>

<Taskbar />
<Desktop />
<CrtOverlay />
{@render children()}
