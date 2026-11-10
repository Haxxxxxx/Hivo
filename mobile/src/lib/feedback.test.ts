import { describe, expect, it } from "vitest";
import { feedbackConfig, feedbackRequest, feedbackResult, isUuid, MAX_FEEDBACK_CHARS, uuidFromBytes } from "./feedback";

const ctx = { installId: "6f1c2a4e-1b2c-4d3e-8f90-a1b2c3d4e5f6", appVersion: "0.7.2", os: "android 15", lang: "fr" };
const config = { url: "https://example.supabase.co", anonKey: "anon" };

describe("feedback", () => {
  it("reads the build's config, https only", () => {
    expect(feedbackConfig({ feedback: { url: "https://example.supabase.co/", anonKey: " anon " } })).toEqual(config);
    expect(feedbackConfig({ feedback: { url: "http://example.supabase.co", anonKey: "anon" } })).toBeNull();
    expect(feedbackConfig({ feedback: { url: "https://example.supabase.co", anonKey: "" } })).toBeNull();
    expect(feedbackConfig({ distribution: "dev" })).toBeNull();
    expect(feedbackConfig(undefined)).toBeNull();
  });

  it("builds the same RPC call as the desktop", () => {
    const r = feedbackRequest(config, { category: "bug", message: "  The scanner fails  ", replyTo: "" }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.url).toBe("https://example.supabase.co/rest/v1/rpc/submit_feedback");
    expect(r.init.headers.apikey).toBe("anon");
    expect(JSON.parse(r.init.body)).toEqual({
      p_install: ctx.installId,
      p_category: "bug",
      p_message: "The scanner fails",
      p_reply_to: null,
      p_app_version: "0.7.2",
      p_os: "android 15",
      p_view: "phone",
      p_lang: "fr",
    });
  });

  it("refuses an empty message, a build without a server, and clips a long one", () => {
    expect(feedbackRequest(config, { category: "idea", message: "   ", replyTo: "" }, ctx)).toEqual({ ok: false, error: "empty" });
    expect(feedbackRequest(null, { category: "idea", message: "hi", replyTo: "" }, ctx)).toEqual({ ok: false, error: "off" });
    const r = feedbackRequest(config, { category: "idea", message: "x".repeat(MAX_FEEDBACK_CHARS + 50), replyTo: "me@example.com" }, ctx);
    if (!r.ok) throw new Error(r.error);
    const body = JSON.parse(r.init.body);
    expect(body.p_message).toHaveLength(MAX_FEEDBACK_CHARS);
    expect(body.p_reply_to).toBe("me@example.com");
  });

  it("names the server's limits", () => {
    expect(feedbackResult(200, "\"id\"")).toEqual({ ok: true });
    expect(feedbackResult(400, '{"message":"too many messages today"}')).toEqual({ ok: false, error: "today" });
    expect(feedbackResult(400, '{"message":"too many messages right now"}')).toEqual({ ok: false, error: "busy" });
    expect(feedbackResult(503, "")).toEqual({ ok: false, error: "busy" });
    expect(feedbackResult(401, "")).toEqual({ ok: false, error: "server" });
  });

  it("makes v4 uuids", () => {
    const id = uuidFromBytes(new Uint8Array(16).fill(0xff));
    expect(isUuid(id)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});
