import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AttentionItem } from "../lib/attention";
import { canRenderInApp, dawOf } from "../lib/daws";
import { useAppStore } from "../store/useAppStore";
import { formatRelative } from "../lib/format";
import { statusInfo } from "../lib/songs";
import { StatusDot } from "../ui";
import { dict, plural, tr } from "../i18n";
import { errorText } from "../lib/errors";

const T = dict(
  {
    empty: "Nothing needs you right now: mixdowns are current and every song opens cleanly.",
    count: (n: number) => `${n} song${plural(n, "", "s")}`,
    previous: "Previous songs",
    more: "More songs",
    list: "Songs that need attention",
    renderNow: "Render now",
    lastActivity: (when: string) => `Last activity ${when}`,
  },
  {
    empty: "Rien à compléter pour l'instant : les mixdowns sont à jour et chaque son s'ouvre sans souci.",
    count: (n: number) => `${n} son${plural(n, "", "s")}`,
    previous: "Sons précédents",
    more: "Plus de sons",
    list: "Sons qui demandent ton attention",
    renderNow: "Faire le rendu maintenant",
    lastActivity: (when: string) => `Dernière activité ${when}`,
  },
);

const LEVEL: Record<string, string> = {
  "no-mixdown": "#ff4040",
  "stale-mixdown": "#ffc233",
  "missing-samples": "#ffc233",
  "missing-plugins": "#ffc233",
};

/** Songs with something to fix, as a horizontal row of cards: drag or swipe
 * with a trackpad or touch, the arrow buttons, or ←/→ when the row has focus. */
export function AttentionCarousel({ items, label, onOpen }: { items: AttentionItem[]; label: (i: AttentionItem) => string; onOpen: (path: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const demoMode = useAppStore((s) => s.demoMode);
  const rendering = useAppStore((s) => s.rendering);

  const measure = () => {
    const el = row.current;
    if (!el) return;
    // A few px of slack: snap padding leaves the row a little off zero.
    setEdges({ start: el.scrollLeft <= 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(() => {
    measure();
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);

  const page = (dir: 1 | -1) => {
    const el = row.current;
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: reduced ? "auto" : "smooth" });
  };

  if (!items.length) {
    return <div className="text-xs text-engrave">{tr(T).empty}</div>;
  }

  const arrow = "flex h-7 w-7 items-center justify-center rounded border border-rule text-body hover:bg-raised hover:text-cream disabled:opacity-30";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-engrave">
        <span className="flex-1">
          {tr(T).count(items.length)}
        </span>
        <button onClick={() => page(-1)} disabled={edges.start} aria-label={tr(T).previous} className={arrow}>
          <ChevronLeft size={14} />
        </button>
        <button onClick={() => page(1)} disabled={edges.end} aria-label={tr(T).more} className={arrow}>
          <ChevronRight size={14} />
        </button>
      </div>
      <div
        ref={row}
        role="list"
        aria-label={tr(T).list}
        tabIndex={0}
        onScroll={measure}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "ArrowRight") (e.preventDefault(), page(1));
          if (e.key === "ArrowLeft") (e.preventDefault(), page(-1));
        }}
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-cream/40"
      >
        {items.map((i) => {
          const stage = statusInfo(i.status);
          return (
            <div key={i.song.path} role="listitem" className="w-60 shrink-0 snap-start">
              <button
                onClick={() => onOpen(i.song.path)}
                title={i.song.path}
                className="flex h-full w-full flex-col gap-2 rounded-md border border-rule bg-raised p-3 text-left hover:border-rule-strong focus-visible:outline-2 focus-visible:outline-cream"
              >
                <span className="truncate text-sm font-medium text-cream">{label(i)}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-body">
                  <StatusDot color={stage.color} size={7} />
                  {stage.label}
                  <span className="text-engrave">· {dawOf(i.song).label}</span>
                </span>
                <span className="flex flex-col gap-1">
                  {i.reasons.map((r) => (
                    <span key={r.kind} className="flex items-start gap-1.5 text-xs text-cream">
                      <span className="flex h-4 items-center">
                        <StatusDot color={LEVEL[r.kind]} size={6} />
                      </span>
                      {r.text}
                    </span>
                  ))}
                </span>
                <span className="mt-auto text-[11px] text-engrave">{tr(T).lastActivity(formatRelative(i.lastActivityMs))}</span>
              </button>
              {/* "No mixdown" / "outdated": render it from here (FL Studio projects). */}
              {i.reasons.some((r) => r.kind === "no-mixdown" || r.kind === "stale-mixdown") && canRenderInApp(i.song) && !demoMode && (
                <button
                  onClick={() =>
                    void useAppStore
                      .getState()
                      .startRender([i.song.path])
                      .catch((e) => useAppStore.setState({ actionError: errorText(e) }))
                  }
                  disabled={rendering}
                  className="mt-1.5 w-full rounded border border-rule-strong px-2 py-1 text-[11px] text-body hover:bg-raised hover:text-cream disabled:opacity-50"
                >
                  {tr(T).renderNow}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
