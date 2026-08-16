import type { Component } from 'svelte';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type SnapZone = 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'maximize' | null;

export interface WindowDef {
	id: string;
	title: string;
	component: Component;
	defaultRect: Rect;
	resizable?: boolean;
	visible?: boolean;
	minW?: number;
	minH?: number;
}

export interface WindowState {
	id: string;
	title: string;
	component: Component;
	rect: Rect;
	zIndex: number;
	visible: boolean;
	maximized: boolean;
	snapZone: SnapZone;
	preSnapRect: Rect | null;
	resizable: boolean;
	minW: number;
	minH: number;
}
