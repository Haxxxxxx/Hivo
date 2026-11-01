import * as api from "./tauri";
import { artistLine, briefSpecs, CAPTION_HEADINGS, CAPTION_LANGUAGE_NAMES, isoDate, parseDate, RELEASE_TYPES, type KitField, type KitInput } from "./launchKit";
import { KEYS } from "./songs";
import { detectKey, detectedPeople } from "./people";
import type { AiFieldReview, KitFieldId, Settings } from "../types";
import { dict, tr } from "../i18n";

// The Launch Kit's AI layer (roadmap principle 2): Gemini drafts the copy,
// then a separate pass checks every field (its own drafts included) against
// the project's facts. The prompts and schemas live in Rust (ai.rs, ai_kit):
// this side sends typed facts, never a prompt. Answers are sanitized here, so
// a confused model can flag things but never quietly rewrite measured values.

const MEASURED: KitFieldId[] = ["bpm", "duration"];
/** Facts only the crew can know: the model may flag them, never fill them in
 * (an invented ISRC or songwriter name would go straight to the distributor). */
const NEVER_SUGGEST: KitFieldId[] = ["isrc", "upc", "songwriters", "trackNumber"];
const LONG_TEXT: KitFieldId[] = ["captions", "coverBrief"];

export interface ContextOptions {
  /** The user's notes (off unless "Include notes" is on in Settings). */
  includeNotes?: boolean;
}

/** Facts about the song, as sent to the model. Never file paths, usernames,
 * sample names or the raw mixer track names: only what was found in them
 * (a key, crew members' names). Notes only when the user opted in. */
export function kitContext({ project, meta, people, albums, analysis, today = new Date() }: KitInput, { includeNotes = false }: ContextOptions = {}) {
  const name = (id: string) => people.find((p) => p.id === id)?.name;
  const release = albums.find((a) => a.trackPaths.includes(project.path));
  return {
    // Local dates: the UTC date is already tomorrow on an evening in the Americas.
    today: isoDate(today),
    projectName: project.name,
    pipelineStage: meta.status ?? "unsorted",
    tags: (meta.tags ?? []).slice(0, 30),
    ...(includeNotes && meta.notes?.trim() ? { notes: meta.notes.trim().slice(0, 1500) } : {}),
    tempoBpm: project.tempoBpm,
    timeSignature: project.timeSigNum && project.timeSigDenom ? `${project.timeSigNum}/${project.timeSigDenom}` : null,
    keySetInApp: meta.key ?? null,
    keyWrittenInTrackNames: detectKey(project.trackNames),
    mixdownDurationSec: analysis ? Math.round(analysis.durationSec) : null,
    credits: (meta.credits ?? [])
      .flatMap((c) => (name(c.personId) ? [{ name: name(c.personId)!, role: c.role, split: c.split ?? null }] : []))
      .slice(0, 30),
    peopleFoundInTrackNames: detectedPeople(project, people)
      .map((p) => p.name)
      .slice(0, 30),
    release: release ? { title: release.title, kind: release.kind, date: release.releaseDate } : null,
    lastSavedInFl: isoDate(new Date(project.modifiedAtMs)),
  };
}

// On-screen text only: the prompts and what's sent stay as they are.
const T = dict(
  {
    disclosure: (includeNotes: boolean) =>
      "Sends the song name (the project file's name), stage, tags, tempo, key, credits, release dates and the kit fields to Google Gemini" +
      (includeNotes ? ", plus your notes when checking a kit" : "") +
      ". Never audio, file paths, sample names or your track names (only a key or a crew member's name spotted in them)" +
      (includeNotes ? "" : ", and never your notes") +
      ". On the free tier Google may use what it receives to improve its products.",
    draftIncomplete: "Gemini's draft came back incomplete. Try again.",
    checkEmpty: "Gemini's check came back empty. Try again.",
  },
  {
    disclosure: (includeNotes: boolean) =>
      "Envoie à Google Gemini le nom du son (celui du fichier projet), l'étape, les tags, le tempo, la tonalité, les crédits, les dates de sortie et les champs du kit" +
      (includeNotes ? ", plus tes notes quand tu vérifies un kit" : "") +
      ". Jamais l'audio, les chemins de fichiers, les noms de samples ni les noms de tes pistes (seulement une tonalité ou le nom d'un membre du crew repéré dedans)" +
      (includeNotes ? "" : ", et jamais tes notes") +
      ". Avec l'offre gratuite, Google peut utiliser ce qu'il reçoit pour améliorer ses produits.",
    draftIncomplete: "Le brouillon de Gemini est revenu incomplet. Réessaie.",
    checkEmpty: "La vérif de Gemini est revenue vide. Réessaie.",
  },
);

/** What AI calls send, worded once for every place that says it. */
export function aiDisclosure(includeNotes: boolean): string {
  return tr(T).disclosure(includeNotes);
}

// ---- Drafting ----

function fieldValues(fields: KitField[]): Record<string, string> {
  return Object.fromEntries(fields.filter((f) => !LONG_TEXT.includes(f.id)).map((f) => [f.id, f.value]));
}

/** AI-written captions and cover brief, in the kit's text format. Never sees
 * the notes, even when they're included in checks: the cover concept it
 * writes becomes the FLUX prompt, which goes to Cloudflare. */
export async function draftCopy(input: KitInput, fields: KitField[], settings: Settings) {
  const lang = input.captionLanguage ?? "fr";
  const answer = await api.aiKit({
    kind: "draft",
    model: settings.aiModel,
    language: CAPTION_LANGUAGE_NAMES[lang],
    context: kitContext(input),
    fields: fieldValues(fields),
  });
  const d = (answer.data ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string).trim() : "");
  if (!s("announce") || !s("concept")) throw new Error(tr(T).draftIncomplete);
  const value = (id: KitFieldId) => fields.find((f) => f.id === id)?.value ?? "";
  const h = CAPTION_HEADINGS[lang];
  const captions = `${h.announce}\n${s("announce")}\n\n${h.teaser}\n${s("teaser")}\n\n${h.releaseDay}\n${s("releaseDay")}`;
  const coverBrief = [
    ...briefSpecs(value("title"), artistLine(value("artists"), value("featuring"))),
    "",
    `Concept: ${s("concept")}`,
    `Palette: ${s("palette")}`,
    `Imagery: ${s("imagery")}`,
    `Typography: ${s("typography")}`,
    `Avoid: ${s("avoid")}`,
  ].join("\n");
  const basis = { title: value("title"), artists: value("artists"), releaseDate: value("releaseDate"), language: lang };
  return { captions, coverBrief, basis, model: answer.model };
}

// ---- Verification ----

/** Keeps only well-formed verdicts; measured fields never get suggestions. */
export function sanitizeReview(raw: unknown, fields: KitField[]): Partial<Record<KitFieldId, AiFieldReview>> {
  const out: Partial<Record<KitFieldId, AiFieldReview>> = {};
  const items = (raw as { fields?: unknown })?.fields;
  if (!Array.isArray(items)) return out;
  for (const item of items as Record<string, unknown>[]) {
    const field = fields.find((f) => f.id === item?.id);
    const verdict = item?.verdict;
    if (!field || (verdict !== "ok" && verdict !== "check" && verdict !== "wrong") || out[field.id]) continue;
    const confidence = Math.min(1, Math.max(0, Number(item.confidence)));
    let suggestion = typeof item.suggestion === "string" ? item.suggestion.trim() : "";
    const limit = LONG_TEXT.includes(field.id) ? 4000 : 200;
    if (
      verdict === "ok" ||
      MEASURED.includes(field.id) ||
      NEVER_SUGGEST.includes(field.id) ||
      suggestion === field.value ||
      suggestion.length > limit ||
      (field.id === "releaseDate" && !parseDate(suggestion)) ||
      (field.id === "explicit" && suggestion !== "Yes" && suggestion !== "No") ||
      // Choices with a fixed list: anything else would fail the field's own check.
      (field.id === "key" && !KEYS.includes(suggestion)) ||
      (field.id === "releaseType" && !RELEASE_TYPES.includes(suggestion))
    ) {
      suggestion = "";
    }
    out[field.id] = {
      verdict,
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
      reason: typeof item.reason === "string" ? item.reason.trim().slice(0, 300) : "",
      suggestion: suggestion || undefined,
      checkedValue: field.value,
    };
  }
  return out;
}

/** The cover brief template quotes the notes ("- Notes: …"): dropped unless they're included. */
export function withoutNotesLine(brief: string): string {
  return brief
    .split("\n")
    .filter((l) => !/^\s*-?\s*notes\s*:/i.test(l))
    .join("\n");
}

/** What the "Check kit" call sends: CONTEXT and FIELDS. */
export function reviewPayload(input: KitInput, fields: KitField[], includeNotes: boolean) {
  const values: Record<string, string> = Object.fromEntries(
    fields.map((f) => [f.id, f.id === "coverBrief" && !includeNotes ? withoutNotesLine(f.value) : f.value]),
  );
  return { context: kitContext(input, { includeNotes }), values };
}

export async function reviewKit(input: KitInput, fields: KitField[], settings: Settings) {
  // Rust drops the notes again unless the saved setting allows them.
  const { context, values } = reviewPayload(input, fields, !!settings.aiIncludeNotes);
  // The check flags captions that aren't fully in the kit's language.
  const language = CAPTION_LANGUAGE_NAMES[input.captionLanguage ?? "fr"];
  const answer = await api.aiKit({ kind: "review", model: settings.aiModel, language, context, fields: values });
  const review = sanitizeReview(answer.data, fields);
  if (Object.keys(review).length === 0) throw new Error(tr(T).checkEmpty);
  return { review, model: answer.model };
}
