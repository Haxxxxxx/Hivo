// "Send feedback" (Settings): the same `submit_feedback` function as the
// desktop app (supabase/migrations/*_feedback*.sql), called over HTTPS with
// the anon key. It's the one thing the phone sends anywhere but the paired
// computer, and only when the user taps Send (privacy policy, Play Data
// safety in docs/PLAY-CONSOLE.md). No Supabase client: one POST.
//
// The server trims and clips everything; these caps only keep a request
// small and say the limit before the user hits it.

export type FeedbackCategory = "bug" | "idea" | "question";

export const MAX_FEEDBACK_CHARS = 4000;
export const MAX_REPLY_TO_CHARS = 200;

/** Where feedback goes, from the build (`app.config.js` → `extra.feedback`). */
export type FeedbackConfig = { url: string; anonKey: string } | null;

export type FeedbackDraft = {
  category: FeedbackCategory;
  message: string;
  replyTo: string;
};

export type FeedbackContext = {
  installId: string;
  appVersion: string;
  /** "android 15" */
  os: string;
  lang: string;
};

export type FeedbackError =
  | "empty" // nothing to send
  | "off" // this build has no server configured
  | "offline" // no answer (no internet)
  | "today" // 10 a day from this phone
  | "busy" // the global hourly cap, or a server hiccup
  | "server";

/** The build's config, or null when it has none (dev builds) or it's not https. */
export function feedbackConfig(extra: unknown): FeedbackConfig {
  const f = extra && typeof extra === "object" ? (extra as { feedback?: unknown }).feedback : undefined;
  if (!f || typeof f !== "object") return null;
  const { url, anonKey } = f as { url?: unknown; anonKey?: unknown };
  if (typeof url !== "string" || typeof anonKey !== "string" || !anonKey.trim()) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return { url: u.origin, anonKey: anonKey.trim() };
  } catch {
    return null;
  }
}

/** The RPC request, or why there's nothing to send. */
export function feedbackRequest(
  config: FeedbackConfig,
  draft: FeedbackDraft,
  ctx: FeedbackContext,
): { ok: true; url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } | { ok: false; error: FeedbackError } {
  const message = draft.message.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!message) return { ok: false, error: "empty" };
  if (!config) return { ok: false, error: "off" };
  const replyTo = draft.replyTo.trim().slice(0, MAX_REPLY_TO_CHARS);
  return {
    ok: true,
    url: `${config.url}/rest/v1/rpc/submit_feedback`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      body: JSON.stringify({
        p_install: ctx.installId,
        p_category: draft.category,
        p_message: message,
        p_reply_to: replyTo || null,
        p_app_version: ctx.appVersion,
        p_os: ctx.os,
        // The desktop sends the view it was on; the phone says it's the phone.
        p_view: "phone",
        p_lang: ctx.lang,
      }),
    },
  };
}

/** What a PostgREST answer means. `text` is the body (an error JSON on failure). */
export function feedbackResult(status: number, text: string): { ok: true } | { ok: false; error: FeedbackError } {
  if (status >= 200 && status < 300) return { ok: true };
  if (/too many messages today/.test(text)) return { ok: false, error: "today" };
  if (/too many messages right now/.test(text) || status === 429 || status >= 500) return { ok: false, error: "busy" };
  return { ok: false, error: "server" };
}

/** A v4 uuid string from 16 random bytes (the install id the server rate-limits on). */
export function uuidFromBytes(b: Uint8Array): string {
  if (b.length < 16) throw new Error("16 bytes needed");
  const x = Array.from(b.slice(0, 16));
  x[6] = (x[6] & 0x0f) | 0x40;
  x[8] = (x[8] & 0x3f) | 0x80;
  const h = x.map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
