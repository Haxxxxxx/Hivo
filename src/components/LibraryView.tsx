import { DetectedFolders } from "./DetectedFolders";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  CheckSquare,
  ChevronRight,
  Folder,
  Download,
  FolderSearch,
  LayoutTemplate,
  Archive,
  Music2,
  Package,
  Plug,
  RefreshCw,
  Search,
  Square,
  Star,
  X,
} from "lucide-react";
import { useAppStore, type SortKey, type StatusFilter } from "../store/useAppStore";
import { useCrewStore } from "../store/useCrewStore";
import { useCanShare } from "./CrewPanel";
import { detectKey } from "../lib/people";
import { dawOf } from "../lib/daws";
import { buildFolderTree, folderPath, hasFolderNode, inFolder, type FolderNode } from "../lib/folderTree";
import { formatDate } from "../lib/format";
import { dict, tr } from "../i18n";
import {
  KEYS,
  STATUSES,
  UNSORTED,
  albumsOf,
  formatBpm,
  hasProblems,
  lastSaveMs,
  missingPlugins,
  missingSamples,
  songLabel,
} from "../lib/songs";
import type { ProjectInfo, SongStatus } from "../types";
import { ConfirmButton, StatusDot, StatusSelect, btn, btnPrimary } from "./ui";
import { Chip, MixdownBadge, Toggle } from "../ui";

const T = dict(
  {
    colSong: "Song",
    colStatus: "Status",
    colBpm: "BPM",
    colKey: "Key",
    colLastSaved: "Last saved",
    colBackups: "Backups",
    colMixdown: "Mixdown",
    colAlbum: "Album",
    searchPlaceholder: "Search songs, tags, notes, plugins, samples…",
    rescan: "Rescan folders",
    favorites: "Favorites",
    issues: (n: number) => `Issues (${n})`,
    archived: (n: number) => `Archived (${n})`,
    templates: (n: number) => `Templates (${n})`,
    all: "All",
    selected: (n: number) => `${n} selected`,
    setStatus: "Set status",
    addToRelease: "Add to release",
    crew: "Crew",
    shareWith: (crew: string | null) => `Share with ${crew}`,
    stopSharing: "Stop sharing",
    sharedElsewhere: (n: number) =>
      `${n} song${n === 1 ? " is" : "s are"} shared with another crew: move ${n === 1 ? "it" : "them"} from the song panel.`,
    archive: "Archive",
    archiveSelected: "Archive selected",
    unarchiveSelected: "Unarchive selected",
    packageTitle: "Zip each selected song with its samples",
    packageN: (n: number) => `Package ${n}`,
    rendering: "Rendering…",
    exportN: (n: number) => `Export ${n}`,
    demoBanner: "Sample data — changes aren't saved and export is disabled until you link a real project folder.",
    scanning: "Scanning your project folders…",
    noMatch: "No songs match",
    clearFilters: "Clear filters",
    unreachable: (folder: string) => `${folder} isn't reachable right now (unplugged drive or moved folder). Its songs are hidden until it's back; their stages, notes and credits are kept.`,
    retry: "Retry",
    repoint: "It moved: find it",
    repointTitle: "Pick the folder's new place (a drive with another letter, a renamed folder). Every song's data follows.",
    unlink: "Unlink",
    unlinkConfirm: "Unlink it?",
    hiddenSelected: (n: number) => `(${n} hidden by the filters, left out)`,
    removeFavorite: "Remove from favorites",
    addFavorite: "Add to favorites",
    template: "template",
    keyFromTrack: "Found in a mixer track name — set it in the song panel",
    pluginsMissing: (names: string) => `Plugins not installed: ${names}`,
    samplesMissing: (n: number) => `${n} missing sample${n === 1 ? "" : "s"}`,
    unreadable: (err: string) => `Couldn't be read: ${err}`,
    folders: "Folders",
    allSongs: "All songs",
    fold: (name: string) => `Fold ${name}`,
    unfold: (name: string) => `Unfold ${name}`,
    folderIssues: (n: number) => `${n} song${n === 1 ? "" : "s"} with issues`,
    noFolder: "No project folder linked yet",
    foundFolders: "Found these DAW folders on this computer. Link the ones you use:",
    pointAt:
      "Point Hivo at the folder where your projects live: FL Studio, Ableton Live, REAPER, Studio One, Pro Tools, Cubase or Bitwig. You can link several.",
    anotherFolder: "Another folder…",
    linkFolder: "Link a project folder",
    loadSample: "Load sample data",
  },
  {
    colSong: "Son",
    colStatus: "Étape",
    colBpm: "BPM",
    colKey: "Tonalité",
    colLastSaved: "Dernière sauvegarde",
    colBackups: "Sauvegardes",
    colMixdown: "Mixdown",
    colAlbum: "Album",
    searchPlaceholder: "Cherche des sons, tags, notes, plugins, samples…",
    rescan: "Rescanner les dossiers",
    favorites: "Favoris",
    issues: (n: number) => `Problèmes (${n})`,
    archived: (n: number) => `Archivés (${n})`,
    templates: (n: number) => `Templates (${n})`,
    all: "Tous",
    selected: (n: number) => `${n} sélectionné${n === 1 ? "" : "s"}`,
    setStatus: "Changer l'étape",
    addToRelease: "Ajouter à une sortie",
    crew: "Crew",
    shareWith: (crew: string | null) => `Partager avec ${crew}`,
    stopSharing: "Ne plus partager",
    sharedElsewhere: (n: number) =>
      n === 1
        ? "1 son est partagé avec un autre crew : change-le depuis le panneau du son."
        : `${n} sons sont partagés avec un autre crew : change-les depuis le panneau du son.`,
    archive: "Archiver",
    archiveSelected: "Archiver la sélection",
    unarchiveSelected: "Désarchiver la sélection",
    packageTitle: "Zipper chaque son sélectionné avec ses samples",
    packageN: (n: number) => `Pack zip (${n})`,
    rendering: "Rendu en cours…",
    exportN: (n: number) => `Exporter ${n}`,
    demoBanner:
      "Données d'exemple — rien n'est sauvegardé et l'export est désactivé tant que tu n'as pas lié un vrai dossier de projets.",
    scanning: "Scan de tes dossiers de projets…",
    noMatch: "Aucun son ne correspond",
    clearFilters: "Effacer les filtres",
    unreachable: (folder: string) => `${folder} est injoignable pour l'instant (disque débranché ou dossier déplacé). Ses sons sont masqués jusqu'à son retour ; leurs étapes, notes et crédits sont gardés.`,
    retry: "Réessayer",
    repoint: "Il a bougé : le retrouver",
    repointTitle: "Choisis le nouvel emplacement du dossier (disque avec une autre lettre, dossier renommé). Les infos de chaque son suivent.",
    unlink: "Délier",
    unlinkConfirm: "Le délier ?",
    hiddenSelected: (n: number) => `(${n} masqué${n === 1 ? "" : "s"} par les filtres, laissé${n === 1 ? "" : "s"} de côté)`,
    removeFavorite: "Retirer des favoris",
    addFavorite: "Ajouter aux favoris",
    template: "template",
    keyFromTrack: "Trouvée dans un nom de piste du mixer — règle-la dans le panneau du son",
    pluginsMissing: (names: string) => `Plugins pas installés : ${names}`,
    samplesMissing: (n: number) => `${n} sample${n === 1 ? " manquant" : "s manquants"}`,
    unreadable: (err: string) => `Illisible : ${err}`,
    folders: "Dossiers",
    allSongs: "Tous les sons",
    fold: (name: string) => `Replier ${name}`,
    unfold: (name: string) => `Déplier ${name}`,
    folderIssues: (n: number) => `${n} son${n === 1 ? "" : "s"} avec des soucis`,
    noFolder: "Aucun dossier de projets lié pour l'instant",
    foundFolders: "On a trouvé ces dossiers de DAW sur cet ordi. Lie ceux que tu utilises :",
    pointAt:
      "Indique à Hivo le dossier où vivent tes projets : FL Studio, Ableton Live, REAPER, Studio One, Pro Tools, Cubase ou Bitwig. Tu peux en lier plusieurs.",
    anotherFolder: "Un autre dossier…",
    linkFolder: "Lier un dossier de projets",
    loadSample: "Charger les données d'exemple",
  },
);

const STATUS_ORDER: Record<string, number> = Object.fromEntries(STATUSES.map((s, i) => [s.id, i + 1]));

function columns(): { key: SortKey | null; label: string; className?: string }[] {
  const t = tr(T);
  return [
    { key: "name", label: t.colSong },
    { key: "status", label: t.colStatus },
    { key: "tempo", label: t.colBpm },
    { key: "key", label: t.colKey },
    { key: "modified", label: t.colLastSaved },
    { key: "versions", label: t.colBackups },
    { key: null, label: t.colMixdown },
    { key: null, label: t.colAlbum },
  ];
}

/** Songs shown in the library, board and stats. Templates and archived songs
 * only in the Library table (`followArchivedToggle`), when their toggles are
 * on: never in the Dashboard, the stats, the pipeline or the kit picker. */
export function useVisibleSongs(followArchivedToggle = false): ProjectInfo[] {
  const projects = useAppStore((s) => s.projects);
  const songs = useAppStore((s) => s.workspace.songs);
  const showTemplates = useAppStore((s) => s.showTemplates) && followArchivedToggle;
  const showArchived = useAppStore((s) => s.showArchived) && followArchivedToggle;
  return useMemo(
    () =>
      projects.filter(
        (p) => (showTemplates || !p.isTemplate) && (showArchived ? songs[p.path]?.archived : !songs[p.path]?.archived),
      ),
    [projects, songs, showTemplates, showArchived],
  );
}

export function LibraryView() {
  const songs = useVisibleSongs(true);
  const showArchived = useAppStore((s) => s.showArchived);
  const setShowArchived = useAppStore((s) => s.setShowArchived);
  const startPackage = useAppStore((s) => s.startPackage);
  const packaging = useAppStore((s) => s.packaging);
  const archivedCount = useAppStore(
    (s) => s.projects.filter((p) => s.workspace.songs[p.path]?.archived).length,
  );
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const scanning = useAppStore((s) => s.scanning);
  const search = useAppStore((s) => s.search);
  const setSearch = useAppStore((s) => s.setSearch);
  const selected = useAppStore((s) => s.selected);
  const toggleSelected = useAppStore((s) => s.toggleSelected);
  const selectAll = useAppStore((s) => s.selectAll);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const rescan = useAppStore((s) => s.rescan);
  const startRender = useAppStore((s) => s.startRender);
  const rendering = useAppStore((s) => s.rendering);
  const settings = useAppStore((s) => s.settings);
  const demoMode = useAppStore((s) => s.demoMode);
  const sortKey = useAppStore((s) => s.sortKey);
  const sortDir = useAppStore((s) => s.sortDir);
  const setSort = useAppStore((s) => s.setSort);
  const statusFilter = useAppStore((s) => s.statusFilter);
  const setStatusFilter = useAppStore((s) => s.setStatusFilter);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const setTagFilter = useAppStore((s) => s.setTagFilter);
  const favoritesOnly = useAppStore((s) => s.favoritesOnly);
  const setFavoritesOnly = useAppStore((s) => s.setFavoritesOnly);
  const showTemplates = useAppStore((s) => s.showTemplates);
  const setShowTemplates = useAppStore((s) => s.setShowTemplates);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const pluginFilter = useAppStore((s) => s.pluginFilter);
  const setPluginFilter = useAppStore((s) => s.setPluginFilter);
  const problemsOnly = useAppStore((s) => s.problemsOnly);
  const setProblemsOnly = useAppStore((s) => s.setProblemsOnly);
  const folderFilter = useAppStore((s) => s.folderFilter);
  const setFolderFilter = useAppStore((s) => s.setFolderFilter);
  // The folder tree of the songs shown (empty when there's nothing to branch into).
  const tree = useMemo(() => buildFolderTree(songs), [songs]);
  const crumbs = useMemo(() => (folderFilter ? folderPath(tree, folderFilter) : []), [tree, folderFilter]);
  const updateSong = useAppStore((s) => s.updateSong);
  const setStatus = useAppStore((s) => s.setStatus);
  const addTracks = useAppStore((s) => s.addTracks);
  const detailPath = useAppStore((s) => s.detailPath);
  const openDetail = useAppStore((s) => s.openDetail);
  const [error, setError] = useState<string | null>(null);

  const statusOf = (p: ProjectInfo) => workspace.songs[p.path]?.status;
  const templateCount = projects.length - projects.filter((p) => !p.isTemplate).length;

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of songs) {
      const key = workspace.songs[p.path]?.status ?? "unsorted";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [songs, workspace.songs]);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of songs)
      for (const t of workspace.songs[p.path]?.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [songs, workspace.songs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = songs;
    if (q) {
      list = list.filter((p) => {
        const meta = workspace.songs[p.path];
        return (
          p.name.toLowerCase().includes(q) ||
          p.folder.toLowerCase().includes(q) ||
          meta?.notes?.toLowerCase().includes(q) ||
          meta?.tags?.some((t) => t.includes(q)) ||
          meta?.key?.toLowerCase() === q ||
          p.plugins.some((x) => x.name.toLowerCase().includes(q)) ||
          // "Which songs use this sample / pack?" — match file names only.
          p.samples.some((s) => (s.path.split(/[/\\]/).pop() ?? "").toLowerCase().includes(q))
        );
      });
    }
    if (folderFilter) {
      list = list.filter((p) => inFolder(p, folderFilter));
    }
    if (pluginFilter) {
      list = list.filter((p) => p.plugins.some((x) => x.name === pluginFilter));
    }
    if (problemsOnly) {
      list = list.filter(hasProblems);
    }
    if (statusFilter) {
      list = list.filter((p) => (statusOf(p) ?? "unsorted") === statusFilter);
    }
    if (tagFilter) {
      list = list.filter((p) => workspace.songs[p.path]?.tags?.includes(tagFilter));
    }
    if (favoritesOnly) {
      list = list.filter((p) => settings.favorites.includes(p.path));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      if (sortKey === "status")
        return ((STATUS_ORDER[statusOf(a) ?? ""] ?? 0) - (STATUS_ORDER[statusOf(b) ?? ""] ?? 0)) * dir;
      if (sortKey === "tempo") return ((a.tempoBpm ?? -1) - (b.tempoBpm ?? -1)) * dir;
      if (sortKey === "key") {
        const ka = workspace.songs[a.path]?.key ?? "";
        const kb = workspace.songs[b.path]?.key ?? "";
        return (KEYS.indexOf(ka) - KEYS.indexOf(kb)) * dir;
      }
      if (sortKey === "versions") return (a.backups.length - b.backups.length) * dir;
      return (lastSaveMs(a) - lastSaveMs(b)) * dir;
    });
    // statusOf only reads workspace.songs, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, workspace.songs, search, statusFilter, tagFilter, pluginFilter, problemsOnly, favoritesOnly, folderFilter, settings.favorites, sortKey, sortDir]);

  const problemCount = useMemo(() => songs.filter(hasProblems).length, [songs]);
  const filteredByFolderCount = useMemo(() => (folderFilter ? songs.filter((p) => inFolder(p, folderFilter)).length : songs.length), [songs, folderFilter]);

  const { can: canShare, crewName } = useCanShare();
  const setShared = useCrewStore((s) => s.setShared);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.path));
  // Bulk actions only touch the selected songs that are on screen: a filter
  // can hide some, and they must not be changed (or rendered) unseen.
  const selectedPaths = useMemo(() => filtered.filter((p) => selected.has(p.path)).map((p) => p.path), [filtered, selected]);
  const hiddenSelected = selected.size - selectedPaths.length;
  const unreachable = useAppStore((s) => s.unreachable);
  const repointFolder = useAppStore((s) => s.repointFolder);
  const removeWatchedFolder = useAppStore((s) => s.removeWatchedFolder);
  const resetLibraryFilters = useAppStore((s) => s.resetLibraryFilters);
  const filtersOn = !!(search.trim() || statusFilter || tagFilter || pluginFilter || problemsOnly || favoritesOnly || folderFilter || showArchived);

  // A folder filter whose node is gone (songs moved, folder unlinked or
  // unreachable) would leave "No songs match" with nothing to click.
  useEffect(() => {
    if (folderFilter && !scanning && !hasFolderNode(tree, folderFilter)) setFolderFilter(null);
  }, [folderFilter, scanning, tree, setFolderFilter]);

  async function handleRender() {
    setError(null);
    try {
      await startRender(selectedPaths);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (settings.watchedFolders.length === 0 && !demoMode) {
    return <EmptyLibrary />;
  }

  const t = tr(T);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-6 py-3 [&_button]:whitespace-nowrap">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-engrave" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchPlaceholder}
            className="w-full rounded-md border border-rule bg-raised py-2 pl-9 pr-3 text-sm text-cream placeholder:text-engrave focus:border-orange-400/50 focus:outline-none"
          />
        </div>
        <button
          onClick={() => {
            setError(null);
            rescan().catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }}
          disabled={scanning || demoMode}
          className={btn}
          title={t.rescan}
        >
          <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
        </button>
        <Toggle active={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>
          <Star size={14} /> {t.favorites}
        </Toggle>
        {(problemCount > 0 || problemsOnly) && (
          <Toggle active={problemsOnly} onClick={() => setProblemsOnly(!problemsOnly)}>
            <AlertTriangle size={14} /> {t.issues(problemCount)}
          </Toggle>
        )}
        {(archivedCount > 0 || showArchived) && (
          <Toggle active={showArchived} onClick={() => setShowArchived(!showArchived)}>
            <Archive size={14} /> {t.archived(archivedCount)}
          </Toggle>
        )}
        {templateCount > 0 && (
          <Toggle active={showTemplates} onClick={() => setShowTemplates(!showTemplates)}>
            <LayoutTemplate size={14} /> {t.templates(templateCount)}
          </Toggle>
        )}

      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-6 py-2">
        {crumbs.length > 0 && (
          <nav aria-label={t.folders} className="mr-2 flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.08em]">
            <button onClick={() => setFolderFilter(null)} className="text-engrave hover:text-cream">
              {t.allSongs}
            </button>
            {crumbs.map((n, i) => (
              <span key={n.path} className="flex items-center gap-1">
                <ChevronRight size={11} className="text-engrave" aria-hidden />
                <button onClick={() => setFolderFilter(n.path)} className={i === crumbs.length - 1 ? "text-cream" : "text-engrave hover:text-cream"}>
                  {n.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        <Chip active={statusFilter === null} onClick={() => setStatusFilter(null)}>
          {t.all} <span className="text-engrave">{folderFilter ? filteredByFolderCount : songs.length}</span>
        </Chip>
        {[{ id: "unsorted" as const, ...UNSORTED }, ...STATUSES].map((s) => {
          const count = statusCounts.get(s.id) ?? 0;
          if (!count && statusFilter !== s.id) return null;
          return (
            <Chip
              key={s.id}
              active={statusFilter === s.id}
              onClick={() => setStatusFilter(statusFilter === s.id ? null : (s.id as StatusFilter))}
            >
              <StatusDot color={s.color} /> {s.label} <span className="text-engrave">{count}</span>
            </Chip>
          );
        })}
        {pluginFilter && (
          <Chip active onClick={() => setPluginFilter(null)}>
            <Plug size={11} /> {pluginFilter} <X size={11} />
          </Chip>
        )}
        {tags.length > 0 && <span className="mx-2 h-4 w-px bg-rule" />}
        {tags.slice(0, 12).map(([tag, count]) => (
          <Chip key={tag} active={tagFilter === tag} onClick={() => setTagFilter(tagFilter === tag ? null : tag)}>
            #{tag} <span className="text-engrave">{count}</span>
            {tagFilter === tag && <X size={11} />}
          </Chip>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-orange-400/20 bg-orange-500/[0.06] px-6 py-2 text-sm">
          <span className="text-orange-200">{t.selected(selectedPaths.length)}</span>
          {hiddenSelected > 0 && <span className="text-xs text-engrave">{t.hiddenSelected(hiddenSelected)}</span>}
          <BulkSelect
            label={t.setStatus}
            options={[{ value: "", label: UNSORTED.label }, ...STATUSES.map((s) => ({ value: s.id, label: s.label }))]}
            onPick={(v) => setStatus(selectedPaths, (v || undefined) as SongStatus | undefined)}
          />
          {workspace.albums.length > 0 && (
            <BulkSelect
              label={t.addToRelease}
              options={workspace.albums.map((a) => ({ value: a.id, label: a.title }))}
              onPick={(id) => addTracks(id, selectedPaths)}
            />
          )}
          {canShare && (
            <BulkSelect
              label={t.crew}
              options={[
                { value: "share", label: t.shareWith(crewName) },
                { value: "unshare", label: t.stopSharing },
              ]}
              onPick={(v) => {
                const skipped = setShared(selectedPaths, v === "share");
                setShareNote(skipped ? t.sharedElsewhere(skipped) : null);
              }}
            />
          )}
          {shareNote && (
            <span role="status" className="text-xs text-amber-300">
              {shareNote}
            </span>
          )}
          <BulkSelect
            label={t.archive}
            options={[
              { value: "archive", label: t.archiveSelected },
              { value: "unarchive", label: t.unarchiveSelected },
            ]}
            onPick={(v) => {
              for (const p of selectedPaths) updateSong(p, { archived: v === "archive" });
              clearSelection();
            }}
          />
          <button
            onClick={() => startPackage(selectedPaths).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
            disabled={packaging || demoMode || selectedPaths.length === 0}
            className={`${btn} ml-auto py-1 text-xs`}
            title={t.packageTitle}
          >
            <Package size={13} /> {t.packageN(selectedPaths.length)}
          </button>
          <button onClick={handleRender} disabled={rendering || demoMode || selectedPaths.length === 0} className={btnPrimary}>
            <Download size={14} />
            {rendering ? t.rendering : t.exportN(selectedPaths.length)}
          </button>
          <button onClick={clearSelection} className="rounded p-1 text-engrave hover:text-cream">
            <X size={15} />
          </button>
        </div>
      )}

      {!demoMode &&
        unreachable.map((folder) => (
          <div
            key={folder}
            role="status"
            className="mx-6 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200"
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 break-all">{t.unreachable(folder)}</span>
            <button
              onClick={() => {
                setError(null);
                rescan().catch((e) => setError(e instanceof Error ? e.message : String(e)));
              }}
              disabled={scanning}
              className={`${btn} py-1 text-xs`}
            >
              <RefreshCw size={12} /> {t.retry}
            </button>
            <button
              onClick={() => repointFolder(folder).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
              title={t.repointTitle}
              className={`${btn} py-1 text-xs`}
            >
              <FolderSearch size={12} /> {t.repoint}
            </button>
            <ConfirmButton
              label={t.unlink}
              confirmLabel={t.unlinkConfirm}
              onConfirm={() => removeWatchedFolder(folder).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
              className={`${btn} py-1 text-xs`}
            />
          </div>
        ))}

      {error && (
        <div className="mx-6 mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {tree.length > 0 && <FolderPane tree={tree} selected={folderFilter} onSelect={setFolderFilter} />}
        <div className="min-w-0 flex-1 overflow-auto px-4 py-2">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-engrave">
            <Music2 size={28} />
            <div className="text-sm">{scanning ? t.scanning : t.noMatch}</div>
            {!scanning && filtersOn && (
              <button onClick={resetLibraryFilters} className={`${btn} mt-1 text-xs`}>
                <X size={12} /> {t.clearFilters}
              </button>
            )}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-y-0.5 text-sm">
            <thead className="sticky top-0 z-10 bg-chassis">
              <tr className="text-left font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">
                <th className="w-8 px-2 py-2">
                  <button
                    onClick={() => (allSelected ? clearSelection() : selectAll(filtered.map((p) => p.path)))}
                    className="flex text-engrave hover:text-body"
                  >
                    {allSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                  </button>
                </th>
                <th className="w-6 px-1 py-2" />
                {columns().map((col) => (
                  <th key={col.label} className="whitespace-nowrap px-2 py-2 font-medium">
                    {col.key ? (
                      <button
                        onClick={() => setSort(col.key!)}
                        className={`flex items-center gap-1 uppercase tracking-[0.14em] hover:text-body ${sortKey === col.key ? "text-cream" : ""}`}
                      >
                        {col.label}
                        <ArrowUpDown size={10} />
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((project) => {
                const isSelected = selected.has(project.path);
                const isOpen = detailPath === project.path;
                const isFavorite = settings.favorites.includes(project.path);
                const meta = workspace.songs[project.path];
                const albums = albumsOf(workspace, project.path);
                return (
                  <tr
                    key={project.path}
                    onClick={() => openDetail(isOpen ? null : project.path)}
                    className={`cursor-pointer ${
                      isOpen ? "bg-raised" : isSelected ? "bg-orange-500/10" : "hover:bg-panel"
                    }`}
                  >
                    <td className="rounded-l-md px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => toggleSelected(project.path)} className="flex text-engrave hover:text-body">
                        {isSelected ? <CheckSquare size={15} className="text-orange-400" /> : <Square size={15} />}
                      </button>
                    </td>
                    <td className="px-1 py-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggleFavorite(project.path)}
                        aria-label={isFavorite ? t.removeFavorite : t.addFavorite}
                        className="flex text-engrave hover:text-orange-300"
                      >
                        <Star size={13} fill={isFavorite ? "currentColor" : "none"} className={isFavorite ? "text-orange-400" : ""} />
                      </button>
                    </td>
                    <td className="max-w-[280px] px-2 py-2">
                      <div className="flex items-center gap-2">
                        {project.daw && project.daw !== "fl-studio" && (
                          <span className="shrink-0 rounded bg-rule px-1.5 py-px text-[10px] font-medium text-body" title={dawOf(project).label}>
                            {dawOf(project).short}
                          </span>
                        )}
                        <span className="truncate font-medium text-cream" title={project.path}>
                          {songLabel(project, songs)}
                        </span>
                        {hasProblems(project) && <ProblemIcon project={project} />}
                        {project.isTemplate && (
                          <span className="rounded bg-rule px-1.5 text-[10px]  text-engrave">{t.template}</span>
                        )}
                      </div>
                      {meta?.tags && meta.tags.length > 0 && (
                        <div className="mt-0.5 truncate text-[11px] text-engrave">
                          {meta.tags.map((t) => `#${t}`).join("  ")}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <StatusSelect compact value={meta?.status} onChange={(status) => updateSong(project.path, { status })} />
                    </td>
                    <td className="px-2 py-2 font-mono text-[13px] tabular-nums text-body">{formatBpm(project.tempoBpm)}</td>
                    <td className="px-2 py-2 font-mono text-[13px] text-body">
                      {meta?.key ??
                        (detectKey(project.trackNames) ? (
                          <span className="italic text-engrave" title={t.keyFromTrack}>
                            {detectKey(project.trackNames)}?
                          </span>
                        ) : (
                          <span className="text-engrave/50">—</span>
                        ))}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-[13px] text-body">{formatDate(lastSaveMs(project))}</td>
                    <td className="px-2 py-2 tabular-nums text-engrave">{project.backups.length || "—"}</td>
                    <td className="px-2 py-2">
                      <MixdownBadge project={project} short />
                    </td>
                    <td className="rounded-r-md px-2 py-2">
                      <div className="flex max-w-[160px] items-center gap-1.5 truncate text-xs text-engrave">
                        {albums.map((a) => (
                          <span key={a.id} className="flex items-center gap-1 truncate" title={a.title}>
                            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: a.color }} />
                            {albums.length === 1 && <span className="truncate">{a.title}</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </div>
      </div>
    </div>
  );
}

/** The folder tree on the Library's left: the watched roots and the folders
 * that hold two or more songs. Clicking a folder scopes the table to that
 * branch; the chevron folds it. Roots and their first level start open. */
function FolderPane({ tree, selected, onSelect }: { tree: FolderNode[]; selected: string | null; onSelect: (path: string | null) => void }) {
  const t = tr(T);
  const [folded, setFolded] = useState<Set<string>>(() => {
    const deep = new Set<string>();
    const walk = (nodes: FolderNode[]) =>
      nodes.forEach((n) => {
        if (n.depth >= 1 && n.children.length) deep.add(n.path);
        walk(n.children);
      });
    walk(tree);
    return deep;
  });
  const toggle = (path: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const row = (n: FolderNode) => {
    const on = selected !== null && selected === n.path;
    const open = !folded.has(n.path);
    return (
      <li key={n.path}>
        <div
          className={`flex items-center gap-1 rounded py-1 pr-2 text-xs ${on ? "bg-cream text-chassis" : "text-body hover:bg-raised"}`}
          style={{ paddingLeft: 6 + n.depth * 12 }}
        >
          {n.children.length > 0 ? (
            <button onClick={() => toggle(n.path)} aria-label={open ? t.fold(n.name) : t.unfold(n.name)} className={`shrink-0 rounded p-0.5 ${on ? "text-chassis" : "text-engrave hover:text-cream"}`}>
              <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
            </button>
          ) : (
            <span className="w-[20px] shrink-0" />
          )}
          <button onClick={() => onSelect(on ? null : n.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={n.path}>
            <Folder size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{n.name}</span>
            {n.issues > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-missing" title={t.folderIssues(n.issues)} />}
            <span className={`ml-auto shrink-0 font-mono text-[10.5px] ${on ? "text-chassis/70" : "text-engrave"}`}>{n.count}</span>
          </button>
        </div>
        {open && n.children.length > 0 && <ul>{n.children.map(row)}</ul>}
      </li>
    );
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-rule py-2 pl-2 pr-1" aria-label={t.folders}>
      <div className="mb-1 px-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{t.folders}</div>
      <ul className="flex flex-col gap-px">
        <li>
          <button onClick={() => onSelect(null)} className={`flex w-full items-center gap-1.5 rounded py-1 pl-[26px] pr-2 text-left text-xs ${selected === null ? "bg-cream text-chassis" : "text-body hover:bg-raised"}`}>
            <span className="truncate">{t.allSongs}</span>
          </button>
        </li>
        {tree.map(row)}
      </ul>
    </aside>
  );
}

function ProblemIcon({ project }: { project: ProjectInfo }) {
  const plugins = missingPlugins(project).map((p) => p.name);
  const samples = missingSamples(project).length;
  const lines = [
    project.readError ? tr(T).unreadable(project.readError) : "",
    plugins.length ? tr(T).pluginsMissing(plugins.join(", ")) : "",
    samples ? tr(T).samplesMissing(samples) : "",
  ].filter(Boolean);
  return (
    <span title={lines.join("\n")} className="shrink-0 text-red-400" aria-label={lines.join(". ")}>
      <AlertTriangle size={12} />
    </span>
  );
}

function BulkSelect({
  label,
  options,
  onPick,
}: {
  label: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  return (
    <label className={`${btn} relative cursor-pointer py-1 text-xs`}>
      {label}
      <select
        value="__"
        onChange={(e) => onPick(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="__" disabled>
          {label}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** First run: no folder linked. Proposes every DAW folder found. */
export function EmptyLibrary() {
  const detected = useAppStore((s) => s.detectedFolders);
  const suggested = (detected?.length ?? 0) > 0;
  const addWatchedFolder = useAppStore((s) => s.addWatchedFolder);
  const loadDemoData = useAppStore((s) => s.loadDemoData);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => () => {
    setError(null);
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const t = tr(T);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-raised text-engrave">
        <FolderSearch size={28} />
      </div>
      <div className="text-base font-medium text-cream">{t.noFolder}</div>
      {suggested ? (
        <div className="w-full max-w-xl text-sm text-engrave">
          {t.foundFolders}
          <div className="mt-3">
            <DetectedFolders compact />
          </div>
        </div>
      ) : (
        <div className="max-w-sm text-sm text-engrave">
          {t.pointAt}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button onClick={run(addWatchedFolder)} className={suggested ? btn : btnPrimary}>
          {suggested ? t.anotherFolder : t.linkFolder}
        </button>
        <button onClick={loadDemoData} className={btn}>
          {t.loadSample}
        </button>
      </div>
      {error && <div className="max-w-md text-xs text-red-300">{error}</div>}
    </div>
  );
}
