import { useMemo } from "react";
import { AlertTriangle, CalendarDays, Hourglass, Users } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { buildCalendar } from "../lib/calendar";
import { crewActivity, stalledSongs, STALLED_DAYS } from "../lib/crew";
import { formatRelative } from "../lib/format";
import { STATUSES, UNSORTED, statusInfo } from "../lib/songs";
import type { ProjectInfo } from "../types";
import { StatusDot } from "./ui";
import { HeroStat } from "../ui";
import { dict, locale, tr } from "../i18n";

const T = dict(
  {
    nextRelease: "Next release",
    calendar: "Calendar",
    today: "Today",
    tomorrow: "Tomorrow",
    progress: (finished: number, kits: number, total: number) => ` · ${finished}/${total} finished · ${kits}/${total} kits`,
    nothingDated: "Nothing dated yet.",
    planRelease: "Plan a release",
    daysToGo: (n: number) => `day${n === 1 ? "" : "s"} to go`,
    stalledTitle: (days: number) => `Stalled · no save in ${days}+ days`,
    nothingStuck: (days: number) => `Nothing stuck: every unfinished song was saved in the last ${days} days.`,
    idleDays: (n: number) => `${n}d`,
    more: (n: number) => `+${n} more`,
    crewTitle: "Crew · who's on what",
    people: "People",
    addCrewBefore: "Add the crew in",
    addCrewAfter: "to see who's working on what. Names in mixer tracks are picked up automatically.",
    active: (n: number, total: number) => `${total} song${total === 1 ? "" : "s"} · ${n} being made`,
    openPerson: (name: string) => `Open ${name} in People`,
    byStage: "Their songs by stage",
  },
  {
    nextRelease: "Prochaine sortie",
    calendar: "Calendrier",
    today: "Aujourd'hui",
    tomorrow: "Demain",
    progress: (finished: number, kits: number, total: number) =>
      ` · ${finished}/${total} fini${finished > 1 ? "s" : ""} · ${kits}/${total} kits`,
    nothingDated: "Rien de daté pour l'instant.",
    planRelease: "Prévoir une sortie",
    daysToGo: (n: number) => `jour${n === 1 ? "" : "s"} avant la sortie`,
    stalledTitle: (days: number) => `À l'arrêt · pas de sauvegarde depuis ${days}+ jours`,
    nothingStuck: (days: number) =>
      `Rien de bloqué : chaque son pas fini a été sauvegardé dans les ${days} derniers jours.`,
    idleDays: (n: number) => `${n}j`,
    more: (n: number) => `+${n} autres`,
    crewTitle: "Crew · qui bosse sur quoi",
    people: "Personnes",
    addCrewBefore: "Ajoute le crew dans",
    addCrewAfter: "pour voir qui bosse sur quoi. Les noms dans les pistes du mixer sont repérés tout seuls.",
    active: (n: number, total: number) => `${total} son${total > 1 ? "s" : ""} · ${n} en cours`,
    openPerson: (name: string) => `Ouvrir ${name} dans Personnes`,
    byStage: "Ses sons par étape",
  },
);

// Three dashboard blocks: next release, stalled tracks, and (in a crew) who's
// working on what. The dashboard places them; each is its own block there.

/** The next dated release, as a card (date in words) or a countdown (the
 * number of days, hero style). `control` sits at the right of the title. */
export function NextReleaseCard({ variant = "card", control }: { variant?: "card" | "countdown"; control?: React.ReactNode }) {
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const setView = useAppStore((s) => s.setView);
  const openAlbum = useAppStore((s) => s.openAlbum);
  const openLaunchKit = useAppStore((s) => s.openLaunchKit);
  const next = useMemo(() => buildCalendar(projects, workspace).find((e) => e.daysAway >= 0), [projects, workspace]);
  const t = tr(T);

  const open = () => next && (next.source.type === "album" ? openAlbum(next.source.id) : openLaunchKit(next.source.path));
  const warning = next?.checks.find((c) => c.level === "warn");
  return (
    <Card icon={<CalendarDays size={13} />} title={t.nextRelease} action={{ label: t.calendar, run: () => setView("calendar") }} control={control}>
      {!next ? (
        <div className="text-xs text-engrave">
          {t.nothingDated}{" "}
          <button onClick={() => openAlbum(null)} className="underline hover:text-cream">
            {t.planRelease}
          </button>
        </div>
      ) : variant === "countdown" ? (
        <button onClick={open} className="flex w-full flex-col gap-1.5 text-left">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: next.color }} />
            <span className="truncate text-sm font-medium text-cream">{next.title}</span>
          </div>
          <HeroStat
            value={next.daysAway === 0 ? t.today : next.daysAway}
            label={next.daysAway === 0 ? new Date(next.dateMs).toLocaleDateString(locale(), { month: "long", day: "numeric" }) : t.daysToGo(next.daysAway)}
          />
          {warning && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-300">
              <AlertTriangle size={11} className="mt-px shrink-0" /> {warning.message}
            </div>
          )}
        </button>
      ) : (
        <button onClick={open} className="flex w-full flex-col gap-1.5 text-left">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: next.color }} />
            <span className="truncate text-sm font-medium text-cream">{next.title}</span>
          </div>
          <div className="font-display text-3xl leading-none text-cream">
            {next.daysAway === 0 ? t.today : next.daysAway === 1 ? t.tomorrow : formatRelative(next.dateMs)}
          </div>
          <div className="text-[11px] text-body">
            {new Date(next.dateMs).toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric" })}
            {next.tracks.length > 0 && t.progress(next.finished, next.kitsAccepted, next.tracks.length)}
          </div>
          {warning && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-300">
              <AlertTriangle size={11} className="mt-px shrink-0" /> {warning.message}
            </div>
          )}
        </button>
      )}
    </Card>
  );
}

/** Unfinished songs with no save in STALLED_DAYS. */
export function StalledCard({ songs }: { songs: ProjectInfo[] }) {
  const workspace = useAppStore((s) => s.workspace);
  const openDetail = useAppStore((s) => s.openDetail);
  const stalled = useMemo(() => stalledSongs(songs, workspace), [songs, workspace]);
  const t = tr(T);

  return (
    <Card icon={<Hourglass size={13} />} title={t.stalledTitle(STALLED_DAYS)}>
      {stalled.length === 0 ? (
        <div className="text-xs text-engrave">{t.nothingStuck(STALLED_DAYS)}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {stalled.slice(0, 5).map((s) => (
            <button key={s.song.path} onClick={() => openDetail(s.song.path)} className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel">
              <StatusDot color={statusInfo(s.status).color} size={6} />
              <span className="min-w-0 flex-1 truncate text-cream">{s.song.name}</span>
              <span className="shrink-0 tabular-nums text-engrave">{t.idleDays(s.idleDays)}</span>
            </button>
          ))}
          {stalled.length > 5 && <div className="px-1 text-[11px] text-engrave">{t.more(stalled.length - 5)}</div>}
        </div>
      )}
    </Card>
  );
}

/** Who's working on what: the people in the workspace and their songs by
 * stage, by name. Each row opens the person. */
export function CrewWhoCard({ songs }: { songs: ProjectInfo[] }) {
  const workspace = useAppStore((s) => s.workspace);
  const openPerson = useAppStore((s) => s.openPerson);
  const crew = useMemo(() => crewActivity(workspace.people, songs, workspace), [songs, workspace]);
  const t = tr(T);

  return (
    <Card icon={<Users size={13} />} title={t.crewTitle} action={{ label: t.people, run: () => openPerson(null) }}>
      {crew.length === 0 ? (
        <div className="text-xs text-engrave">
          {t.addCrewBefore}{" "}
          <button onClick={() => openPerson(null)} className="underline hover:text-cream">
            {t.people}
          </button>{" "}
          {t.addCrewAfter}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {crew.slice(0, 5).map((m) => (
            <button key={m.person.id} onClick={() => openPerson(m.person.id)} title={t.openPerson(m.person.name)} className="flex flex-col gap-1 rounded px-1 py-0.5 text-left hover:bg-panel">
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-cream">{m.person.name}</span>
                <span className="shrink-0 text-body">
                  {t.active(m.active, m.songs.length)}
                </span>
              </div>
              <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-raised" title={t.byStage}>
                {[{ id: "unsorted" as const, ...UNSORTED }, ...STATUSES].map((st) =>
                  m.byStage[st.id] ? <span key={st.id} style={{ flexGrow: m.byStage[st.id], background: st.color }} /> : null,
                )}
              </div>
            </button>
          ))}
          {crew.length > 5 && (
            <button onClick={() => openPerson(null)} className="self-start px-1 text-[11px] text-engrave underline hover:text-cream">
              {t.more(crew.length - 5)}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function Card({
  icon,
  title,
  action,
  control,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: { label: string; run: () => void };
  /** A variant switch, between the title and the action. */
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full rounded-lg border border-rule bg-panel p-4">
      <div className="mb-3 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">
        {icon} <span className="min-w-0 flex-1 truncate">{title}</span>
        {control}
        {action && (
          <button onClick={action.run} className="shrink-0 font-display text-[13px] font-semibold tracking-[0.06em] text-body hover:text-cream">
            {action.label} →
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
