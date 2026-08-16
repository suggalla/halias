<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { WindowState, SnapZone } from '../wm/types.js';
	import { windowStore } from '../wm/store.js';
	import { drag } from '../wm/drag.js';
	import { resize } from '../wm/resize.js';

	interface Props {
		win: WindowState;
		onSnapPreview?: (zone: SnapZone) => void;
		children: Snippet;
	}

	let { win, onSnapPreview, children }: Props = $props();

	function handleFocus() {
		windowStore.focusWindow(win.id);
	}

	function handleMinimize(e: MouseEvent) {
		e.stopPropagation();
		windowStore.closeWindow(win.id);
	}

	function handleMaximize(e: MouseEvent) {
		e.stopPropagation();
		windowStore.maximizeWindow(win.id);
	}

	function handleClose(e: MouseEvent) {
		e.stopPropagation();
		windowStore.closeWindow(win.id);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="window"
	data-window-id={win.id}
	style="left:{win.rect.x}px;top:{win.rect.y}px;width:{win.rect.w}px;height:{win.rect.h}px;z-index:{win.zIndex}"
	onpointerdown={handleFocus}
>
	<div class="titlebar" use:drag={{ id: win.id, onSnapPreview }}>
		<span class="titlebar-text">{win.title}</span>
		<div class="titlebar-btns">
			<!-- svelte-ignore a11y_consider_explicit_label -->
			<button
				class="window-btn window-minimize"
				onclick={handleMinimize}
				title="Minimize"
			>
				<span class="min-icon"></span>
			</button>
			<!-- svelte-ignore a11y_consider_explicit_label -->
			<button
				class="window-btn window-maximize"
				class:is-maximized={win.maximized}
				onclick={handleMaximize}
				title={win.maximized ? 'Restore' : 'Maximize'}
			>
				{#if win.maximized}
					<span class="restore-icon"></span>
				{:else}
					<span class="max-icon"></span>
				{/if}
			</button>
			<!-- svelte-ignore a11y_consider_explicit_label -->
			<button class="window-btn window-close" onclick={handleClose}>&times;</button>
		</div>
	</div>
	<div class="window-content">
		{@render children()}
	</div>
	{#if win.resizable}
		<div class="resize-handle" use:resize={{ id: win.id }}></div>
	{/if}
</div>

<style>
	.window {
		position: absolute;
		border: 1px solid var(--border);
		background: var(--bg-window);
		box-shadow: 4px 4px 0 var(--shadow);
		display: flex;
		flex-direction: column;
		user-select: none;
	}

	.titlebar {
		height: var(--titlebar-h);
		background: var(--bg-titlebar);
		border-bottom: 1px solid var(--border);
		border-top: 2px solid var(--accent);
		display: flex;
		align-items: center;
		padding: 0 8px;
		cursor: grab;
		flex-shrink: 0;
	}

	.titlebar:active {
		cursor: grabbing;
	}

	.titlebar-text {
		flex: 1;
		font-size: 13px;
		text-transform: uppercase;
		letter-spacing: 1.5px;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.titlebar-btns {
		display: flex;
		gap: 4px;
	}

	.window-btn {
		width: 22px;
		height: 22px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-dim);
		font-size: 15px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
		padding: 0;
	}

	.window-minimize:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.min-icon {
		display: block;
		width: 9px;
		height: 0;
		border-bottom: 1.5px solid currentColor;
	}

	.window-maximize:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.window-maximize.is-maximized {
		border-color: var(--accent);
		color: var(--accent);
	}

	.max-icon {
		display: block;
		width: 9px;
		height: 9px;
		border: 1.5px solid currentColor;
	}

	.restore-icon {
		display: block;
		width: 9px;
		height: 9px;
		border: 1.5px solid currentColor;
		position: relative;
	}

	.restore-icon::after {
		content: '';
		position: absolute;
		top: -3px;
		left: 3px;
		width: 7px;
		height: 7px;
		border: 1.5px solid currentColor;
		border-bottom: none;
		border-left: none;
	}

	.window-close:hover {
		border-color: var(--accent-secondary);
		color: var(--accent-secondary);
	}

	.window-content {
		flex: 1;
		overflow: auto;
		padding: 14px;
	}

	.resize-handle {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 10px;
		height: 10px;
		cursor: nwse-resize;
	}

	.resize-handle::after {
		content: '';
		position: absolute;
		right: 2px;
		bottom: 2px;
		width: 5px;
		height: 5px;
		border-right: 1.5px solid var(--text-dim);
		border-bottom: 1.5px solid var(--text-dim);
	}
</style>
