<script lang="ts">
	import type { SnapZone } from '../wm/types.js';
	import { windowStore } from '../wm/store.js';
	import { snapZoneToRect } from '../wm/snap.js';
	import Window from './Window.svelte';

	let snapPreviewZone: SnapZone = $state(null);

	function handleSnapPreview(zone: SnapZone) {
		snapPreviewZone = zone;
	}

	let previewRect = $derived.by(() => {
		if (!snapPreviewZone) return null;
		return snapZoneToRect(snapPreviewZone, window.innerWidth, window.innerHeight - 42, 0);
	});
</script>

<div class="desktop">
	{#each $windowStore as win (win.id)}
		{#if win.visible}
			<Window {win} onSnapPreview={handleSnapPreview}>
				<win.component />
			</Window>
		{/if}
	{/each}

	{#if previewRect}
		<div
			class="snap-preview"
			style="left:{previewRect.x}px;top:{previewRect.y}px;width:{previewRect.w}px;height:{previewRect.h}px"
		></div>
	{/if}
</div>

<style>
	.desktop {
		position: fixed;
		top: var(--taskbar-h);
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--bg-desktop);
	}

	.snap-preview {
		position: absolute;
		background: var(--snap-preview);
		border: 1px solid var(--accent);
		border-radius: 2px;
		pointer-events: none;
		z-index: 999998;
		transition: all 0.1s ease-out;
	}
</style>
