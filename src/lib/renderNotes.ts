import { dict, tr } from "../i18n";

// What a finished render says about the project's samples. Rust reports
// counts and stored paths (render.rs `SampleReport`); the words are here, in
// the app's language.

const T = dict(
  {
    moved: (n: number) =>
      `${n} sample${n === 1 ? "" : "s"} the project stores at a path that doesn't exist here ${n === 1 ? "was" : "were"} rendered from where Hivo found ${n === 1 ? "it" : "them"} (song folder or sample library).`,
    missing: (n: number, shown: string, more: number) =>
      `${n} sample${n === 1 ? " wasn't" : "s weren't"} found, so ${n === 1 ? "it's" : "they're"} silent in this mixdown: ${shown}${more > 0 ? ` (+${more})` : ""}.`,
  },
  {
    moved: (n: number) =>
      `${n} sample${n === 1 ? "" : "s"} que le projet range à un chemin qui n'existe pas ici ${n === 1 ? "a été rendu" : "ont été rendus"} depuis l'endroit où Hivo ${n === 1 ? "l'a trouvé" : "les a trouvés"} (dossier du son ou bibliothèque de samples).`,
    missing: (n: number, shown: string, more: number) =>
      `${n} sample${n === 1 ? " n'a pas été trouvé : il est muet" : "s n'ont pas été trouvés : ils sont muets"} dans ce mixdown : ${shown}${more > 0 ? ` (+${more})` : ""}.`,
  },
);

/** How many missing samples are named (the rest are counted). */
const SHOWN = 3;

/** The file name of a stored path, whatever OS saved it. */
const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** The note under a finished render, or null when every sample was where
 * the project says. */
export function renderSampleNote(moved: number | undefined, missing: string[] | undefined): string | null {
  const parts: string[] = [];
  const m = tr(T);
  if (missing?.length) {
    const shown = missing.slice(0, SHOWN).map(fileName).join(", ");
    parts.push(m.missing(missing.length, shown, missing.length - SHOWN));
  }
  if (moved) parts.push(m.moved(moved));
  return parts.length ? parts.join(" ") : null;
}
