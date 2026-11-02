import { useMemo, useState, type ReactNode } from "react";
import type React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Disc3,
  FolderInput,
  FolderSearch,
  Music2,
  PlayCircle,
  Sparkles,
  Trophy,
} from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { usePipelineView } from "../store/usePipelineView";
import { formatBytes, formatRelative } from "../lib/format";
import { localDayMs } from "../lib/launchKit";
import { isKitAccepted } from "../lib/kitState";
import { openInFlStudio, revealInFileManager } from "../lib/tauri";
import { isSketch } from "../lib/daws";
import {
  STATUSES,
  isFinished,
  UNSORTED,
  backupsBytes,
  hasProblems,
  lastSaveMs,
  songLabel,
  rendersBytes,
  saveTimestamps,
  statusInfo,
} from "../lib/songs";
import { EmptyLibrary, useVisibleSongs } from "./LibraryView";
import { CrewWhoCard, NextReleaseCard, StalledCard } from "./CrewCards";
import { AttentionCarousel } from "./AttentionCarousel";
import { AddBlockTray, BlockFrame, EmptyBlock, T_LAYOUT, VariantSwitch, useBlockDrag } from "./DashboardEdit";
import { TendencyBlock, tendencyLooks } from "./TendencyBlocks";
import {
  defaultLayout,
  hideBlock,
  moveBlock,
  normalizeLayout,
  setSize,
  setVariant,
  showBlock,
  sizeOf,
  variantOf,
  visibleBlocks,
  type DashboardBlockId,
} from "../lib/dashboardLayout";
import { attentionItems } from "../lib/attention";
import { useCrewStore, useInCrew } from "../store/useCrewStore";
import { crewStats, RECENT_DAYS } from "../lib/crewStats";
import { STALLED_DAYS } from "../lib/crew";
import { pathsByShareId } from "../lib/crewSync";
import { ProgressBar } from "./AlbumsView";
import { ConfirmButton, StatusDot, btn, btnPrimary, btnQuiet } from "./ui";
import { Card, HeroStat, SongLines, StatTile, engrave } from "../ui";
import { areaPath, monotonePath } from "../lib/curve";
import { dict, locale, tr } from "../i18n";

// Charts stay neutral (cream → grey, plus one amber) so blue keeps meaning
// "stage" and orange "needs you". Storage is part-to-whole over four
// categories in fixed order, backed by direct labels in the legend.
const STORAGE_COLORS = ["#f2efe8", "#8d897f", "#5a5850", "#c98500"];
// Activity curve: saves per week over the last year, one neutral series on
// a hairline grid (charts stay neutral; orange is for "needs you").
const DAY = 24 * 60 * 60 * 1000;
const ACTIVITY_WEEKS = 53;
// Heatmap variant: the same cream, from unlit to full.
const HEAT = ["#1f1f1c", "rgba(242,239,232,0.25)", "rgba(242,239,232,0.5)", "rgba(242,239,232,0.75)", "#f2efe8"];
/** Drawing space of the curve; the SVG is stretched to the card's width. */
const CURVE_W = 1000;
const CURVE_H = 150;
/** Room above the highest point for its marker. */
const CURVE_PAD = 6;

const s = (n: number) => (n === 1 ? "" : "s");

const T = dict(
  {
    projectFiles: "Project files",
    backups: "Backups",
    recordings: "Recordings",
    mixdowns: "Mixdowns",
    scanning: "Scanning your projects…",
    noSongs: "No songs found yet",
    noProjects: "No projects in your linked folders. Check the folders in Settings, or load sample data to look around.",
    openSettings: "Open Settings",
    loadSample: "Load sample data",
    showingSample: "Showing sample data — link a real folder anytime.",
    exitDemo: "Exit demo",
    songs: "Songs",
    inProgress: "In progress",
    finished: "Finished",
    releases: "Releases",
    pickUp: "Pick up where you left off",
    kitToDo: "Launch Kit to do",
    open: "Open",
    studioActivity: "Studio activity — saves per week, last 12 months",
    studioHeatmap: "Studio activity — saves per day, last 12 months",
    weekdays: ["Mon", "", "Wed", "", "Fri", "", ""].join(","),
    less: "Less",
    more: "More",
    // Block looks (the segmented control in a card's header)
    curve: "Curve",
    heatmap: "Heatmap",
    bars: "Bars",
    counts: "Counts",
    card: "Card",
    countdown: "Countdown",
    tiles: "Tiles",
    hero: "Hero",
    statsLine: (inProgress: number, finished: number, releases: number) =>
      `${inProgress} in progress · ${finished} finished · ${releases} release${s(releases)}`,
    pipeline: "Pipeline",
    nothingTriaged: "Nothing triaged yet — open the Pipeline board and drag songs into stages.",
    willOpen: "Will this computer open your songs?",
    needsAttention: "Needs attention",
    storage: (total: string) => `Storage — ${total}`,
    storagePart: (label: string, size: string) => `${label}: ${size}`,
    done: (done: number, total: number) => `${done}/${total} done`,
    mostBackups: "Most backups — clean up from the song's Versions panel",
    files: (n: number) => `${n} files`,
    activeDays: "Active days",
    currentStreak: "Current streak",
    streakDays: (n: number) => `${n} day${s(n)}`,
    lastSession: "Last session",
    longestStreak: "Longest streak",
    longestDays: (n: number) => `${n} days`,
    busiest: (date: string, n: number) => `Busiest: ${date} · ${n} saves`,
    week: (from: string, to: string) => `${from} – ${to}`,
    perWeekMax: (n: number) => `max ${n}`,
    saves: (n: number) => `${n} save${s(n)}`,
    unknown: "Unknown",
    followUp: (days: number) => `Follow up — no answer after ${days} days`,
    nothingWaiting: "Nothing waiting.",
    wins: (n: number) => `Wins — placed or sold · ${n}`,
    noneLogged: (n: number) => `None logged yet. ${n} send${s(n)} tracked.`,
    sold: "Sold",
    placed: "Placed",
    openCleanly: (n: number) => `of ${n} songs open cleanly on this computer`,
    allGood: "Every song has its plugins and samples.",
    showAffected: (n: number) => `Show ${n} →`,
    healthBar: (clean: number, affected: number) => `${clean} open cleanly · ${affected} missing plugins or samples`,
    pluginsNotInstalled: "Plugins not installed",
    pluginSongs: (name: string, n: number) => `${name} · ${n} song${s(n)}`,
    samplesMissing: (n: number, songs: number) => `${n} sample${s(n)} missing across ${songs} song${s(songs)}`,
    relocated: (n: number) =>
      `${n} samples aren't at their saved path but were found in the song's folder — the project was moved. The DAW usually finds these; re-saving the project there fixes the paths.`,
    crew: "Crew",
    scope: "Dashboard scope",
    me: "Me",
    you: "You",
    noCrewStats: "No crew stats yet: nothing is shared. Share songs from their panel or the Library, and ask the crew to do the same.",
    sharedSongs: "Shared songs",
    moved: (days: number) => `Moved · ${days} days`,
    crewPipeline: "Crew pipeline",
    whosOnWhat: "Who's on what",
    memberTitle: "Shared songs · being made · finished (Prep or later)",
    memberSongs: (n: number, making: number, done: number) => `${n} song${s(n)} · ${making} being made · ${done} done`,
    openTheirs: (name: string) => `Open ${name}'s songs on the crew board`,
    openYours: "Open your songs on the crew board",
    readyToShip: (n: number) => `Ready to ship · ${n}`,
    nothingReady: "Nothing in Prep with a mixdown and an accepted Launch Kit yet.",
    noDate: "no date",
    comingOut: "Coming out",
    noUpcoming: "No release dates on shared songs. Set them in the Launch Kit.",
    crewStalled: (days: number) => `Stalled — no save or move in ${days}+ days`,
    allMoving: "Everything in Creation or Production moved recently.",
    days: (n: number) => `${n} days`,
  },
  {
    projectFiles: "Fichiers projet",
    backups: "Sauvegardes",
    recordings: "Enregistrements",
    mixdowns: "Mixdowns",
    scanning: "Scan de tes projets…",
    noSongs: "Aucun son trouvé pour l'instant",
    noProjects:
      "Aucun projet dans tes dossiers liés. Vérifie les dossiers dans Réglages, ou charge les données d'exemple pour faire le tour.",
    openSettings: "Ouvrir les réglages",
    loadSample: "Charger les données d'exemple",
    showingSample: "Données d'exemple affichées — lie un vrai dossier quand tu veux.",
    exitDemo: "Quitter la démo",
    songs: "Sons",
    inProgress: "En cours",
    finished: "Finis",
    releases: "Sorties",
    pickUp: "Reprends là où tu t'es arrêté",
    kitToDo: "Launch Kit à faire",
    open: "Ouvrir",
    studioActivity: "Activité studio — sauvegardes par semaine, 12 derniers mois",
    studioHeatmap: "Activité studio — sauvegardes par jour, 12 derniers mois",
    weekdays: ["Lun", "", "Mer", "", "Ven", "", ""].join(","),
    less: "Moins",
    more: "Plus",
    curve: "Courbe",
    heatmap: "Grille",
    bars: "Barres",
    counts: "Nombres",
    card: "Carte",
    countdown: "Compte à rebours",
    tiles: "Tuiles",
    hero: "Un chiffre",
    statsLine: (inProgress: number, finished: number, releases: number) =>
      `${inProgress} en cours · ${finished} fini${s(finished)} · ${releases} sortie${s(releases)}`,
    pipeline: "Pipeline",
    nothingTriaged: "Rien de classé pour l'instant — ouvre le tableau Pipeline et glisse tes sons dans les étapes.",
    willOpen: "Cet ordi va-t-il ouvrir tes sons ?",
    needsAttention: "À compléter",
    storage: (total: string) => `Stockage — ${total}`,
    storagePart: (label: string, size: string) => `${label} : ${size}`,
    done: (done: number, total: number) => `${done}/${total} fini${done > 1 ? "s" : ""}`,
    mostBackups: "Le plus de sauvegardes — fais le ménage depuis le panneau Versions du son",
    files: (n: number) => `${n} fichiers`,
    activeDays: "Jours actifs",
    currentStreak: "Série en cours",
    streakDays: (n: number) => `${n} jour${s(n)}`,
    lastSession: "Dernière session",
    longestStreak: "Plus longue série",
    longestDays: (n: number) => `${n} jours`,
    busiest: (date: string, n: number) => `Record : ${date} · ${n} sauvegardes`,
    week: (from: string, to: string) => `${from} – ${to}`,
    perWeekMax: (n: number) => `max ${n}`,
    saves: (n: number) => `${n} sauvegarde${s(n)}`,
    unknown: "Inconnu",
    followUp: (days: number) => `À relancer — pas de réponse après ${days} jours`,
    nothingWaiting: "Rien en attente.",
    wins: (n: number) => `Victoires — placés ou vendus · ${n}`,
    noneLogged: (n: number) => `Rien de noté pour l'instant. ${n} envoi${s(n)} suivi${s(n)}.`,
    sold: "Vendu",
    placed: "Placé",
    openCleanly: (n: number) => `des ${n} sons s'ouvrent sans souci sur cet ordi`,
    allGood: "Chaque son a ses plugins et ses samples.",
    showAffected: (n: number) => `Voir ${n} →`,
    healthBar: (clean: number, affected: number) =>
      `${clean} s'ouvre${clean > 1 ? "nt" : ""} sans souci · ${affected} avec des plugins ou samples manquants`,
    pluginsNotInstalled: "Plugins pas installés",
    pluginSongs: (name: string, n: number) => `${name} · ${n} son${s(n)}`,
    samplesMissing: (n: number, songs: number) =>
      `${n} sample${s(n)} manquant${s(n)} sur ${songs} son${s(songs)}`,
    relocated: (n: number) =>
      `${n} samples ne sont plus à leur chemin enregistré mais ont été trouvés dans le dossier du son — le projet a été déplacé. Le DAW les retrouve en général ; réenregistrer le projet là-bas corrige les chemins.`,
    crew: "Crew",
    scope: "Portée du tableau de bord",
    me: "Moi",
    you: "Toi",
    noCrewStats:
      "Pas encore de stats crew : rien n'est partagé. Partage des sons depuis leur panneau ou la Bibliothèque, et demande au crew de faire pareil.",
    sharedSongs: "Sons partagés",
    moved: (days: number) => `Bougés · ${days} jours`,
    crewPipeline: "Pipeline du crew",
    whosOnWhat: "Qui est sur quoi",
    memberTitle: "Sons partagés · en cours · finis (Prépa ou après)",
    memberSongs: (n: number, making: number, done: number) =>
      `${n} son${s(n)} · ${making} en cours · ${done} fini${done > 1 ? "s" : ""}`,
    openTheirs: (name: string) => `Ouvrir les sons de ${name} sur le tableau du crew`,
    openYours: "Ouvrir tes sons sur le tableau du crew",
    readyToShip: (n: number) => `Prêt à sortir · ${n}`,
    nothingReady: "Rien en Prépa avec un mixdown et un Launch Kit validé pour l'instant.",
    noDate: "pas de date",
    comingOut: "Ça sort bientôt",
    noUpcoming: "Pas de date de sortie sur les sons partagés. Mets-les dans le Launch Kit.",
    crewStalled: (days: number) => `À l'arrêt — pas de sauvegarde ni de déplacement depuis ${days}+ jours`,
    allMoving: "Tout ce qui est en Création ou Production a bougé récemment.",
    days: (n: number) => `${n} jours`,
  },
);

function MyDashboard({ editing }: { editing: boolean }) {
  const songs = useVisibleSongs();
  const inCrew = useInCrew();
  const workspace = useAppStore((s) => s.workspace);
  const demoMode = useAppStore((s) => s.demoMode);
  const loadDemoData = useAppStore((s) => s.loadDemoData);
  const setView = useAppStore((s) => s.setView);
  const openDetail = useAppStore((s) => s.openDetail);
  const openAlbum = useAppStore((s) => s.openAlbum);
  const setStatusFilter = useAppStore((s) => s.setStatusFilter);
  const resetLibraryFilters = useAppStore((s) => s.resetLibraryFilters);
  const setDashboardLayout = useAppStore((s) => s.setDashboardLayout);
  const watchedFolders = useAppStore((s) => s.settings.watchedFolders);
  const scanning = useAppStore((s) => s.scanning);
  const t = tr(T);

  // Sample data always shows the default arrangement (nothing is saved in
  // demo mode anyway). In a crew the three crew cards share a row.
  const layout = useMemo(
    () => (demoMode ? defaultLayout(inCrew) : normalizeLayout(workspace.dashboard, defaultLayout(inCrew))),
    [workspace.dashboard, demoMode, inCrew],
  );
  const drag = useBlockDrag((id, spot) => {
    const order = visibleBlocks(layout);
    const from = order.indexOf(id);
    const target = order.indexOf(spot.id);
    if (from < 0 || target < 0) return;
    // Index after the dragged block is taken out, before or after the target.
    const to = target + (spot.before ? 0 : 1) - (from < target ? 1 : 0);
    setDashboardLayout(moveBlock(layout, id, to));
  });

  const statusOf = (path: string) => workspace.songs[path]?.status;

  const pipeline = useMemo(
    () =>
      [{ id: undefined, ...UNSORTED }, ...STATUSES].map((s) => ({
        ...s,
        count: songs.filter((p) => statusOf(p.path) === s.id).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [songs, workspace.songs],
  );

  const inProgress = songs.filter((p) => {
    const s = statusOf(p.path);
    return s && !isFinished(s);
  }).length;
  const finished = pipeline.filter((s) => isFinished(s.id)).reduce((t, s) => t + s.count, 0);

  // Songs still being made first; then songs in Prep whose Launch Kit isn't
  // accepted yet (the second half of the journey), so the block never goes empty.
  const continueWith = useMemo(
    () =>
      [
        ...songs.filter((p) => !isFinished(statusOf(p.path))).map((p) => ({ p, kit: false })),
        ...songs.filter((p) => statusOf(p.path) === "prep" && !isKitAccepted(p, workspace.songs[p.path], workspace.albums)).map((p) => ({ p, kit: true })),
      ].slice(0, 4),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [songs, workspace.songs],
  );

  const attention = useMemo(() => attentionItems(songs, workspace), [songs, workspace]);
  const hasPitches = useMemo(() => Object.values(workspace.songs).some((m) => m.pitches?.length), [workspace.songs]);

  const storage = useMemo(() => {
    const sum = (f: (p: (typeof songs)[number]) => number) => songs.reduce((t, p) => t + f(p), 0);
    return [
      { label: t.projectFiles, bytes: sum((p) => p.sizeBytes) },
      { label: t.backups, bytes: sum(backupsBytes) },
      { label: t.recordings, bytes: sum((p) => p.recordingsBytes) },
      { label: t.mixdowns, bytes: sum(rendersBytes) },
    ];
  }, [songs]);
  const storageTotal = storage.reduce((t, s) => t + s.bytes, 0);

  if (songs.length === 0) {
    if (!demoMode && watchedFolders.length === 0) return <EmptyLibrary />;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-raised text-engrave">
          <FolderSearch size={28} />
        </div>
        <div className="text-base font-medium text-cream">{scanning ? t.scanning : t.noSongs}</div>
        {!scanning && (
          <>
            <div className="max-w-sm text-sm text-engrave">
              {t.noProjects}
            </div>
            <div className="mt-2 flex gap-2">
              <button onClick={() => setView("settings", "folders")} className={btnPrimary}>
                {t.openSettings}
              </button>
              <button onClick={loadDemoData} className={btn}>
                {t.loadSample}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  /** The A/B control of a block, in its card header (in and out of edit mode). */
  const variantSwitch = (id: DashboardBlockId, options: { id: string; label: string }[]) => (
    <VariantSwitch label={tr(T_LAYOUT).look} options={options} value={variantOf(layout, id)} onChange={(v) => setDashboardLayout(setVariant(layout, id, v))} />
  );

  // Blocks with nothing to draw stay off the grid, except in edit mode,
  // where their frame shows so they can still be moved or hidden.
  const available: Partial<Record<DashboardBlockId, boolean>> = {
    crewWho: inCrew,
    pitches: hasPitches,
    releases: workspace.albums.length > 0,
  };

  const block = (id: DashboardBlockId): ReactNode => {
    switch (id) {
      case "stats": {
        const control = variantSwitch("stats", [
          { id: "tiles", label: t.tiles },
          { id: "hero", label: t.hero },
        ]);
        if (variantOf(layout, "stats") === "hero") {
          return (
            <div className="h-full rounded border border-rule bg-panel px-5 py-4 shadow-panel">
              <div className="flex items-center justify-between">
                <div className={`flex items-center gap-1.5 ${engrave}`}>
                  <Music2 size={15} />
                  <span>{t.songs}</span>
                </div>
                {control}
              </div>
              <div className="mt-2 font-display text-5xl font-semibold leading-[0.9] tabular-nums text-cream">{songs.length}</div>
              <div className="mt-2 text-xs text-body">{t.statsLine(inProgress, finished, workspace.albums.length)}</div>
            </div>
          );
        }
        return (
          <div className="flex flex-col gap-2">
            <div className="flex justify-end">{control}</div>
            <div className="grid grid-cols-4 gap-3">
              {/* Each figure opens where it's counted. */}
              <TileLink onClick={() => (useAppStore.getState().resetLibraryFilters(), setView("library"))}>
                <StatTile icon={<Music2 size={15} />} label={t.songs} value={songs.length} />
              </TileLink>
              <TileLink onClick={() => setView("pipeline")}>
                <StatTile icon={<Sparkles size={15} />} label={t.inProgress} value={inProgress} />
              </TileLink>
              <TileLink onClick={() => setView("pipeline")}>
                <StatTile icon={<Trophy size={15} />} label={t.finished} value={finished} />
              </TileLink>
              <TileLink onClick={() => useAppStore.getState().openAlbum(null)}>
                <StatTile icon={<Disc3 size={15} />} label={t.releases} value={workspace.albums.length} />
              </TileLink>
            </div>
          </div>
        );
      }
      case "pickUp":
        return (
          <Card title={t.pickUp} className="h-full">
            <div className="grid grid-cols-4 gap-2">
              {continueWith.map(({ p, kit }) => {
                const s = statusInfo(statusOf(p.path));
                return (
                  <div
                    key={p.path}
                    onClick={() => (kit ? useAppStore.getState().openLaunchKit(p.path) : openDetail(p.path))}
                    className="group cursor-pointer rounded-lg border border-rule bg-raised p-3 hover:border-rule-strong"
                  >
                    {/* The card is a mouse target; the title is its keyboard control. */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (kit) useAppStore.getState().openLaunchKit(p.path);
                        else openDetail(p.path);
                      }}
                      className="block w-full truncate rounded text-left text-sm font-medium text-cream focus-visible:outline-2 focus-visible:outline-cream"
                    >
                      {p.name}
                    </button>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-body">
                      <StatusDot color={s.color} size={6} /> {s.label}
                      {kit && <span className="text-engrave">· {t.kitToDo}</span>}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-engrave">
                      <span>{formatRelative(lastSaveMs(p))}</span>
                      {!demoMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // A BandLab sketch has no project yet: show its folder.
                            (isSketch(p) ? revealInFileManager(p.path) : openInFlStudio(p.path)).catch((err) => console.error("couldn't open the project", err));
                          }}
                          className="flex items-center gap-1 text-engrave opacity-0 hover:text-orange-300 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                        >
                          <PlayCircle size={13} /> {t.open}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      case "nextRelease":
        return (
          <NextReleaseCard
            variant={variantOf(layout, "nextRelease") as "card" | "countdown"}
            control={variantSwitch("nextRelease", [
              { id: "card", label: t.card },
              { id: "countdown", label: t.countdown },
            ])}
          />
        );
      case "stalled":
        return <StalledCard songs={songs} />;
      case "crewWho":
        return <CrewWhoCard songs={songs} />;
      case "activity": {
        const heat = variantOf(layout, "activity") === "heatmap";
        return (
          <Card
            title={heat ? t.studioHeatmap : t.studioActivity}
            className="h-full"
            action={variantSwitch("activity", [
              { id: "curve", label: t.curve },
              { id: "heatmap", label: t.heatmap },
            ])}
          >
            {heat ? <ActivityHeatmap /> : <ActivityCurve />}
          </Card>
        );
      }
      case "pipeline": {
        const counts = variantOf(layout, "pipeline") === "counts";
        const max = Math.max(1, ...pipeline.map((x) => x.count));
        const show = (s: (typeof pipeline)[number]) => {
          resetLibraryFilters();
          setStatusFilter(s.id ?? "unsorted");
          setView("library");
        };
        return (
          <Card
            title={t.pipeline}
            className="h-full"
            action={variantSwitch("pipeline", [
              { id: "bars", label: t.bars },
              { id: "counts", label: t.counts },
            ])}
          >
            <div className="flex flex-col gap-1.5">
              {pipeline.map((s) => (
                <button key={s.label} onClick={() => show(s)} className="group flex items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-panel">
                  <span className={`flex shrink-0 items-center gap-1.5 text-xs text-body ${counts ? "flex-1" : "w-24"}`}>
                    <StatusDot color={s.color} /> {s.label}
                  </span>
                  {!counts && (
                    <span className="flex h-4 flex-1 items-center">
                      <span
                        className="h-full rounded-r"
                        style={{ width: `${(s.count / max) * 100}%`, minWidth: s.count ? 3 : 0, background: s.color }}
                      />
                    </span>
                  )}
                  <span className="w-8 text-right text-xs tabular-nums text-body">{s.count}</span>
                </button>
              ))}
            </div>
            {pipeline[0].count === songs.length && (
              <div className="mt-3 text-xs text-engrave">
                {t.nothingTriaged}
              </div>
            )}
          </Card>
        );
      }
      case "openCleanly":
        return (
          <Card title={t.willOpen} className="h-full">
            <HealthCard />
          </Card>
        );
      case "attention":
        return (
          <Card title={t.needsAttention} className="h-full">
            <AttentionCarousel items={attention} label={(i) => songLabel(i.song, songs)} onOpen={openDetail} />
          </Card>
        );
      case "storage":
        return (
          <Card title={t.storage(formatBytes(storageTotal))} className="h-full">
            <div className="flex h-4 gap-[2px]">
              {storage.map((s, i) =>
                s.bytes ? (
                  <div
                    key={s.label}
                    title={t.storagePart(s.label, formatBytes(s.bytes))}
                    style={{ flexGrow: s.bytes, background: STORAGE_COLORS[i], minWidth: 3 }}
                    className="first:rounded-l last:rounded-r"
                  />
                ) : null,
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              {storage.map((s, i) => (
                <div key={s.label} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: STORAGE_COLORS[i] }} />
                  <span className="flex-1 text-body">{s.label}</span>
                  <span className="tabular-nums text-cream">{formatBytes(s.bytes)}</span>
                </div>
              ))}
            </div>
            <BackupHogs />
          </Card>
        );
      case "pitches":
        return <PitchesCard />;
      case "releases":
        return (
          <Card title={t.releases} className="h-full">
            <div className="flex flex-col gap-3">
              {workspace.albums.map((a) => {
                const done = a.trackPaths.filter((p) => isFinished(statusOf(p))).length;
                return (
                  <button key={a.id} onClick={() => openAlbum(a.id)} className="flex items-center gap-3 text-left">
                    <span className="h-8 w-8 shrink-0 rounded" style={{ background: a.color }} />
                    <span className="w-40 shrink-0">
                      <span className="block truncate text-sm text-cream">{a.title}</span>
                      <span className="block text-[11px] text-engrave">
                        {t.done(done, a.trackPaths.length)}
                        {localDayMs(a.releaseDate) !== null && ` · ${formatRelative(localDayMs(a.releaseDate) as number)}`}
                      </span>
                    </span>
                    <span className="flex-1">
                      <ProgressBar trackPaths={a.trackPaths} workspace={workspace} height={8} />
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>
        );
      // The tendency blocks (hidden until added from the tray).
      case "tempoKey":
      case "workingHours":
      case "yourSound":
      case "collaborators":
      case "songShape":
        return <TendencyBlock id={id} variant={variantOf(layout, id)} control={variantSwitch(id, tendencyLooks(id))} />;
    }
  };

  const shown = visibleBlocks(layout).filter((id) => editing || available[id] !== false);
  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">

        <div className="grid grid-cols-12 gap-x-4 gap-y-5">
          {shown.map((id, i) => (
            <BlockFrame
              key={id}
              id={id}
              size={sizeOf(layout, id)}
              editing={editing}
              index={i}
              count={shown.length}
              drag={drag}
              onMove={(to) => setDashboardLayout(moveBlock(layout, id, to))}
              onSize={(size) => setDashboardLayout(setSize(layout, id, size))}
              onHide={() => setDashboardLayout(hideBlock(layout, id))}
            >
              {available[id] === false ? <EmptyBlock /> : block(id)}
            </BlockFrame>
          ))}
          {editing && <AddBlockTray hidden={layout.hidden} onShow={(id) => setDashboardLayout(showBlock(layout, id))} />}
        </div>
      </div>
    </div>
  );


  function BackupHogs() {
    const top = [...songs].sort((a, b) => backupsBytes(b) - backupsBytes(a)).slice(0, 3).filter((p) => p.backups.length > 5);
    if (!top.length) return null;
    return (
      <div className="mt-4 border-t border-rule pt-3 text-xs">
        <div className="text-body">{t.mostBackups}</div>
        {top.map((p) => (
          <button key={p.path} onClick={() => openDetail(p.path)} className="mt-1 flex w-full items-center gap-2 text-left hover:text-cream">
            <span className="flex-1 truncate text-body">{p.name}</span>
            <span className="text-engrave">{t.files(p.backups.length)}</span>
            <span className="w-16 text-right tabular-nums text-body">{formatBytes(backupsBytes(p))}</span>
          </button>
        ))}
      </div>
    );
  }
}

/** Every save (current file + each backup) is a real work session, bucketed
 * by calendar day over the last ACTIVITY_WEEKS weeks, with the streaks. The
 * curve and the heatmap both draw from this. */
function useStudioDays() {
  const songs = useVisibleSongs();
  const lastSave = useMemo(() => Math.max(0, ...songs.map(lastSaveMs)), [songs]);
  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // The series starts on the Monday ACTIVITY_WEEKS weeks back.
    const start = new Date(today);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (ACTIVITY_WEEKS - 1) * 7);
    // Calendar days, not 24h steps: a DST change makes one day 23 or 25h
    // long, which would shift every later day's date (or drop today).
    const dayIndex = (d: Date) =>
      Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
        Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / DAY);
    const total = dayIndex(today) + 1;
    const days = Array.from({ length: total }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { date: d, saves: 0, songs: new Set<string>() };
    });
    for (const p of songs) {
      for (const t of saveTimestamps(p)) {
        const idx = dayIndex(new Date(t));
        if (idx >= 0 && idx < total) {
          days[idx].saves += 1;
          days[idx].songs.add(p.name);
        }
      }
    }
    // Today doesn't break the streak until it's over.
    let streak = 0;
    for (let i = days[total - 1].saves ? total - 1 : total - 2; i >= 0 && days[i].saves > 0; i--) streak++;
    let longest = 0;
    let run = 0;
    for (const d of days) {
      run = d.saves ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    const busiest = days.reduce((a, b) => (b.saves > a.saves ? b : a), days[0]);
    // Month label at the first week containing the 1st of that month.
    const months: (string | null)[] = Array.from({ length: Math.ceil(total / 7) }, (_, w) => {
      const firstOfMonth = days.slice(w * 7, w * 7 + 7).find((d) => d.date.getDate() === 1);
      return firstOfMonth ? firstOfMonth.date.toLocaleDateString(locale(), { month: "short" }) : null;
    });
    return {
      days,
      activeDays: days.filter((d) => d.saves > 0).length,
      streak,
      longest,
      busiest,
      months,
    };
  }, [songs]);
  return { songs, lastSave, ...stats };
}

/** The figures beside the curve or the heatmap. */
function StudioStats({ activeDays, streak, longest, busiest, lastSave }: Pick<ReturnType<typeof useStudioDays>, "activeDays" | "streak" | "longest" | "busiest" | "lastSave">) {
  const t = tr(T);
  return (
    <div className="flex shrink-0 flex-col justify-center gap-2 text-xs">
      <HeroStat label={t.activeDays} value={activeDays} />
      {streak > 0 ? (
        <HeroStat label={t.currentStreak} value={t.streakDays(streak)} />
      ) : (
        lastSave > 0 && <HeroStat label={t.lastSession} value={formatRelative(lastSave)} />
      )}
      {longest > 1 && <HeroStat label={t.longestStreak} value={t.longestDays(longest)} />}
      {busiest.saves > 0 && (
        <div className="text-[11px] text-engrave">
          {t.busiest(busiest.date.toLocaleDateString(locale(), { month: "short", day: "numeric" }), busiest.saves)}
        </div>
      )}
    </div>
  );
}

/** Saves per week as one curve over the last year. */
function ActivityCurve() {
  const openDetail = useAppStore((s) => s.openDetail);
  const [hover, setHover] = useState<number | null>(null);
  const t = tr(T);
  const { songs, days, months, ...stats } = useStudioDays();

  // One point per week (Monday to Sunday, the last one ending today).
  const { weeks, max } = useMemo(() => {
    const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => {
      const slice = days.slice(w * 7, w * 7 + 7);
      const names = new Set<string>();
      let saves = 0;
      for (const d of slice) {
        saves += d.saves;
        for (const n of d.songs) names.add(n);
      }
      return { start: slice[0].date, end: slice[slice.length - 1].date, saves, songs: names };
    });
    return { weeks, max: Math.max(1, ...weeks.map((w) => w.saves)) };
  }, [days]);

  const xAt = (i: number) => (weeks.length > 1 ? i / (weeks.length - 1) : 0);
  const points = weeks.map((w, i) => ({ x: xAt(i) * CURVE_W, y: CURVE_PAD + (1 - w.saves / max) * (CURVE_H - CURVE_PAD) }));
  const line = monotonePath(points);
  const area = areaPath(points, line, CURVE_H);
  const hovered = hover === null ? null : weeks[hover];
  const gridY = [CURVE_H, CURVE_PAD + (CURVE_H - CURVE_PAD) / 2, CURVE_PAD];

  // The crosshair snaps to the nearest week for the pointer's x.
  const track = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = r.width ? (e.clientX - r.left) / r.width : 0;
    setHover(Math.max(0, Math.min(weeks.length - 1, Math.round(ratio * (weeks.length - 1)))));
  };
  const openFirstSong = () => {
    const name = hovered ? [...hovered.songs][0] : undefined;
    const p = name ? songs.find((s) => s.name === name) : undefined;
    if (p) openDetail(p.path);
  };
  const dateShort = (d: Date) => d.toLocaleDateString(locale(), { month: "short", day: "numeric" });

  return (
    <div className="flex gap-4">
      <div className="relative min-w-0 flex-1">
        <div className="relative" style={{ height: CURVE_H }}>
          {/* Stretched viewBox so the curve fills the card; strokes keep their
              width through vector-effect, and the marker is HTML so it stays round. */}
          <svg
            viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t.studioActivity}
            onPointerMove={track}
            onPointerLeave={() => setHover(null)}
            onClick={openFirstSong}
            className={`absolute inset-0 h-full w-full overflow-visible ${hovered?.songs.size ? "cursor-pointer" : ""}`}
          >
            {gridY.map((y) => (
              <line key={y} x1={0} x2={CURVE_W} y1={y} y2={y} stroke="var(--color-rule)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <path d={area} fill="var(--color-cream)" fillOpacity={0.08} />
            <path d={line} fill="none" stroke="var(--color-cream)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {hover !== null && (
              <line x1={points[hover].x} x2={points[hover].x} y1={CURVE_PAD} y2={CURVE_H} stroke="var(--color-rule-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hover !== null && (
            <span
              className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cream ring-2 ring-panel"
              style={{ left: `${xAt(hover) * 100}%`, top: `${(points[hover].y / CURVE_H) * 100}%` }}
            />
          )}
          <span className="pointer-events-none absolute right-0 top-0 -translate-y-1/2 bg-panel pl-1 text-[10.5px] text-engrave">{t.perWeekMax(max)}</span>
        </div>
        <div className="relative mt-1 h-[13px] text-[10.5px] text-engrave">
          {months.map((m, w) =>
            m ? (
              <span key={w} className="absolute whitespace-nowrap" style={{ left: `${xAt(w) * 100}%` }}>
                {m}
              </span>
            ) : null,
          )}
        </div>
        {hover !== null && hovered && (
          <div
            className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-rule bg-chassis px-2.5 py-1.5 text-[11px] shadow-xl"
            style={{ left: `${Math.min(92, Math.max(8, xAt(hover) * 100))}%`, top: points[hover].y - 10 }}
          >
            <div className="text-engrave">{t.week(dateShort(hovered.start), dateShort(hovered.end))}</div>
            <div className="font-medium text-cream">{t.saves(hovered.saves)}</div>
            {hovered.songs.size > 0 && <div className="max-w-[200px] truncate text-body">{[...hovered.songs].join(", ")}</div>}
          </div>
        )}
      </div>
      <StudioStats {...stats} />
    </div>
  );
}

/** GitHub-style calendar: one cell per day, lit by how many saves it had. */
function ActivityHeatmap() {
  const openDetail = useAppStore((s) => s.openDetail);
  const [hover, setHover] = useState<{ day: number; x: number; y: number } | null>(null);
  const t = tr(T);
  const { songs, days, months, ...stats } = useStudioDays();

  const max = Math.max(1, ...days.map((d) => d.saves));
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor(((n - 1) / max) * 4)));
  const weeks = Math.ceil(days.length / 7);
  const hovered = hover ? days[hover.day] : null;

  return (
    <div className="relative">
      <div className="flex gap-4">
        <div className="flex gap-[2px] overflow-x-auto pb-1">
          <div className="mr-1 flex flex-col gap-[2px] pt-[15px] text-[10.5px] leading-[11px] text-engrave">
            {t.weekdays.split(",").map((d, i) => (
              <span key={i} className="h-[11px]">{d}</span>
            ))}
          </div>
          {Array.from({ length: weeks }, (_, w) => (
            <div key={w} className="flex flex-col gap-[2px]">
              <span className="h-[13px] w-[11px] overflow-visible whitespace-nowrap text-[10.5px] leading-[11px] text-engrave">
                {months[w]}
              </span>
              {days.slice(w * 7, w * 7 + 7).map((d, i) => (
                <div
                  key={d.date.getTime()}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const parent = e.currentTarget.closest(".relative")!.getBoundingClientRect();
                    setHover({ day: w * 7 + i, x: r.left - parent.left + r.width / 2, y: r.top - parent.top });
                  }}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => {
                    const name = [...d.songs][0];
                    const p = songs.find((s) => s.name === name);
                    if (p) openDetail(p.path);
                  }}
                  className={`h-[11px] w-[11px] rounded-[2px] ${d.saves ? "cursor-pointer" : ""} ${hover?.day === w * 7 + i ? "ring-1 ring-cream" : ""}`}
                  style={{ background: HEAT[level(d.saves)] }}
                />
              ))}
            </div>
          ))}
        </div>
        <StudioStats {...stats} />
      </div>
      <div className="mt-2 flex items-center gap-1 text-[10px] text-engrave">
        {t.less}
        {HEAT.map((c) => (
          <span key={c} className="h-[10px] w-[10px] rounded-[2px]" style={{ background: c }} />
        ))}
        {t.more}
      </div>
      {hover && hovered && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-rule bg-chassis px-2.5 py-1.5 text-[11px] shadow-xl"
          style={{ left: hover.x, top: hover.y - 6 }}
        >
          <div className="text-engrave">
            {hovered.date.toLocaleDateString(locale(), { weekday: "short", month: "short", day: "numeric" })}
          </div>
          <div className="font-medium text-cream">
            {t.saves(hovered.saves)}
          </div>
          {hovered.songs.size > 0 && (
            <div className="max-w-[200px] truncate text-body">{[...hovered.songs].join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

const CRITICAL = "#ff4040";
const FOLLOW_UP_DAYS = 14;

/** Beats sent with no answer for two weeks, and recent wins. */
function PitchesCard() {
  const songsMeta = useAppStore((s) => s.workspace.songs);
  const people = useAppStore((s) => s.workspace.people);
  const projects = useAppStore((s) => s.projects);
  const openDetail = useAppStore((s) => s.openDetail);
  const t = tr(T);

  const { followUps, wins, total } = useMemo(() => {
    const names = new Map(people.map((p) => [p.id, p.name]));
    const songNames = new Map(projects.map((p) => [p.path, p.name]));
    const cutoff = new Date(Date.now() - FOLLOW_UP_DAYS * DAY).toISOString().slice(0, 10);
    const all = Object.entries(songsMeta).flatMap(([path, meta]) =>
      (meta.pitches ?? []).map((pitch) => ({
        path,
        pitch,
        song: songNames.get(path) ?? path.split(/[/\\]/).pop() ?? path,
        who: names.get(pitch.personId) ?? t.unknown,
      })),
    );
    return {
      total: all.length,
      followUps: all
        .filter((x) => (x.pitch.outcome === "sent" || x.pitch.outcome === "listened") && x.pitch.date <= cutoff)
        .sort((a, b) => a.pitch.date.localeCompare(b.pitch.date)),
      wins: all
        .filter((x) => x.pitch.outcome === "placed" || x.pitch.outcome === "sold")
        .sort((a, b) => b.pitch.date.localeCompare(a.pitch.date)),
    };
  }, [songsMeta, people, projects]);

  if (total === 0) return null;
  const Row = ({ x, right }: { x: (typeof followUps)[number]; right: string }) => (
    <button onClick={() => openDetail(x.path)} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-panel">
      <span className="min-w-0 flex-1 truncate text-cream">{x.song}</span>
      <span className="w-32 truncate text-engrave">→ {x.who}</span>
      <span className="w-24 text-right text-engrave">{right}</span>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title={t.followUp(FOLLOW_UP_DAYS)}>
        {followUps.length === 0 ? (
          <div className="text-xs text-engrave">{t.nothingWaiting}</div>
        ) : (
          followUps.slice(0, 6).map((x) => <Row key={x.pitch.id} x={x} right={localDayMs(x.pitch.date) !== null ? formatRelative(localDayMs(x.pitch.date) as number) : ""} />)
        )}
      </Card>
      <Card title={t.wins(wins.length)}>
        {wins.length === 0 ? (
          <div className="text-xs text-engrave">{t.noneLogged(total)}</div>
        ) : (
          wins.slice(0, 6).map((x) => <Row key={x.pitch.id} x={x} right={x.pitch.outcome === "sold" ? t.sold : t.placed} />)
        )}
      </Card>
    </div>
  );
}

function usePluginStats() {
  const songs = useVisibleSongs();
  return useMemo(() => {
    // count = songs using it; missingCount = songs where it didn't resolve
    // (can differ per song: projects store different plugin paths).
    const stats = new Map<string, { name: string; count: number; missingCount: number; thirdParty: boolean; missing: boolean }>();
    for (const p of songs) {
      for (const plugin of p.plugins) {
        const s = stats.get(plugin.name) ?? { name: plugin.name, count: 0, missingCount: 0, thirdParty: plugin.installed !== null, missing: false };
        s.count += 1;
        if (plugin.installed === false) {
          s.missing = true;
          s.missingCount += 1;
        }
        stats.set(plugin.name, s);
      }
    }
    return [...stats.values()].sort((a, b) => b.count - a.count);
  }, [songs]);
}

function useShowSongsWithPlugin() {
  const setView = useAppStore((s) => s.setView);
  const setPluginFilter = useAppStore((s) => s.setPluginFilter);
  const resetLibraryFilters = useAppStore((s) => s.resetLibraryFilters);
  return (name: string) => {
    resetLibraryFilters();
    setPluginFilter(name);
    setView("library");
  };
}

function HealthCard() {
  const songs = useVisibleSongs();
  const stats = usePluginStats();
  const showSongs = useShowSongsWithPlugin();
  const setView = useAppStore((s) => s.setView);
  const setProblemsOnly = useAppStore((s) => s.setProblemsOnly);
  const resetLibraryFilters = useAppStore((s) => s.resetLibraryFilters);
  const missingPlugins = stats.filter((s) => s.missing);
  const t = tr(T);
  const samples = useMemo(() => {
    const c = { missing: 0, relocated: 0, songsMissing: 0 };
    for (const p of songs) {
      let m = 0;
      for (const s of p.samples) {
        if (s.status === "missing") m++;
        if (s.status === "relocated") c.relocated++;
      }
      c.missing += m;
      if (m) c.songsMissing++;
    }
    return c;
  }, [songs]);
  const affected = songs.filter(hasProblems).length;
  const clean = songs.length - affected;
  const pct = songs.length ? Math.floor((clean / songs.length) * 100) : 100;

  if (!affected && !samples.relocated) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-emerald-300">100%</span>
          <span className="text-xs text-engrave">{t.openCleanly(songs.length)}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-emerald-300">
          <CheckCircle2 size={16} /> {t.allGood}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-semibold ${affected ? "text-cream" : "text-emerald-300"}`}>{pct}%</span>
        <span className="text-engrave">
          {t.openCleanly(songs.length)}
        </span>
        {affected > 0 && (
          <button
            onClick={() => {
              resetLibraryFilters();
              setProblemsOnly(true);
              setView("library");
            }}
            className="ml-auto text-body hover:text-cream"
          >
            {t.showAffected(affected)}
          </button>
        )}
      </div>
      <div className="flex h-2 gap-[2px]" title={t.healthBar(clean, affected)}>
        {clean > 0 && <div className="rounded-l bg-emerald-500/70 last:rounded-r" style={{ flexGrow: clean }} />}
        {affected > 0 && <div className="rounded-r first:rounded-l" style={{ flexGrow: affected, background: CRITICAL }} />}
      </div>
      {missingPlugins.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-body">
            <AlertTriangle size={12} className="text-red-400" /> {t.pluginsNotInstalled}
          </div>
          <div className="flex flex-wrap gap-1">
            {missingPlugins.map((p) => (
              <button
                key={p.name}
                onClick={() => showSongs(p.name)}
                className="rounded bg-red-500/10 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-500/20"
              >
                {t.pluginSongs(p.name, p.missingCount)}
              </button>
            ))}
          </div>
        </div>
      )}
      {samples.missing > 0 && (
        <div className="flex items-center gap-1.5 text-body">
          <AlertTriangle size={12} className="text-red-400" />
          {t.samplesMissing(samples.missing, samples.songsMissing)}
        </div>
      )}
      {samples.relocated > 0 && (
        <div className="flex items-start gap-1.5 text-engrave">
          <FolderInput size={12} className="mt-px shrink-0 text-sky-400" />
          <span>{t.relocated(samples.relocated)}</span>
        </div>
      )}
    </div>
  );
}

type Scope = "me" | "crew";

/** "Me" = this computer's songs and studio habits. "Crew" = group stats from
 * shared songs only (roadmap 1a). The switch appears once you're in a crew.
 * The Me dashboard's blocks can be rearranged: "Edit layout" at the right. */
export function Dashboard() {
  const inCrew = useInCrew();
  const crewName = useCrewStore((s) => s.crews.find((c) => c.id === s.activeCrewId)?.name ?? tr(T).crew);
  const hasLocal = useAppStore((s) => s.projects.length > 0 || s.settings.watchedFolders.length > 0);
  // The same songs MyDashboard shows: when it's in its empty state (say, only
  // templates), there's no layout to edit.
  const hasSongs = useVisibleSongs().length > 0;
  const demoMode = useAppStore((s) => s.demoMode);
  const resetDashboardLayout = useAppStore((s) => s.resetDashboardLayout);
  const [picked, setPicked] = useState<Scope | null>(null);
  const [editing, setEditing] = useState(false);
  // Members with no FL folders of their own land on the crew view.
  const scope: Scope = inCrew ? (picked ?? (hasLocal ? "me" : "crew")) : "me";
  // Sample data keeps the default arrangement, so there's nothing to edit.
  const canEdit = scope === "me" && hasSongs && !demoMode;
  const tl = tr(T_LAYOUT);

  if (!inCrew && !canEdit) return <MyDashboard editing={false} />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={`relative flex min-h-[46px] items-center justify-center px-8 pb-2 pt-4 ${inCrew ? "border-b border-rule" : ""}`}>
        {inCrew && (
          <div role="tablist" aria-label={tr(T).scope} className="flex rounded-md border border-rule p-0.5 text-xs">
            {(["me", "crew"] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={scope === s}
                onClick={() => setPicked(s)}
                className={`rounded px-3 py-1 ${scope === s ? "bg-rule text-cream" : "text-engrave hover:text-cream"}`}
              >
                {s === "me" ? tr(T).me : crewName}
              </button>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="absolute right-8 top-1/2 flex -translate-y-1/2 items-center gap-2 pt-1">
            {editing ? (
              <>
                <ConfirmButton label={tl.resetLayout} confirmLabel={tl.resetConfirm} onConfirm={resetDashboardLayout} className={btn} />
                <button onClick={() => setEditing(false)} className={btnPrimary}>
                  {tl.done}
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)} className={btnQuiet}>
                {tl.editLayout}
              </button>
            )}
          </div>
        )}
      </div>
      {scope === "me" ? <MyDashboard editing={editing && canEdit} /> : <CrewDashboard />}
    </div>
  );
}

function CrewDashboard() {
  const songs = useCrewStore((s) => s.songs);
  const members = useCrewStore((s) => s.members);
  const userId = useCrewStore((s) => s.userId);
  const workspace = useAppStore((s) => s.workspace);
  const openDetail = useAppStore((s) => s.openDetail);
  const setView = useAppStore((s) => s.setView);
  const stats = useMemo(() => crewStats(songs, members), [songs, members]);
  const localPath = useMemo(() => pathsByShareId(workspace), [workspace]);
  // Your own shared songs open their panel; others' songs open the crew board.
  const open = (id: string) => {
    const path = localPath.get(id);
    if (path) openDetail(path);
    else setView("crewBoard");
  };
  // A member row opens the crew board on that member's songs.
  const openMember = (id: string) => {
    usePipelineView.getState().setCrewMember(id);
    setView("crewBoard");
  };
  const t = tr(T);
  const who = (id: string, name: string) => (id === userId ? t.you : name);

  if (songs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-body">
        {t.noCrewStats}
      </div>
    );
  }

  const max = Math.max(1, ...stats.byStage.map((s) => s.count));
  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="grid grid-cols-4 gap-3">
          <StatTile icon={<Music2 size={15} />} label={t.sharedSongs} value={stats.total} />
          <StatTile icon={<Sparkles size={15} />} label={t.inProgress} value={stats.inProgress} />
          <StatTile icon={<Trophy size={15} />} label={t.finished} value={stats.finished} />
          <StatTile icon={<PlayCircle size={15} />} label={t.moved(RECENT_DAYS)} value={stats.movedRecently} />
        </div>

        <div className="grid grid-cols-2 gap-5">
          <Card title={t.crewPipeline}>
            <div className="flex flex-col gap-2">
              {stats.byStage.map((s) => {
                const info = statusInfo(s.id ?? undefined);
                return (
                  <div key={s.id ?? "none"} className="flex items-center gap-3 text-xs">
                    <span className="flex w-24 items-center gap-2 text-body">
                      <StatusDot color={info.color} /> {info.label}
                    </span>
                    <div className="h-2 flex-1 rounded bg-raised">
                      <div className="h-2 rounded" style={{ width: `${(s.count / max) * 100}%`, background: info.color }} />
                    </div>
                    <span className="w-6 text-right tabular-nums text-body">{s.count}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title={t.whosOnWhat}>
            <div className="flex flex-col gap-2 text-xs">
              {stats.members.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => openMember(m.userId)}
                  title={m.userId === userId ? t.openYours : t.openTheirs(m.name)}
                  className="flex items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate text-cream">{who(m.userId, m.name)}</span>
                  <span className="tabular-nums text-engrave" title={t.memberTitle}>
                    {t.memberSongs(m.songs, m.making, m.finished)}
                  </span>
                  <ChevronRight size={12} className="shrink-0 text-engrave" aria-hidden />
                </button>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-2 gap-5">
          <Card title={t.readyToShip(stats.readyToShip.length)}>
            {stats.readyToShip.length === 0 ? (
              <p className="text-xs text-body">{t.nothingReady}</p>
            ) : (
              <SongLines items={stats.readyToShip.map((s) => ({ id: s.id, title: s.title, right: s.release_date ?? t.noDate }))} onOpen={open} />
            )}
          </Card>
          <Card title={t.comingOut}>
            {stats.upcoming.length === 0 ? (
              <p className="text-xs text-body">{t.noUpcoming}</p>
            ) : (
              <SongLines
                items={stats.upcoming.slice(0, 6).map((u) => ({ id: u.song.id, title: u.song.title, sub: who(u.song.owner_id, u.owner), right: u.date }))}
                onOpen={open}
              />
            )}
          </Card>
        </div>

        <Card title={t.crewStalled(STALLED_DAYS)}>
          {stats.stalled.length === 0 ? (
            <p className="flex items-center gap-2 text-xs text-engrave">
              <CheckCircle2 size={13} className="text-emerald-400" /> {t.allMoving}
            </p>
          ) : (
            <SongLines
              items={stats.stalled.map((x) => ({ id: x.song.id, title: x.song.title, sub: who(x.song.owner_id, x.owner), right: t.days(x.days) }))}
              onOpen={open}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

/** A dashboard figure that opens the list it counts. */
function TileLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded text-left transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-cream">
      {children}
    </button>
  );
}
