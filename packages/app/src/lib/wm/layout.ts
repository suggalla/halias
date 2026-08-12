import type { Rect } from './types.js';

// Default workspace layout.
//
// The desktop metaphor's failure mode is a single small window floating on a large empty
// background — which is what you got, because only Welcome opened and everything else
// started hidden. Windows are still movable; they just start somewhere useful instead of
// requiring the user to assemble a workspace before the app does anything.

const GUTTER = 10;
const TASKBAR = 42;

// Below this the desktop metaphor stops making sense at all and windows are stacked
// full-width instead, which is the closest a floating-window UI gets to a phone layout.
export const NARROW_BREAKPOINT = 900;

export interface Workspace {
	wallet: Rect;
	transact: Rect;
	welcome: Rect;
	narrow: boolean;
}

export function computeWorkspace(vw: number, vh: number): Workspace {
	const h = vh - TASKBAR;
	const narrow = vw < NARROW_BREAKPOINT;

	if (narrow) {
		// One column, each panel sized to its content rather than stretched. The user
		// scrolls the desktop rather than tiling.
		const w = vw - GUTTER * 2;
		let y = GUTTER;
		const stack = (height: number): Rect => {
			const r = { x: GUTTER, y, w, h: height };
			y += height + GUTTER;
			return r;
		};
		return {
			wallet: stack(Math.min(480, h - 260)),
			transact: stack(300),
			welcome: { x: GUTTER, y: GUTTER, w, h: Math.min(440, h - GUTTER * 2) },
			narrow
		};
	}

	// Two columns. Wallet is the home panel and takes the larger share, since it holds
	// the balance, aliases and the note list; Transact is a compact form.
	const fullH  = h - GUTTER * 2;
	const walletW = Math.floor((vw - GUTTER * 3) * 0.58);
	const moveW   = vw - GUTTER * 3 - walletW;

	return {
		wallet: { x: GUTTER, y: GUTTER, w: walletW, h: fullH },
		transact: { x: GUTTER * 2 + walletW, y: GUTTER, w: moveW, h: fullH },
		welcome: {
			x: Math.floor((vw - Math.min(520, vw - 40)) / 2),
			y: Math.floor((h - Math.min(440, h - 40)) / 2),
			w: Math.min(520, vw - 40),
			h: Math.min(440, h - 40)
		},
		narrow
	};
}

// Welcome earns the screen once. After that the workspace is what opens, because a
// returning user wants their balance, not an introduction.
const SEEN_KEY = 'halias.seenWelcome';

export function shouldShowWelcome(): boolean {
	try {
		return localStorage.getItem(SEEN_KEY) === null;
	} catch {
		return true;
	}
}

export function markWelcomeSeen() {
	try {
		localStorage.setItem(SEEN_KEY, '1');
	} catch {
		/* private browsing — showing it again is harmless */
	}
}
