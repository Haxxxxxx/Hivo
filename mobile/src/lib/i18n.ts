// Same idea as the desktop's src/i18n: dict(en, fr) next to the code, tr(T)
// at render time. The phone follows the device language (French when it
// prefers fr, else English).

export type Lang = "en" | "fr";
let current: Lang = "en";

export function setLang(languageCode: string | null | undefined): void {
  current = languageCode?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const lang = (): Lang => current;

/** English is the reference: the French must have the same keys and signatures. */
export function dict<T extends object>(en: T, fr: NoInfer<T>): { en: T; fr: T } {
  return { en, fr };
}

export function tr<T>(d: { en: T; fr: T }): T {
  return current === "fr" ? d.fr : d.en;
}

/** The singular or the plural for `n`: French takes the singular for 0 and 1,
 * English only for 1 (same as the desktop's src/i18n `plural`). */
export function plural(n: number, one: string, other: string, l: Lang = current): string {
  return isOne(n, l) ? one : other;
}

/** CLDR's "one" for the two languages, by hand: Hermes (the release app's
 * engine on Android) has no Intl.PluralRules, and `new` on it threw, which
 * crashed the note screen as soon as a line count or a bar count showed.
 * French: 0 ≤ n < 2; English: exactly 1 (an integer, no decimals). */
export function isOne(n: number, l: Lang): boolean {
  return l === "fr" ? n >= 0 && n < 2 : n === 1;
}

const NNBSP = "\u202f";

/** A file size: "1.2 MB" / "345 KB", in French "1,2 Mo" / "345 Ko" (no Intl: Hermes). */
export function sizeText(bytes: number, l: Lang = current): string {
  const fr = l === "fr";
  if (bytes >= 1024 * 1024) {
    const v = (bytes / 1024 / 1024).toFixed(1);
    return fr ? `${v.replace(".", ",")}\u00a0Mo` : `${v} MB`;
  }
  const k = Math.max(1, Math.round(bytes / 1024));
  return fr ? `${k}\u00a0Ko` : `${k} KB`;
}

/** "just now", "3 min ago", "2 h ago", "4 days ago" (and the French). */
export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  const fr = current === "fr";
  if (s < 60) return fr ? "à l'instant" : "just now";
  const m = Math.round(s / 60);
  if (m < 60) return fr ? `il y a ${m}${NNBSP}min` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return fr ? `il y a ${h}${NNBSP}h` : `${h} h ago`;
  const d = Math.round(h / 24);
  return fr ? `il y a ${d}${NNBSP}${plural(d, "jour", "jours", "fr")}` : `${d} ${plural(d, "day", "days", "en")} ago`;
}
