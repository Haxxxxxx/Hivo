import { useMemo, useState } from "react";
import { Pencil } from "lucide-react";
import { parseNoteSections } from "../lib/lyrics";
import { MAX_NOTE_CHARS } from "../lib/notes";
import { dict, locale, plural, tr } from "../i18n";
import { engrave } from "../ui";

// A note with two modes: Read (the note laid out as lyrics: `[Hook]` lines
// as section headings, a syllable count on every line) and Edit (a plain
// monospace textarea, saved as you type by the caller's `onChange`). Used by
// the Digger's notes panel (beats and saved prods) and the song drawer.
// Remount it (`key`) when it switches to another note.

const T = dict(
  {
    read: "Read",
    edit: "Edit",
    modes: "Notes view",
    empty: "No notes yet",
    emptyHint: "Lyrics, flow ideas, what to change. Put [Verse 1] or [Hook] on its own line for a section.",
    placeholder: "Lyrics, flow ideas, what to change…\n\n[Hook]\n…",
    label: "Notes",
    count: (n: string, max: string) => `${n} / ${max}`,
    syllables: (n: number) => `${n} syllable${plural(n, "", "s")}`,
  },
  {
    read: "Lire",
    edit: "Écrire",
    modes: "Affichage des notes",
    empty: "Pas encore de notes",
    emptyHint: "Paroles, idées de flow, ce qu'il faut changer. Mets [Couplet 1] ou [Refrain] seul sur une ligne pour une partie.",
    placeholder: "Paroles, idées de flow, ce qu'il faut changer…\n\n[Refrain]\n…",
    label: "Notes",
    count: (n: string, max: string) => `${n} / ${max}`,
    syllables: (n: number) => `${n} syllabe${plural(n, "", "s")}`,
  },
);

const tabClass = (on: boolean) =>
  `rounded border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] ${on ? "border-cream bg-cream text-chassis" : "border-rule-strong text-engrave hover:text-cream"}`;

interface Props {
  value: string | undefined;
  onChange: (text: string) => void;
  /** Take the parent's height (the Digger's panel); otherwise sized to the note (the song drawer). */
  fill?: boolean;
  /** The Edit mode's placeholder (a default suits lyrics). */
  placeholder?: string;
}

export function NotesEditor({ value, onChange, fill = false, placeholder }: Props) {
  const t = tr(T);
  const text = value ?? "";
  const [mode, setMode] = useState<"read" | "edit">("read");
  const lines = useMemo(() => parseNoteSections(text), [text]);
  const fmt = (n: number) => n.toLocaleString(locale());

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${fill ? "flex-1" : ""}`}>
      <div role="tablist" aria-label={t.modes} className="flex items-center gap-1.5">
        <button type="button" role="tab" aria-selected={mode === "read"} onClick={() => setMode("read")} className={tabClass(mode === "read")}>
          {t.read}
        </button>
        <button type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")} className={tabClass(mode === "edit")}>
          {t.edit}
        </button>
        {mode === "edit" && (
          <span className={`ml-auto tabular-nums ${engrave}`} aria-live="polite">
            {t.count(fmt(text.length), fmt(MAX_NOTE_CHARS))}
          </span>
        )}
      </div>

      {mode === "edit" ? (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? t.placeholder}
          aria-label={t.label}
          maxLength={MAX_NOTE_CHARS}
          autoFocus
          rows={fill ? undefined : Math.min(18, Math.max(6, text.split("\n").length + 1))}
          className={`w-full resize-none rounded border border-rule bg-chassis px-3 py-2.5 font-mono text-xs leading-relaxed text-cream placeholder:text-engrave focus:border-hot focus:outline-none ${fill ? "min-h-0 flex-1" : "resize-y"}`}
        />
      ) : lines.length === 0 ? (
        <div className={`flex flex-col items-start gap-2 rounded border border-dashed border-rule-strong px-3 py-4 ${fill ? "flex-1" : ""}`}>
          <p className="text-sm text-cream">{t.empty}</p>
          <p className="text-[11px] leading-relaxed text-engrave">{t.emptyHint}</p>
          <button type="button" onClick={() => setMode("edit")} className="mt-1 flex items-center gap-1.5 rounded border border-rule-strong px-2.5 py-1.5 text-xs font-semibold text-cream hover:border-cream">
            <Pencil size={11} aria-hidden /> {t.edit}
          </button>
        </div>
      ) : (
        <div className={`rounded border border-rule bg-chassis px-3 py-2.5 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
          {lines.map((line, i) =>
            line.kind === "heading" ? (
              <h4 key={i} className={`font-display text-[13px] font-semibold uppercase tracking-[0.08em] text-engrave ${i > 0 ? "mt-2" : ""}`}>
                {line.text}
              </h4>
            ) : line.kind === "blank" ? (
              <div key={i} className="h-3" aria-hidden />
            ) : (
              <p key={i} className="flex items-baseline gap-3 text-sm leading-relaxed text-cream">
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.text}</span>
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-engrave" title={t.syllables(line.syllables)}>
                  {line.syllables}
                </span>
              </p>
            ),
          )}
        </div>
      )}
    </div>
  );
}
