// The Me dashboard's optional tendency blocks: Tempo & key, Working hours,
// Your sound, Collaborators, Song shape. Hidden until added from the tray.
// All five read src/lib/tendencies.ts and only draw. Charts follow the
// activity curve: one neutral series in cream on a hairline grid, direct
// labels where they help, a tooltip on hover, text never in a data colour.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../store/useAppStore";
import { useVisibleSongs } from "./LibraryView";
import { T_LAYOUT, type TendencyBlockId } from "./DashboardEdit";
import { HeroStat, engrave } from "../ui";
import { formatRelative } from "../lib/format";
import {
  BPM_BIN,
  HOUR_WINDOW,
  NOT_LATELY_DAYS,
  RECENT_COLLAB_DAYS,
  collaborators,
  isFromFileDates,
  keyName,
  pace,
  songShape,
  tempoKeyTendencies,
  weekdayRun,
  workingHours,
  yourSound,
  type Chronotype,
} from "../lib/tendencies";
import { statusInfo } from "../lib/songs";
import { dict, locale, tr } from "../i18n";

const s = (n: number) => (n === 1 ? "" : "s");
const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
/** The cream ramp of the activity heatmap, as opacities over the raised surface. */
const HEAT_STEPS = [0, 0.25, 0.5, 0.75, 1];
const CHART_H = 96;

const T = dict(
  {
    // Looks
    bars: "Bars",
    list: "List",
    grid: "Grid",
    summary: "Summary",
    top: "Top",
    shifts: "Shifts",
    recent: "Recent",
    numbers: "Numbers",
    starts: "Starts",
    // Tempo & key
    typical: (parts: string[]) => `Typical: ${parts.join(" · ")}`,
    bpmBin: (from: number) => `${from}–${from + BPM_BIN} BPM`,
    minor: "minor",
    major: "major",
    scanFew: "Scan a few songs to see your tendencies.",
    tempos: (n: number) => `Tempos · ${n} song${s(n)}`,
    keys: "Keys",
    noKeys: "No keys set yet — set one in a song's panel.",
    songsN: (n: number) => `${n} song${s(n)}`,
    // Working hours
    weekdays: "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
    mostSaves: (days: string, hours: string) => `Most saves: ${days}, ${hours}`,
    hourRange: (from: number) => `${hh(from)}–${hh(from + HOUR_WINDOW)}`,
    chronotype: (c: Chronotype) => ({ nightOwl: "Night owl", earlyBird: "Early bird", officeHours: "Office hours" })[c],
    profile: "Profile",
    savesYear: "Saves, 12 months",
    saves: (n: number) => `${n} save${s(n)}`,
    noSaves: "No saves in the last 12 months.",
    less: "Less",
    more: "More",
    // Your sound
    plugins: "Plugins",
    folders: "Sample folders",
    regulars: (n: number) => `Regulars — in half or more of your last ${n} songs`,
    dropped: (n: number) => `Dropped lately — 3+ songs, none of the last ${n}`,
    noRegulars: "Nothing is in half of your recent songs yet.",
    noDropped: "Nothing you used to lean on has gone quiet.",
    noSound: "No plugins or samples read from your songs yet.",
    kindPlugin: "plugin",
    kindFolder: "folder",
    // Collaborators
    addCredits: "Add credits in a song's panel to see this.",
    workedRecently: (days: number) => `Worked with in the last ${days} days`,
    notLately: (days: number) => `Not lately — nothing in ${days}+ days`,
    nobodyRecent: "No one in that window.",
    everyoneRecent: "Everyone's been around.",
    // Song shape
    versions: "Versions per song",
    daysToMix: "Days to first mixdown",
    withMix: "With a mixdown",
    median: "median",
    noMix: "No mixdown yet",
    startsTitle: "Songs started per month, last 12 months · the number above a bar = finished since",
    started: (n: number) => `${n} started`,
    finished: (n: number) => `${n} finished`,
    perMonthMax: (n: number) => `max ${n}`,
    noStarts: "No song started in the last 12 months.",
    daysIn: (stage: string) => `Days in ${stage}`,
    fromStageLog: "Days in each stage come from Hivo's stage log, not from file dates.",
    // Pace
    paceStages: "By stage",
    paceNow: "Running long",
    paceCollecting: (since: string | null) =>
      since
        ? `Collecting: Hivo has logged stage moves since ${since}. This fills in once songs have moved on from a stage.`
        : "Collecting: this fills in as songs move from one stage to the next.",
    stallsIn: (stage: string) => `Songs stay longest in ${stage}`,
    daysMedian: (n: number) => `${n} day${s(n)}`,
    stays: (n: number) => `${n} stay${s(n)}`,
    nothingLong: "Nothing's running long: every song is within its stage's usual time.",
    longFor: (days: number, stage: string, usual: number) => `${days} days in ${stage} · usually ${usual}`,
    // File-date blocks
    approx: "Approximate: from file dates",
    approxWhy:
      "Read from the dates on your project, backup and render files. Copying or syncing a folder, or FL Studio pruning old backups, changes those dates, so treat these numbers as estimates.",
  },
  {
    bars: "Barres",
    list: "Liste",
    grid: "Grille",
    summary: "Résumé",
    top: "Top",
    shifts: "Évolution",
    recent: "Récents",
    numbers: "Chiffres",
    starts: "Démarrages",
    typical: (parts: string[]) => `Typique : ${parts.join(" · ")}`,
    bpmBin: (from: number) => `${from}–${from + BPM_BIN} BPM`,
    minor: "mineur",
    major: "majeur",
    scanFew: "Scanne quelques sons pour voir tes tendances.",
    tempos: (n: number) => `Tempos · ${n} son${s(n)}`,
    keys: "Tonalités",
    noKeys: "Pas encore de tonalité — note-la dans le panneau d'un son.",
    songsN: (n: number) => `${n} son${s(n)}`,
    weekdays: "Lun,Mar,Mer,Jeu,Ven,Sam,Dim",
    mostSaves: (days: string, hours: string) => `Le plus de sauvegardes : ${days}, ${hours}`,
    hourRange: (from: number) => `${hh(from)}–${hh(from + HOUR_WINDOW)}`,
    chronotype: (c: Chronotype) => ({ nightOwl: "Oiseau de nuit", earlyBird: "Lève-tôt", officeHours: "Heures de bureau" })[c],
    profile: "Profil",
    savesYear: "Sauvegardes, 12 mois",
    saves: (n: number) => `${n} sauvegarde${s(n)}`,
    noSaves: "Aucune sauvegarde ces 12 derniers mois.",
    less: "Moins",
    more: "Plus",
    plugins: "Plugins",
    folders: "Dossiers de samples",
    regulars: (n: number) => `Habitués — dans la moitié ou plus de tes ${n} derniers sons`,
    dropped: (n: number) => `Délaissés — 3 sons ou plus, aucun des ${n} derniers`,
    noRegulars: "Rien n'est encore dans la moitié de tes sons récents.",
    noDropped: "Rien de ce que tu utilisais n'a disparu.",
    noSound: "Aucun plugin ni sample lu dans tes sons pour l'instant.",
    kindPlugin: "plugin",
    kindFolder: "dossier",
    addCredits: "Ajoute des crédits dans le panneau d'un son pour voir ça.",
    workedRecently: (days: number) => `Avec qui tu as bossé ces ${days} derniers jours`,
    notLately: (days: number) => `Pas récemment — rien depuis ${days}+ jours`,
    nobodyRecent: "Personne sur cette période.",
    everyoneRecent: "Tout le monde est dans le coin.",
    versions: "Versions par son",
    daysToMix: "Jours jusqu'au premier mixdown",
    withMix: "Avec un mixdown",
    median: "médiane",
    noMix: "Pas encore de mixdown",
    startsTitle: "Sons démarrés par mois, 12 derniers mois · le chiffre au-dessus d'une barre = finis depuis",
    started: (n: number) => `${n} démarré${s(n)}`,
    finished: (n: number) => `${n} fini${s(n)}`,
    perMonthMax: (n: number) => `max ${n}`,
    noStarts: "Aucun son démarré ces 12 derniers mois.",
    daysIn: (stage: string) => `Jours en ${stage}`,
    fromStageLog: "Les jours par étape viennent du journal des étapes de Hivo, pas des dates des fichiers.",
    // Pace
    paceStages: "Par étape",
    paceNow: "Ça traîne",
    paceCollecting: (since: string | null) =>
      since
        ? `En cours${" "}: Hivo note les changements d'étape depuis ${since}. Ça se remplit quand des sons passent à l'étape suivante.`
        : "En cours : ça se remplit à mesure que tes sons passent d'une étape à la suivante.",
    stallsIn: (stage: string) => `Tes sons restent le plus longtemps en ${stage}`,
    daysMedian: (n: number) => `${n} jour${n < 2 ? "" : "s"}`,
    stays: (n: number) => `${n} passage${n < 2 ? "" : "s"}`,
    nothingLong: "Rien ne traîne : chaque son est dans le temps habituel de son étape.",
    longFor: (days: number, stage: string, usual: number) => `${days} jours en ${stage} · d'habitude ${usual}`,
    approx: "Approximatif : d'après les dates des fichiers",
    approxWhy:
      "Lu dans les dates de tes fichiers de projet, de sauvegarde et de rendu. Copier ou synchroniser un dossier, ou FL Studio qui supprime les vieilles sauvegardes, change ces dates : prends ces chiffres comme des estimations.",
  },
);

/** The A/B options of a tendency block, in the current language. */
export function tendencyLooks(id: TendencyBlockId): { id: string; label: string }[] {
  const t = tr(T);
  const looks: Record<TendencyBlockId, { id: string; label: string }[]> = {
    tempoKey: [
      { id: "bars", label: t.bars },
      { id: "list", label: t.list },
    ],
    workingHours: [
      { id: "grid", label: t.grid },
      { id: "summary", label: t.summary },
    ],
    yourSound: [
      { id: "top", label: t.top },
      { id: "shifts", label: t.shifts },
    ],
    collaborators: [
      { id: "top", label: t.top },
      { id: "recent", label: t.recent },
    ],
    songShape: [
      { id: "numbers", label: t.numbers },
      { id: "starts", label: t.starts },
    ],
    pace: [
      { id: "stages", label: t.paceStages },
      { id: "now", label: t.paceNow },
    ],
  };
  return looks[id];
}

/** One tendency block, by id and chosen look. `control` is the A/B switch from the dashboard. */
export function TendencyBlock({ id, variant, control }: { id: TendencyBlockId; variant: string; control: ReactNode }) {
  switch (id) {
    case "tempoKey":
      return <TempoKeyBlock list={variant === "list"} control={control} />;
    case "workingHours":
      return <WorkingHoursBlock summary={variant === "summary"} control={control} />;
    case "yourSound":
      return <YourSoundBlock shifts={variant === "shifts"} control={control} />;
    case "collaborators":
      return <CollaboratorsBlock recent={variant === "recent"} control={control} />;
    case "songShape":
      return <SongShapeBlock starts={variant === "starts"} control={control} />;
    case "pace":
      return <PaceBlock now={variant === "now"} control={control} />;
  }
}

// ---- Pieces ----

/** A card with the block's title and its "what this reads" line under it. */
function TendencyCard({ id, action, children }: { id: TendencyBlockId; action: ReactNode; children: ReactNode }) {
  const t = tr(T_LAYOUT);
  const tt = tr(T);
  return (
    <div className="h-full rounded border border-rule bg-panel p-5 shadow-panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={engrave}>{t.blockTitle(id)}</div>
          <div className="mt-0.5 text-[11px] text-engrave">{t.blockSubtitle(id)}</div>
          {isFromFileDates(id) && (
            <div className="mt-0.5 text-[11px] text-engrave">
              <span title={tt.approxWhy} className="cursor-help underline decoration-dotted underline-offset-2">
                {tt.approx}
              </span>
              <span className="sr-only">. {tt.approxWhy}</span>
            </div>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="py-2 text-xs text-engrave">{children}</div>;
}

function Headline({ children }: { children: ReactNode }) {
  return <div className="mb-3 font-display text-2xl font-semibold leading-none text-cream">{children}</div>;
}

/** Hover readout, positioned by the caller (percent or px of the nearest `relative` parent). */
function Tip({ left, top, title, children }: { left: string | number; top: number; title: string; children?: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-rule bg-chassis px-2.5 py-1.5 text-[11px] shadow-xl"
      style={{ left, top }}
    >
      <div className="text-engrave">{title}</div>
      {children}
    </div>
  );
}

/** Rows of label + thin cream bar + count: one series, direct labels, no legend. */
function Rows({ rows, sub }: { rows: { key: string; label: string; count: number; sub?: string }[]; sub?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3 text-xs">
          <span className={`flex min-w-0 items-baseline gap-1.5 ${sub ? "w-36" : "w-28"} shrink-0`}>
            <span className="truncate text-cream">{r.label}</span>
            {r.sub && <span className="shrink-0 text-[10px] text-engrave">{r.sub}</span>}
          </span>
          <span className="flex h-1.5 flex-1 items-center">
            <span className="h-full rounded-r bg-cream" style={{ width: `${(r.count / max) * 100}%`, minWidth: r.count ? 3 : 0 }} />
          </span>
          <span className="w-6 text-right tabular-nums text-engrave">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

/** Three hairlines behind a column chart: baseline, half, top. */
function Hairlines() {
  return (
    <>
      {[0, 50, 100].map((pct) => (
        <div key={pct} className="pointer-events-none absolute inset-x-0 border-t border-rule" style={{ bottom: `${pct}%` }} />
      ))}
    </>
  );
}

// ---- 1. Tempo & key ----

function TempoKeyBlock({ list, control }: { list: boolean; control: ReactNode }) {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const [hover, setHover] = useState<number | null>(null);
  const t = tr(T);
  const out = useMemo(() => tempoKeyTendencies(songs, workspace), [songs, workspace]);

  if (out.bins.length === 0 && out.keys.length === 0) {
    return (
      <TendencyCard id="tempoKey" action={control}>
        <Empty>{t.scanFew}</Empty>
      </TendencyCard>
    );
  }
  const parts: string[] = [];
  if (out.typicalBin) parts.push(t.bpmBin(out.typicalBin.from));
  if (out.typicalKey) parts.push(keyName(out.typicalKey, t.minor, t.major));
  const max = Math.max(1, ...out.bins.map((b) => b.count));
  const hovered = hover === null ? null : out.bins[hover];
  const keyRows = out.keys.map((k) => ({ key: k.key, label: k.key, count: k.count }));

  return (
    <TendencyCard id="tempoKey" action={control}>
      <Headline>{t.typical(parts)}</Headline>
      {list ? (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className={`mb-2 ${engrave}`}>{t.tempos(out.withBpm)}</div>
            <Rows rows={[...out.bins].filter((b) => b.count).sort((a, b) => b.count - a.count || a.from - b.from).slice(0, 5).map((b) => ({ key: String(b.from), label: t.bpmBin(b.from), count: b.count }))} />
          </div>
          <div>
            <div className={`mb-2 ${engrave}`}>{t.keys}</div>
            {keyRows.length ? <Rows rows={keyRows} /> : <Empty>{t.noKeys}</Empty>}
          </div>
        </div>
      ) : (
        <div className="flex gap-4">
          <div className="relative min-w-0 flex-1">
            <div className={`mb-1 ${engrave}`}>{t.tempos(out.withBpm)}</div>
            <div className="relative" style={{ height: CHART_H }}>
              <Hairlines />
              <div className="absolute inset-0 flex items-end gap-[3px]">
                {out.bins.map((b, i) => (
                  <div
                    key={b.from}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    className="flex h-full flex-1 flex-col items-center justify-end"
                  >
                    {b === out.typicalBin && b.count > 0 && <span className="mb-0.5 text-[10.5px] tabular-nums text-engrave">{b.count}</span>}
                    <span
                      className={`w-full rounded-t bg-cream ${hover === i ? "" : "opacity-80"}`}
                      style={{ height: `${(b.count / max) * 100}%`, minHeight: b.count ? 2 : 0 }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="relative mt-1 h-[13px] text-[10.5px] text-engrave">
              {out.bins.map((b, i) =>
                i === 0 || i === out.bins.length - 1 || b === out.typicalBin ? (
                  <span key={b.from} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / out.bins.length) * 100}%` }}>
                    {b.from}
                  </span>
                ) : null,
              )}
            </div>
            {hover !== null && hovered && (
              <Tip left={`${((hover + 0.5) / out.bins.length) * 100}%`} top={CHART_H * (1 - hovered.count / max) + 8} title={t.bpmBin(hovered.from)}>
                <div className="font-medium text-cream">{t.songsN(hovered.count)}</div>
              </Tip>
            )}
          </div>
          <div className="w-32 shrink-0">
            <div className={`mb-1 ${engrave}`}>{t.keys}</div>
            {keyRows.length ? <Rows rows={keyRows} /> : <Empty>{t.noKeys}</Empty>}
          </div>
        </div>
      )}
    </TendencyCard>
  );
}

// ---- 2. Working hours ----

function WorkingHoursBlock({ summary, control }: { summary: boolean; control: ReactNode }) {
  const songs = useVisibleSongs();
  const [hover, setHover] = useState<{ day: number; hour: number; x: number; y: number } | null>(null);
  // The tooltip is placed against this wrapper (the cells are positioned too).
  const frame = useRef<HTMLDivElement>(null);
  const t = tr(T);
  const out = useMemo(() => workingHours(songs), [songs]);
  const weekdays = t.weekdays.split(",");

  if (out.total === 0) {
    return (
      <TendencyCard id="workingHours" action={control}>
        <Empty>{t.noSaves}</Empty>
      </TendencyCard>
    );
  }

  if (summary) {
    const run = weekdayRun(out.topWeekdays);
    const days = run ? `${weekdays[run.from]}–${weekdays[run.to]}` : out.topWeekdays.map((d) => weekdays[d]).join(", ");
    return (
      <TendencyCard id="workingHours" action={control}>
        <div className="flex items-end gap-8">
          {out.chronotype && <HeroStat label={t.profile} value={t.chronotype(out.chronotype)} />}
          <HeroStat label={t.savesYear} value={out.total} />
        </div>
        <div className="mt-3 text-sm text-body">{t.mostSaves(days, t.hourRange(out.peakHour))}</div>
      </TendencyCard>
    );
  }

  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor(((n - 1) / Math.max(1, out.max)) * 4)));
  return (
    <TendencyCard id="workingHours" action={control}>
      <div ref={frame} className="relative">
        <div className="flex gap-1.5">
          <div className="flex flex-col gap-[2px] text-[10.5px] leading-[11px] text-engrave">
            {weekdays.map((d) => (
              <span key={d} className="h-[11px] w-6">
                {d}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
            {out.grid.map((row, day) => (
              <div key={day} className="flex gap-[2px]">
                {row.map((n, hour) => (
                  <div
                    key={hour}
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      const parent = (frame.current ?? e.currentTarget).getBoundingClientRect();
                      setHover({ day, hour, x: r.left - parent.left + r.width / 2, y: r.top - parent.top });
                    }}
                    onMouseLeave={() => setHover(null)}
                    className={`relative h-[11px] min-w-0 flex-1 rounded-[2px] bg-raised ${hover?.day === day && hover.hour === hour ? "ring-1 ring-cream" : ""}`}
                  >
                    <span className="absolute inset-0 rounded-[2px] bg-cream" style={{ opacity: HEAT_STEPS[level(n)] }} />
                  </div>
                ))}
              </div>
            ))}
            <div className="relative h-[13px] text-[10.5px] text-engrave">
              {[0, 6, 12, 18].map((h) => (
                <span key={h} className="absolute" style={{ left: `${(h / 24) * 100}%` }}>
                  {hh(h)}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-1 flex items-center gap-1 text-[10px] text-engrave">
          {t.less}
          {HEAT_STEPS.map((o) => (
            <span key={o} className="relative h-[10px] w-[10px] rounded-[2px] bg-raised">
              <span className="absolute inset-0 rounded-[2px] bg-cream" style={{ opacity: o }} />
            </span>
          ))}
          {t.more}
        </div>
        {hover && (
          <Tip left={hover.x} top={hover.y - 6} title={`${weekdays[hover.day]} ${hh(hover.hour)}–${hh(hover.hour + 1)}`}>
            <div className="font-medium text-cream">{t.saves(out.grid[hover.day][hover.hour])}</div>
          </Tip>
        )}
      </div>
    </TendencyCard>
  );
}

// ---- 3. Your sound ----

function YourSoundBlock({ shifts, control }: { shifts: boolean; control: ReactNode }) {
  const songs = useVisibleSongs();
  const t = tr(T);
  const out = useMemo(() => yourSound(songs), [songs]);

  if (out.plugins.length === 0 && out.folders.length === 0) {
    return (
      <TendencyCard id="yourSound" action={control}>
        <Empty>{t.noSound}</Empty>
      </TendencyCard>
    );
  }
  const kind = (k: "plugin" | "folder") => (k === "plugin" ? t.kindPlugin : t.kindFolder);
  if (shifts) {
    const rows = (xs: typeof out.regulars) => xs.slice(0, 6).map((x) => ({ key: `${x.kind}:${x.name}`, label: x.name, count: x.songs, sub: kind(x.kind) }));
    return (
      <TendencyCard id="yourSound" action={control}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className={`mb-2 ${engrave}`}>{t.regulars(out.recentCount)}</div>
            {out.regulars.length ? <Rows rows={rows(out.regulars)} sub /> : <Empty>{t.noRegulars}</Empty>}
          </div>
          <div>
            <div className={`mb-2 ${engrave}`}>{t.dropped(out.recentCount)}</div>
            {out.dropped.length ? <Rows rows={rows(out.dropped)} sub /> : <Empty>{t.noDropped}</Empty>}
          </div>
        </div>
      </TendencyCard>
    );
  }
  return (
    <TendencyCard id="yourSound" action={control}>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className={`mb-2 ${engrave}`}>{t.plugins}</div>
          <Rows rows={out.plugins.map((p) => ({ key: p.name, label: p.name, count: p.songs }))} />
        </div>
        <div>
          <div className={`mb-2 ${engrave}`}>{t.folders}</div>
          <Rows rows={out.folders.map((f) => ({ key: f.name, label: f.name, count: f.songs }))} />
        </div>
      </div>
    </TendencyCard>
  );
}

// ---- 4. Collaborators ----

function CollaboratorsBlock({ recent, control }: { recent: boolean; control: ReactNode }) {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const t = tr(T);
  const out = useMemo(() => collaborators(songs, workspace), [songs, workspace]);

  if (!out.hasCredits || out.top.length === 0) {
    return (
      <TendencyCard id="collaborators" action={control}>
        <Empty>{t.addCredits}</Empty>
      </TendencyCard>
    );
  }
  if (recent) {
    const group = (xs: typeof out.top) => (
      <div className="flex flex-col gap-1.5 text-xs">
        {xs.slice(0, 6).map((c) => (
          <div key={c.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-cream">{c.name}</span>
            <span className="text-engrave">{c.lastWorkedMs ? formatRelative(c.lastWorkedMs) : "—"}</span>
          </div>
        ))}
      </div>
    );
    return (
      <TendencyCard id="collaborators" action={control}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className={`mb-2 ${engrave}`}>{t.workedRecently(RECENT_COLLAB_DAYS)}</div>
            {out.recent.length ? group(out.recent) : <Empty>{t.nobodyRecent}</Empty>}
          </div>
          <div>
            <div className={`mb-2 ${engrave}`}>{t.notLately(NOT_LATELY_DAYS)}</div>
            {out.notLately.length ? group(out.notLately) : <Empty>{t.everyoneRecent}</Empty>}
          </div>
        </div>
      </TendencyCard>
    );
  }
  return (
    <TendencyCard id="collaborators" action={control}>
      <Rows rows={out.top.slice(0, 8).map((c) => ({ key: c.id, label: c.name, count: c.songs, sub: c.role || undefined }))} sub />
    </TendencyCard>
  );
}

// ---- 5. Song shape ----

function SongShapeBlock({ starts, control }: { starts: boolean; control: ReactNode }) {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const [hover, setHover] = useState<number | null>(null);
  const t = tr(T);
  const out = useMemo(() => songShape(songs, workspace), [songs, workspace]);

  if (!starts) {
    const share = out.total ? Math.round((out.withMixdown / out.total) * 100) : 0;
    return (
      <TendencyCard id="songShape" action={control}>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <HeroStat label={`${t.versions} · ${t.median}`} value={out.medianVersions ?? "—"} />
          {out.timingSource === "stageLog" ? (
            out.stageDays.map((d) => <HeroStat key={d.stage} label={`${t.daysIn(statusInfo(d.stage).label)} · ${t.median}`} value={d.medianDays} />)
          ) : (
            <HeroStat label={`${t.daysToMix} · ${t.median}`} value={out.medianDaysToMixdown ?? "—"} />
          )}
          <HeroStat label={t.withMix} value={`${share}%`} />
        </div>
        {out.timingSource === "stageLog" && <div className="mt-3 text-xs text-engrave">{t.fromStageLog}</div>}
        {out.withMixdown === 0 && <div className="mt-3 text-xs text-engrave">{t.noMix}</div>}
      </TendencyCard>
    );
  }

  const max = Math.max(1, ...out.starts.map((m) => m.started));
  const any = out.starts.some((m) => m.started > 0);
  const monthShort = (d: Date) => d.toLocaleDateString(locale(), { month: "short" });
  const monthLong = (d: Date) => d.toLocaleDateString(locale(), { month: "long", year: "numeric" });
  const hovered = hover === null ? null : out.starts[hover];
  return (
    <TendencyCard id="songShape" action={control}>
      <div className={`mb-1 ${engrave}`}>{t.startsTitle}</div>
      {!any ? (
        <Empty>{t.noStarts}</Empty>
      ) : (
        <div className="relative">
          <div className="relative" style={{ height: CHART_H }}>
            <Hairlines />
            <div className="absolute inset-0 flex items-end gap-[4px]">
              {out.starts.map((m, i) => (
                <div
                  key={m.month.getTime()}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  className="flex h-full flex-1 flex-col items-center justify-end"
                >
                  {m.finished > 0 && <span className="mb-0.5 text-[10.5px] tabular-nums text-engrave">{m.finished}</span>}
                  <span
                    className={`w-full rounded-t bg-cream ${hover === i ? "" : "opacity-80"}`}
                    style={{ height: `${(m.started / max) * 100}%`, minHeight: m.started ? 2 : 0 }}
                  />
                </div>
              ))}
            </div>
            <span className="pointer-events-none absolute right-0 top-0 -translate-y-1/2 bg-panel pl-1 text-[10.5px] text-engrave">{t.perMonthMax(max)}</span>
          </div>
          <div className="relative mt-1 h-[13px] text-[10.5px] text-engrave">
            {out.starts.map((m, i) =>
              i % 3 === 0 ? (
                <span key={m.month.getTime()} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / out.starts.length) * 100}%` }}>
                  {monthShort(m.month)}
                </span>
              ) : null,
            )}
          </div>
          {hover !== null && hovered && (
            <Tip left={`${((hover + 0.5) / out.starts.length) * 100}%`} top={CHART_H * (1 - hovered.started / max) + 8} title={monthLong(hovered.month)}>
              <div className="font-medium text-cream">{t.started(hovered.started)}</div>
              {hovered.finished > 0 && <div className="text-body">{t.finished(hovered.finished)}</div>}
            </Tip>
          )}
        </div>
      )}
    </TendencyCard>
  );
}

// ---- 6. Pace ----

/** Median days per stage from the stage log, and the songs sitting in their
 * stage much longer than usual (a click opens the song). One neutral series:
 * the slowest stage is named in words, not coloured. */
function PaceBlock({ now, control }: { now: boolean; control: ReactNode }) {
  const songs = useVisibleSongs();
  const workspace = useAppStore((s) => s.workspace);
  const openDetail = useAppStore((s) => s.openDetail);
  const t = tr(T);
  const out = useMemo(() => pace(songs, workspace), [songs, workspace]);
  const since = out.sinceMs ? new Date(out.sinceMs).toLocaleDateString(locale(), { day: "numeric", month: "long" }) : null;

  if (out.stages.length === 0) {
    return (
      <TendencyCard id="pace" action={control}>
        <Empty>{t.paceCollecting(since)}</Empty>
      </TendencyCard>
    );
  }

  if (!now) {
    return (
      <TendencyCard id="pace" action={control}>
        {out.slowest && <Headline>{t.stallsIn(statusInfo(out.slowest).label)}</Headline>}
        <Rows
          sub
          rows={out.stages.map((d) => ({ key: d.stage, label: statusInfo(d.stage).label, sub: t.stays(d.songs), count: d.medianDays }))}
        />
        <div className="mt-3 text-xs text-engrave">
          {t.median} · {t.fromStageLog}
        </div>
      </TendencyCard>
    );
  }

  return (
    <TendencyCard id="pace" action={control}>
      {out.runningLong.length === 0 ? (
        <Empty>{t.nothingLong}</Empty>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {out.runningLong.map((r) => (
            <li key={r.path}>
              <button onClick={() => openDetail(r.path)} className="flex w-full items-baseline justify-between gap-3 text-left text-xs hover:text-cream">
                <span className="min-w-0 truncate text-cream">{r.name}</span>
                <span className="shrink-0 tabular-nums text-engrave">{t.longFor(r.days, statusInfo(r.stage).label, r.usualDays)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </TendencyCard>
  );
}
