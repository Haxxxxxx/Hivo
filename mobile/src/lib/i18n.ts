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
  return new Intl.PluralRules(l === "fr" ? "fr-FR" : "en-US").select(n) === "one" ? one : other;
}

const NNBSP = "\u202f";

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
