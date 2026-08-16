import { writable, get } from 'svelte/store';
import type { WindowDef, WindowState, Rect, SnapZone } from './types.js';
import { snapZoneToRect } from './snap.js';

const TASKBAR_H = 42;
const GAP = 4;

function findOpenArea(wins: WindowState[], id: string, minW: number, minH: number): Rect {
	const vw = window.innerWidth;
	const vh = window.innerHeight - TASKBAR_H;
	const others = wins.filter((w) => w.id !== id && w.visible);

	if (others.length === 0) {
		return { x: 0, y: 0, w: vw, h: vh };
	}

	const xs = new Set([0, vw]);
	const ys = new Set([0, vh]);
	for (const o of others) {
		const r = o.rect;
		xs.add(r.x);
		xs.add(r.x + r.w);
		ys.add(r.y);
		ys.add(r.y + r.h);
	}
	const sortedX = [...xs].sort((a, b) => a - b);
	const sortedY = [...ys].sort((a, b) => a - b);

	function overlaps(rect: Rect): boolean {
		for (const o of others) {
			const r = o.rect;
			if (rect.x < r.x + r.w && rect.x + rect.w > r.x &&
				rect.y < r.y + r.h && rect.y + rect.h > r.y) {
				return true;
			}
		}
		return false;
	}

	let bestRect: Rect = { x: 0, y: 0, w: vw, h: vh };
	let bestArea = 0;

	for (let xi1 = 0; xi1 < sortedX.length; xi1++) {
		for (let yi1 = 0; yi1 < sortedY.length; yi1++) {
			for (let xi2 = xi1 + 1; xi2 < sortedX.length; xi2++) {
				for (let yi2 = yi1 + 1; yi2 < sortedY.length; yi2++) {
					const candidate: Rect = {
						x: sortedX[xi1],
						y: sortedY[yi1],
						w: sortedX[xi2] - sortedX[xi1],
						h: sortedY[yi2] - sortedY[yi1]
					};
					if (candidate.w < minW || candidate.h < minH) continue;
					const area = candidate.w * candidate.h;
					if (area <= bestArea) continue;
					if (!overlaps(candidate)) {
						bestArea = area;
						bestRect = candidate;
					}
				}
			}
		}
	}

	// Apply gap insets only against sibling edges, not viewport edges
	const finalRect = { ...bestRect };
	if (finalRect.x > 0) { finalRect.x += GAP; finalRect.w -= GAP; }
	if (finalRect.y > 0) { finalRect.y += GAP; finalRect.h -= GAP; }
	if (finalRect.x + finalRect.w < vw) { finalRect.w -= GAP; }
	if (finalRect.y + finalRect.h < vh) { finalRect.h -= GAP; }

	return finalRect;
}

function createWindowStore() {
	const store = writable<WindowState[]>([]);
	const { subscribe, update } = store;
	let nextZ = 1;

	return {
		subscribe,

		getWindows(): WindowState[] {
			return get(store);
		},

		register(defs: WindowDef[]) {
			const states: WindowState[] = defs.map((def, i) => ({
				id: def.id,
				title: def.title,
				component: def.component,
				rect: { ...def.defaultRect },
				zIndex: i + 1,
				visible: def.visible ?? true,
				maximized: false,
				snapZone: null,
				preSnapRect: null,
				resizable: def.resizable ?? true,
				minW: def.minW ?? 280,
				minH: def.minH ?? 200
			}));
			nextZ = defs.length + 1;
			update(() => states);
		},

		focusWindow(id: string) {
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (win) {
					win.zIndex = ++nextZ;
					win.visible = true;
				}
				return wins;
			});
		},

		closeWindow(id: string) {
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (win) win.visible = false;
				return wins;
			});
		},

		openWindow(id: string) {
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (win) {
					if (!win.visible) {
						// Auto-snap to largest open area
						win.rect = findOpenArea(wins, id, win.minW, win.minH);
					}
					win.visible = true;
					win.zIndex = ++nextZ;
				}
				return wins;
			});
		},

		toggleWindow(id: string) {
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (!win) return wins;
				if (win.visible) {
					win.visible = false;
				} else {
					// Auto-snap to largest open area
					win.rect = findOpenArea(wins, id, win.minW, win.minH);
					win.visible = true;
					win.zIndex = ++nextZ;
				}
				return wins;
			});
		},

		moveWindow(id: string, x: number, y: number) {
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (win) {
					const vw = window.innerWidth;
					const vh = window.innerHeight - TASKBAR_H;
					win.rect.x = Math.max(0, Math.min(x, vw - win.rect.w));
					win.rect.y = Math.max(0, Math.min(y, vh - win.rect.h));
				}
				return wins;
			});
		},

		resizeWindow(id: string, w: number, h: number) {
			update((wins) => {
				const win = wins.find((w2) => w2.id === id);
				if (win) {
					const vw = window.innerWidth;
					const vh = window.innerHeight - TASKBAR_H;
					win.rect.w = Math.min(Math.max(w, win.minW), vw - win.rect.x);
					win.rect.h = Math.min(Math.max(h, win.minH), vh - win.rect.y);
				}
				return wins;
			});
		},

		maximizeWindow(id: string) {
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (!win) return wins;

				if (win.maximized && win.preSnapRect) {
					win.rect = { ...win.preSnapRect };
					win.maximized = false;
					win.preSnapRect = null;
					return wins;
				}

				win.preSnapRect = { ...win.rect };
				win.maximized = true;
				win.zIndex = ++nextZ;
				win.rect = findOpenArea(wins, id, win.minW, win.minH);
				return wins;
			});
		},

		snapWindow(id: string, zone: SnapZone) {
			if (!zone) return;
			const rect = snapZoneToRect(zone, window.innerWidth, window.innerHeight - TASKBAR_H, 0);
			if (!rect) return;
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (win) {
					if (!win.snapZone) {
						win.preSnapRect = { ...win.rect };
					}
					win.snapZone = zone;
					win.maximized = false;
					win.rect = rect;
				}
				return wins;
			});
		},

		unsnapWindow(id: string): Rect | null {
			let restored: Rect | null = null;
			update((wins) => {
				const win = wins.find((w) => w.id === id);
				if (win && (win.snapZone || win.maximized) && win.preSnapRect) {
					restored = { ...win.preSnapRect };
					win.rect = { ...win.preSnapRect };
					win.snapZone = null;
					win.maximized = false;
					win.preSnapRect = null;
				}
				return wins;
			});
			return restored;
		}
	};
}

export const windowStore = createWindowStore();
