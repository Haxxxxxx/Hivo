import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Minus, Pause, Pin, PinOff, Play, Plus } from "lucide-react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyLang, dict, tr } from "../i18n";
import { barMs, clampCursor, FONT_SIZES, moveSection, nextLine, sessionSections, type Cursor, type SessionPayload } from "../lib/session";
import { btn, btnPrimary, engrave } from "../ui";

// The session view's window (src-tauri/src/session.rs): the lyrics large,
// section by section, kept on top of FL Studio. The main window sends the
// text (src/store/sessionBridge.ts); this window only reads it.
// Keys: ↓/→/PageDown next section, ↑/←/PageUp previous, Space auto-scroll
// (one line per bar at the song's tempo), + / − text size, Home the start.

const T = dict(
  {
    waiting: "Waiting for Hivo…",
    empty: "Nothing written yet.",
    emptyHint: "Write the lyrics in the notes: they show here as you type. [Verse 1], [Hook]… lines start sections.",
    openNotes: "Open the notes",
    gone: "This isn't in Hivo's library any more: the last text stays here.",
    prev: "Previous section (↑)",
    next: "Next section (↓)",
    play: "Auto-scroll, one line per bar (Space)",
    pause: "Stop scrolling (Space)",
    smaller: "Smaller text (−)",
    bigger: "Bigger text (+)",
    pinOn: "Keep on top: on",
    pinOff: "Keep on top: off",
    bpm: (n: number) => `${Math.round(n)} BPM`,
    noBpm: "90 BPM (no tempo known)",
    section: (n: number, of: number) => `${n} / ${of}`,
    end: "End",
  },
  {
    waiting: "En attente de Hivo…",
    empty: "Rien d'écrit pour l'instant.",
    emptyHint: "Écris le texte dans les notes : il s'affiche ici pendant que tu tapes. Les lignes [Couplet 1], [Refrain]… ouvrent les parties.",
    openNotes: "Ouvrir les notes",
    gone: "Ce n'est plus dans la bibliothèque de Hivo : le dernier texte reste affiché.",
    prev: "Partie précédente (↑)",
    next: "Partie suivante (↓)",
    play: "Défilement, une ligne par mesure (Espace)",
    pause: "Arrêter le défilement (Espace)",
    smaller: "Texte plus petit (−)",
    bigger: "Texte plus grand (+)",
    pinOn: "Toujours devant : oui",
    pinOff: "Toujours devant : non",
    bpm: (n: number) => `${Math.round(n)} BPM`,
    noBpm: "90 BPM (tempo inconnu)",
    section: (n: number, of: number) => `${n} / ${of}`,
    end: "Fin",
  },
);

const SIZE_KEY = "hivo.session.size";

function readSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return FONT_SIZES.includes(n) ? n : 34;
  } catch {
    return 34;
  }
}

export function SessionWindow() {
  const [data, setData] = useState<SessionPayload | null>(null);
  const [cursor, setCursor] = useState<Cursor>({ section: 0, line: 0 });
  const [playing, setPlaying] = useState(false);
  const [size, setSize] = useState(readSize);
  const [onTop, setOnTop] = useState(true);
  const [, setLangTick] = useState(0);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const lineRef = useRef<HTMLParagraphElement | null>(null);
  const t = tr(T);

  // Text from the main window; say hello so it sends the current one.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let live = true;
    void listen<SessionPayload>("session-text", (e) => {
      // Kept when the target is gone: the last text stays readable.
      setData((prev) => (e.payload.gone && prev && prev.id === e.payload.id ? { ...prev, gone: true } : e.payload));
      applyLang(e.payload.lang);
      setLangTick((n) => n + 1);
    }).then((u) => {
      if (live) unlisten = u;
      else u();
    });
    void emitTo("main", "session-hello", null).catch(() => {});
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  // Another song opened in the same window: back to the top, stopped.
  const targetId = data ? `${data.kind}:${data.id}` : "";
  useEffect(() => {
    setCursor({ section: 0, line: 0 });
    setPlaying(false);
  }, [targetId]);

  const sections = useMemo(() => sessionSections(data?.text ?? ""), [data?.text]);
  const pos = clampCursor(sections, cursor);

  const go = useCallback((step: number) => setCursor((c) => moveSection(sections, clampCursor(sections, c), step)), [sections]);

  // Auto-scroll: one line per bar.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setCursor((c) => {
        const n = nextLine(sections, clampCursor(sections, c));
        if (!n) setPlaying(false);
        return n ?? c;
      });
    }, barMs(data?.bpm ?? null));
    return () => clearInterval(id);
  }, [playing, sections, data?.bpm]);

  useEffect(() => {
    const target = playing ? lineRef.current : sectionRefs.current[pos.section];
    // Smooth only for those who don't ask the system for less motion.
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    target?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: playing ? "center" : "start" });
  }, [pos.section, pos.line, playing]);

  const resize = useCallback((step: number) => {
    setSize((s) => {
      const i = Math.min(FONT_SIZES.length - 1, Math.max(0, FONT_SIZES.indexOf(s) + step));
      const next = FONT_SIZES[i];
      try {
        localStorage.setItem(SIZE_KEY, String(next));
      } catch {
        /* a convenience only */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (["ArrowDown", "ArrowRight", "PageDown"].includes(e.key)) go(1);
      else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) go(-1);
      else if (e.key === " ") setPlaying((p) => !p);
      else if (e.key === "+" || e.key === "=") resize(1);
      else if (e.key === "-" || e.key === "_") resize(-1);
      else if (e.key === "Home") setCursor({ section: 0, line: 0 });
      else if (e.key === "Escape") setPlaying(false);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, resize]);

  const togglePin = () => {
    const next = !onTop;
    setOnTop(next);
    void getCurrentWindow().setAlwaysOnTop(next).catch(() => setOnTop(!next));
  };

  if (!data) {
    return <div className="flex h-screen items-center justify-center bg-chassis text-sm text-engrave">{t.waiting}</div>;
  }

  return (
    <div className="flex h-screen flex-col bg-chassis text-cream">
      <header className="flex items-center gap-2 border-b border-rule bg-panel px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-lg uppercase leading-tight tracking-tight">{data.title}</div>
          <div className={engrave}>
            {data.bpm ? t.bpm(data.bpm) : t.noBpm}
            {sections.length > 0 && ` · ${t.section(pos.section + 1, sections.length)}`}
          </div>
        </div>
        <button className={btn} onClick={() => go(-1)} title={t.prev} aria-label={t.prev}>
          <ChevronUp size={15} />
        </button>
        <button className={btn} onClick={() => go(1)} title={t.next} aria-label={t.next}>
          <ChevronDown size={15} />
        </button>
        <button className={playing ? btnPrimary : btn} onClick={() => setPlaying((p) => !p)} title={playing ? t.pause : t.play} aria-label={playing ? t.pause : t.play} disabled={sections.length === 0}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button className={btn} onClick={() => resize(-1)} title={t.smaller} aria-label={t.smaller}>
          <Minus size={15} />
        </button>
        <button className={btn} onClick={() => resize(1)} title={t.bigger} aria-label={t.bigger}>
          <Plus size={15} />
        </button>
        <button className={btn} onClick={togglePin} title={onTop ? t.pinOn : t.pinOff} aria-label={onTop ? t.pinOn : t.pinOff}>
          {onTop ? <Pin size={15} /> : <PinOff size={15} />}
        </button>
      </header>

      {data.gone && <div className="border-b border-rule bg-panel px-3 py-1.5 text-xs text-warn">{t.gone}</div>}

      <main className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {sections.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 pt-16 text-center">
            <p className="font-display text-2xl uppercase">{t.empty}</p>
            <p className="text-sm text-body">{t.emptyHint}</p>
            <button className={btn} onClick={() => void emitTo("main", "session-open-notes", null).catch(() => {})}>
              {t.openNotes}
            </button>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-8 pb-[50vh]">
            {sections.map((s, i) => {
              const current = i === pos.section;
              return (
                <section
                  key={i}
                  ref={(el) => {
                    sectionRefs.current[i] = el;
                  }}
                  onClick={() => setCursor({ section: i, line: 0 })}
                  className={`cursor-pointer transition-opacity ${current ? "opacity-100" : "opacity-35"}`}
                >
                  {s.heading && <h2 className={`${engrave} mb-2 text-[12px] ${current ? "text-hot" : ""}`}>{s.heading}</h2>}
                  {s.lines.map((line, j) => {
                    const on = playing && current && j === pos.line;
                    return (
                      <p
                        key={j}
                        ref={on ? lineRef : undefined}
                        style={{ fontSize: size, lineHeight: 1.25 }}
                        className={`font-medium ${on ? "text-cream" : playing && current ? "text-body" : ""}`}
                      >
                        {line}
                      </p>
                    );
                  })}
                </section>
              );
            })}
            <div className={`${engrave} text-center`}>{t.end}</div>
          </div>
        )}
      </main>
    </div>
  );
}
