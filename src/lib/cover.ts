// Cover-art concepts: turns the Launch Kit's cover art brief into a FLUX
// prompt. Pure and deterministic (same brief + variant = same prompt), so it
// can be unit-tested; the image call itself is in src-tauri/src/cover.rs.
//
// Rules baked in:
// - Album-cover framing, square.
// - No text, letters or logos: FLUX spells badly, and the title and artist
//   name go on later, by a designer. Typography lines and sentences about
//   lettering are dropped, and the title / artist names never reach FLUX.
// - No real person's likeness: figures stay anonymous or stylized. Notes are
//   left out too (they can name people).

/** FLUX.1 [schnell] on Workers AI accepts at most 2048 characters. */
export const MAX_PROMPT = 2048;

/** One composition per concept, so the four in a grid differ in more than
 * the seed (and still differ if Cloudflare ignores the seed). */
export const COVER_VARIANTS = [
  "Centered single subject with a bold silhouette against a clean background",
  "Extreme close-up of one telling detail, shallow depth of field, cinematic lighting",
  "Wide atmospheric scene with generous negative space",
  "Stylized graphic illustration with flat bold shapes and high contrast",
] as const;

export interface CoverBriefParts {
  /** Gemini's art direction, when the brief has it. */
  concept?: string;
  imagery?: string;
  palette?: string;
  /** Template vibe cues. */
  tempoFeel?: string;
  keyMood?: string;
  tags: string[];
  /** Free text the user wrote instead of the structured lines. */
  freeText?: string;
}

const LABEL = /^\s*-?\s*(concept|palette|imagery|typography|avoid|tempo|key|tags|notes)\s*:\s*(.*)$/i;
/** Lines of the brief that are specs or rules, not looks. */
const SPEC_LINE = /^(cover art brief|format:|distributors |vibe cues|it has to work as a thumbnail)/i;
/** Sentences about lettering would make FLUX try to write. */
const TEXT_TALK = /\b(text|title|typograph\w*|font|letter\w*|lettering|word(?:mark)?s?|logo\w*|written|caption|name|signature)\b/i;

/** Splits a brief (Gemini's or the template, possibly edited) into parts. */
export function parseCoverBrief(brief: string): CoverBriefParts {
  const parts: CoverBriefParts = { tags: [] };
  const free: string[] = [];
  for (const raw of brief.split("\n")) {
    const line = raw.trim();
    if (!line || SPEC_LINE.test(line)) continue;
    const m = LABEL.exec(line);
    if (!m) {
      free.push(line.replace(/^-\s*/, ""));
      continue;
    }
    const value = m[2].trim();
    const paren = /\(([^)]*)\)/.exec(value)?.[1]?.trim();
    switch (m[1].toLowerCase()) {
      case "concept":
        parts.concept = value;
        break;
      case "imagery":
        parts.imagery = value;
        break;
      case "palette":
        parts.palette = value;
        break;
      case "tempo":
        if (paren) parts.tempoFeel = paren;
        break;
      case "key":
        // "Am (minor: darker, moodier)" → "darker, moodier"
        if (paren) parts.keyMood = paren.replace(/^(minor|major)\s*:\s*/i, "").trim();
        break;
      case "tags":
        parts.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      // typography, avoid, notes: deliberately not sent to FLUX.
    }
  }
  if (free.length) parts.freeText = free.join(" ");
  return parts;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Artist credits → individual names ("A feat. B & C" → A, B, C). */
function names(artists: string): string[] {
  return artists
    .split(/,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b/i)
    .map((n) => n.trim())
    .filter((n) => n.length >= 2);
}

/** A whole-word pattern for `phrase` that ignores case and accents ("Été"
 * also catches "ete" and "ÉTÉ"), for text in NFD form. `\b` is ASCII-only in
 * JS, so it never matched a word starting or ending with an accent. */
function loosePattern(phrase: string): RegExp {
  const base = phrase.normalize("NFD").replace(/\p{M}/gu, "").trim();
  const body = [...base].map((c) => (/[\p{L}]/u.test(c) ? `${escapeRegExp(c)}\\p{M}*` : escapeRegExp(c))).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

/** Whether `phrase` appears in `text` as a word, ignoring case and accents. */
export function mentions(text: string, phrase: string): boolean {
  return phrase.trim().length >= 2 && loosePattern(phrase).test(text.normalize("NFD"));
}

/** Drops lettering talk, quotes and the title; people's names become an
 * anonymous figure (no likeness). */
export function scrub(text: string, banned: string[], people: string[] = []): string {
  const sentences = text
    .split(/(?<=[.;!?])\s+/)
    .filter((s) => !TEXT_TALK.test(s));
  let out = sentences.join(" ").normalize("NFD");
  const swap = (list: string[], by: string) => {
    for (const b of list) {
      if (b.trim().length < 2) continue;
      out = out.replace(loosePattern(b), by);
    }
  };
  swap(people, "an anonymous figure");
  swap(banned, "");
  return out
    .replace(/["“”«»]/g, "")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/([,;]\s*){2,}/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:-]+|[\s,;:-]+$/g, "")
    .trim()
    .normalize("NFC");
}

function sentence(s: string): string {
  const t = s.trim().replace(/[.;,\s]+$/, "");
  return t ? `${t.replace(/(^|[.!?]\s+)([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())}.` : "";
}

export interface CoverPromptInput {
  brief: string;
  title: string;
  artists: string;
  /** Index into COVER_VARIANTS (wraps). */
  variant: number;
  /** The kit's release type ("Single", "EP", "Album", "Mixtape"). */
  releaseType?: string;
}

/** "a rap single", "a rap EP"…: what the cover is for. */
function releaseWording(releaseType: string | undefined): string {
  switch ((releaseType ?? "").trim().toLowerCase()) {
    case "ep":
      return "a rap EP";
    case "album":
      return "a rap album";
    case "mixtape":
      return "a rap mixtape";
    default:
      return "a rap single";
  }
}

/** The FLUX prompt for one concept. Deterministic. */
export function buildCoverPrompt({ brief, title, artists, variant, releaseType }: CoverPromptInput): string {
  const p = parseCoverBrief(brief);
  const people = names(artists);
  const clean = (s: string | undefined) => (s ? scrub(s, [title], people) : "");

  const subject = [clean(p.concept), clean(p.imagery)].filter(Boolean).map(sentence).join(" ") || clean(p.freeText);
  // Tags are short: a name or the title there is dropped, not swapped.
  const tags = p.tags.map((t) => scrub(t, [title, ...people])).filter(Boolean).join(", ");
  const moods = [p.tempoFeel, p.keyMood, tags].filter(Boolean).join("; ");
  const palette = clean(p.palette);
  const composition = COVER_VARIANTS[((variant % COVER_VARIANTS.length) + COVER_VARIANTS.length) % COVER_VARIANTS.length];

  const head = `Square cover artwork for ${releaseWording(releaseType)}, 1:1 composition.`;
  const tail = [
    sentence(composition),
    palette ? sentence(`Color palette: ${palette}`) : "",
    moods ? sentence(`Mood: ${moods}`) : "",
    "Professional, high-detail music artwork with one strong focal point that still reads as a small thumbnail.",
    "Purely visual image: no text, no letters, no words, no numbers, no typography, no logos, no watermark, no signature.",
    "No recognizable real person or celebrity likeness; any figure is anonymous, seen from behind, in silhouette or stylized.",
  ]
    .filter(Boolean)
    .join(" ");

  // The subject is the only open-ended part: shorten it to fit the limit.
  const room = MAX_PROMPT - head.length - tail.length - 2;
  let body = sentence(subject || "A bold, moody visual metaphor for a modern hip-hop track");
  if (body.length > room) body = sentence(body.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, ""));
  const prompt = [head, body, tail].filter(Boolean).join(" ");
  // Last guard: the title never reaches Cloudflare, whatever slipped past
  // the scrub above (a title like "Night" or "Single" can be a common word).
  if (!mentions(prompt, title)) return prompt;
  return prompt.normalize("NFD").replace(loosePattern(title), "").replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").normalize("NFC");
}

/** Positive 31-bit seeds, distinct. `rand` is injectable for tests. */
export function randomSeeds(n: number, rand: () => number = Math.random): number[] {
  const seeds = new Set<number>();
  for (let tries = 0; seeds.size < n && tries < n * 20; tries++) seeds.add(1 + Math.floor(rand() * 0x7ffffffe));
  // A degenerate rand (constant): step from the last seed instead.
  let next = Math.max(0, ...seeds);
  while (seeds.size < n) seeds.add((next = (next % 0x7ffffffe) + 1));
  return [...seeds];
}

/** Rough neuron cost of one 1024 px image at 4 steps (4 tiles × 4.8 +
 * 4 steps × 9.6), for the "how many left today" hint. */
export const NEURONS_PER_IMAGE = 4 * 4.8 + 4 * 9.6;
export const FREE_NEURONS_PER_DAY = 10_000;
