/** Responsive layout rules (proposal 5.7): the layout follows the current columns and rows of the terminal. */
export type WidthTier = 'wide' | 'standard' | 'narrow' | 'tiny';
export type HeightTier = 'full' | 'compact' | 'short';

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 10;

export function widthTier(columns: number): WidthTier {
	if (columns >= 120) return 'wide';
	if (columns >= 80) return 'standard';
	if (columns >= 60) return 'narrow';
	return 'tiny';
}

export function heightTier(rows: number): HeightTier {
	if (rows >= 24) return 'full';
	if (rows >= 16) return 'compact';
	return 'short';
}

export type Layout =
	| {kind: 'too-small'; columns: number; rows: number}
	| {
			kind: 'ok';
			columns: number;
			rows: number;
			width: WidthTier;
			height: HeightTier;
			header: 'full' | 'short' | 'hidden';
			/** Width of the session/run panel on the right; 0 when there is none. */
			sidePanel: number;
			paletteMax: number;
			inputMaxLines: number;
			status: 'full' | 'usage' | 'single';
	  };

export function computeLayout(columns: number, rows: number): Layout {
	if (columns < MIN_COLUMNS || rows < MIN_ROWS) return {kind: 'too-small', columns, rows};
	const width = widthTier(columns);
	const height = heightTier(rows);
	return {
		kind: 'ok',
		columns,
		rows,
		width,
		height,
		header: width === 'tiny' || height === 'short' ? 'hidden' : width === 'narrow' ? 'short' : 'full',
		sidePanel: width === 'wide' ? Math.min(56, Math.max(36, Math.floor(columns / 3))) : 0,
		paletteMax: height === 'full' ? 8 : height === 'compact' ? 5 : 3,
		inputMaxLines: height === 'full' ? 5 : height === 'compact' ? 3 : 2,
		status: width === 'tiny' ? 'single' : width === 'narrow' ? 'usage' : 'full',
	};
}
