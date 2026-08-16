import type { Rect, SnapZone } from './types.js';

const EDGE_THRESHOLD = 12;

export function detectSnapZone(
	pointerX: number,
	pointerY: number,
	viewportW: number,
	viewportH: number
): SnapZone {
	const atLeft = pointerX <= EDGE_THRESHOLD;
	const atRight = pointerX >= viewportW - EDGE_THRESHOLD;
	const atTop = pointerY <= EDGE_THRESHOLD;
	const atBottom = pointerY >= viewportH - EDGE_THRESHOLD;

	if (atTop && atLeft) return 'top-left';
	if (atTop && atRight) return 'top-right';
	if (atBottom && atLeft) return 'bottom-left';
	if (atBottom && atRight) return 'bottom-right';
	if (atTop) return 'maximize';
	if (atLeft) return 'left';
	if (atRight) return 'right';

	return null;
}

export function snapZoneToRect(
	zone: SnapZone,
	viewportW: number,
	viewportH: number,
	taskbarH: number
): Rect | null {
	if (!zone) return null;

	const usableH = viewportH - taskbarH;
	const halfW = Math.floor(viewportW / 2);
	const halfH = Math.floor(usableH / 2);

	switch (zone) {
		case 'maximize':
			return { x: 0, y: 0, w: viewportW, h: usableH };
		case 'left':
			return { x: 0, y: 0, w: halfW, h: usableH };
		case 'right':
			return { x: halfW, y: 0, w: viewportW - halfW, h: usableH };
		case 'top-left':
			return { x: 0, y: 0, w: halfW, h: halfH };
		case 'top-right':
			return { x: halfW, y: 0, w: viewportW - halfW, h: halfH };
		case 'bottom-left':
			return { x: 0, y: halfH, w: halfW, h: usableH - halfH };
		case 'bottom-right':
			return { x: halfW, y: halfH, w: viewportW - halfW, h: usableH - halfH };
		default:
			return null;
	}
}
