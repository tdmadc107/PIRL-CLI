/** Languages of the CLI's own text. Agents reply in the language of the user's request whatever this is. */
export const LANGUAGE_IDS = ['vi', 'en'] as const;
export type Language = (typeof LANGUAGE_IDS)[number];

let current: Language = 'vi';

/** Sets the language of the text the CLI writes from now on; text already on screen keeps its language. */
export function setLanguage(language: Language): void {
	current = language;
}

export const currentLanguage = (): Language => current;

/** The CLI's text in the current language, given in Vietnamese and in English. */
export const t = (vi: string, en: string): string => (current === 'en' ? en : vi);

/** The English noun for a count: "1 file", "2 files". Vietnamese nouns do not change with the count. */
export const plural = (count: number, singular: string): string => (count === 1 ? singular : `${singular}s`);
