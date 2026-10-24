import type {Key} from 'ink';
import {useRef, useState} from 'react';
import {blank, hanging, type Line} from './lines.js';
import type {Theme} from './theme.js';

/**
 * A panel listing entries the user picks with the arrow keys: Enter opens an entry's details (a Plan file, a
 * record) or acts on it (resuming a run). Rows without `open` or `act` are headings and are skipped.
 */
export type ListEntry = {
	render(active: boolean, columns: number): Line[];
	open?(): ListDetail | null;
	act?(): void;
};

export type ListDetail = {title: string; lines(columns: number): Line[]};

export function useListOverlay() {
	const [selected, setSelected] = useState(0);
	const [detail, setDetailState] = useState<ListDetail | null>(null);
	const [scroll, setScroll] = useState(0);
	const detailRef = useRef<ListDetail | null>(null);
	const maxTopRef = useRef(0);
	const setDetail = (next: ListDetail | null) => {
		detailRef.current = next;
		setDetailState(next);
		setScroll(0);
	};

	const reset = () => {
		setSelected(0);
		setDetail(null);
	};

	const choosable = (entries: ListEntry[]) => entries.map((entry, index) => (entry.open || entry.act ? index : -1)).filter(index => index >= 0);

	/** The panel's lines for a frame whose content is `height` rows, and the first line to show. */
	const view = (entries: ListEntry[], header: Line[], columns: number, height: number, theme: Theme): {lines: Line[]; top: number} => {
		const rows = Math.max(1, height - 2);
		if (detail) {
			const lines = [...hanging([], detail.title, columns, {bold: true, color: 'accent'}), blank, ...detail.lines(columns)];
			maxTopRef.current = Math.max(0, lines.length - rows);
			return {lines, top: Math.min(scroll, maxTopRef.current)};
		}
		const indexes = choosable(entries);
		const current = indexes[Math.min(selected, indexes.length - 1)] ?? -1;
		const lines: Line[] = [...header];
		let focus = 0;
		entries.forEach((entry, index) => {
			if (index === current) focus = lines.length;
			lines.push(...entry.render(index === current, columns));
		});
		void theme;
		maxTopRef.current = Math.max(0, lines.length - rows);
		// Keep the chosen entry in view, with the lines above it when they fit.
		return {lines, top: Math.min(maxTopRef.current, Math.max(0, focus - rows + 3))};
	};

	/** Keys while the panel is open; returns false when Esc on the list closes it. */
	const handleKey = (input: string, key: Key, page: number, entries: ListEntry[]): boolean => {
		const clamp = (top: number) => Math.max(0, Math.min(maxTopRef.current, top));
		if (detailRef.current) {
			if (key.escape) setDetail(null);
			else if (key.upArrow) setScroll(top => clamp(top - 1));
			else if (key.downArrow) setScroll(top => clamp(top + 1));
			else if (key.pageUp) setScroll(top => clamp(top - page));
			else if (key.pageDown) setScroll(top => clamp(top + page));
			return true;
		}
		if (key.escape) return false;
		const indexes = choosable(entries);
		if (indexes.length === 0) return true;
		const at = Math.min(selected, indexes.length - 1);
		if (key.upArrow) setSelected((at - 1 + indexes.length) % indexes.length);
		else if (key.downArrow) setSelected((at + 1) % indexes.length);
		else if (key.pageUp) setSelected(Math.max(0, at - 5));
		else if (key.pageDown) setSelected(Math.min(indexes.length - 1, at + 5));
		else if (key.return) {
			const entry = entries[indexes[at]!]!;
			if (entry.act) entry.act();
			else {
				const opened = entry.open?.();
				if (opened) setDetail(opened);
			}
		}
		void input;
		return true;
	};

	/** Mouse wheel: scrolls the details, or moves the choice on the list. */
	const wheel = (lines: number, entries: ListEntry[]) => {
		if (detailRef.current) {
			setScroll(top => Math.max(0, Math.min(maxTopRef.current, top - lines)));
			return;
		}
		const count = choosable(entries).length;
		if (count === 0) return;
		setSelected(current => Math.max(0, Math.min(count - 1, Math.min(current, count - 1) - Math.sign(lines))));
	};

	const hints = (theme: Theme, action = 'xem'): string[] =>
		detail ? [`${theme.glyphs.upDown} PgUp/PgDn cuộn`, 'Esc quay lại'] : [`${theme.glyphs.upDown} chọn`, `Enter ${action}`, 'Esc đóng'];

	return {reset, view, handleKey, wheel, hints, inDetail: detail !== null};
}
