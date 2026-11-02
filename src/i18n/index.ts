import { currentUiLang, setUiLang, uiLang, type UiLang } from "../lib/crewMessages";

// The app's language: French or English (Settings → Language: System,
// Français, English). Every visible word comes from a dictionary:
//
//   const T = dict({ title: "Releases", count: (n: number) => `${n} songs` },
//                  { title: "Sorties",  count: (n: number) => `${n} sons` });
//   ...  tr(T).title  ...  tr(T).count(3)
//
// English is the reference; TypeScript refuses a French dictionary that
// misses a key or changes a signature. Changing the language remounts the
// whole app (App.tsx keys the root on it), so `tr` can be called anywhere,
// in components or plain helpers, without hooks.
//
// French: casual "tu", the landing page's words (docs/I18N.md).

export type Lang = UiLang;
export type UiLanguageSetting = "system" | "fr" | "en";

export function resolveLang(setting: string | undefined): Lang {
  return setting === "fr" || setting === "en" ? setting : uiLang();
}

/** Pin the language for everything (the app calls this from its settings). */
export function applyLang(lang: Lang) {
  setUiLang(lang);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

/** The language in use now. */
export function currentLang(): Lang {
  return currentUiLang();
}

type Entry = string | ((...args: never[]) => string);
type Dict = Record<string, Entry>;

/** A dictionary: English, then French with exactly the same keys and shapes. */
export function dict<T extends Dict>(en: T, fr: { [K in keyof T]: T[K] }): Record<Lang, T> {
  return { en, fr };
}

/** The current language's strings of a dictionary. */
export function tr<T>(d: Record<Lang, T>): T {
  return d[currentLang()];
}

/** Picks the singular or the plural for `n` in the current language (or
 * `lang`). French takes the singular for 0 and 1 ("0 son", "1 son", "2 sons"),
 * English only for 1 ("0 songs", "1 song"). */
export function plural(n: number, one: string, other: string, lang: Lang = currentLang()): string {
  return new Intl.PluralRules(lang === "fr" ? "fr-FR" : "en-US").select(n) === "one" ? one : other;
}

/** For Intl / toLocale* calls: French, or the system's own format in English. */
export function locale(): string | undefined {
  return currentLang() === "fr" ? "fr-FR" : undefined;
}
