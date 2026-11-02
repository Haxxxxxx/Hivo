import { useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronDown, Info, Plus } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { buildCalendar, monthLabel, undatedReleased, type CalendarEntry } from "../lib/calendar";
import { formatRelative } from "../lib/format";
import { btn, btnPrimary } from "./ui";
import { Meter } from "../ui";
import { dict, locale, plural, tr } from "../i18n";

const T = dict(
  {
    album: "Album",
    ep: "EP",
    single: "Single",
    mixtape: "Mixtape",
    title: "Release calendar",
    planRelease: "Plan a release",
    undated: (n: number) => `${n} song${plural(n, "", "s")} in Release or Promotion ${plural(n, "has", "have")} no date, so ${plural(n, "it isn't", "they aren't")} on the calendar. Give ${plural(n, "it", "them")} a date in the Launch Kit or on a release.`,
    noDates: "No release dates yet",
    noDatesHint: "Give a release a date in Releases, or set a release date in a song's Launch Kit. It shows up here with how ready it is.",
    nothingPlanned: (when: string) => `Nothing planned. The last release was ${when}.`,
    released: (n: number) => `Released · ${n}`,
    showFewer: "Show fewer",
    showAll: (n: number) => `Show all ${n}`,
    today: "Today",
    tomorrow: "Tomorrow",
    tracks: (n: number) => `${n} track${plural(n, "", "s")}`,
    finished: "Finished (Prep or later)",
    kitAccepted: "Launch Kit accepted",
  },
  {
    album: "Album",
    ep: "EP",
    single: "Single",
    mixtape: "Mixtape",
    title: "Calendrier des sorties",
    planRelease: "Prévoir une sortie",
    undated: (n: number) => `${n} son${plural(n, "", "s")} en Sortie ou Promo ${plural(n, "n'a", "n'ont")} pas de date, donc pas dans le calendrier. Donne-${plural(n, "lui", "leur")} une date dans le Launch Kit ou sur une sortie.`,
    noDates: "Pas encore de date de sortie",
    noDatesHint:
      "Donne une date à une sortie dans Sorties, ou mets une date de sortie dans le Launch Kit d'un son. Elle s'affiche ici avec où elle en est.",
    nothingPlanned: (when: string) => `Rien de prévu. La dernière sortie, c'était ${when}.`,
    released: (n: number) => `Sorties passées · ${n}`,
    showFewer: "Afficher moins",
    showAll: (n: number) => `Tout afficher (${n})`,
    today: "Aujourd'hui",
    tomorrow: "Demain",
    tracks: (n: number) => `${n} morceau${plural(n, "", "x")}`,
    finished: "Finis (Prépa ou après)",
    kitAccepted: "Launch Kit validé",
  },
);

/** Planned and past releases, with how ready each one is. */
export function CalendarView() {
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const openAlbum = useAppStore((s) => s.openAlbum);
  const openLaunchKit = useAppStore((s) => s.openLaunchKit);
  const [showAllPast, setShowAllPast] = useState(false);
  const t = tr(T);

  const entries = useMemo(() => buildCalendar(projects, workspace), [projects, workspace]);
  const undated = useMemo(() => undatedReleased(projects, workspace), [projects, workspace]);
  const upcoming = entries.filter((e) => e.daysAway >= 0);
  const past = entries.filter((e) => e.daysAway < 0).reverse();
  const months = useMemo(() => {
    const groups: { label: string; items: CalendarEntry[] }[] = [];
    for (const e of upcoming) {
      const label = monthLabel(e.dateMs);
      const last = groups[groups.length - 1];
      if (last?.label === label) last.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  }, [upcoming]);

  const open = (e: CalendarEntry) => (e.source.type === "album" ? openAlbum(e.source.id) : openLaunchKit(e.source.path));

  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <header className="flex items-center gap-3">
          <CalendarDays size={18} className="text-orange-300" />
          <div>
            <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{t.title}</h1>
          </div>
          <button onClick={() => openAlbum(null)} className={`${btn} ml-auto`}>
            <Plus size={14} /> {t.planRelease}
          </button>
        </header>

        {entries.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-rule bg-panel px-6 py-12 text-center">
            <CalendarDays size={28} className="text-body" />
            <div className="text-sm font-medium text-cream">{t.noDates}</div>
            <div className="max-w-sm text-xs text-body">
              {t.noDatesHint}
            </div>
            <button onClick={() => openAlbum(null)} className={btnPrimary}>
              {t.planRelease}
            </button>
          </div>
        )}

        {undated > 0 && <div className="rounded-lg border border-rule bg-panel px-4 py-3 text-xs text-body">{t.undated(undated)}</div>}

        {upcoming.length === 0 && entries.length > 0 && (
          <div className="rounded-lg border border-rule bg-panel px-4 py-3 text-xs text-engrave">{t.nothingPlanned(formatRelative(past[0].dateMs))}</div>
        )}

        {months.map((m) => (
          <section key={m.label} className="flex flex-col gap-2">
            <h2 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{m.label}</h2>
            {m.items.map((e) => (
              <Row key={e.key} entry={e} onOpen={() => open(e)} />
            ))}
          </section>
        ))}

        {past.length > 0 && (
          <section className="flex flex-col gap-2 border-t border-rule pt-5">
            <h2 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{t.released(past.length)}</h2>
            {(showAllPast ? past : past.slice(0, 5)).map((e) => (
              <Row key={e.key} entry={e} onOpen={() => open(e)} past />
            ))}
            {past.length > 5 && (
              <button onClick={() => setShowAllPast((v) => !v)} className="flex items-center gap-1 self-start text-xs text-body hover:text-cream">
                <ChevronDown size={13} className={showAllPast ? "rotate-180" : ""} /> {showAllPast ? t.showFewer : t.showAll(past.length)}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ entry: e, onOpen, past = false }: { entry: CalendarEntry; onOpen: () => void; past?: boolean }) {
  const d = new Date(e.dateMs);
  const total = e.tracks.length;
  const t = tr(T);
  const countdown = e.daysAway === 0 ? t.today : e.daysAway === 1 ? t.tomorrow : formatRelative(e.dateMs);
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-start gap-4 rounded-lg border border-rule bg-panel p-3 text-left hover:border-rule-strong hover:bg-raised ${past ? "opacity-70" : ""}`}
    >
      <div className="flex w-14 shrink-0 flex-col items-center rounded-md bg-raised py-1.5">
        <span className="text-[12px] font-semibold text-body">{d.toLocaleDateString(locale(), { weekday: "short" })}</span>
        <span className="font-display text-2xl leading-none text-cream">{d.getDate()}</span>
        <span className="text-[10px]  text-body">{d.toLocaleDateString(locale(), { month: "short" })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: e.color }} />
          <span className="truncate text-sm font-medium text-cream">{e.title}</span>
          <span className="shrink-0 rounded bg-rule px-1.5 py-px text-[10px] text-body">{t[e.kind]}</span>
          <span className={`ml-auto shrink-0 text-xs ${e.daysAway >= 0 && e.daysAway < 7 ? "text-orange-300" : "text-body"}`}>{countdown}</span>
        </div>
        <div className="mt-1 truncate text-[11px] text-engrave">
          {t.tracks(total)}
          {total > 0 && total <= 4 && ` · ${e.tracks.map((t) => t.name).join(", ")}`}
        </div>
        {total > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-3 text-[11px]">
            <Meter label={t.finished} value={e.finished} total={total} />
            <Meter label={t.kitAccepted} value={e.kitsAccepted} total={total} />
          </div>
        )}
        {e.checks.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            {e.checks.map((c) => (
              <div key={c.message} className={`flex items-start gap-1.5 text-[11px] ${c.level === "warn" ? "text-amber-300" : "text-body"}`}>
                {c.level === "warn" ? <AlertTriangle size={11} className="mt-px shrink-0" /> : <Info size={11} className="mt-px shrink-0" />}
                {c.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
