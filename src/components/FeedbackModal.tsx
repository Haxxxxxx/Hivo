// "Report a bug or send feedback": a short form that sends to the crew
// backend (src/lib/feedback.ts), with the version, OS, view and language
// attached and shown. Nothing else leaves the app: no paths, no song data.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { Modal, btn, btnPrimary, btnQuiet, engrave, input, sectionLabel } from "../ui";
import { currentLang, dict, tr } from "../i18n";
import { supabase } from "../lib/supabase";
import {
  FEEDBACK_CATEGORIES,
  FeedbackError,
  MESSAGE_MAX,
  contextLine,
  feedbackAsText,
  newInstallId,
  osFromUserAgent,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackDraft,
  type FeedbackErrorKind,
  type FeedbackInput,
} from "../lib/feedback";

const T = dict(
  {
    title: "Report a bug or send feedback",
    bug: "Bug",
    idea: "Idea",
    question: "Question",
    message: "Message",
    placeholder: "What happened? What did you expect?",
    email: "Email, if you want an answer (optional)",
    attached: (line: string) => `Attached: ${line}`,
    send: "Send",
    sending: "Sending…",
    cancel: "Cancel",
    sent: "Thanks, sent.",
    rateLimited: "Ten messages a day is the limit. Try again tomorrow, or copy it as text.",
    network: "Couldn't reach the server. Check your connection and try again, or copy it as text.",
    failed: (detail: string) => `Couldn't send: ${detail}`,
    copy: "Copy as text",
    copied: "Copied",
  },
  {
    title: "Signaler un bug ou donner ton avis",
    bug: "Bug",
    idea: "Idée",
    question: "Question",
    message: "Message",
    placeholder: "Qu'est-ce qui s'est passé ? Qu'est-ce que tu attendais ?",
    email: "Email, si tu veux une réponse (facultatif)",
    attached: (line: string) => `Joint : ${line}`,
    send: "Envoyer",
    sending: "Envoi…",
    cancel: "Annuler",
    sent: "Merci, c'est envoyé.",
    rateLimited: "Dix messages par jour, c'est le maximum. Réessaie demain, ou copie le texte.",
    network: "Impossible de joindre le serveur. Vérifie ta connexion et réessaie, ou copie le texte.",
    failed: (detail: string) => `Envoi impossible : ${detail}`,
    copy: "Copier en texte",
    copied: "Copié",
  },
);

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; error: FeedbackErrorKind; detail: string };

export function FeedbackModal() {
  const draft = useAppStore((s) => s.feedback);
  if (!draft) return null;
  // Keyed on open, so a "Report this" prefill never leaks into the next form.
  return <FeedbackForm key={`${draft.category}:${draft.message}`} draft={draft} />;
}

function FeedbackForm({ draft }: { draft: FeedbackDraft }) {
  const t = tr(T);
  const close = useAppStore((s) => s.closeFeedback);
  const view = useAppStore((s) => s.view);
  const installId = useAppStore((s) => s.settings.installId);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [category, setCategory] = useState<FeedbackCategory>(draft.category);
  const [message, setMessage] = useState(draft.message);
  const [replyTo, setReplyTo] = useState("");
  const [version, setVersion] = useState("dev");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let on = true;
    getVersion()
      .then((v) => on && setVersion(v))
      .catch(() => {});
    return () => void (on = false);
  }, []);

  // Sent: a short thanks, then the form goes away on its own.
  useEffect(() => {
    if (status.kind !== "sent") return;
    const timer = setTimeout(close, 1500);
    return () => clearTimeout(timer);
  }, [status.kind, close]);

  const ctx = { version, os: osFromUserAgent(navigator.userAgent), view, lang: currentLang() };
  const build = (id: string): FeedbackInput => ({ installId: id, category, message, replyTo, ctx });
  const canSend = message.trim().length > 0 && status.kind !== "sending" && status.kind !== "sent";

  const send = async () => {
    if (!canSend || !supabase) return;
    setStatus({ kind: "sending" });
    // The install id is made on the first send and kept in settings.json.
    let id = installId;
    if (!id) {
      id = newInstallId();
      await updateSettings({ installId: id }).catch(() => {});
    }
    try {
      await submitFeedback(supabase, build(id));
      setStatus({ kind: "sent" });
    } catch (e) {
      const error = e instanceof FeedbackError ? e.kind : "failed";
      setStatus({ kind: "error", error, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const copy = () => {
    void navigator.clipboard?.writeText(feedbackAsText(build(installId ?? ""))).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const errorText =
    status.kind === "error"
      ? status.error === "rate-limited"
        ? t.rateLimited
        : status.error === "network"
          ? t.network
          : t.failed(status.detail)
      : null;

  return (
    <Modal title={t.title} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex gap-1" role="group" aria-label={t.title}>
          {FEEDBACK_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`rounded px-3 py-1 font-mono text-[11px] uppercase tracking-[0.08em] ${
                category === c ? "bg-cream font-medium text-chassis" : "border border-rule-strong text-body hover:bg-raised"
              }`}
            >
              {t[c]}
            </button>
          ))}
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="feedback-message" className={sectionLabel}>
              {t.message}
            </label>
            <span className={`${engrave} tabular-nums`}>
              {message.length}/{MESSAGE_MAX}
            </span>
          </div>
          <textarea
            id="feedback-message"
            autoFocus
            required
            value={message}
            maxLength={MESSAGE_MAX}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t.placeholder}
            rows={6}
            className={`${input} mt-1.5 resize-y leading-relaxed`}
          />
        </div>

        <div>
          <label htmlFor="feedback-email" className={sectionLabel}>
            {t.email}
          </label>
          <input
            id="feedback-email"
            type="email"
            autoComplete="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            className={`${input} mt-1.5`}
          />
        </div>

        <div className={engrave}>{t.attached(contextLine(ctx))}</div>

        {errorText && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-xs text-missing">
            <span>{errorText}</span>
            <button type="button" onClick={copy} className={`${btn} py-1 text-[13px]`}>
              {copied ? t.copied : t.copy}
            </button>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {status.kind === "sent" && <span className="mr-auto text-sm text-cream">{t.sent}</span>}
          <button type="button" onClick={close} className={btnQuiet}>
            {t.cancel}
          </button>
          <button type="submit" disabled={!canSend} className={btnPrimary}>
            {status.kind === "sending" ? t.sending : t.send}
          </button>
        </div>
      </form>
    </Modal>
  );
}
