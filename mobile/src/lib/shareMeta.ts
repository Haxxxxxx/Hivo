import { clip } from "./text";

// What another app (BandLab first) shared with Hivo, turned into a clean
// title, its link and file names. Apps send this badly shaped: a file with no
// display name arrives as the provider's id ("msf:1000032969"), the subject
// can be "BandLab", the text a bare link or "Check out … on BandLab https://…".
// Pure, so it's tested without a phone.

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const BANDLAB_RE = /https:\/\/(?:[a-z0-9-]+\.)*bandlab\.com\/[^\s"'<>]*/i;
/** Subjects and lines that name the app or the action, not the song. */
const GENERIC = /^(bandlab|bandlab\s*[-–:|]?\s*(music|studio|song|track|mixdown|export|link)?|share|shared|partag[ée]e?|song|track|mixdown|export|untitled|sans titre|audio|recording|enregistrement|new (song|project)|nouveau (son|projet))$/i;
/** "… on BandLab", "… | BandLab", "… - BandLab", "… sur BandLab" at the end. */
const APP_SUFFIX = /\s*(?:[-–|:•]\s*|\b(?:on|sur|via|from|de)\s+)bandlab(?:\s*(?:music|studio))?\s*[.!:]*\s*$/i;
/** "Check out", "Listen to", "Écoute"… at the start. */
const LEAD_IN = /^(?:check\s+out|listen\s+to|hear|écoute|ecoute|découvre|decouvre|regarde)\s+(?:my\s+|mon\s+|ma\s+|the\s+|le\s+|la\s+)?(?:new\s+|nouveau\s+|nouvelle\s+)?(?:song|track|son|morceau|titre)?\s*[:-]?\s*/i;

/** A file name that's an id, not a name: "msf:1000032969", "document_42", "1000032969", a UUID. */
export function isOpaqueName(name: string): boolean {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  if (!stem) return true;
  if (/^(msf|document|media|audio|primary|raw|image|video|content|file|shared)[\s:_-]*\d+$/i.test(stem)) return true;
  if (/^\d{3,}$/.test(stem)) return true;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(stem)) return true;
  return /^shared(-\d+)?$/i.test(stem);
}

/** A song name from a file: "Night_Run (Mixdown).mp3" → "Night Run"; "" for an id-like name. */
export function nameFromFile(file: string): string {
  if (isOpaqueName(file)) return "";
  return file
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/[\s-]*[([]?\b(bandlab|mixdown|mix|master|export|stems?)\b[)\]]?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One cleaned title candidate, or "" when it says nothing about the song. */
export function cleanTitle(raw: string): string {
  let t = raw.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  // A quoted title wins: Listen to “Night Drive” by Ana on BandLab.
  const quoted = /[“"«]\s*([^”"»]{1,120}?)\s*[”"»]/.exec(t);
  if (quoted) t = quoted[1];
  t = t.replace(LEAD_IN, "");
  for (let i = 0; i < 2; i++) t = t.replace(APP_SUFFIX, "");
  // "Night Drive by Ana": keep the song.
  t = t.replace(/\s+(?:by|par)\s+[^,]{1,60}$/i, "");
  t = t.replace(/^[\s"'“”«»\-–|:•.]+|[\s"'“”«»\-–|:•]+$/g, "").replace(/\s+/g, " ").trim();
  if (!t || GENERIC.test(t) || isOpaqueName(t)) return "";
  return clip(t, 120).trim();
}

/** The first BandLab link in the shared text or subject. */
export function bandlabLinkIn(...parts: (string | null | undefined)[]): string | null {
  const m = BANDLAB_RE.exec(parts.filter(Boolean).join(" "));
  return m ? m[0].replace(/[).,!?]+$/, "") : null;
}

/** The best title for a share: the subject, a line of the text, then a file's own name. */
export function titleFromShare(share: { subject: string | null; text: string | null; fileNames: string[] }): string {
  const fromSubject = cleanTitle(share.subject ?? "");
  if (fromSubject) return fromSubject;
  for (const line of (share.text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const t = cleanTitle(line);
    // A long line is a sentence or lyrics, not a title.
    if (t && t.length <= 80) return t;
  }
  for (const f of share.fileNames) {
    const t = nameFromFile(f);
    if (t) return t;
  }
  return "";
}

/** The name a shared file keeps: its own, unless it's an id; then the title
 * ("Night Drive.m4a", "Night Drive 2.m4a"), else `fallback` (the app
 * language's "BandLab export"). */
export function fileNameFor(name: string, named: boolean, title: string, index: number, count: number, fallback = "BandLab export"): string {
  // Without a display name the provider's last path segment stands in: a
  // real name ("Beat été test.wav") stays; a bare number ("19") is an id.
  if (!isOpaqueName(name) && (named || !/^\d+$/.test(name.replace(/\.[a-z0-9]{1,5}$/i, "").trim()))) return name;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  const base = clip((title.replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() || fallback), 100).trim();
  const stem = count > 1 ? `${base} ${index + 1}` : base;
  return ext ? `${stem}.${ext}` : stem;
}

/** A share that comes from BandLab (its link, or its name in the subject or the text). */
export const isBandlabShare = (text: string | null, subject: string | null): boolean => !!bandlabLinkIn(text, subject) || /\bbandlab\b/i.test(`${subject ?? ""} ${text ?? ""}`);

/** How a skipped item is named on screen: its own name, never a provider id ("19", "msf:42"). */
export const skippedLabel = (name: string, named: boolean | undefined, unnamed: string): string =>
  !name.trim() || named === false || isOpaqueName(name) || /^\d+$/.test(name.trim()) ? unnamed : name;

/**
 * A file picked with "Add a file": the provider's own name (`display`, from
 * its DISPLAY_NAME) first; else the address's last part, decoded
 * ("primary:Music/Night Drive.m4a" → "Night Drive.m4a"), which is often only
 * an id ("msf:1000032969": not a name, `named: false`). Smoke F3.
 */
export function pickedName(display: string | null, uriName: string): { name: string; named: boolean } {
  const own = display?.trim();
  if (own) return { name: own, named: true };
  let raw = uriName;
  try {
    raw = decodeURIComponent(uriName);
  } catch {
    // Not encoded: as it is.
  }
  const name = raw.split(/[/:]/).pop()?.trim() || raw.trim();
  return { name, named: !!name && !isOpaqueName(name) && !/^\d+$/.test(name) };
}

/** The shared text kept with an upload (the link and BandLab's words), capped. */
export const MAX_SHARE_TEXT = 2000;
export function shareText(text: string | null, subject: string | null): string {
  const parts = [subject?.trim(), text?.trim()].filter((p): p is string => !!p);
  const joined = parts.length === 2 && parts[1].includes(parts[0]) ? parts[1] : parts.join("\n");
  return clip(joined, MAX_SHARE_TEXT);
}
