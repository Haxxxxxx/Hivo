import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { frenchErrorSamples } from "../lib/errors";

// French typography (docs/I18N.md): a narrow no-break space (U+202F), never a
// plain one, before : ; ? ! and inside « ». This reads the source of every
// French dictionary in the desktop app, the website and the phone app: the
// second argument of dict(), a `fr:` value, a `const fr` / `const FR` object.

// Read from disk, not through Vite: a `?raw` glob still runs the phone's files
// through the transform, which needs mobile/node_modules (absent in CI's desktop job).
function sourcesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const root = process.cwd();
  for (const rel of readdirSync(join(root, dir), { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(rel) || /\.test\.ts$/.test(rel)) continue;
    const key = `/${dir}/${rel.split(sep).join("/")}`;
    out[key] = readFileSync(join(root, dir, rel), "utf8");
  }
  return out;
}

const SOURCES: Record<string, string> = { ...sourcesUnder("src"), ...sourcesUnder("web/src"), ...sourcesUnder("mobile/src") };

type Tok =
  | { kind: "str"; text: string; at: number }
  | { kind: "punct"; ch: string; at: number }
  | { kind: "word"; text: string; at: number };

/** A small TS lexer: strings and template text, brackets, words. Comments
 * and regex literals are skipped well enough for dictionaries. */
export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  // Template literals nest through ${ }: a stack of brace depths at which a
  // template resumes.
  const resume: number[] = [];
  let depth = 0;
  let i = 0;
  const readTemplate = () => {
    // i is just after ` or after the } that closes a ${
    let text = "";
    const at = i;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        i++;
        out.push({ kind: "str", text, at });
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        out.push({ kind: "str", text, at });
        out.push({ kind: "punct", ch: "${", at: i - 2 });
        resume.push(depth);
        depth++;
        return;
      } else {
        text += c;
        i++;
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      const at = i;
      let text = "";
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          text += src.slice(i, i + 2);
          i += 2;
        } else text += src[i++];
      }
      i++;
      out.push({ kind: "str", text, at: at + 1 });
    } else if (c === "`") {
      i++;
      readTemplate();
    } else if ("{[(".includes(c)) {
      out.push({ kind: "punct", ch: c, at: i });
      depth++;
      i++;
    } else if ("}])".includes(c)) {
      depth--;
      i++;
      if (c === "}" && resume.length && resume[resume.length - 1] === depth) {
        resume.pop();
        out.push({ kind: "punct", ch: "}$", at: i - 1 });
        readTemplate();
      } else out.push({ kind: "punct", ch: c, at: i - 1 });
    } else if (",:=;".includes(c)) {
      out.push({ kind: "punct", ch: c, at: i });
      i++;
    } else if (/[A-Za-z_$]/.test(c)) {
      const at = i;
      while (i < src.length && /[\w$]/.test(src[i])) i++;
      out.push({ kind: "word", text: src.slice(at, i), at });
    } else if (c === "/" && /[(,=:[!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 20), i))) {
      // a regex literal
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "[") (inClass = true), i++;
        else if (src[i] === "]") (inClass = false), i++;
        else if (src[i] === "/" && !inClass) break;
        else i++;
      }
      i++;
    } else i++;
  }
  return out;
}

const OPEN = new Set(["{", "[", "(", "${"]);
const CLOSE = new Set(["}", "]", ")", "}$"]);

/** Index of the token closing the bracket opened at `k`. */
function matching(toks: Tok[], k: number): number {
  let d = 0;
  for (let j = k; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if (OPEN.has(t.ch)) d++;
    else if (CLOSE.has(t.ch) && --d === 0) return j;
  }
  return toks.length - 1;
}

/** The end of a value starting at `k` (a literal, a bracketed expression, or
 * up to the next , or closing bracket at this level). */
function valueEnd(toks: Tok[], k: number): number {
  let d = 0;
  for (let j = k; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind !== "punct") continue;
    if (OPEN.has(t.ch)) d++;
    else if (CLOSE.has(t.ch)) {
      if (d === 0) return j - 1;
      d--;
    } else if (d === 0 && (t.ch === "," || t.ch === ";")) return j - 1;
  }
  return toks.length - 1;
}

/** The French string pieces of a file. */
export function frenchStrings(src: string): { text: string; at: number }[] {
  const toks = lex(src);
  const inFr = new Array<boolean>(toks.length).fill(false);
  const mark = (a: number, b: number) => {
    for (let j = a; j <= b; j++) inFr[j] = true;
  };
  toks.forEach((t, k) => {
    const next = toks[k + 1];
    if (t.kind !== "word") return;
    // dict(en, fr): the second argument.
    if (t.text === "dict" && next?.kind === "punct" && next.ch === "(") {
      const end = matching(toks, k + 1);
      const enEnd = valueEnd(toks, k + 2);
      if (enEnd + 2 <= end - 1) mark(enEnd + 2, end - 1);
    }
    // fr: value
    if (t.text === "fr" && next?.kind === "punct" && next.ch === ":") mark(k + 2, valueEnd(toks, k + 2));
    // const fr = {…} / const FR: X = {…}
    const prev = toks[k - 1];
    if ((t.text === "fr" || t.text === "FR") && prev?.kind === "word" && (prev.text === "const" || prev.text === "let")) {
      const eq = toks.findIndex((x, j) => j > k && x.kind === "punct" && x.ch === "=");
      if (eq > 0) mark(eq + 1, valueEnd(toks, eq + 1));
    }
  });
  return toks.flatMap((t, k) => (inFr[k] && t.kind === "str" ? [{ text: t.text, at: t.at }] : []));
}

const cook = (s: string) =>
  s.replace(/\\u202f/gi, " ").replace(/\\u00a0/gi, " ").replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");

/** What's wrong with a French text's typography, if anything. */
export function typographyProblems(raw: string): string[] {
  const s = cook(raw);
  const out: string[] = [];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    const after = s[i + 1] ?? "";
    if (":;?!".includes(c) && s[i - 1] === " " && !/[\w/=]/.test(after)) out.push(`plain space before "${c}"`);
    if (c === " " && s[i - 1] === "«") out.push('plain space after "«"');
    if (c === "»" && s[i - 1] === " ") out.push('plain space before "»"');
  }
  return out;
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

describe("French typography", () => {
  it("the checker sees what it should", () => {
    expect(typographyProblems("Pas encore de code ?")).toEqual(['plain space before "?"']);
    expect(typographyProblems("Réglages : ok")).toEqual(['plain space before ":"']);
    expect(typographyProblems("« jour de sortie »")).toEqual(['plain space after "«"', 'plain space before "»"']);
    expect(typographyProblems("Pas encore de code\\u202f? Vidéos 9:16, https://x.fr/?a=1")).toEqual([]);
    const src = 'const T = dict({ a: "Hi :" }, { a: "Salut :", b: (n: number) => `${n} son : ok` });\nconst x = { fr: "Oui ?" , en: "Yes ?" };';
    expect(frenchStrings(src).map((s) => s.text)).toEqual(["Salut :", "", " son : ok", "Oui ?"]);
  });

  it("every French dictionary uses narrow no-break spaces", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const s of frenchStrings(src)) {
        for (const p of typographyProblems(s.text)) hits.push(`${file}:${lineOf(src, s.at)} ${p}: ${s.text.slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the translated Rust errors too", () => {
    const hits = frenchErrorSamples().flatMap((s) => typographyProblems(s).map((p) => `${p}: ${s}`));
    expect(hits).toEqual([]);
  });
});
