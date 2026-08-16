import type { Action } from 'svelte/action';
import { windowStore } from './store.js';

interface ResizeParams {
	id: string;
}

export const resize: Action<HTMLElement, ResizeParams> = (node, params) => {
	let id = params.id;
	let startX = 0;
	let startY = 0;
	let startW = 0;
	let startH = 0;
	let resizing = false;

	function onPointerDown(e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		node.setPointerCapture(e.pointerId);

		const win = node.closest<HTMLElement>('[data-window-id]');
		if (!win) return;

		startX = e.clientX;
		startY = e.clientY;
		startW = win.offsetWidth;
		startH = win.offsetHeight;
		resizing = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!resizing) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		windowStore.resizeWindow(id, startW + dx, startH + dy);
	}

	function onPointerUp() {
		resizing = false;
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);

	return {
		update(newParams: ResizeParams) {
			id = newParams.id;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
		}
	};
};
