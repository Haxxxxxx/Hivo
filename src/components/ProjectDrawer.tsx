import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Package,
  CheckCircle2,
  Copy,
  Disc3,
  Download,
  ExternalLink,
  FileAudio,
  FolderInput,
  FolderOpen,
  History,
  PlayCircle,
  Plus,
  Rocket,
  RotateCcw,
  Star,
  MonitorPlay,
  Trash2,
  X,
} from "lucide-react";
import { useAppStore, type RenderJob } from "../store/useAppStore";
import { isUnder } from "../lib/relink";
import { formatBytes, formatDateTime, trashName } from "../lib/format";
import { audioSrc, backupsOnRiskyVolumes, openExternal, openInFlStudio, revealInFileManager } from "../lib/tauri";
import { KEYS, albumsOf, backupsBytes, formatBpm, lastSaveMs, missingPlugins, renderFreshness } from "../lib/songs";
import type { ProjectInfo } from "../types";
import { detectKey } from "../lib/people";
import { SongCredits, SongPitches } from "./SongPeople";
import { CrewMoveNote, MoveShareOffer, ShareToggle, StageConflictBanner } from "./CrewPanel";
import { FilesPanel } from "./FilesPanel";
import { NotesEditor } from "./NotesEditor";
import { PhoneMemos } from "./PhoneMemos";
import { openSession } from "../store/sessionBridge";
import { usePhoneInbox } from "../store/usePhoneInbox";
import { memosForSong } from "../lib/phoneInbox";
import { canRenderInApp, dawOf, isSketch } from "../lib/daws";
import { MAX_BANDLAB_URL, cleanBandlabUrl } from "../lib/sketch";
import { TemplateSelect, useFactoryTemplates } from "./NewProjectModal";
import { ConfirmButton, StatusSelect, TagEditor, btn, btnPrimary, input, sectionLabel } from "./ui";
import { Fact, Section } from "../ui";
import { dict, tr } from "../i18n";

const KEEP_BACKUPS = 5;

const T = dict(
  {
    couldntOpen: (err: string) => `Couldn't open it: ${err}`,
    openIn: (daw: string) => `Open in ${daw}`,
    reveal: "Reveal",
    launchKitTitle: "Metadata, snippets, release date, captions",
    renderDone: "Render finished: see the panel at the bottom.",
    renderTitle: "Render a mixdown with FL Studio (close FL Studio first if it's open: it can't render from the command line while it runs)",
    renderFailed: (err: string) => `The render failed: ${err}`,
    renderPending: "The render is still running: see the panel at the bottom.",
    renderMissingSamples: (n: number) =>
      `${n} sample${n === 1 ? "" : "s"} of this song can't be found: a render will be silent where ${n === 1 ? "it plays" : "they play"}.`,
    ambiguousExports: (n: number) =>
      `${n} mixdown${n === 1 ? "" : "s"} in the export folder ${n === 1 ? "is" : "are"} named after this song, but another linked song has the same name, so ${n === 1 ? "it isn't" : "they aren't"} counted for either. Rename one of the projects to tell them apart.`,
    notFound: "Not found right now",
    notFoundUnreachable: (folder: string) =>
      `Its linked folder (${folder}) isn't reachable: an unplugged drive or a moved folder. Its stage, notes and credits are kept; it comes back when the folder does.`,
    notFoundGone: "The project isn't where it was. If it was moved or renamed inside a linked folder, the next scan follows it; its stage, notes and credits are kept.",
    close: "Close",
    renderFlOnly: (tip: string) => `Rendering from the app works with FL Studio. ${tip}`,
    render: "Render",
    packageTitle: "Zip the project with every sample it uses — FL opens it directly. For sharing, collabs or archiving.",
    packageNext: "Check the files to include in the panel at the bottom, then write the package.",
    package: "Package",
    archiveTitle: "Hide from the library, board and stats. Nothing on disk changes.",
    archive: "Archive",
    readError: (err: string) =>
      `Couldn't read inside this project: ${err}. It's still tracked; tempo, samples and plugins are missing.`,
    archivedNote: "Archived — hidden from the library, board and stats.",
    unarchive: "Unarchive",
    stage: "Stage",
    key: "Key",
    notSet: "Not set",
    keyFromTrack: "Found in a mixer track name",
    useKey: (k: string) => `Use ${k}?`,
    releases: "Releases",
    addToRelease: "Add to release",
    noReleases: "No releases yet",
    tags: "Tags",
    notes: "Notes",
    notesPlaceholder: "Ideas, lyrics, what's left to do…",
    session: "Session view",
    sessionTitle: "The lyrics large, in a window kept on top of FL Studio",
    project: "Project",
    tempo: "Tempo",
    timeSig: "Time sig",
    lastSaved: "Last saved",
    dawVersion: (daw: string) => `${daw} version`,
    recordings: "Recordings",
    none: "none",
    projectFile: "Project file",
    credits: "Credits",
    sentTo: (n: number) => `Sent to · ${n}`,
    files: "Files",
    mixdown: "Mixdown",
    upToDate: "Up to date",
    olderThanProject: "Older than project",
    rendered: (when: string, size: string) => `Rendered ${when} · ${size}`,
    otherBounces: (n: number) => `+${n} other bounce${n > 1 ? "s" : ""} in the folder`,
    noMixdown: "No mixdown yet — render it, or bounce it from FL next to the project.",
    versions: (n: number, size: string) => `Versions · ${n} backups · ${size}`,
    saveVersion: "Save as new version",
    created: (name: string) => `Created ${name}`,
    create: "Create",
    restoreTitle: "Restore as a new file next to the project (the current version is untouched)",
    restoredAs: (name: string) => `Restored as ${name}`,
    restore: "Restore",
    showAll: (n: number) => `Show all ${n}`,
    cleanUp: (n: number, size: string) => `Clean up ${n} older backups (${size})`,
    confirmTrash: (n: number, trash: string) => `Move ${n} to ${trash}? Click again`,
    nothingDeleted: "Nothing deleted yet: read the warning below.",
    movedToTrash: (n: number, trash: string) => `Moved ${n} backups to the ${trash}`,
    riskyAll: "These backups are",
    riskySome: (n: number) => `${n} of these backups are`,
    riskyRest: (trash: string) => ` on a removable or network drive, which has no ${trash}: they would be `,
    deletedPermanently: "deleted permanently",
    deleted: (n: number) => `Deleted ${n} backups`,
    deletePermanently: "Delete permanently",
    keepThem: "Keep them",
    keepsRecent: (n: number) => `Keeps the ${n} most recent.`,
    plugins: (n: number) => `Plugins · ${n}`,
    notInstalled: (names: string) => `Not installed on this computer: ${names}`,
    pluginsUnknown: (daw: string) => `Whether they're installed here isn't checked for ${daw} projects yet.`,
    noneFound: "None found",
    librariesHint: "A pack that lives at another path on this computer counts as missing until you add it in Settings → Sample libraries.",
    librariesLink: "Add sample libraries",
    samples: (n: number) => `Samples · ${n}`,
    found: (n: number) => `${n} found`,
    movedTitle:
      "Not at the stored path, but a file with the same name is in this song's folder — the project was moved. FL can usually find these.",
    moved: (n: number) => `${n} moved`,
    missing: (n: number) => `${n} missing`,
    toggleProblems: (open: boolean, n: number) => `${open ? "Hide" : "Show"} ${n} not at their stored path`,
    revealSketch: "Show in folder",
    sketch: "BandLab sketch",
    sketchNote: "Audio exported from BandLab, no project yet. Its stage, notes and credits move to the FL project when you continue it.",
    bandlabLink: "BandLab link",
    linkPlaceholder: "https://www.bandlab.com/…",
    badLink: "The link must start with https:// (300 characters max). Not saved.",
    openLink: "Open in the browser",
    continueTemplate: "Start the FL project from",
    continueFl: "Continue in FL Studio",
    continuing: "Creating…",
    continueHint: "Hivo makes a new FL project from this template, with each BandLab file on its own playlist track from bar 1. Your existing projects are never changed.",
    continueNote: (name: string, clips: number, note: string | null) =>
      clips > 0 ? `${name}: ${clips} BandLab file${clips === 1 ? "" : "s"} on the playlist.${note ? ` ${note}.` : ""}` : `${name} is created. ${note ?? ""}.`,
    continueSkipped: (n: number) => ` ${n} more file${n === 1 ? " isn't" : "s aren't"} on it (20 at most): drag ${n === 1 ? "it" : "them"} in from the BandLab folder.`,
    continueMixdown: (names: string) => ` The mixdown (${names}) stays off the playlist, so it doesn't play over the stems.`,
    continueOpenFailed: (name: string, err: string) => `Created ${name}, but FL Studio didn't open: ${err}. Open it from the song panel.`,
    favorite: "Favorite",
    closePanel: "Close the song panel",
    removeFromRelease: (title: string) => `Remove from ${title}`,
    cancelVersion: "Cancel the new version",
    versionNameLabel: "New version name",
  },
  {
    couldntOpen: (err: string) => `Impossible de l'ouvrir : ${err}`,
    openIn: (daw: string) => `Ouvrir dans ${daw}`,
    reveal: "Afficher",
    launchKitTitle: "Métadonnées, extraits, date de sortie, textes",
    renderDone: "Rendu terminé : regarde le panneau en bas.",
    renderTitle: "Faire le rendu d'un mixdown avec FL Studio (ferme FL Studio d'abord s'il est ouvert : il ne peut pas faire de rendu en ligne de commande pendant qu'il tourne)",
    renderFailed: (err: string) => `Le rendu a échoué : ${err}`,
    renderPending: "Le rendu tourne encore : regarde le panneau en bas.",
    renderMissingSamples: (n: number) =>
      `${n} sample${n === 1 ? " de ce son est introuvable" : "s de ce son sont introuvables"} : un rendu sera muet là où ${n === 1 ? "il joue" : "ils jouent"}.`,
    ambiguousExports: (n: number) =>
      `${n} mixdown${n === 1 ? "" : "s"} du dossier d'export ${n === 1 ? "porte" : "portent"} le nom de ce son, mais un autre son lié a le même nom : ${n === 1 ? "il ne compte" : "ils ne comptent"} pour aucun des deux. Renomme un des projets pour les distinguer.`,
    notFound: "Introuvable pour l'instant",
    notFoundUnreachable: (folder: string) =>
      `Son dossier lié (${folder}) est injoignable : disque débranché ou dossier déplacé. Son étape, ses notes et ses crédits sont gardés ; il revient avec le dossier.`,
    notFoundGone: "Le projet n'est plus là où il était. S'il a été déplacé ou renommé dans un dossier lié, le prochain scan le suit ; son étape, ses notes et ses crédits sont gardés.",
    close: "Fermer",
    renderFlOnly: (tip: string) => `Le rendu depuis l'app marche avec FL Studio. ${tip}`,
    render: "Faire le rendu",
    packageTitle:
      "Zippe le projet avec tous les samples qu'il utilise — FL l'ouvre direct. Pour partager, collaborer ou archiver.",
    packageNext: "Vérifie les fichiers à inclure dans le panneau en bas, puis écris le pack zip.",
    package: "Pack zip",
    archiveTitle: "Cacher de la bibliothèque, du tableau et des stats. Rien ne change sur le disque.",
    archive: "Archiver",
    readError: (err: string) =>
      `Impossible de lire l'intérieur de ce projet : ${err}. Il reste suivi ; il manque le tempo, les samples et les plugins.`,
    archivedNote: "Archivé — caché de la bibliothèque, du tableau et des stats.",
    unarchive: "Désarchiver",
    stage: "Étape",
    key: "Tonalité",
    notSet: "Pas définie",
    keyFromTrack: "Trouvée dans un nom de piste du mixer",
    useKey: (k: string) => `Utiliser ${k} ?`,
    releases: "Sorties",
    addToRelease: "Ajouter à une sortie",
    noReleases: "Pas encore de sortie",
    tags: "Tags",
    notes: "Notes",
    notesPlaceholder: "Idées, paroles, ce qu'il reste à faire…",
    session: "Vue session",
    sessionTitle: "Le texte en grand, dans une fenêtre gardée devant FL Studio",
    project: "Projet",
    tempo: "Tempo",
    timeSig: "Signature",
    lastSaved: "Dernière sauvegarde",
    dawVersion: (daw: string) => `Version de ${daw}`,
    recordings: "Enregistrements",
    none: "aucun",
    projectFile: "Fichier projet",
    credits: "Crédits",
    sentTo: (n: number) => `Envoyé à · ${n}`,
    files: "Fichiers",
    mixdown: "Mixdown",
    upToDate: "À jour",
    olderThanProject: "Plus ancien que le projet",
    rendered: (when: string, size: string) => `Rendu le ${when} · ${size}`,
    otherBounces: (n: number) => `+${n} autre${n > 1 ? "s" : ""} bounce${n > 1 ? "s" : ""} dans le dossier`,
    noMixdown: "Pas encore de mixdown — fais le rendu, ou bounce-le depuis FL à côté du projet.",
    versions: (n: number, size: string) => `Versions · ${n} sauvegardes · ${size}`,
    saveVersion: "Enregistrer une nouvelle version",
    created: (name: string) => `${name} créé`,
    create: "Créer",
    restoreTitle: "Restaurer dans un nouveau fichier à côté du projet (la version actuelle ne bouge pas)",
    restoredAs: (name: string) => `Restauré sous ${name}`,
    restore: "Restaurer",
    showAll: (n: number) => `Tout afficher (${n})`,
    cleanUp: (n: number, size: string) => `Nettoyer ${n} anciennes sauvegardes (${size})`,
    confirmTrash: (n: number, trash: string) => `Mettre ${n} à la ${trash} ? Clique encore`,
    nothingDeleted: "Rien n'est supprimé pour l'instant : lis l'avertissement en dessous.",
    movedToTrash: (n: number, trash: string) => `${n} sauvegardes mises à la ${trash}`,
    riskyAll: "Ces sauvegardes sont",
    riskySome: (n: number) => `${n} de ces sauvegardes sont`,
    riskyRest: (trash: string) => ` sur un disque amovible ou réseau, qui n'a pas de ${trash} : elles seraient `,
    deletedPermanently: "supprimées définitivement",
    deleted: (n: number) => `${n} sauvegardes supprimées`,
    deletePermanently: "Supprimer définitivement",
    keepThem: "Les garder",
    keepsRecent: (n: number) => `Garde les ${n} plus récentes.`,
    plugins: (n: number) => `Plugins · ${n}`,
    notInstalled: (names: string) => `Pas installés sur cet ordi : ${names}`,
    noneFound: "Aucun trouvé",
    pluginsUnknown: (daw: string) => `Savoir s'ils sont installés ici n'est pas encore vérifié pour les projets ${daw}.`,
    librariesHint: "Un pack rangé à un autre endroit sur cet ordi compte comme manquant tant qu'il n'est pas ajouté dans Réglages → Banques de samples.",
    librariesLink: "Ajouter des banques de samples",
    samples: (n: number) => `Samples · ${n}`,
    found: (n: number) => `${n} trouvé${n > 1 ? "s" : ""}`,
    movedTitle:
      "Pas au chemin enregistré, mais un fichier du même nom est dans le dossier de ce son — le projet a été déplacé. FL les retrouve en général.",
    moved: (n: number) => `${n} déplacé${n > 1 ? "s" : ""}`,
    missing: (n: number) => `${n} manquant${n > 1 ? "s" : ""}`,
    toggleProblems: (open: boolean, n: number) =>
      `${open ? "Masquer" : "Afficher"} les ${n} qui ne sont pas à leur chemin enregistré`,
    revealSketch: "Afficher le dossier",
    sketch: "Sketch BandLab",
    sketchNote: "De l'audio exporté depuis BandLab, pas encore de projet. Son étape, ses notes et ses crédits passent au projet FL quand tu le continues.",
    bandlabLink: "Lien BandLab",
    linkPlaceholder: "https://www.bandlab.com/…",
    badLink: "Le lien doit commencer par https:// (300 caractères max). Pas enregistré.",
    openLink: "Ouvrir dans le navigateur",
    continueTemplate: "Démarrer le projet FL avec",
    continueFl: "Continuer dans FL Studio",
    continuing: "Création…",
    continueHint: "Hivo crée un nouveau projet FL à partir de ce modèle, avec chaque fichier BandLab sur sa propre piste de la playlist dès la mesure 1. Tes projets existants ne sont jamais modifiés.",
    continueNote: (name: string, clips: number, note: string | null) =>
      clips > 0 ? `${name} : ${clips} fichier${clips === 1 ? "" : "s"} BandLab sur la playlist.${note ? ` ${note}.` : ""}` : `${name} est créé. ${note ?? ""}.`,
    continueSkipped: (n: number) => ` ${n} autre${n === 1 ? " fichier n'y est" : "s fichiers n'y sont"} pas (20 au maximum) : glisse-${n === 1 ? "le" : "les"} depuis le dossier BandLab.`,
    continueMixdown: (names: string) => ` Le mix (${names}) reste hors de la playlist, pour ne pas jouer par-dessus les stems.`,
    continueOpenFailed: (name: string, err: string) => `${name} est créé, mais FL Studio ne s'est pas ouvert : ${err}. Ouvre-le depuis le panneau du son.`,
    favorite: "Favori",
    closePanel: "Fermer le panneau du son",
    removeFromRelease: (title: string) => `Retirer de ${title}`,
    cancelVersion: "Annuler la nouvelle version",
    versionNameLabel: "Nom de la nouvelle version",
  },
);

/** Resolves with the song's render job once it's done or failed (the
 * progress event can land just after the render command returns), or
 * whatever it is after a few seconds. */
function settledJob(path: string): Promise<RenderJob | undefined> {
  const settled = (j: RenderJob | undefined) => j?.status === "done" || j?.status === "error";
  const now = useAppStore.getState().renderJobs.get(path);
  if (settled(now)) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(useAppStore.getState().renderJobs.get(path));
    }, 3000);
    const off = useAppStore.subscribe((s) => {
      const j = s.renderJobs.get(path);
      if (settled(j)) {
        clearTimeout(timer);
        off();
        resolve(j);
      }
    });
  });
}

/** The open song vanished from the last scan: its folder is unreachable, or
 * the file is gone. Its data is kept either way. */
function NotFoundDrawer({ path, unreachable, onClose }: { path: string; unreachable: string[]; onClose: () => void }) {
  const t = tr(T);
  const root = unreachable.find((r) => isUnder(path, r));
  const name = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-rule bg-panel">
      <div className="flex items-start gap-2 border-b border-rule px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-cream">{name}</h2>
          <div className="mt-0.5 truncate text-[11px] text-engrave" title={path}>
            {path}
          </div>
        </div>
        <button onClick={onClose} aria-label={t.close} className="rounded p-1 text-engrave hover:bg-rule hover:text-cream">
          <X size={16} />
        </button>
      </div>
      <div className="px-5 py-4">
        <div role="status" className="rounded-md border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/80">
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={13} /> {t.notFound}
          </div>
          {root ? t.notFoundUnreachable(root) : t.notFoundGone}
        </div>
      </div>
    </aside>
  );
}

export function ProjectDrawer() {
  const detailPath = useAppStore((s) => s.detailPath);
  const project = useAppStore((s) => s.projects.find((p) => p.path === s.detailPath));
  const workspace = useAppStore((s) => s.workspace);
  const settings = useAppStore((s) => s.settings);
  const demoMode = useAppStore((s) => s.demoMode);
  const openDetail = useAppStore((s) => s.openDetail);
  const updateSong = useAppStore((s) => s.updateSong);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const addTracks = useAppStore((s) => s.addTracks);
  const removeTrack = useAppStore((s) => s.removeTrack);
  const openAlbum = useAppStore((s) => s.openAlbum);
  const startRender = useAppStore((s) => s.startRender);
  const rendering = useAppStore((s) => s.rendering);
  const duplicateProject = useAppStore((s) => s.duplicateProject);
  const restoreBackup = useAppStore((s) => s.restoreBackup);
  const trashBackups = useAppStore((s) => s.trashBackups);
  const startPackage = useAppStore((s) => s.startPackage);
  const packaging = useAppStore((s) => s.packaging);
  const openLaunchKit = useAppStore((s) => s.openLaunchKit);

  const [versionName, setVersionName] = useState<string | null>(null);
  /** The version just saved, to offer moving the crew card to it. */
  const [newVersion, setNewVersion] = useState<{ from: string; to: string } | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [showAllBackups, setShowAllBackups] = useState(false);
  /** Backups to clean up that sit on a drive with no Recycle Bin: waiting for an explicit OK. */
  const [permanent, setPermanent] = useState<{ project: string; paths: string[]; risky: number } | null>(null);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const meta of Object.values(workspace.songs))
      for (const t of meta.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [workspace.songs]);
  const inboxItems = usePhoneInbox((s) => s.items);
  const unreachable = useAppStore((s) => s.unreachable);

  if (!detailPath) return null;
  // Gone from the last scan: say so instead of closing under the user.
  if (!project) return <NotFoundDrawer path={detailPath} unreachable={unreachable} onClose={() => openDetail(null)} />;

  const meta = workspace.songs[project.path] ?? {};
  const detectedKey = detectKey(project.trackNames);
  const albums = albumsOf(workspace, project.path);
  const otherAlbums = workspace.albums.filter((a) => !albums.includes(a));
  const freshness = renderFreshness(project);
  const isFavorite = settings.favorites.includes(project.path);
  const latestRender = project.renders[0];
  const oldBackups = project.backups.slice(KEEP_BACKUPS);
  const visibleBackups = showAllBackups ? project.backups : project.backups.slice(0, 6);
  const sketch = isSketch(project);
  const songMemos = memosForSong(inboxItems, project.path);
  const missingCount = project.samples.filter((s) => s.status === "missing").length;

  async function run(action: () => Promise<string | number>, ok: (r: string | number) => string) {
    setMessage(null);
    try {
      const result = await action();
      setMessage({ kind: "ok", text: ok(result) });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const fileName = (p: string) => p.split(/[/\\]/).pop() ?? p;
  const t = tr(T);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-rule bg-panel">
      <div className="flex items-start gap-2 border-b border-rule px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-cream">{project.name}</h2>
            <button onClick={() => toggleFavorite(project.path)} aria-label={t.favorite} aria-pressed={isFavorite} className="text-engrave hover:text-orange-300">
              <Star size={15} fill={isFavorite ? "currentColor" : "none"} className={isFavorite ? "text-orange-400" : ""} />
            </button>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-engrave" title={project.path}>
            {project.folder}
          </div>
        </div>
        <button onClick={() => openDetail(null)} aria-label={t.closePanel} className="rounded p-1 text-engrave hover:bg-rule hover:text-cream">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {sketch ? (
            // No project to open yet: show the BandLab folder instead.
            <button onClick={() => revealInFileManager(project.path)} disabled={demoMode} className={btn}>
              <FolderOpen size={14} /> {t.revealSketch}
            </button>
          ) : (
            <>
              <button
                onClick={() => openInFlStudio(project.path).catch((e) => setMessage({ kind: "error", text: t.couldntOpen(e instanceof Error ? e.message : String(e)) }))}
                disabled={demoMode}
                className={btnPrimary}
              >
                <PlayCircle size={14} /> {t.openIn(dawOf(project).short === "FL" ? "FL" : dawOf(project).label)}
              </button>
              <button onClick={() => revealInFileManager(project.path)} disabled={demoMode} className={btn}>
                <FolderOpen size={14} /> {t.reveal}
              </button>
            </>
          )}
          <button onClick={() => openLaunchKit(project.path)} className={btn} title={t.launchKitTitle}>
            <Rocket size={14} /> Launch Kit
          </button>
          <button
            onClick={async () => {
              // The drawer reports this song's own job: done, done with a
              // warning (samples not found), or its error.
              setMessage(null);
              try {
                await startRender([project.path]);
                const job = await settledJob(project.path);
                if (job?.status === "error") setMessage({ kind: "error", text: t.renderFailed(job.message ?? "?") });
                else if (job?.status === "done") setMessage(job.message ? { kind: "warn", text: job.message } : { kind: "ok", text: t.renderDone });
                else setMessage({ kind: "warn", text: t.renderPending });
              } catch (e) {
                setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
              }
            }}
            disabled={demoMode || rendering || !canRenderInApp(project)}
            title={canRenderInApp(project) ? t.renderTitle : t.renderFlOnly(dawOf(project).exportTip)}
            className={btn}
          >
            <Download size={14} /> {t.render}
          </button>
          <button
            title={t.packageTitle}
            onClick={() => run(async () => (await startPackage([project.path]), ""), () => t.packageNext)}
            disabled={demoMode || packaging || !canRenderInApp(project)}
            className={btn}
          >
            <Package size={14} /> {t.package}
          </button>
          {!meta.archived && (
            <button
              title={t.archiveTitle}
              onClick={() => {
                updateSong(project.path, { archived: true });
                openDetail(null);
              }}
              className={btn}
            >
              <Archive size={14} /> {t.archive}
            </button>
          )}
        </div>
        <ShareToggle path={project.path} />
        <StageConflictBanner path={project.path} />
        <CrewMoveNote path={project.path} />
        {canRenderInApp(project) && missingCount > 0 && (
          <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/80">
            {t.renderMissingSamples(missingCount)}
          </div>
        )}
        {(project.ambiguousExports ?? 0) > 0 && (
          <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/80">
            {t.ambiguousExports(project.ambiguousExports ?? 0)}
          </div>
        )}
        {project.readError && (
          <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/80">
            {t.readError(project.readError)}
          </div>
        )}

        {message && (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-xs ${
              message.kind === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : message.kind === "warn"
                  ? "border-amber-400/30 bg-amber-500/[0.06] text-amber-200"
                  : "border-red-500/30 bg-red-500/10 text-red-300"
            }`}
          >
            {message.text}
          </div>
        )}

        {meta.archived && (
          <div className="mt-3 flex items-center justify-between rounded-md border border-rule bg-panel px-3 py-2 text-xs text-body">
            {t.archivedNote}
            <button onClick={() => updateSong(project.path, { archived: false })} className="text-cream hover:underline">
              {t.unarchive}
            </button>
          </div>
        )}

        {(sketch || meta.bandlabUrl) && <SketchPanel project={project} />}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div>
            <div className={`${sectionLabel} mb-2`}>{t.stage}</div>
            <StatusSelect value={meta.status} onChange={(status) => updateSong(project.path, { status })} />
          </div>
          <div>
            <div className={`${sectionLabel} mb-2`}>{t.key}</div>
            <select
              value={meta.key ?? ""}
              onChange={(e) => updateSong(project.path, { key: e.target.value || undefined })}
              className="rounded-full border border-rule bg-panel px-2.5 py-1 text-xs text-body hover:bg-raised"
            >
              <option value="" className="bg-raised">
                {t.notSet}
              </option>
              {KEYS.map((k) => (
                <option key={k} value={k} className="bg-raised">
                  {k}
                </option>
              ))}
            </select>
            {!meta.key && detectedKey && (
              <button
                onClick={() => updateSong(project.path, { key: detectedKey })}
                title={t.keyFromTrack}
                className="ml-1.5 rounded-full border border-dashed border-rule-strong px-2 py-0.5 text-[11px] text-body hover:text-cream"
              >
                {t.useKey(detectedKey)}
              </button>
            )}
          </div>
        </div>

        <Section label={t.releases}>
          <div className="flex flex-wrap items-center gap-1.5">
            {albums.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5 rounded-full bg-raised py-0.5 pl-1 pr-2 text-xs text-cream">
                <span className="h-4 w-4 rounded-full" style={{ background: a.color }} />
                <button onClick={() => openAlbum(a.id)} className="hover:underline">
                  {a.title}
                </button>
                <button onClick={() => removeTrack(a.id, project.path)} aria-label={t.removeFromRelease(a.title)} className="text-engrave hover:text-cream">
                  <X size={11} />
                </button>
              </span>
            ))}
            {otherAlbums.length > 0 && (
              <label className="relative flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-rule-strong px-2 py-0.5 text-[11px] text-engrave hover:text-body">
                <Plus size={11} /> {t.addToRelease}
                <select
                  value=""
                  onChange={(e) => e.target.value && addTracks(e.target.value, [project.path])}
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value="" />
                  {otherAlbums.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {workspace.albums.length === 0 && <span className="text-xs text-engrave">{t.noReleases}</span>}
          </div>
        </Section>

        <Section label={t.tags}>
          <TagEditor
            tags={meta.tags ?? []}
            suggestions={allTags}
            onChange={(tags) => updateSong(project.path, { tags })}
          />
        </Section>

        <Section label={t.notes}>
          <NotesEditor
            key={project.path}
            value={meta.notes}
            onChange={(notes) => updateSong(project.path, { notes })}
            placeholder={t.notesPlaceholder}
          />
          <div className="mt-2 flex">
            <button
              className={btn}
              title={t.sessionTitle}
              onClick={() =>
                void openSession({ kind: "song", id: project.path, title: project.name, bpm: project.tempoBpm ?? null }).catch((e) =>
                  setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) }),
                )
              }
            >
              <MonitorPlay size={14} /> {t.session}
            </button>
          </div>
          <div className="mt-3">
            <PhoneMemos memos={songMemos} />
          </div>
        </Section>

        {!sketch && (
          <Section label={t.project}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Fact label={t.tempo} value={project.tempoBpm ? `${formatBpm(project.tempoBpm)} BPM` : "—"} />
              <Fact
                label={t.timeSig}
                value={project.timeSigNum ? `${project.timeSigNum}/${project.timeSigDenom}` : "—"}
              />
              <Fact label={t.lastSaved} value={formatDateTime(lastSaveMs(project))} />
              <Fact
                label={t.dawVersion(dawOf(project).label)}
                value={(project.flVersion?.split(".").slice(0, 3).join(".") ?? project.dawVersion?.replace(/^(Ableton Live|Studio One|REAPER)\s*/i, "")) || "—"}
              />
              <Fact
                label={t.recordings}
                value={project.recordingsCount ? `${project.recordingsCount} · ${formatBytes(project.recordingsBytes)}` : t.none}
              />
              <Fact label={t.projectFile} value={formatBytes(project.sizeBytes)} />
            </dl>
          </Section>
        )}

        <Section label={t.credits}>
          <SongCredits project={project} />
        </Section>

        <Section label={t.sentTo(meta.pitches?.length ?? 0)}>
          <SongPitches project={project} />
        </Section>

        {!sketch && <PluginsAndSamples project={project} />}

        <Section label={t.files}>
          <FilesPanel project={project} />
        </Section>

        <Section label={t.mixdown}>
          {latestRender ? (
            <div className="rounded-lg border border-rule bg-panel p-3">
              <div className="flex items-center gap-2 text-xs">
                <Disc3 size={14} className="text-engrave" />
                <span className="min-w-0 flex-1 truncate text-cream">{fileName(latestRender.path)}</span>
                {freshness === "fresh" ? (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 size={12} /> {t.upToDate}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-amber-400">
                    <AlertTriangle size={12} /> {t.olderThanProject}
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-engrave">
                {t.rendered(formatDateTime(latestRender.modifiedAtMs), formatBytes(latestRender.sizeBytes))}
              </div>
              {!demoMode && (
                <audio controls preload="none" src={audioSrc(latestRender.path)} className="mt-2 h-8 w-full" />
              )}
              {project.renders.length > 1 && (
                <div className="mt-2 text-[11px] text-engrave">
                  {t.otherBounces(project.renders.length - 1)}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-engrave">{t.noMixdown}</div>
          )}
        </Section>

        {!sketch && (
          <Section label={t.versions(project.backups.length, formatBytes(backupsBytes(project)))}>
            {versionName === null ? (
              <button onClick={() => setVersionName(`${project.name} v2`)} disabled={demoMode} className={btn}>
                <Copy size={14} /> {t.saveVersion}
              </button>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = versionName;
                  setVersionName(null);
                  const from = project.path;
                  run(
                    () => duplicateProject(from, name),
                    (p) => (setNewVersion({ from, to: String(p) }), t.created(fileName(String(p)))),
                  );
                }}
              >
                <input autoFocus value={versionName} onChange={(e) => setVersionName(e.target.value)} aria-label={t.versionNameLabel} className={`${input} py-1.5`} />
                <button type="submit" className={btn}>
                  {t.create}
                </button>
                <button type="button" onClick={() => setVersionName(null)} aria-label={t.cancelVersion} className="text-engrave hover:text-cream">
                  <X size={14} />
                </button>
              </form>
            )}
            {newVersion?.from === project.path && <MoveShareOffer from={newVersion.from} to={newVersion.to} onDone={() => setNewVersion(null)} />}

            {project.backups.length > 0 && (
              <ol className="mt-3 border-l border-rule pl-3">
                {visibleBackups.map((b) => (
                  <li key={b.path} className="group relative flex items-center gap-2 py-1 text-xs">
                    <span className="absolute -left-[15.5px] h-2 w-2 rounded-full bg-rule-strong" />
                    <History size={12} className="text-body" />
                    <span className="flex-1 text-body">{formatDateTime(b.modifiedAtMs)}</span>
                    <span className="text-body">{formatBytes(b.sizeBytes)}</span>
                    <button
                      title={t.restoreTitle}
                      disabled={demoMode}
                      onClick={() => run(() => restoreBackup(b.path, project.path), (p) => t.restoredAs(fileName(String(p))))}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-engrave opacity-0 hover:bg-rule hover:text-cream focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <RotateCcw size={11} /> {t.restore}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {project.backups.length > visibleBackups.length && (
              <button onClick={() => setShowAllBackups(true)} className="mt-1 text-[11px] text-engrave hover:text-body">
                {t.showAll(project.backups.length)}
              </button>
            )}
            {oldBackups.length > 0 && (
              <ConfirmButton
                disabled={demoMode}
                label={
                  <>
                    <Trash2 size={13} /> {t.cleanUp(oldBackups.length, formatBytes(backupsBytes({ ...project, backups: oldBackups })))}
                  </>
                }
                confirmLabel={t.confirmTrash(oldBackups.length, trashName())}
                onConfirm={() =>
                  run(
                    async () => {
                      const paths = oldBackups.map((b) => b.path);
                      // Removable or network drive: no Recycle Bin, so ask first.
                      const risky = await backupsOnRiskyVolumes(paths);
                      if (risky.length > 0) {
                        setPermanent({ project: project.path, paths, risky: risky.length });
                        return -1;
                      }
                      return trashBackups(paths);
                    },
                    (n) => (n === -1 ? t.nothingDeleted : t.movedToTrash(Number(n), trashName())),
                  )
                }
                className={`${btn} mt-3 text-xs`}
              />
            )}
            {permanent && permanent.project === project.path && (
              <div className="mt-2 rounded-md border border-red-400/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-200/90">
                {permanent.risky === permanent.paths.length ? t.riskyAll : t.riskySome(permanent.risky)}
                {t.riskyRest(trashName())}
                <b className="font-semibold">{t.deletedPermanently}</b>.
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      const paths = permanent.paths;
                      setPermanent(null);
                      void run(() => trashBackups(paths, true), (n) => t.deleted(Number(n)));
                    }}
                    className="rounded border border-red-400/40 px-2 py-1 text-red-200 hover:bg-red-500/10"
                  >
                    {t.deletePermanently}
                  </button>
                  <button onClick={() => setPermanent(null)} className="rounded border border-rule-strong px-2 py-1 text-body hover:bg-raised">
                    {t.keepThem}
                  </button>
                </div>
              </div>
            )}
            {oldBackups.length > 0 && (
              <div className="mt-1 text-[11px] text-engrave">{t.keepsRecent(KEEP_BACKUPS)}</div>
            )}
          </Section>
        )}
      </div>
    </aside>
  );
}

function PluginsAndSamples({ project }: { project: ProjectInfo }) {
  const [showSamples, setShowSamples] = useState(false);
  const missingP = missingPlugins(project);
  // "installed" is only checked for FL's wrapper plugins; for the other
  // DAWs every plugin comes back null, which isn't "native".
  const checksInstalled = dawOf(project).id === "fl-studio";
  const thirdParty = project.plugins.filter((p) => p.installed !== null);
  const native = project.plugins.filter((p) => p.installed === null);
  const sampleFolders = useAppStore((s) => s.settings.sampleFolders ?? []);
  const setView = useAppStore((s) => s.setView);
  const counts = { ok: 0, relocated: 0, missing: 0 };
  for (const s of project.samples) counts[s.status]++;
  const problemSamples = project.samples.filter((s) => s.status !== "ok");
  const fileName = (p: string) => p.split(/[/\\]/).pop() ?? p;
  const t = tr(T);

  return (
    <>
      <Section label={t.plugins(project.plugins.length)}>
        {missingP.length > 0 && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-200">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            {t.notInstalled(missingP.map((p) => p.name).join(", "))}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {thirdParty.map((p) => (
            <span
              key={p.name}
              title={p.vendor ?? undefined}
              className={`rounded px-1.5 py-0.5 text-[11px] ${
                p.installed ? "bg-rule text-cream" : "bg-red-500/15 text-red-300 line-through decoration-red-400/60"
              }`}
            >
              {p.name}
            </span>
          ))}
          {native.map((p) => (
            <span key={p.name} className="rounded bg-panel px-1.5 py-0.5 text-[11px] text-body">
              {p.name}
            </span>
          ))}
          {project.plugins.length === 0 && <span className="text-xs text-engrave">{t.noneFound}</span>}
        </div>
        {!checksInstalled && project.plugins.length > 0 && (
          <p className="mt-1.5 text-[11px] text-engrave">{t.pluginsUnknown(dawOf(project).label)}</p>
        )}
      </Section>

      <Section label={t.samples(project.samples.length)}>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1 text-body">
            <CheckCircle2 size={12} className="text-emerald-400" /> {t.found(counts.ok)}
          </span>
          {counts.relocated > 0 && (
            <span className="flex items-center gap-1 text-body" title={t.movedTitle}>
              <FolderInput size={12} className="text-sky-400" /> {t.moved(counts.relocated)}
            </span>
          )}
          {counts.missing > 0 && (
            <span className="flex items-center gap-1 text-red-300">
              <AlertTriangle size={12} /> {t.missing(counts.missing)}
            </span>
          )}
        </div>
        {counts.missing > 0 && sampleFolders.length === 0 && (
          <p className="mt-1.5 text-[11px] text-engrave">
            {t.librariesHint}{" "}
            <button onClick={() => setView("settings", "samples")} className="text-body underline-offset-2 hover:text-cream hover:underline">
              {t.librariesLink}
            </button>
          </p>
        )}
        {problemSamples.length > 0 && (
          <>
            <button onClick={() => setShowSamples(!showSamples)} className="mt-1.5 text-[11px] text-engrave hover:text-body">
              {t.toggleProblems(showSamples, problemSamples.length)}
            </button>
            {showSamples && (
              <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-auto text-[11px]">
                {problemSamples.map((s) => (
                  <li key={s.path} title={s.path} className={`truncate ${s.status === "missing" ? "text-red-300" : "text-body"}`}>
                    {s.status === "missing" ? "✕" : "↪"} {fileName(s.path)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>
    </>
  );
}

/** A BandLab sketch's link and "Continue in FL Studio" (src/lib/sketch.ts,
 * src-tauri/src/sketch.rs). Songs continued from a sketch keep the link. */
function SketchPanel({ project }: { project: ProjectInfo }) {
  const saved = useAppStore((s) => s.workspace.songs[project.path]?.bandlabUrl ?? "");
  const updateSong = useAppStore((s) => s.updateSong);
  const continueSketch = useAppStore((s) => s.continueSketch);
  const demoMode = useAppStore((s) => s.demoMode);
  const sketch = isSketch(project);
  const [link, setLink] = useState(saved);
  const [templatePath, setTemplatePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const factory = useFactoryTemplates(sketch, setTemplatePath);
  useEffect(() => setLink(saved), [saved]);
  const clean = cleanBandlabUrl(link);
  const t = tr(T);

  function saveLink() {
    if (clean === null || clean === saved) return;
    updateSong(project.path, { bandlabUrl: clean || undefined });
  }

  async function continueInFl() {
    setBusy(true);
    setError(null);
    try {
      // The drawer moves to the new .flp once this returns, so an open
      // failure is reported in the app's error banner.
      const done = await continueSketch(project.path, templatePath);
      // Only what needs a hand goes in the (red) banner: the audio not in the
      // project, files left off past 20, the mixdown left off for the stems.
      if (done.clips === 0 || done.skipped > 0 || done.mixdown.length > 0) {
        const extra = (done.skipped > 0 ? t.continueSkipped(done.skipped) : "") + (done.mixdown.length > 0 ? t.continueMixdown(done.mixdown.join(", ")) : "");
        useAppStore.setState({ actionError: t.continueNote(project.name, done.clips, done.note) + extra });
      }
      await openInFlStudio(done.flp).catch((e) =>
        useAppStore.setState({ actionError: t.continueOpenFailed(project.name, e instanceof Error ? e.message : String(e)) }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Section label={sketch ? t.sketch : t.bandlabLink}>
      {sketch && <p className="mb-3 text-[11px] leading-relaxed text-engrave">{t.sketchNote}</p>}
      {sketch && <div className={`${sectionLabel} mb-1.5`}>{t.bandlabLink}</div>}
      <div className="flex gap-2">
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onBlur={saveLink}
          onKeyDown={(e) => e.key === "Enter" && saveLink()}
          placeholder={t.linkPlaceholder}
          maxLength={MAX_BANDLAB_URL}
          className={`${input} py-1.5 text-xs`}
        />
        <button onClick={() => saved && openExternal(saved)} disabled={!saved} title={t.openLink} className={btn}>
          <ExternalLink size={13} />
        </button>
      </div>
      {clean === null && <div className="mt-1 text-[11px] text-warn">{t.badLink}</div>}

      {sketch && (
        <div className="mt-4">
          <div className={`${sectionLabel} mb-1.5`}>{t.continueTemplate}</div>
          <TemplateSelect value={templatePath} onChange={setTemplatePath} factory={factory} className="py-1.5 text-xs" />
          <button onClick={continueInFl} disabled={demoMode || busy || !templatePath} className={`${btnPrimary} mt-2`}>
            <FileAudio size={14} /> {busy ? t.continuing : t.continueFl}
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-engrave">{t.continueHint}</p>
          {error && <div className="mt-2 rounded border border-missing/30 bg-missing/10 px-3 py-2 text-xs text-missing">{error}</div>}
        </div>
      )}
    </Section>
  );
}
