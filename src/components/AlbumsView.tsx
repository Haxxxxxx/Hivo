import { useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Disc3, Download, Package, Plus, Rocket, Search, Trash2, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { formatRelative } from "../lib/format";
import { localDayMs } from "../lib/launchKit";
import { ALBUM_COLORS, STATUSES, UNSORTED, formatBpm, isFinished, renderFreshness, statusInfo } from "../lib/songs";
import type { Album, AlbumKind, ProjectInfo, Workspace } from "../types";
import { ConfirmButton, Modal, StatusDot, StatusSelect, btn, btnPrimary, input, sectionLabel } from "./ui";
import { MixdownBadge, Stat } from "../ui";
import { ReleaseShare } from "./CrewPanel";
import { dict, tr } from "../i18n";

const T = dict(
  {
    title: "Albums & releases",
    newRelease: "New release",
    releaseTitle: "Release title",
    create: "Create",
    cancel: "Cancel",
    empty: "No releases yet. Create one and add songs from your library.",
    cardLine: (tracks: number, done: number) => `${tracks} track${tracks === 1 ? "" : "s"} · ${done} done`,
    allReleases: "All releases",
    coverColor: (color: string) => `Cover color ${color}`,
    releaseDate: "Release date",
    released: (when: string) => `released ${when}`,
    releasing: (when: string) => `release ${when}`,
    tracks: "Tracks",
    done: "Done",
    mixdownsCurrent: "Mixdowns current",
    bpmRange: "BPM range",
    tracklist: "Tracklist",
    addSongs: "Add songs",
    newSong: "New song for this release",
    packageHint:
      "Zip every track with its samples into <export folder>/Packages/<release title> — for a mix engineer, a collaborator, or archiving",
    packageRelease: "Package release",
    exportHint: "Render every track, numbered, into <export folder>/<release title>",
    exportRelease: "Export release",
    noTracks: "No tracks yet — add songs from your library.",
    missing: (file: string) => `Missing: ${file} (moved or renamed?)`,
    removeTrack: "Remove from release",
    openKit: "Open its Launch Kit",
    notes: "Notes",
    notesPlaceholder: "Concept, artwork ideas, features, release plan…",
    deleteRelease: "Delete release",
    deleteConfirm: "Delete? The songs themselves are kept. Click again",
    addTo: (title: string) => `Add songs to ${title}`,
    search: "Search songs",
    nothing: "Nothing to add",
    addPicked: (n: number) => `Add ${n || ""} song${n === 1 ? "" : "s"}`,
    trackUp: (name: string) => `Move ${name} up`,
    trackDown: (name: string) => `Move ${name} down`,
    trackRemove: (name: string) => `Remove ${name} from the release`,
  },
  {
    title: "Albums et sorties",
    newRelease: "Nouvelle sortie",
    releaseTitle: "Titre de la sortie",
    create: "Créer",
    cancel: "Annuler",
    empty: "Pas encore de sortie. Crées-en une et ajoute des sons depuis ta bibliothèque.",
    cardLine: (tracks: number, done: number) => `${tracks} morceau${tracks === 1 ? "" : "x"} · ${done} fini${done > 1 ? "s" : ""}`,
    allReleases: "Toutes les sorties",
    coverColor: (color: string) => `Couleur de cover ${color}`,
    releaseDate: "Date de sortie",
    released: (when: string) => `sortie ${when}`,
    releasing: (when: string) => `sortie ${when}`,
    tracks: "Morceaux",
    done: "Finis",
    mixdownsCurrent: "Mixdowns à jour",
    bpmRange: "Plage de BPM",
    tracklist: "Tracklist",
    addSongs: "Ajouter des sons",
    newSong: "Nouveau son pour cette sortie",
    packageHint:
      "Zippe chaque morceau avec ses samples dans <dossier d'export>/Packages/<titre de la sortie> — pour un ingé mix, un collab ou pour archiver",
    packageRelease: "Faire le pack zip",
    exportHint: "Fait le rendu de chaque morceau, numéroté, dans <dossier d'export>/<titre de la sortie>",
    exportRelease: "Exporter la sortie",
    noTracks: "Pas encore de morceaux — ajoute des sons depuis ta bibliothèque.",
    missing: (file: string) => `Introuvable : ${file} (déplacé ou renommé ?)`,
    removeTrack: "Retirer de la sortie",
    openKit: "Ouvrir son Launch Kit",
    notes: "Notes",
    notesPlaceholder: "Concept, idées de visuels, feats, plan de sortie…",
    deleteRelease: "Supprimer la sortie",
    deleteConfirm: "Supprimer ? Les sons eux-mêmes sont gardés. Clique encore",
    addTo: (title: string) => `Ajouter des sons à ${title}`,
    search: "Chercher des sons",
    nothing: "Rien à ajouter",
    addPicked: (n: number) => (n === 0 ? "Ajouter des sons" : `Ajouter ${n} son${n === 1 ? "" : "s"}`),
    trackUp: (name: string) => `Monter ${name}`,
    trackDown: (name: string) => `Descendre ${name}`,
    trackRemove: (name: string) => `Retirer ${name} de la sortie`,
  },
);

const KINDS: { id: AlbumKind; label: string }[] = [
  { id: "album", label: "Album" },
  { id: "ep", label: "EP" },
  { id: "mixtape", label: "Mixtape" },
  { id: "single", label: "Single" },
];

function kindLabel(kind: AlbumKind) {
  return KINDS.find((k) => k.id === kind)?.label ?? kind;
}

function tracksOf(album: Album, projects: ProjectInfo[]): (ProjectInfo | null)[] {
  const byPath = new Map(projects.map((p) => [p.path, p]));
  // A track whose project file was moved/renamed shows as missing rather than vanishing.
  return album.trackPaths.map((path) => byPath.get(path) ?? null);
}

export function AlbumsView() {
  const openAlbumId = useAppStore((s) => s.openAlbumId);
  const album = useAppStore((s) => s.workspace.albums.find((a) => a.id === s.openAlbumId));
  return openAlbumId && album ? <AlbumDetail album={album} /> : <AlbumGrid />;
}

function AlbumGrid() {
  const workspace = useAppStore((s) => s.workspace);
  const projects = useAppStore((s) => s.projects);
  const createAlbum = useAppStore((s) => s.createAlbum);
  const openAlbum = useAppStore((s) => s.openAlbum);
  const [draft, setDraft] = useState<string | null>(null);
  const t = tr(T);

  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">{t.title}</h1>
          </div>
          {draft === null && (
            <button onClick={() => setDraft("")} className={btnPrimary}>
              <Plus size={14} /> {t.newRelease}
            </button>
          )}
        </div>

        {draft !== null && (
          <form
            className="mt-5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const id = createAlbum(draft);
              setDraft(null);
              openAlbum(id);
            }}
          >
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.releaseTitle} className={input} />
            <button type="submit" className={btnPrimary}>
              {t.create}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={btn}>
              {t.cancel}
            </button>
          </form>
        )}

        {workspace.albums.length === 0 && draft === null ? (
          <div className="mt-16 flex flex-col items-center gap-2 text-center text-engrave">
            <Disc3 size={32} />
            <div className="text-sm">{t.empty}</div>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
            {workspace.albums.map((album) => (
              <AlbumCard key={album.id} album={album} projects={projects} workspace={workspace} onOpen={() => openAlbum(album.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AlbumCard({
  album,
  projects,
  workspace,
  onOpen,
}: {
  album: Album;
  projects: ProjectInfo[];
  workspace: Workspace;
  onOpen: () => void;
}) {
  const tracks = tracksOf(album, projects);
  const done = album.trackPaths.filter((p) => isFinished(workspace.songs[p]?.status)).length;
  return (
    <button onClick={onOpen} className="group rounded-xl border border-rule bg-panel p-3 text-left hover:border-rule-strong">
      <Cover album={album} />
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <div className="truncate font-medium text-cream">{album.title}</div>
        <div className="shrink-0 text-[11px]  text-engrave">{kindLabel(album.kind)}</div>
      </div>
      <div className="mt-0.5 text-xs text-engrave">
        {tr(T).cardLine(tracks.length, done)}
        {localDayMs(album.releaseDate) !== null && ` · ${formatRelative(localDayMs(album.releaseDate) as number)}`}
      </div>
      <div className="mt-2">
        <ProgressBar trackPaths={album.trackPaths} workspace={workspace} height={6} />
      </div>
    </button>
  );
}

function Cover({ album, size = "w-full" }: { album: Album; size?: string }) {
  const initials = album.title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div
      className={`${size} flex aspect-square items-end rounded-lg p-3`}
      style={{ background: `linear-gradient(135deg, ${album.color} 0%, ${album.color}55 55%, #161614 100%)` }}
    >
      <span className="text-3xl font-bold tracking-tight text-cream">{initials}</span>
    </div>
  );
}

/** Segmented bar: songs per pipeline stage, ordinal colors, 2px gaps. */
export function ProgressBar({ trackPaths, workspace, height = 10 }: { trackPaths: string[]; workspace: Workspace; height?: number }) {
  const segments = [{ id: undefined, ...UNSORTED }, ...STATUSES]
    .map((s) => ({ ...s, count: trackPaths.filter((p) => workspace.songs[p]?.status === s.id).length }))
    .filter((s) => s.count > 0);
  if (trackPaths.length === 0) return <div className="rounded-full bg-raised" style={{ height }} />;
  return (
    <div className="flex gap-[2px]" style={{ height }}>
      {segments.map((s, i) => (
        <div
          key={s.label}
          title={`${s.label}: ${s.count}`}
          style={{ flexGrow: s.count, background: s.color }}
          className={`${i === 0 ? "rounded-l-full" : ""} ${i === segments.length - 1 ? "rounded-r-full" : ""}`}
        />
      ))}
    </div>
  );
}

function AlbumDetail({ album }: { album: Album }) {
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const updateAlbum = useAppStore((s) => s.updateAlbum);
  const deleteAlbum = useAppStore((s) => s.deleteAlbum);
  const removeTrack = useAppStore((s) => s.removeTrack);
  const moveTrack = useAppStore((s) => s.moveTrack);
  const updateSong = useAppStore((s) => s.updateSong);
  const openAlbum = useAppStore((s) => s.openAlbum);
  const openDetail = useAppStore((s) => s.openDetail);
  const openNewProject = useAppStore((s) => s.openNewProject);
  const startRender = useAppStore((s) => s.startRender);
  const rendering = useAppStore((s) => s.rendering);
  const demoMode = useAppStore((s) => s.demoMode);
  const startPackage = useAppStore((s) => s.startPackage);
  const packaging = useAppStore((s) => s.packaging);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tracks = tracksOf(album, projects);
  const present = tracks.filter((t): t is ProjectInfo => t !== null);
  const done = album.trackPaths.filter((p) => isFinished(workspace.songs[p]?.status)).length;
  const mixed = present.filter((t) => renderFreshness(t) === "fresh").length;
  const bpms = present.map((t) => t.tempoBpm).filter((b): b is number => b != null);
  const releaseMs = localDayMs(album.releaseDate);
  const t = tr(T);

  async function exportAlbum() {
    setError(null);
    const numbered = tracks
      .map((t, i) => (t ? { path: t.path, name: `${String(i + 1).padStart(2, "0")} - ${t.name}` } : null))
      .filter((t): t is { path: string; name: string } => t !== null);
    try {
      await startRender(
        numbered.map((t) => t.path),
        { subfolder: album.title, names: numbered.map((t) => t.name) },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-6">
      <div className="mx-auto max-w-4xl">
        <button onClick={() => openAlbum(null)} className="flex items-center gap-1 text-xs text-engrave hover:text-cream">
          <ArrowLeft size={13} /> {t.allReleases}
        </button>

        <div className="mt-4 flex gap-6">
          <div className="w-44 shrink-0">
            <Cover album={album} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ALBUM_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => updateAlbum(album.id, { color: c })}
                  className={`h-5 w-5 rounded-full ${album.color === c ? "ring-2 ring-cream ring-offset-2 ring-offset-chassis" : ""}`}
                  style={{ background: c }}
                  aria-label={t.coverColor(c)}
                />
              ))}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <select
                value={album.kind}
                onChange={(e) => updateAlbum(album.id, { kind: e.target.value as AlbumKind })}
                className="rounded border border-rule bg-panel px-1.5 py-0.5 text-[12px] font-semibold text-engrave hover:text-cream"
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id} className="bg-raised">
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={album.title}
              onChange={(e) => updateAlbum(album.id, { title: e.target.value })}
              aria-label={t.releaseTitle}
              className="mt-1 w-full rounded border border-transparent bg-transparent text-2xl font-semibold text-cream focus:border-hot focus:outline-none"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-engrave">
              <label className="flex items-center gap-1.5">
                <span className="text-engrave">{t.releaseDate}</span>
                <input
                  type="date"
                  value={album.releaseDate ?? ""}
                  onChange={(e) => updateAlbum(album.id, { releaseDate: e.target.value || null })}
                  className="rounded border border-transparent bg-transparent text-body focus:border-hot focus:outline-none"
                />
              </label>
              {releaseMs && (
                <span className={releaseMs < Date.now() ? "text-engrave" : "text-orange-300"}>
                  {releaseMs < Date.now() ? t.released(formatRelative(releaseMs)) : t.releasing(formatRelative(releaseMs))}
                </span>
              )}
            </div>
            <ReleaseShare albumId={album.id} />

            <div className="mt-4 grid grid-cols-4 gap-2">
              <Stat label={t.tracks} value={String(album.trackPaths.length)} />
              <Stat label={t.done} value={`${done}/${album.trackPaths.length}`} />
              <Stat label={t.mixdownsCurrent} value={`${mixed}/${present.length}`} />
              <Stat
                label={t.bpmRange}
                value={bpms.length ? `${formatBpm(Math.min(...bpms))}–${formatBpm(Math.max(...bpms))}` : "—"}
              />
            </div>

            <div className="mt-4">
              <ProgressBar trackPaths={album.trackPaths} workspace={workspace} />
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-body">
                {[{ id: undefined, ...UNSORTED }, ...STATUSES].map((s) => {
                  const n = album.trackPaths.filter((p) => workspace.songs[p]?.status === s.id).length;
                  return n ? (
                    <span key={s.label} className="flex items-center gap-1">
                      <StatusDot color={s.color} /> {s.label} {n}
                    </span>
                  ) : null;
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 flex items-center gap-2">
          <div className={sectionLabel}>{t.tracklist}</div>
          <div className="ml-auto flex gap-2">
            <button onClick={() => setPicking(true)} className={btn}>
              <Plus size={14} /> {t.addSongs}
            </button>
            <button onClick={() => openNewProject({ albumId: album.id, status: "creation" })} className={btn}>
              <Plus size={14} /> {t.newSong}
            </button>
            <button
              onClick={() =>
                startPackage(present.map((t) => t.path), album.title).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
              }
              disabled={demoMode || packaging || present.length === 0}
              className={btn}
              title={t.packageHint}
            >
              <Package size={14} /> {t.packageRelease}
            </button>
            <button
              onClick={exportAlbum}
              disabled={demoMode || rendering || present.length === 0}
              className={btnPrimary}
              title={t.exportHint}
            >
              <Download size={14} /> {t.exportRelease}
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
        )}

        <div className="mt-3 overflow-hidden rounded-lg border border-rule">
          {tracks.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-engrave">{t.noTracks}</div>
          )}
          {tracks.map((t, i) => {
            const path = album.trackPaths[i];
            const trackName = t?.name ?? path.split(/[/\\]/).pop() ?? "";
            return (
              <div key={path} className="group flex items-center gap-3 border-b border-rule px-3 py-2 text-sm last:border-0 hover:bg-panel">
                <span className="w-6 text-right tabular-nums text-engrave">{i + 1}</span>
                <div className="flex flex-col opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    onClick={() => moveTrack(album.id, i, i - 1)}
                    disabled={i === 0}
                    aria-label={tr(T).trackUp(trackName)}
                    className="text-engrave hover:text-cream disabled:opacity-20"
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    onClick={() => moveTrack(album.id, i, i + 1)}
                    disabled={i === tracks.length - 1}
                    aria-label={tr(T).trackDown(trackName)}
                    className="text-engrave hover:text-cream disabled:opacity-20"
                  >
                    <ArrowDown size={11} />
                  </button>
                </div>
                {t ? (
                  <>
                    <button onClick={() => openDetail(t.path)} className="min-w-0 flex-1 truncate text-left font-medium text-cream hover:underline">
                      {t.name}
                    </button>
                    <StatusSelect compact value={workspace.songs[t.path]?.status} onChange={(status) => updateSong(t.path, { status })} />
                    <span className="w-10 text-right text-xs text-engrave">{workspace.songs[t.path]?.key ?? "—"}</span>
                    <span className="w-14 text-right tabular-nums text-xs text-body">{formatBpm(t.tempoBpm)}</span>
                    <span className="w-20">
                      <MixdownBadge project={t} />
                    </span>
                    <button
                      onClick={() => useAppStore.getState().openLaunchKit(t.path)}
                      title={tr(T).openKit}
                      aria-label={tr(T).openKit}
                      className="text-body opacity-0 hover:text-cream focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Rocket size={13} />
                    </button>
                  </>
                ) : (
                  <span className="flex-1 truncate text-engrave" title={path}>
                    {tr(T).missing(path.split(/[/\\]/).pop() ?? "")}
                  </span>
                )}
                <button
                  onClick={() => removeTrack(album.id, path)}
                  title={tr(T).removeTrack}
                  aria-label={tr(T).trackRemove(trackName)}
                  className="text-body opacity-0 hover:text-cream focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <div className={`${sectionLabel} mt-8`}>{t.notes}</div>
        <textarea
          value={album.notes}
          onChange={(e) => updateAlbum(album.id, { notes: e.target.value })}
          placeholder={t.notesPlaceholder}
          rows={4}
          className={`${input} mt-2 resize-y text-sm`}
        />

        <div className="mt-8 border-t border-rule pt-4">
          <ConfirmButton
            label={
              <>
                <Trash2 size={13} /> {t.deleteRelease}
              </>
            }
            confirmLabel={t.deleteConfirm}
            onConfirm={() => deleteAlbum(album.id)}
            className={`${btn} text-xs`}
          />
        </div>
      </div>

      {picking && <TrackPicker album={album} onClose={() => setPicking(false)} />}
    </div>
  );
}

function TrackPicker({ album, onClose }: { album: Album; onClose: () => void }) {
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const addTracks = useAppStore((s) => s.addTracks);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter(
      (p) => !p.isTemplate && !album.trackPaths.includes(p.path) && (!q || p.name.toLowerCase().includes(q)),
    );
  }, [projects, album.trackPaths, query]);
  const t = tr(T);

  return (
    <Modal title={t.addTo(album.title)} onClose={onClose}>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-engrave" />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search} className={`${input} pl-8`} />
      </div>
      <div className="mt-3 max-h-80 overflow-auto">
        {candidates.map((p) => {
          const on = picked.includes(p.path);
          const status = statusInfo(workspace.songs[p.path]?.status);
          return (
            <label key={p.path} className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm ${on ? "bg-orange-500/10" : "hover:bg-raised"}`}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => setPicked(on ? picked.filter((x) => x !== p.path) : [...picked, p.path])}
                className="accent-orange-500"
              />
              <span className="flex-1 truncate text-cream">{p.name}</span>
              <span className="flex items-center gap-1 text-[11px] text-engrave">
                <StatusDot color={status.color} size={6} /> {status.label}
              </span>
            </label>
          );
        })}
        {candidates.length === 0 && <div className="py-6 text-center text-sm text-engrave">{t.nothing}</div>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={btn}>
          {t.cancel}
        </button>
        <button
          disabled={picked.length === 0}
          onClick={() => {
            addTracks(album.id, picked);
            onClose();
          }}
          className={btnPrimary}
        >
          {t.addPicked(picked.length)}
        </button>
      </div>
    </Modal>
  );
}
