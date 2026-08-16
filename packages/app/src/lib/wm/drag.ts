import type { Action } from 'svelte/action';
import type { SnapZone } from './types.js';
import { windowStore } from './store.js';
import { detectSnapZone } from './snap.js';

const SNAP_THRESHOLD = 20;

interface DragParams {
	id: string;
	onSnapPreview?: (zone: SnapZone) => void;
}

export const drag: Action<HTMLElement, DragParams> = (node, params) => {
	let id = params.id;
	let onSnapPreview = params.onSnapPreview;
	let startX = 0;
	let startY = 0;
	let startRectX = 0;
	let startRectY = 0;
	let winW = 0;
	let winH = 0;
	let dragging = false;
	let wasSnapped = false;
	let snapRatioX = 0.5;

	function onPointerDown(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('.window-btn')) return;
		e.preventDefault();
		node.setPointerCapture(e.pointerId);

		const winEl = node.closest<HTMLElement>('[data-window-id]');
		const rect = winEl?.getBoundingClientRect();
		if (!rect) return;

		// Desktop starts below the taskbar
		const desktopTop = 42;

		const restored = windowStore.unsnapWindow(id);
		if (restored) {
			wasSnapped = true;
			snapRatioX = (e.clientX - rect.left) / rect.width;
			startRectX = e.clientX - restored.w * snapRatioX;
			startRectY = e.clientY - desktopTop - 14;
			winW = restored.w;
			winH = restored.h;
		} else {
			startRectX = rect.left;
			startRectY = rect.top - desktopTop;
			winW = rect.width;
			winH = rect.height;
		}

		startX = e.clientX;
		startY = e.clientY;
		dragging = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;

		const vw = window.innerWidth;
		const vh = window.innerHeight - 42; // taskbar height

		// Raw position clamped to desktop area
		let newX = Math.max(0, Math.min(startRectX + dx, vw - winW));
		let newY = Math.max(0, Math.min(startRectY + dy, vh - winH));

		// Magnetic snapping to sibling window edges
		const siblings = windowStore.getWindows().filter((w) => w.id !== id && w.visible);

		// Collect all snap lines: viewport edges + sibling edges
		const snapXLines: number[] = [0, vw];
		const snapYLines: number[] = [0, vh];
		for (const s of siblings) {
			const r = s.rect;
			snapXLines.push(r.x, r.x + r.w);
			snapYLines.push(r.y, r.y + r.h);
		}

		// Snap left edge and right edge of dragged window
		let snappedX = false;
		for (const line of snapXLines) {
			if (!snappedX && Math.abs(newX - line) < SNAP_THRESHOLD) {
				newX = line;
				snappedX = true;
			}
			if (!snappedX && Math.abs(newX + winW - line) < SNAP_THRESHOLD) {
				newX = line - winW;
				snappedX = true;
			}
		}

		// Snap top edge and bottom edge
		let snappedY = false;
		for (const line of snapYLines) {
			if (!snappedY && Math.abs(newY - line) < SNAP_THRESHOLD) {
				newY = line;
				snappedY = true;
			}
			if (!snappedY && Math.abs(newY + winH - line) < SNAP_THRESHOLD) {
				newY = line - winH;
				snappedY = true;
			}
		}

		// Re-clamp after snapping
		newX = Math.max(0, Math.min(newX, vw - winW));
		newY = Math.max(0, Math.min(newY, vh - winH));

		windowStore.moveWindow(id, newX, newY);

		// Detect snap zones using desktop-relative Y
		const pointerDesktopY = e.clientY - 42;
		const zone = detectSnapZone(e.clientX, pointerDesktopY, vw, vh);
		onSnapPreview?.(zone);
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		wasSnapped = false;

		const vh = window.innerHeight - 42;
		const pointerDesktopY = e.clientY - 42;
		const zone = detectSnapZone(e.clientX, pointerDesktopY, window.innerWidth, vh);
		if (zone) {
			windowStore.snapWindow(id, zone);
		}
		onSnapPreview?.(null);
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);

	return {
		update(newParams: DragParams) {
			id = newParams.id;
			onSnapPreview = newParams.onSnapPreview;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
		}
	};
};
