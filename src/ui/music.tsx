// Music-specific building blocks: mixdown state, song lists, files, and the
// Launch Kit's field rows and checks.
import { useState } from "react";
import { ClipboardCopy, FolderOpen, RotateCcw } from "lucide-react";
import { renderFreshness } from "../lib/songs";
import { LOW_CONFIDENCE, type Check as KitCheck, type KitField } from "../lib/launchKit";
import type { AiFieldReview, ProjectInfo } from "../types";
import { engrave, input, StatusDot } from "./base";
import { dict, plural, tr } from "../i18n";

const T = dict(
  {
    freshShort: "Current",
    freshLabel: "Mix current",
    freshTitle: "Mixdown is newer than the last save",
    staleShort: "Outdated",
    staleLabel: "Mix outdated",
    staleTitle: "Project was saved after the last mixdown",
    noneShort: "None",
    noneLabel: "No mixdown",
    noneTitle: "No mixdown found for this song",
    showInFolder: "Show in folder",
    checkMissing: "Missing",
    revealLabel: (what: string) => `Show ${what} in its folder`,
    checkWarning: "To check",
    detected: "Detected",
    suggested: "Suggested",
    ai: "AI draft",
    edited: "Edited",
    missing: "Needs you",
    ok: "AI: looks right",
    check: "AI: worth a look",
    wrong: "AI: looks wrong",
    needYou: (missing: number, warnings: number) =>
      `${missing} need${plural(missing, "s", "")} you${warnings ? ` · ${warnings} to check` : ""}`,
    nextField: "Go to the next field that needs you",
    readyToExport: "Ready to export",
    readyToReview: "Ready to review",
    aiVerified: " · AI-verified",
    toCheck: (n: number) => ` · ${n} to check`,
    aiReview: "AI review",
    use: "Use",
    sure: (pct: number) => `${pct}% sure`,
    lowConfidence: "low confidence",
    staleReview: " (checked an earlier value)",
    resetTitle: "Back to the generated value",
    reset: "Reset",
    copied: "Copied",
    choiceYes: "Yes",
    choiceNo: "No",
    copy: "Copy",
    typeOnce: "Type it once",
  },
  {
    freshShort: "À jour",
    freshLabel: "Mix à jour",
    freshTitle: "Le mixdown est plus récent que la dernière sauvegarde",
    staleShort: "Dépassé",
    staleLabel: "Mix dépassé",
    staleTitle: "Le projet a été sauvegardé après le dernier mixdown",
    noneShort: "Aucun",
    noneLabel: "Pas de mixdown",
    noneTitle: "Aucun mixdown trouvé pour ce son",
    showInFolder: "Afficher dans le dossier",
    checkMissing: "Manquant",
    revealLabel: (what: string) => `Afficher ${what} dans son dossier`,
    checkWarning: "À vérifier",
    detected: "Détecté",
    suggested: "Suggéré",
    ai: "Brouillon IA",
    edited: "Modifié",
    missing: "À compléter",
    ok: "IA : ça a l'air bon",
    check: "IA : à vérifier",
    wrong: "IA : ça a l'air faux",
    needYou: (missing: number, warnings: number) =>
      `${missing} à compléter${warnings ? ` · ${warnings} à vérifier` : ""}`,
    nextField: "Aller au prochain champ à compléter",
    readyToExport: "Prêt à exporter",
    readyToReview: "Prêt à relire",
    aiVerified: " · vérifié par l'IA",
    toCheck: (n: number) => ` · ${n} à vérifier`,
    aiReview: "Relecture IA",
    use: "Utiliser",
    sure: (pct: number) => `sûr à ${pct} %`,
    lowConfidence: "confiance faible",
    staleReview: " (a vérifié une valeur précédente)",
    resetTitle: "Revenir à la valeur générée",
    reset: "Réinitialiser",
    copied: "Copié",
    choiceYes: "Oui",
    choiceNo: "Non",
    copy: "Copier",
    typeOnce: "Tape-le une fois",
  },
);

const MIX_STATE = {
  fresh: { color: "#3ddc84", key: "fresh" },
  stale: { color: "#ffc233", key: "stale" },
  none: { color: "#ff4040", key: "none" },
} as const;

/** Read-only properties that look up the current language each time. */
function live<K extends string>(keys: Record<K, () => string>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of Object.keys(keys) as K[]) Object.defineProperty(out, k, { enumerable: true, get: keys[k] });
  return out;
}

/** `rest` plus a `label` that follows the language. */
function labelled<R extends object>(label: () => string, rest: R): R & { label: string } {
  return Object.defineProperty(rest, "label", { enumerable: true, get: label }) as R & { label: string };
}

/** Whether the newest mixdown is current, outdated, or missing: an LED and
 * a word. `short` uses one word (under a Mixdown column header); `compact`
 * keeps just the LED (the word moves to the tooltip). */
export function MixdownBadge({ project, compact = false, short = false }: { project: ProjectInfo; compact?: boolean; short?: boolean }) {
  const f = renderFreshness(project);
  const m = MIX_STATE[f === "fresh" ? "fresh" : f === "none" ? "none" : "stale"];
  const t = tr(T);
  const state = { color: m.color, short: t[`${m.key}Short`], label: t[`${m.key}Label`], title: t[`${m.key}Title`] };
  return (
    <span
      className="flex items-center gap-2 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.08em] text-cream"
      title={state.title}
      role={compact ? "img" : undefined}
      aria-label={compact ? state.label : undefined}
    >
      <StatusDot color={state.color} />
      {!compact && (short ? state.short : state.label)}
    </span>
  );
}

/** Clickable list of songs: title, optional sub-label, right-aligned value. */
export function SongLines({ items, onOpen }: { items: { id: string; title: string; sub?: string; right: string }[]; onOpen: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      {items.map((it) => (
        <button key={it.id} onClick={() => onOpen(it.id)} className="flex items-center gap-3 rounded px-1 py-1 text-left text-xs hover:bg-panel">
          <span className="min-w-0 flex-1 truncate text-cream">{it.title}</span>
          {it.sub && <span className="text-body">{it.sub}</span>}
          <span className="w-20 text-right tabular-nums text-engrave">{it.right}</span>
        </button>
      ))}
    </div>
  );
}

/** One file location: icon, label, detail and a Show-in-folder button on hover. */
export function FileRow({ icon, label, detail, onReveal }: { icon: React.ReactNode; label: string; detail: string; onReveal?: () => void }) {
  return (
    <div className="group flex min-w-0 items-center gap-2 rounded px-1 py-0.5 hover:bg-panel">
      <span className="text-engrave">{icon}</span>
      <span className="w-[92px] shrink-0 text-engrave">{label}</span>
      <span className="min-w-0 flex-1 truncate text-body" title={detail}>
        {detail}
      </span>
      {onReveal && (
        <button
          onClick={onReveal}
          title={tr(T).showInFolder}
          aria-label={tr(T).revealLabel(label)}
          className="shrink-0 rounded p-0.5 text-engrave opacity-0 hover:bg-rule hover:text-cream focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <FolderOpen size={12} />
        </button>
      )}
    </div>
  );
}

/** Where a Launch Kit value came from. Sources differ by shape, not just
 * hue: LED dot (detected, suggested), dashed (AI draft), cream outline
 * (edited), solid orange (needs you). */
export const SOURCE_STYLE: Record<KitField["source"], { label: string; className: string; led?: string }> = {
  detected: labelled(() => tr(T).detected, { className: "border border-rule-strong text-body", led: "#3ddc84" }),
  suggested: labelled(() => tr(T).suggested, { className: "border border-rule-strong text-body", led: "#5598e7" }),
  ai: labelled(() => tr(T).ai, { className: "border border-dashed border-engrave text-body" }),
  edited: labelled(() => tr(T).edited, { className: "border border-cream text-cream" }),
  missing: labelled(() => tr(T).missing, { className: "border border-hot bg-hot font-medium text-chassis" }),
};

/** The source badge for one Launch Kit field. */
export function SourceBadge({ source }: { source: KitField["source"] }) {
  const s = SOURCE_STYLE[source];
  return (
    <span className={`flex items-center gap-1.5 rounded px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.1em] ${s.className}`}>
      {s.led && <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.led }} />}
      {s.label}
    </span>
  );
}

export const VERDICT_LABEL: Record<AiFieldReview["verdict"], string> = live({
  ok: () => tr(T).ok,
  check: () => tr(T).check,
  wrong: () => tr(T).wrong,
});

/** Launch Kit readiness: how many fields need you, or reviewed/ready. */
export function KitStatus({
  missing,
  warnings,
  accepted,
  aiVerified,
  onJump,
}: {
  missing: number;
  warnings: number;
  accepted: boolean;
  aiVerified: boolean;
  /** Go to the next field that needs you (the plate becomes a button). */
  onJump?: () => void;
}) {
  const t = tr(T);
  const plate = "flex items-center gap-2 rounded px-3 py-1 font-display text-[15px] font-bold uppercase tracking-[0.04em]";
  if (missing) {
    const label = t.needYou(missing, warnings);
    return onJump ? (
      <button
        onClick={onJump}
        title={t.nextField}
        className={`${plate} bg-hot text-chassis hover:bg-hot-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream`}
      >
        {label}
      </button>
    ) : (
      <span className={`${plate} bg-hot text-chassis`}>{label}</span>
    );
  }
  return (
    <span className={`${plate} border border-rule-strong text-cream`}>
      <StatusDot color={accepted ? "#3ddc84" : "#ffc233"} />
      {accepted ? t.readyToExport : t.readyToReview}
      {aiVerified && t.aiVerified}
      {warnings ? t.toCheck(warnings) : ""}
    </span>
  );
}

/** A warning (amber LED) or missing-answer (red LED) line. */
export function CheckLine({ check }: { check: KitCheck }) {
  return (
    <div className="flex items-start gap-2 text-xs text-cream">
      <span className="flex h-4 shrink-0 items-center">
        <StatusDot
          color={check.level === "missing" ? "#ff4040" : "#ffc233"}
          size={7}
          label={check.level === "missing" ? tr(T).checkMissing : tr(T).checkWarning}
        />
      </span>
      <span>{check.message}</span>
    </div>
  );
}

/** The AI reviewer's verdict on a field, with its suggestion and a Use button. */
export function AiLine({ review, onUse }: { review: AiFieldReview & { stale: boolean }; onUse: (v: string) => void }) {
  const low = review.confidence < LOW_CONFIDENCE;
  const t = tr(T);
  const led = review.stale ? "#5a5850" : review.verdict === "wrong" ? "#ff4040" : review.verdict === "check" || low ? "#ffc233" : "#3ddc84";
  return (
    <div className="flex flex-col gap-1.5 rounded border border-dashed border-[#5a5850] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className={engrave}>{t.aiReview}</span>
        {review.suggestion && !review.stale && (
          <button
            onClick={() => onUse(review.suggestion!)}
            className="rounded border border-rule-strong px-2.5 py-0.5 font-display text-[13px] font-semibold uppercase tracking-[0.06em] text-cream hover:bg-raised"
          >
            {t.use}
          </button>
        )}
      </div>
      <div className={`flex items-start gap-2 text-xs ${review.stale ? "text-engrave" : "text-body"}`}>
        <span className="flex h-4 shrink-0 items-center">
          <StatusDot color={led} size={7} glow={!review.stale} />
        </span>
        <span>
          <span className="font-medium text-cream">{VERDICT_LABEL[review.verdict]}</span> · {t.sure(Math.round(review.confidence * 100))}
          {low && !review.stale && <span className="ml-1 rounded border border-warn/60 px-1 font-mono text-[10px] uppercase text-warn">{t.lowConfidence}</span>}
          {review.reason && ` · ${review.reason}`}
          {review.stale && t.staleReview}
        </span>
      </div>
      {review.suggestion && !review.stale && (
        <span className="min-w-0 truncate font-mono text-xs text-cream" title={review.suggestion}>
          → {review.suggestion}
        </span>
      )}
    </div>
  );
}

/** One Launch Kit field: label, source badge, note, editor, checks and AI review. */
export function FieldRow({ field, onChange, bare = false }: { field: KitField; onChange: (v: string | undefined) => void; bare?: boolean }) {
  const [copied, setCopied] = useState(false);
  const t = tr(T);
  return (
    <div
      id={`kit-field-${field.id}`}
      data-kit-field={field.id}
      data-needs-you={field.check?.level === "missing" ? "" : undefined}
      className={`flex flex-col gap-1.5 rounded-md ${bare ? "" : "py-3 first:pt-0 last:pb-0"}`}
    >
      <div className="flex items-center gap-2">
        {!bare && <span className="text-xs font-medium text-body">{field.label}</span>}
        <SourceBadge source={field.source} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-engrave" title={field.note}>
          {field.note}
        </span>
        {field.source === "edited" && (
          <button onClick={() => onChange(undefined)} title={t.resetTitle} className="flex items-center gap-1 text-[11px] text-engrave hover:text-cream">
            <RotateCcw size={11} /> {t.reset}
          </button>
        )}
        {field.kind === "multiline" && (
          <button
            onClick={() => {
              navigator.clipboard?.writeText(field.value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="flex items-center gap-1 text-[11px] text-engrave hover:text-cream"
          >
            <ClipboardCopy size={11} /> {copied ? t.copied : t.copy}
          </button>
        )}
      </div>
      {field.kind === "choice" ? (
        <div className="flex gap-1.5">
          {field.options!.map((o) => (
            <button
              key={o}
              onClick={() => onChange(o)}
              className={`rounded-md border px-3 py-1 text-sm ${field.value === o ? "border-cream bg-cream text-chassis" : "border-rule text-body hover:bg-raised"}`}
            >
              {/* The value stays "Yes" / "No" (what distributors expect); only the label is translated. */}
              {o === "Yes" ? tr(T).choiceYes : o === "No" ? tr(T).choiceNo : o}
            </button>
          ))}
        </div>
      ) : field.kind === "multiline" ? (
        <textarea value={field.value} onChange={(e) => onChange(e.target.value)} rows={field.id === "captions" ? 10 : 11} className={`${input} resize-y font-mono text-xs leading-relaxed`} />
      ) : (
        <input
          type={field.kind === "date" ? "date" : "text"}
          value={field.value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.source === "missing" ? t.typeOnce : undefined}
          className={`${input} [color-scheme:dark] ${field.source === "missing" ? "!border-hot" : ""}`}
        />
      )}
      {field.check && <CheckLine check={field.check} />}
      {field.review && <AiLine review={field.review} onUse={(v) => onChange(v)} />}
    </div>
  );
}
