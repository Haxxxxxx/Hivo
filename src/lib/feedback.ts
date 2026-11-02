// "Report a bug / send feedback": an in-app form that sends to the crew
// backend (public.submit_feedback, supabase/migrations/*_feedback.sql) with
// the facts the person who runs the app always asks for (version, OS, where
// you were) attached. Without a backend in this build, it falls back to a
// mailto link to FEEDBACK_EMAIL. No tracking: one install id, nothing else.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Address the mailto fallback writes to; set at build time. */
export const FEEDBACK_EMAIL: string | null = (import.meta.env.VITE_FEEDBACK_EMAIL ?? "").trim() || null;

/** A message with local file paths blanked ("Report this" prefills from
 * error banners, which can name a folder). */
export function scrubPaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|Volumes|private|var|tmp|mnt|media)\/)[^\s"'`]*/g, "<path>");
}

export interface FeedbackContext {
  /** App version ("0.4.0"), or "dev" outside a build. */
  version: string;
  /** "macOS", "Windows", "Linux" or "unknown". */
  os: string;
  /** The view the user was on (the sidebar id). */
  view: string;
  lang: "fr" | "en";
}

export type FeedbackCategory = "bug" | "idea" | "question";
export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = ["bug", "idea", "question"];

/** What the form opens on ("Report this" on an error prefills a bug). */
export interface FeedbackDraft {
  category: FeedbackCategory;
  message: string;
}

/** The database's limits (the function clips, the form counts). */
export const MESSAGE_MAX = 4000;
export const REPLY_TO_MAX = 200;

export interface FeedbackInput {
  /** The install's id (Settings.installId), the rate-limit key. */
  installId: string;
  category: FeedbackCategory;
  message: string;
  /** Optional email to answer at. */
  replyTo: string;
  ctx: FeedbackContext;
}

const TEXT = {
  en: {
    subject: (v: string, os: string) => `Hivo feedback (${v}, ${os})`,
    body: "What happened:\n\n\nWhat you expected:\n\n\n",
  },
  fr: {
    subject: (v: string, os: string) => `Retour Hivo (${v}, ${os})`,
    body: "Ce qui s'est passé :\n\n\nCe que tu attendais :\n\n\n",
  },
};

/** A fresh install id (RFC 4122 v4, the database's uuid type), with a fallback for old webviews. */
export function newInstallId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The OS family from a browser user agent string. */
export function osFromUserAgent(ua: string): string {
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "unknown";
}

/** "Hivo 0.5.0 · macOS · Dashboard · EN": what the form says it attaches. */
export function contextLine(ctx: FeedbackContext): string {
  const view = ctx.view ? ctx.view[0].toUpperCase() + ctx.view.slice(1) : "";
  return `Hivo ${ctx.version} · ${ctx.os} · ${view} · ${ctx.lang.toUpperCase()}`;
}

/** The mailto URL for a feedback email to `to`, with the context in the subject and the footer. */
export function feedbackMailto(to: string, ctx: FeedbackContext): string {
  const t = TEXT[ctx.lang];
  const subject = t.subject(ctx.version, ctx.os);
  const body = `${t.body}—\nHivo ${ctx.version} · ${ctx.os} · ${ctx.view}`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The arguments of public.submit_feedback, clipped like the function does. */
export function feedbackPayload(input: FeedbackInput) {
  return {
    p_install: input.installId,
    p_category: input.category,
    p_message: input.message.trim().slice(0, MESSAGE_MAX),
    p_reply_to: input.replyTo.trim().slice(0, REPLY_TO_MAX) || null,
    p_app_version: input.ctx.version,
    p_os: input.ctx.os,
    p_view: input.ctx.view,
    p_lang: input.ctx.lang,
  };
}

/** The same content as plain text, for "Copy as text" when sending failed. */
export function feedbackAsText(input: FeedbackInput): string {
  const p = feedbackPayload(input);
  const lines = [`[${p.p_category}] ${contextLine(input.ctx)}`];
  if (p.p_reply_to) lines.push(`Reply to: ${p.p_reply_to}`);
  lines.push("", p.p_message);
  return lines.join("\n");
}

export type FeedbackErrorKind = "rate-limited" | "network" | "failed";

export class FeedbackError extends Error {
  constructor(
    readonly kind: FeedbackErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

/** What went wrong, from a PostgREST error or a thrown fetch failure. */
export function feedbackErrorKind(e: unknown): FeedbackErrorKind {
  const err = (typeof e === "object" && e !== null ? e : {}) as { message?: unknown; code?: unknown };
  const message = typeof err.message === "string" ? err.message : String(e ?? "");
  // "too many messages today" (10 a day per install) and "too many messages
  // right now" (200 an hour across every install) both mean: wait.
  if (/too many messages/i.test(message)) return "rate-limited";
  // supabase-js reports a failed request with an empty code and the fetch error as the message.
  if (err.code === "" || /fetch|network|offline|ECONN|ENOTFOUND|timed? ?out/i.test(message)) return "network";
  return "failed";
}

/** Sends one message; resolves to its id. Throws a FeedbackError. */
export async function submitFeedback(client: SupabaseClient, input: FeedbackInput): Promise<string> {
  let res: { data: unknown; error: { message: string; code?: string } | null };
  try {
    res = await client.rpc("submit_feedback", feedbackPayload(input));
  } catch (e) {
    throw new FeedbackError(feedbackErrorKind(e), e instanceof Error ? e.message : String(e));
  }
  if (res.error) throw new FeedbackError(feedbackErrorKind(res.error), res.error.message);
  if (typeof res.data !== "string") throw new FeedbackError("failed", "no id returned");
  return res.data;
}
