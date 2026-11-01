// Syllables per line and a bar estimate from the BPM, for the note editor
// (NOVEMBER-PLAN B3.2). Heuristics, not a dictionary: vowel groups, minus
// the silent endings English and French have. Good to a syllable or so per
// line, which is what writing to a beat needs.

export type LyricsLang = "en" | "fr";

/** [Verse 1], [Hook], (Refrain)… on a line of their own. */
export const isHeader = (line: string): boolean => /^\s*[[(][^\])]{1,40}[\])]\s*$/.test(line);

const FR_VOWELS = "aeiouyàâäéèêëîïôöùûüÿœæ";
const FR_MARKERS = /[àâçéèêëîïôûùœ]|\b(je|tu|nous|vous|les|des|est|dans|pour|avec|pas|mais|qui|que|une|sur|moi|toi|c'est|j'|l'|d')\b/i;

/** French when the text looks French (accents or common words), else English. */
export function guessLang(text: string): LyricsLang {
  const hits = text.match(new RegExp(FR_MARKERS.source, "gi"))?.length ?? 0;
  return hits >= 2 || (hits === 1 && text.length < 80) ? "fr" : "en";
}

function countEn(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Silent endings: "make", "named", "takes" (but not "little", "wanted").
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]e)$/, (m) => m.slice(0, 1)).replace(/(?<=[^dt])ed$/, "d");
  w = w.replace(/^y/, "");
  const groups = w.match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups);
}

function countFr(word: string): number {
  let w = word.toLowerCase().replace(new RegExp(`[^a-z${FR_VOWELS}]`, "g"), "");
  if (!w) return 0;
  // A final mute e / es after a consonant ("monde", "rues" stays 1), when
  // the word has another vowel ("je", "le" keep theirs).
  const stripped = w.replace(/(?<=[^aeiouy])es?$/, "");
  if (new RegExp(`[${FR_VOWELS}]`).test(stripped)) w = stripped;
  const groups = w.match(new RegExp(`[${FR_VOWELS}]+`, "g"))?.length ?? 0;
  return Math.max(1, groups);
}

/** Syllables in one line (0 for a header or an empty line). */
export function lineSyllables(line: string, lang: LyricsLang): number {
  if (isHeader(line)) return 0;
  // French elision: "l'amour", "j'ai" are one word.
  const words = line.split(/[\s\-–—/]+/).filter(Boolean);
  const count = lang === "fr" ? countFr : countEn;
  return words.reduce((n, w) => n + count(w), 0);
}

/** Rap delivery runs about 4.5 syllables a second: at a given BPM that sets
 * how many syllables a 4/4 bar holds. */
export const SYLLABLES_PER_SECOND = 4.5;
export const syllablesPerBar = (bpm: number): number => (SYLLABLES_PER_SECOND * 240) / bpm;

export type LyricsLine = { text: string; syllables: number; header: boolean };
export type LyricsStats = { lang: LyricsLang; lines: LyricsLine[]; syllables: number; bars: number | null };

/** Counts per line, the total, and (with a BPM) the bars it fills, to the half bar. */
export function analyzeLyrics(text: string, bpm: number | null, lang: LyricsLang = guessLang(text)): LyricsStats {
  const lines = text.split("\n").map((t) => ({ text: t, syllables: lineSyllables(t, lang), header: isHeader(t) }));
  const syllables = lines.reduce((n, l) => n + l.syllables, 0);
  const bars = bpm && bpm > 0 && syllables > 0 ? Math.max(0.5, Math.round((syllables / syllablesPerBar(bpm)) * 2) / 2) : null;
  return { lang, lines, syllables, bars };
}

/** The line the cursor is on (0-based). */
export const lineAt = (text: string, cursor: number): number => text.slice(0, Math.max(0, cursor)).split("\n").length - 1;
