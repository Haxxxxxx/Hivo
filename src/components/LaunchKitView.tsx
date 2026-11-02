import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, FolderOpen, Minus, Pause, Play, Plus, Rocket, RotateCcw, Sparkles } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { useCrewStore } from "../store/useCrewStore";
import * as api from "../lib/tauri";
import {
  aiSummary,
  buildKit,
  demoAnalysis,
  formatDuration,
  kitChecks,
  kitFiles,
  kitGuide,
  type KitGuide,
  type KitLang,
  kitSnippets,
  SNIPPET_LENGTHS,
  DISTRIBUTION_FIELDS,
  artistLine,
  masterBaseName,
  METADATA_FIELDS,
  type Check as KitCheck,
  type KitField,
  type KitInput,
  inEnglish,
  kitArtists,
  finalCoverMessage,
  parseDate,
} from "../lib/launchKit";
import { busyDates, daysUntil, releaseOf } from "../lib/releaseDates";
import { acceptFingerprint, exportedFolderName, exportFingerprint, exportStatus, isKitAccepted, isLossless, kitMaster, lastLyricsLanguage, previousKitFolder } from "../lib/kitState";
import { dict, plural, tr } from "../i18n";
import { aiDisclosure, draftCopy, reviewKit } from "../lib/ai";
import { formatRelative } from "../lib/format";
import { stageRank, statusInfo } from "../lib/songs";
import type { AudioAnalysis, FileEntry, ProjectInfo, Snippet } from "../types";
import { useVisibleSongs } from "./LibraryView";
import { SongPicker } from "./SongPicker";
import { ShortsPanel } from "./ShortsPanel";
import { CoverConcepts } from "./CoverConcepts";
import { ConfirmButton, Modal, StatusSelect, btn, btnPrimary } from "./ui";
import { canRenderInApp } from "../lib/daws";
import { Card, CheckLine, FieldRow, KitStatus, StatusDot } from "../ui";
import { errorReason, errorText } from "../lib/errors";

// Snippet colors: the dark categorical slots, in fixed order (as elsewhere).
const SNIPPET_COLORS = ["#ff5a1f", "#f2efe8", "#3ddc84"];


const T = dict(
  {
    empty: "Link a project folder (or load sample data) to build a launch kit.",
    needExportFolder: "Set an export folder in Settings first.",
    openSettings: "Open Settings",
    unavailable: "The song this kit was opened for isn't in the Library any more (archived, a template, or no longer in a linked folder).",
    pickAnother: "Open the kit for another song",
    backToSong: "Song",
    backToSongTitle: "Back to this song's panel in the Library",
    moveToStage: (stage: string) => `Move to ${stage}`,
    renderNow: "Render now",
    rendering: "Rendering…",
    exportConfirm: (missing: number, flagged: number) => {
      const what = [missing && `${missing} field${plural(missing, "", "s")} still need${plural(missing, "s", "")} you`, flagged && `the AI flagged ${flagged}`]
        .filter(Boolean)
        .join(" and ");
      return `${what[0].toUpperCase()}${what.slice(1)}. Export anyway? Open items go in checklist.md and the distributor sheet.`;
    },
    answerFirst: "Answer the fields marked “Needs you” first",
    markReviewed: "Mark every pre-filled value as reviewed",
    accepted: "Accepted",
    acceptAll: "Accept all",
    exportOffDemo: "Export is off for sample data",
    exportWhere: "Writes the kit to <export folder>/Launch Kits/",
    exporting: "Exporting…",
    exportKit: "Export kit",
    includeArtistIds: "Include artist IDs",
    artistIdsHint: (artists: { name: string; profiles: unknown[] }[]) =>
      artists.length === 0
        ? "No one credited on this song yet (credit people in the song panel)."
        : `Adds artist-ids.md and an \"Artist profiles\" section to the distributor sheet: ${artists.map((a) => `${a.name} (${a.profiles.length} ID${plural(a.profiles.length, "", "s")})`).join(", ")}. Look up profiles in People to fill them.`,
    exported: (open: number) => `Kit exported${open ? `, with ${open} open item(s) listed in checklist.md` : ""}.`,
    showFolder: "Show folder",
    useSuggestions: (n: number) => `Use all ${n} AI suggestion${plural(n, "", "s")}`,
    resetConfirm: "Undo every change you made in this kit?",
    clickAgain: "Sure? Click again",
    exportAnyway: "Export anyway",
    cancel: "Cancel",
    resetAll: "Reset all edits",
    blankConfirm: "Clear every pre-filled value so you can fill the kit in by hand? (Reset all edits brings them back.)",
    startBlank: "Start blank",
    metadata: "Metadata",
    releaseTiming: "Release timing",
    distribution: "Distribution: what the upload form asks",
    snippetsCard: "Snippets for reels and stories",
    coverBrief: "Cover art brief",
    captions: "Captions",
    // AI panel
    aiOff: "AI drafts and checks are off. They need a free Gemini API key.",
    addKey: "Add a key",
    notChecked: "Not checked yet.",
    changedSince: "Some values changed since the last check.",
    allRight: "Every field looks right.",
    toLookAt: (n: number) => `${n} field${plural(n, "", "s")} to look at.`,
    notCheckedN: (n: number) => `${n} field${plural(n, "", "s")} not checked. Re-check.`,
    noProblems: "No problems found.",
    aiLayer: "AI layer",
    writing: "Writing…",
    writeCopy: "Write captions & brief",
    upToDate: "Already checked, and nothing changed since: no need to spend free AI quota",
    checkingAll: "Checking every field…",
    checkKit: "Check kit",
    checked: "Checked",
    recheck: "Re-check",
    backToTemplate: "Back to the template text",
    discardDrafts: "Discard AI drafts",
    checkedAgo: (when: string) => ` · checked ${when}`,
    retries: "If Gemini is busy this retries on its own; it gives up after 2 minutes.",
    backup: (model: string, backup: string) => `${model} was overloaded, so ${backup} (the backup free model) answered.`,
    // Snippets
    renderForSnippets: "Render a mixdown to get snippets.",
    listening: "Listening to the mixdown…",
    noAnalysis: "No analysis",
    tooShort: "The mixdown is shorter than 15 seconds.",
    stripHelp: "Drag a snippet to move it, or click to put the selected one there",
    loudness: "Loudness of the mixdown over time",
    snippetStart: (label: string) => `${label} start`,
    dragToMove: (label: string) => `${label}: drag to move`,
    snippetLength: (label: string) => `${label} length`,
    editedByYou: "edited by you",
    barEarlier: "1 bar earlier",
    secEarlier: "1 s earlier",
    barLater: "1 bar later",
    secLater: "1 s later",
    backToDetected: "Back to the detected spot and length",
    noAudioDemo: "No audio in sample data",
    playSnippet: "Play this snippet",
    snippetsHelp:
      "Drag a snippet on the waveform, click to drop the selected one there, or type a start time. Clips are cut on export, with short fades, into snippets/ in the kit.",
    startTime: "Start time",
    // Caption language
    captionLanguage: "Caption language",
    captionsIn: "Captions in",
    forThisKit: "for this kit",
    fromSettings: "(from Settings)",
    // Export record
    changedSinceExport: "Changed since export",
    changedSinceExportHint: "The values, the master or the snippets changed since the last export: export again so the files match",
    exportedAgo: (when: string) => `Exported ${when}`,
    waitAnalysis: "Wait until the master has been listened to",
    releaseDayCame: "The release date has come. Move the song on when it's out.",
    markCoverDone: "Mark as ready",
    // Master
    masterLabel: "Master",
    masterHint: "The file the kit uploads, cuts the snippets from and puts in the shorts",
    masterAuto: "newest lossless",
    lossy: "lossy",
    // Dates
    useReleaseDate: (date: string) => `Use the release's date (${date})`,
    setOnRelease: (title: string) => `Set this date on "${title}"`,
    setOnReleaseHint: "Every track of the release then takes this date",
    preSave: "Pre-save link",
    preSaveHint: "Optional. The captions mention a pre-save only when there's one",
    preSaveInvalid: "An https:// link",
    // Cover
    finalCoverReady: "Final cover ready (3000 × 3000)",
    // AI overwrite
    overwriteConfirm: "This replaces the captions and brief you edited. Write new ones anyway?",
    writeAnyway: "Write anyway",
  },
  {
    empty: "Relie un dossier de projets (ou charge les données d'exemple) pour monter un Launch Kit.",
    needExportFolder: "Choisis d'abord un dossier d'export dans les Réglages.",
    openSettings: "Ouvrir les Réglages",
    unavailable: "Le son pour lequel ce kit était ouvert n'est plus dans la Bibliothèque (archivé, modèle, ou plus dans un dossier relié).",
    pickAnother: "Ouvrir le kit d'un autre son",
    backToSong: "Son",
    backToSongTitle: "Revenir au panneau de ce son dans la Bibliothèque",
    moveToStage: (stage: string) => `Passer en ${stage}`,
    renderNow: "Faire le rendu",
    rendering: "Rendu en cours…",
    exportConfirm: (missing: number, flagged: number) => {
      const what = [missing && `${missing} champ${plural(missing, "", "s")} à compléter`, flagged && `l'IA en a signalé ${flagged}`].filter(Boolean).join(" et ");
      return `${what[0].toUpperCase()}${what.slice(1)}. Exporter quand même ? Ce qui reste ouvert va dans checklist.md et la fiche distributeur.`;
    },
    answerFirst: "Réponds d'abord aux champs marqués « À compléter »",
    markReviewed: "Marque toutes les valeurs pré-remplies comme relues",
    accepted: "Accepté",
    acceptAll: "Tout accepter",
    exportOffDemo: "Pas d'export avec les données d'exemple",
    exportWhere: "Écrit le kit dans <dossier d'export>/Launch Kits/",
    exporting: "Export…",
    exportKit: "Exporter le kit",
    includeArtistIds: "Inclure les ID artistes",
    artistIdsHint: (artists: { name: string; profiles: unknown[] }[]) =>
      artists.length === 0
        ? "Personne n'est crédité sur ce son pour l'instant (crédite des personnes dans le panneau du son)."
        : `Ajoute artist-ids.md et une section « Profils artistes » à la fiche distributeur : ${artists.map((a) => `${a.name} (${a.profiles.length} ID${plural(a.profiles.length, "", "s")})`).join(", ")}. Cherche les profils dans Personnes pour les remplir.`,
    exported: (open: number) => `Kit exporté${open ? `, avec ${open} point${plural(open, "", "s")} ouvert${plural(open, "", "s")} dans checklist.md` : ""}.`,
    showFolder: "Ouvrir le dossier",
    useSuggestions: (n: number) => plural(n, "Utiliser la suggestion de l'IA", `Utiliser les ${n} suggestions de l'IA`),
    resetConfirm: "Annuler tous tes changements dans ce kit ?",
    clickAgain: "Sûr ? Clique encore",
    exportAnyway: "Exporter quand même",
    cancel: "Annuler",
    resetAll: "Annuler toutes les modifs",
    blankConfirm: "Vider toutes les valeurs pré-remplies pour remplir le kit à la main ? (« Annuler toutes les modifs » les remet.)",
    startBlank: "Partir de zéro",
    metadata: "Métadonnées",
    releaseTiming: "Quand ça sort",
    distribution: "Distribution : ce que demande le formulaire d'upload",
    snippetsCard: "Extraits pour les reels et stories",
    coverBrief: "Brief de la cover",
    captions: "Textes",
    aiOff: "Les brouillons et vérifs IA sont coupés. Il faut une clé API Gemini gratuite.",
    addKey: "Ajouter une clé",
    notChecked: "Pas encore vérifié.",
    changedSince: "Des valeurs ont changé depuis la dernière vérif.",
    allRight: "Tous les champs ont l'air bons.",
    toLookAt: (n: number) => `${n} champ${plural(n, "", "s")} à regarder.`,
    notCheckedN: (n: number) => `${n} champ${plural(n, "", "s")} pas vérifié${plural(n, "", "s")}. Revérifie.`,
    noProblems: "Aucun problème trouvé.",
    aiLayer: "Couche IA",
    writing: "Écriture…",
    writeCopy: "Écrire textes et brief",
    upToDate: "Déjà vérifié, et rien n'a changé depuis : pas besoin de griller le quota IA gratuit",
    checkingAll: "Vérif de chaque champ…",
    checkKit: "Vérifier le kit",
    checked: "Vérifié",
    recheck: "Revérifier",
    backToTemplate: "Revenir au texte modèle",
    discardDrafts: "Jeter les brouillons IA",
    checkedAgo: (when: string) => ` · vérifié ${when}`,
    retries: "Si Gemini est occupé, ça réessaie tout seul ; ça abandonne au bout de 2 minutes.",
    backup: (model: string, backup: string) => `${model} était surchargé, donc ${backup} (le modèle gratuit de secours) a répondu.`,
    renderForSnippets: "Fais le rendu d'un mixdown pour avoir des extraits.",
    listening: "Écoute du mixdown…",
    noAnalysis: "Pas d'analyse",
    tooShort: "Le mixdown fait moins de 15 secondes.",
    stripHelp: "Glisse un extrait pour le déplacer, ou clique pour y placer celui sélectionné",
    loudness: "Volume du mixdown dans le temps",
    snippetStart: (label: string) => `Début de ${label}`,
    dragToMove: (label: string) => `${label} : glisse pour déplacer`,
    snippetLength: (label: string) => `Durée de ${label}`,
    editedByYou: "modifié par toi",
    barEarlier: "1 mesure plus tôt",
    secEarlier: "1 s plus tôt",
    barLater: "1 mesure plus tard",
    secLater: "1 s plus tard",
    backToDetected: "Revenir à la position et à la durée détectées",
    noAudioDemo: "Pas d'audio dans les données d'exemple",
    playSnippet: "Écouter cet extrait",
    snippetsHelp:
      "Glisse un extrait sur la forme d'onde, clique pour y poser celui sélectionné, ou tape un début. Les extraits sont coupés à l'export, avec de courts fondus, dans snippets/ du kit.",
    startTime: "Début",
    captionLanguage: "Langue des textes",
    captionsIn: "Textes en",
    forThisKit: "pour ce kit",
    fromSettings: "(depuis les Réglages)",
    changedSinceExport: "Modifié depuis l'export",
    changedSinceExportHint: "Les valeurs, le master ou les extraits ont changé depuis le dernier export : exporte à nouveau pour que les fichiers suivent",
    exportedAgo: (when: string) => `Exporté ${when}`,
    waitAnalysis: "Attends la fin de l'écoute du master",
    releaseDayCame: "La date de sortie est arrivée. Fais avancer le son quand il est sorti.",
    markCoverDone: "Marquer prête",
    masterLabel: "Master",
    masterHint: "Le fichier que le kit envoie, d'où sont coupés les extraits et qui va dans les shorts",
    masterAuto: "le plus récent sans perte",
    lossy: "avec perte",
    useReleaseDate: (date: string) => `Prendre la date de la sortie (${date})`,
    setOnRelease: (title: string) => `Mettre cette date sur "${title}"`,
    setOnReleaseHint: "Tous les morceaux de la sortie prennent alors cette date",
    preSave: "Lien de pré-save",
    preSaveHint: "Optionnel. Les textes ne parlent de pré-save que s'il y en a un",
    preSaveInvalid: "Un lien en https://",
    finalCoverReady: "Cover finale prête (3000 × 3000)",
    overwriteConfirm: "Ça remplace les textes et le brief que tu as modifiés. En écrire de nouveaux quand même ?",
    writeAnyway: "Écrire quand même",
  },
);


/** Keyed by mixdown path + mtime + tempo: re-analyze when the mixdown
 * changes, or the tempo does (snippets snap to its bar grid). */
const analysisCache = new Map<string, AudioAnalysis>();

function useAnalysis(project: ProjectInfo | undefined, render: FileEntry | undefined, demoMode: boolean) {
  const key = render ? `${render.path}|${render.modifiedAtMs}|${project?.tempoBpm ?? ""}` : null;
  const [state, setState] = useState<{ key: string | null; analysis: AudioAnalysis | null; error: string | null; loading: boolean }>({
    key: null,
    analysis: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (!project || !render || !key) return setState({ key, analysis: null, error: null, loading: false });
    if (demoMode) return setState({ key, analysis: demoAnalysis(project), error: null, loading: false });
    const cached = analysisCache.get(key);
    if (cached) return setState({ key, analysis: cached, error: null, loading: false });
    let live = true;
    setState({ key, analysis: null, error: null, loading: true });
    api
      .analyzeAudio(render.path, project.tempoBpm)
      .then((a) => {
        analysisCache.set(key, a);
        if (live) setState({ key, analysis: a, error: null, loading: false });
      })
      .catch((e) => live && setState({ key, analysis: null, error: errorReason(e), loading: false }));
    return () => {
      live = false;
    };
  }, [key, demoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return state.key === key ? state : { analysis: null, error: null, loading: !!key };
}

export function LaunchKitView() {
  const songs = useVisibleSongs();
  const launchPath = useAppStore((s) => s.launchPath);
  const openLaunchKit = useAppStore((s) => s.openLaunchKit);
  const workspace = useAppStore((s) => s.workspace);
  const settings = useAppStore((s) => s.settings);
  const setKitCaptionLanguage = useAppStore((s) => s.setKitCaptionLanguage);
  const setKitIncludeArtistIds = useAppStore((s) => s.setKitIncludeArtistIds);
  const demoMode = useAppStore((s) => s.demoMode);
  const setKitEdit = useAppStore((s) => s.setKitEdit);
  const setKitEdits = useAppStore((s) => s.setKitEdits);
  const crewName = useCrewStore((s) => s.crews.find((c) => c.id === s.activeCrewId)?.name ?? null);
  const crewSongs = useCrewStore((s) => s.songs);
  const setSnippetStart = useAppStore((s) => s.setSnippetStart);
  const setSnippetLength = useAppStore((s) => s.setSnippetLength);
  const acceptKit = useAppStore((s) => s.acceptKit);
  const pinKitReleaseDate = useAppStore((s) => s.pinKitReleaseDate);
  const patchKit = useAppStore((s) => s.patchKit);
  const updateAlbum = useAppStore((s) => s.updateAlbum);

  // Songs closest to release first: ones with a mixdown, then by stage
  // (Promotion … Creation), then by last save.
  const ordered = useMemo(() => {
    const stage = (p: ProjectInfo) => stageRank(workspace.songs[p.path]?.status);
    const rank = (p: ProjectInfo) => (p.renders.length ? 0 : 10) + stage(p);
    return [...songs].sort((a, b) => rank(a) - rank(b) || b.modifiedAtMs - a.modifiedAtMs);
  }, [songs, workspace.songs]);
  // A kit opened for one song never silently shows another: when that song
  // is gone (archived, a template, no longer in a linked folder), say so.
  const chosen = launchPath ? songs.find((p) => p.path === launchPath) : undefined;
  const unavailable = !!launchPath && !chosen;
  const project = chosen ?? (launchPath ? undefined : ordered[0]);
  const updateSong = useAppStore((s) => s.updateSong);
  const setView = useAppStore((s) => s.setView);
  const openDetail = useAppStore((s) => s.openDetail);
  const startRender = useAppStore((s) => s.startRender);
  const rendering = useAppStore((s) => s.rendering);
  const masterFile = project ? kitMaster(project, workspace.songs[project.path]) : undefined;
  const { analysis, error: analysisError, loading } = useAnalysis(project, masterFile, demoMode);
  const [exportState, setExportState] = useState<{ status: "idle" | "running" } | { status: "done"; dir: string } | { status: "error"; message: string }>({ status: "idle" });
  /** Where the last "need you" jump went, so the next click moves on. */
  const lastJump = useRef<string | null>(null);
  /** The "what's in your kit" popup, shown once after each export. */
  const [guide, setGuide] = useState<{ guide: KitGuide; lang: KitLang; dir: string } | null>(null);

  const t = tr(T);
  // "Export anyway" step when fields are still open (before any early return: hooks).
  const [exportArmed, setExportArmed] = useState(false);

  if (!project) {
    if (unavailable && songs.length > 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="max-w-md text-sm text-body">{t.unavailable}</p>
          <button onClick={() => openLaunchKit(null)} className={btn}>
            {t.pickAnother}
          </button>
        </div>
      );
    }
    return <div className="flex flex-1 items-center justify-center text-sm text-engrave">{t.empty}</div>;
  }

  const meta = workspace.songs[project.path] ?? {};
  const master = masterFile;
  // Fridays already taken: other releases, other kits, the crew's songs
  // (never this song's own release or its siblings: releaseDates.ts).
  const busy = busyDates({ path: project.path, albums: workspace.albums, songs: workspace.songs, crewSongs });
  const kitInput: KitInput = {
    project,
    meta,
    people: workspace.people,
    albums: workspace.albums,
    analysis,
    captionLanguage: meta.launchKit?.captionLanguage ?? settings.captionLanguage ?? "fr",
    lastLanguage: lastLyricsLanguage(workspace.songs, project.path),
    labelName: crewName,
    busyDates: busy,
    songs: workspace.songs,
  };
  const fields = buildKit(kitInput);
  const snippets = kitSnippets(analysis, meta);
  const checkOptions = { master, analysisFailed: !!master && !loading && !analysis, finalCoverDone: !!meta.launchKit?.finalCoverDone };
  const extra = kitChecks(project, analysis, checkOptions);
  const all: KitCheck[] = [...extra, ...fields.flatMap((f) => (f.check ? [f.check] : []))];
  const missing = all.filter((c) => c.level === "missing").length;
  const ai = aiSummary(fields);
  const warnings = all.length - missing + ai.flagged;
  const accepted = isKitAccepted(project, meta, workspace.albums);
  const byId = (id: KitField["id"]) => fields.find((f) => f.id === id)!;
  const fingerprint = exportFingerprint(fields, master, snippets);
  const exported = exportStatus(meta, fingerprint);
  const release = releaseOf(workspace.albums, project.path);
  const releaseDate = byId("releaseDate");
  const daysToRelease = daysUntil(releaseDate.value);

  const edits = meta.launchKit?.edits ?? {};
  // stageRank counts down from Promotion (0) to Creation, Unsorted last.
  const beforeRelease = stageRank(meta.status) > stageRank("release");
  // "Move to Release" only once the date has come, never before.
  const releaseDue = beforeRelease && daysToRelease !== null && daysToRelease <= 0;
  const suggestions = fields.filter((f) => f.review && !f.review.stale && f.review.suggestion && f.review.suggestion !== f.value);

  /** The status plate's "N need you": each click goes to the next field
   * that needs an answer, in page order, then wraps around. */
  function jumpToNextNeed() {
    const targets = [...document.querySelectorAll<HTMLElement>("[data-needs-you]")];
    if (!targets.length) return;
    // Clicking the plate takes focus, so remember where the last jump went
    // (by field, since rows re-render as answers come in).
    const current = targets.findIndex((t) => (t.dataset.kitField ?? t.textContent) === lastJump.current);
    const target = targets[(current + 1) % targets.length];
    lastJump.current = target.dataset.kitField ?? target.textContent;
    focusField(target);
  }

  /** The suggested release date becomes the song's date once the kit is
   * accepted or exported, so the Calendar, the Dashboard and the crew see
   * the date the exported files announce (it would otherwise move to the
   * next Friday a week later). A release's own date is left alone. */
  function keepReleaseDate() {
    if (!project) return;
    // Kept as a suggestion: a date set on the release later still wins.
    if (edits.releaseDate === undefined && releaseDate.source === "suggested" && releaseDate.value) pinKitReleaseDate(project.path, releaseDate.value);
  }

  function handleAccept() {
    if (!project) return;
    keepReleaseDate();
    acceptKit(project.path, acceptFingerprint(project, meta, workspace.albums));
  }

  /** Into the song's panel, in the Library. */
  function backToSong() {
    if (!project) return;
    setView("library");
    openDetail(project.path);
  }

  async function handleRender() {
    if (!project) return;
    setExportState({ status: "idle" });
    try {
      await startRender([project.path]);
    } catch (e) {
      setExportState({ status: "error", message: errorText(e) });
    }
  }

  async function handleExport() {
    if (!project) return;
    if (!settings.outputFolder) return setExportState({ status: "error", message: t.needExportFolder });
    // Open items: ask once, inline (a second press of Export anyway goes on).
    if (missing + ai.flagged > 0 && !exportArmed) {
      setExportArmed(true);
      return;
    }
    setExportArmed(false);
    keepReleaseDate();
    const title = byId("title").value || project.name;
    setExportState({ status: "running" });
    try {
      const lang: KitLang = kitInput.captionLanguage ?? "fr";
      const masterExt = master?.path.split(".").pop()?.toLowerCase() ?? null;
      const dir = await api.exportLaunchKit({
        folderName: title,
        // The files don't follow the app's language (distributor sheet, checklist).
        files: inEnglish(() =>
          kitFiles(buildKit(kitInput), snippets, kitChecks(project, analysis, checkOptions), lang, masterExt, meta.launchKit?.includeArtistIds ? kitArtists(meta, kitInput.people) : null),
        ),
        master: master?.path ?? null,
        masterName: masterBaseName(fields, project.name),
        clips: snippets,
        song: project.path,
        previousFolder: previousKitFolder(meta),
      });
      patchKit(project.path, { exported: { atMs: Date.now(), fingerprint, folder: exportedFolderName(dir, title) } });
      setExportState({ status: "done", dir });
      setGuide({ guide: kitGuide(lang, { title, master: masterExt ? `${masterBaseName(fields, project.name)}.${masterExt}` : null, snippets: snippets.map((s) => s.label) }), lang, dir });
    } catch (e) {
      setExportState({ status: "error", message: errorText(e) });
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-orange-300">
            <Rocket size={18} />
            <h1 className="font-display text-3xl uppercase leading-none tracking-tight text-cream">Launch Kit</h1>
          </div>
          <SongPicker
            songs={songs}
            current={project}
            workspace={workspace}
            onSelect={(path) => {
              openLaunchKit(path);
              setExportState({ status: "idle" });
            }}
          />
          <StatusSelect compact value={meta.status} onChange={(status) => updateSong(project.path, { status })} />
          <button onClick={backToSong} className="flex items-center gap-1 text-xs text-body hover:text-cream" title={t.backToSongTitle}>
            <ArrowLeft size={12} /> {t.backToSong}
          </button>
          <KitStatus missing={missing} warnings={warnings} accepted={!!accepted} aiVerified={ai.verified} onJump={jumpToNextNeed} />
          <div className="ml-auto flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-body" title={t.artistIdsHint(kitArtists(meta, kitInput.people))}>
              <input
                type="checkbox"
                checked={!!meta.launchKit?.includeArtistIds}
                onChange={(e) => setKitIncludeArtistIds(project.path, e.target.checked)}
                className="accent-orange-500"
              />
              {t.includeArtistIds}
            </label>
            <button
              onClick={handleAccept}
              disabled={missing > 0 || !!accepted}
              title={missing > 0 ? t.answerFirst : t.markReviewed}
              className={btn}
            >
              <Check size={14} /> {accepted ? t.accepted : t.acceptAll}
            </button>
            {exported !== "never" && meta.launchKit?.exported && (
              <span
                className={`flex items-center gap-1.5 text-xs ${exported === "changed" ? "text-warn" : "text-engrave"}`}
                title={exported === "changed" ? t.changedSinceExportHint : undefined}
              >
                <StatusDot color={exported === "changed" ? "var(--color-warn)" : "var(--color-ok)"} />
                {exported === "changed" ? t.changedSinceExport : t.exportedAgo(formatRelative(meta.launchKit.exported.atMs))}
              </span>
            )}
            <button
              onClick={handleExport}
              disabled={demoMode || exportState.status === "running" || loading}
              title={demoMode ? t.exportOffDemo : loading ? t.waitAnalysis : t.exportWhere}
              className={btnPrimary}
            >
              <Rocket size={14} /> {exportState.status === "running" ? t.exporting : t.exportKit}
            </button>
          </div>
        </header>

        {releaseDue && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-panel px-4 py-2.5 text-sm text-cream">
            <span className="min-w-0 flex-1">{t.releaseDayCame}</span>
            <button onClick={() => updateSong(project.path, { status: "release" })} className={btn}>
              {t.moveToStage(statusInfo("release").label)}
            </button>
          </div>
        )}

        {exportArmed && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn/40 bg-panel px-4 py-2.5 text-sm text-cream" role="alertdialog">
            <span className="min-w-0 flex-1">{t.exportConfirm(missing, ai.flagged)}</span>
            <button onClick={() => setExportArmed(false)} className="text-body hover:text-cream">
              {t.cancel}
            </button>
            <button onClick={handleExport} className={btnPrimary}>
              {t.exportAnyway}
            </button>
          </div>
        )}

        {exportState.status === "done" && (
          <div className="flex items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-200">
            <CheckCircle2 size={16} /> {t.exported(missing + warnings)}
            <button onClick={() => api.revealInFileManager(exportState.dir)} className="ml-auto flex items-center gap-1 text-xs underline">
              <FolderOpen size={13} /> {t.showFolder}
            </button>
          </div>
        )}
        {guide && <KitExportedDialog {...guide} onClose={() => setGuide(null)} />}
        {exportState.status === "error" && (
          <div className="flex items-center gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
            <span className="flex-1">{exportState.message}</span>
            {!settings.outputFolder && (
              <button onClick={() => setView("settings", "export")} className="shrink-0 text-xs underline">
                {t.openSettings}
              </button>
            )}
          </div>
        )}
        {extra.map((c) => (
          <div key={c.message} tabIndex={-1} data-needs-you={c.level === "missing" ? "" : undefined} className="flex items-center gap-3 rounded-md outline-none">
            <div className="min-w-0 flex-1">
              <CheckLine check={c} />
            </div>
            {project.renders.length === 0 && c.level === "missing" && canRenderInApp(project) && !demoMode && (
              <button onClick={() => void handleRender()} disabled={rendering} className={`${btn} shrink-0 text-xs`}>
                {rendering ? t.rendering : t.renderNow}
              </button>
            )}
            {c.message === finalCoverMessage() && (
              <button onClick={() => patchKit(project.path, { finalCoverDone: true })} className={`${btn} shrink-0 text-xs`}>
                <Check size={13} /> {t.markCoverDone}
              </button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 text-xs text-body">
          {suggestions.length > 0 && (
            <button
              onClick={() => setKitEdits(project.path, Object.fromEntries(suggestions.map((f) => [f.id, f.review!.suggestion!])))}
              className="rounded border border-dashed border-engrave px-2 py-1 text-cream hover:bg-raised"
            >
              {t.useSuggestions(suggestions.length)}
            </button>
          )}
          {Object.keys(edits).length > 0 && (
            <span title={t.resetConfirm}>
              <ConfirmButton label={t.resetAll} confirmLabel={t.clickAgain} onConfirm={() => setKitEdits(project.path, null)} className="hover:text-cream" />
            </span>
          )}
          <span title={t.blankConfirm}>
            <ConfirmButton
              label={t.startBlank}
              confirmLabel={t.clickAgain}
              onConfirm={() => setKitEdits(project.path, Object.fromEntries(fields.filter((f) => f.kind !== "multiline").map((f) => [f.id, ""])))}
              className="hover:text-cream"
            />
          </span>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-5">
          <div className="flex flex-col gap-5">
            <Card title={t.metadata}>
              {project.renders.length > 1 && (
                <MasterPicker
                  renders={project.renders}
                  value={meta.launchKit?.master}
                  current={master}
                  onChange={(path) => patchKit(project.path, { master: path })}
                />
              )}
              <div className="flex flex-col divide-y divide-rule">
                {METADATA_FIELDS.map((id) => (
                  <FieldRow key={id} field={byId(id)} onChange={(v) => setKitEdit(project.path, id, v)} />
                ))}
              </div>
            </Card>
            <Card title={t.releaseTiming}>
              <FieldRow field={releaseDate} onChange={(v) => setKitEdit(project.path, "releaseDate", v)} />
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {release?.releaseDate && releaseDate.value !== release.releaseDate && (
                  <button onClick={() => setKitEdit(project.path, "releaseDate", undefined)} className={btn}>
                    {t.useReleaseDate(release.releaseDate)}
                  </button>
                )}
                {release && !release.releaseDate && parseDate(releaseDate.value) && (
                  <button onClick={() => updateAlbum(release.id, { releaseDate: releaseDate.value })} title={t.setOnReleaseHint} className={btn}>
                    {t.setOnRelease(release.title)}
                  </button>
                )}
              </div>
              <PreSaveInput value={meta.launchKit?.preSaveUrl ?? ""} onChange={(url) => patchKit(project.path, { preSaveUrl: url || undefined, acceptedAtMs: undefined })} />
            </Card>
            <Card title={t.distribution}>
              <div className="flex flex-col divide-y divide-rule">
                {DISTRIBUTION_FIELDS.map((id) => (
                  <FieldRow key={id} field={byId(id)} onChange={(v) => setKitEdit(project.path, id, v)} />
                ))}
              </div>
            </Card>
          </div>

          <div className="flex flex-col gap-5">
            <AiPanel key={`ai:${project.path}`} path={project.path} input={kitInput} fields={fields} />
            <Card title={t.snippetsCard}>
              <Snippets
                project={project}
                render={master}
                analysis={analysis}
                snippets={snippets}
                loading={loading}
                error={analysisError}
                demoMode={demoMode}
                onMove={(key, start) => setSnippetStart(project.path, key, start)}
                onLength={(key, length) => setSnippetLength(project.path, key, length)}
              />
            </Card>
            <ShortsPanel
              key={`shorts:${project.path}`}
              project={project}
              master={master}
              fields={fields}
              snippets={snippets}
              analysisLoading={loading}
              analysisError={analysisError}
            />
            <Card title={t.coverBrief}>
              <FieldRow field={byId("coverBrief")} onChange={(v) => setKitEdit(project.path, "coverBrief", v)} bare />
              <CoverConcepts
                key={project.path}
                path={project.path}
                title={byId("title").value || project.name}
                artists={artistLine(byId("artists").value, byId("featuring").value)}
                brief={byId("coverBrief").value}
                releaseType={byId("releaseType").value}
              />
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-body">
                <input
                  type="checkbox"
                  checked={!!meta.launchKit?.finalCoverDone}
                  onChange={(e) => patchKit(project.path, { finalCoverDone: e.target.checked || undefined })}
                  className="accent-orange-500"
                />
                {t.finalCoverReady}
              </label>
            </Card>
            <Card title={t.captions}>
              <CaptionLanguage
                value={kitInput.captionLanguage ?? "fr"}
                own={!!meta.launchKit?.captionLanguage}
                onChange={(lang) => setKitCaptionLanguage(project.path, lang === (settings.captionLanguage ?? "fr") ? undefined : lang)}
              />
              <FieldRow field={byId("captions")} onChange={(v) => setKitEdit(project.path, "captions", v)} bare />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}


/** Draft copy with Gemini, then check every field. Off without a key. */
function AiPanel({ path, input, fields }: { path: string; input: KitInput; fields: KitField[] }) {
  const aiStatus = useAppStore((s) => s.aiStatus);
  const settings = useAppStore((s) => s.settings);
  const setKitAi = useAppStore((s) => s.setKitAi);
  const setKitEdit = useAppStore((s) => s.setKitEdit);
  const setView = useAppStore((s) => s.setView);
  const [running, setRunning] = useState<"draft" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Write captions & brief" over hand-edited text asks first.
  const [overwriteArmed, setOverwriteArmed] = useState(false);

  const t = tr(T);
  if (!aiStatus?.configured) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-rule-strong bg-panel p-4 text-sm">
        <Sparkles size={16} className="shrink-0 text-body" />
        <span className="flex-1 text-body">{t.aiOff}</span>
        <button onClick={() => setView("settings", "ai")} className={btn}>
          {t.addKey}
        </button>
      </div>
    );
  }

  const model = settings.aiModel || aiStatus.defaultModel;
  const summary = aiSummary(fields);
  // Every field already reviewed against its current value: a re-check would
  // only spend free quota for the same answer.
  const upToDate = summary.state === "checked" && summary.skipped === 0;
  const drafts = input.meta.launchKit?.ai?.drafts;
  const reviewedAt = input.meta.launchKit?.ai?.review?.atMs;
  const answeredBy = [drafts?.model, input.meta.launchKit?.ai?.review?.model];
  const backupUsed = answeredBy.find((m) => m && m !== model);

  async function run(withDraft: boolean) {
    setError(null);
    const handEdited = input.meta.launchKit?.edits?.captions !== undefined || input.meta.launchKit?.edits?.coverBrief !== undefined;
    if (withDraft && handEdited && !overwriteArmed) {
      setOverwriteArmed(true);
      return;
    }
    setOverwriteArmed(false);
    // A call can take a while: if the user switches between sample data and
    // their real songs meanwhile, the result belongs to neither.
    const startedInDemo = useAppStore.getState().demoMode;
    const stillValid = () => useAppStore.getState().demoMode === startedInDemo;
    try {
      let current = fields;
      if (withDraft) {
        setRunning("draft");
        const d = await draftCopy(input, fields, settings);
        if (!stillValid()) return;
        // d.model is the model that answered (the backup one if Gemini was busy).
        const newDrafts = { ...d, atMs: Date.now() };
        // Asking for new copy replaces hand edits of those two fields.
        setKitEdit(path, "captions", undefined);
        setKitEdit(path, "coverBrief", undefined);
        setKitAi(path, { drafts: newDrafts });
        const kit = input.meta.launchKit ?? {};
        const { captions: _c, coverBrief: _b, ...edits } = kit.edits ?? {};
        current = buildKit({ ...input, meta: { ...input.meta, launchKit: { ...kit, edits, ai: { ...kit.ai, drafts: newDrafts } } } });
      }
      setRunning("review");
      const checked = await reviewKit(input, current, settings);
      if (!stillValid()) return;
      setKitAi(path, { review: { fields: checked.review, model: checked.model, atMs: Date.now() } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(null);
    }
  }

  const line =
    summary.state === "unchecked"
      ? t.notChecked
      : summary.state === "stale"
        ? t.changedSince
        : summary.verified
          ? t.allRight
          : [summary.flagged && t.toLookAt(summary.flagged), summary.skipped && t.notCheckedN(summary.skipped)].filter(Boolean).join(" ") ||
            t.noProblems;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-rule-strong bg-panel p-4">
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-body" />
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">
          {t.aiLayer} · {model}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => run(true)} disabled={!!running} className={btnPrimary}>
          <Sparkles size={14} /> {running === "draft" ? t.writing : t.writeCopy}
        </button>
        <button
          onClick={() => run(false)}
          disabled={!!running || upToDate}
          title={upToDate ? t.upToDate : undefined}
          className={btn}
        >
          <Check size={14} /> {running === "review" ? t.checkingAll : summary.state === "unchecked" ? t.checkKit : upToDate ? t.checked : t.recheck}
        </button>
        {drafts && !running && (
          <button onClick={() => setKitAi(path, { drafts: undefined })} className="text-xs text-engrave hover:text-cream" title={t.backToTemplate}>
            {t.discardDrafts}
          </button>
        )}
      </div>
      {overwriteArmed && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn/40 bg-chassis px-3 py-2 text-xs text-cream" role="alertdialog">
          <span className="min-w-0 flex-1">{t.overwriteConfirm}</span>
          <button onClick={() => setOverwriteArmed(false)} className="text-body hover:text-cream">
            {t.cancel}
          </button>
          <button onClick={() => void run(true)} className={btnPrimary}>
            {t.writeAnyway}
          </button>
        </div>
      )}
      <div className={`text-xs ${summary.verified ? "text-emerald-300" : summary.state === "checked" ? "text-amber-300" : "text-engrave"}`}>
        {line}
        {reviewedAt && <span className="text-engrave">{t.checkedAgo(formatRelative(reviewedAt))}</span>}
      </div>
      {running && <div className="text-[11px] text-engrave">{t.retries}</div>}
      {backupUsed && !running && <div className="text-[11px] text-engrave">{t.backup(model, backupUsed)}</div>}
      {error && <div className="text-xs text-red-300">{error}</div>}
      <div className="text-[11px] leading-relaxed text-engrave">
        {aiDisclosure(!!settings.aiIncludeNotes)}
      </div>
    </div>
  );
}

function Snippets({
  project,
  render,
  analysis,
  snippets,
  loading,
  error,
  demoMode,
  onMove,
  onLength,
}: {
  project: ProjectInfo;
  render: FileEntry | undefined;
  analysis: AudioAnalysis | null;
  snippets: Snippet[];
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  onMove: (key: string, start: number | undefined) => void;
  onLength: (key: string, length: number | undefined) => void;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // While dragging, the snippet's live start (saved once, on release).
  const [drag, setDrag] = useState<{ key: string; offset: number; start: number; moved: boolean } | null>(null);

  useEffect(() => () => audio.current?.pause(), [render?.path]);

  const t = tr(T);
  if (!render) return <div className="py-6 text-center text-xs text-engrave">{t.renderForSnippets}</div>;
  if (loading) return <div className="py-6 text-center text-xs text-engrave">{t.listening}</div>;
  if (error || !analysis) return <div className="py-6 text-center text-xs text-red-300">{error ?? t.noAnalysis}</div>;
  if (!snippets.length) return <div className="py-6 text-center text-xs text-engrave">{t.tooShort}</div>;

  const duration = analysis.durationSec;
  const bar = project.tempoBpm ? 240 / project.tempoBpm : 1;
  const keyOf = (s: Snippet) => s.key ?? s.label;
  const active = selected ?? keyOf(snippets[0]);
  // ~240 bars across, each the max of its windows so peaks survive.
  const step = Math.max(1, Math.ceil(analysis.energy.length / 240));
  const bars = Array.from({ length: Math.ceil(analysis.energy.length / step) }, (_, i) => Math.max(...analysis.energy.slice(i * step, i * step + step)));
  const clampStart = (start: number, length: number) => Math.round(Math.min(Math.max(0, start), Math.max(0, duration - length)) * 10) / 10;
  const timeAt = (clientX: number) => {
    const r = strip.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * duration;
  };
  const shown = (s: Snippet) => (drag && drag.key === keyOf(s) ? { ...s, startSec: drag.start } : s);

  function play(s: Snippet) {
    const el = audio.current;
    if (!el) return;
    if (playing === keyOf(s)) {
      el.pause();
      setPlayhead(null);
      return setPlaying(null);
    }
    el.currentTime = s.startSec;
    el.ontimeupdate = () => {
      setPlayhead(el.currentTime);
      if (el.currentTime >= s.startSec + s.lengthSec) {
        el.pause();
        setPlaying(null);
        setPlayhead(null);
      }
    };
    el.play().then(() => setPlaying(keyOf(s))).catch(() => setPlaying(null));
  }

  // Drag a snippet along the waveform, or click empty space to put the
  // selected snippet there.
  function down(e: React.PointerEvent, s?: Snippet) {
    if (!strip.current) return;
    e.preventDefault();
    const t = timeAt(e.clientX);
    if (s) {
      setSelected(keyOf(s));
      setDrag({ key: keyOf(s), offset: t - s.startSec, start: s.startSec, moved: false });
    } else {
      const target = snippets.find((x) => keyOf(x) === active)!;
      const start = clampStart(t - target.lengthSec / 2, target.lengthSec);
      setDrag({ key: active, offset: t - start, start, moved: true });
    }
    strip.current.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    if (!drag) return;
    const s = snippets.find((x) => keyOf(x) === drag.key)!;
    setDrag({ ...drag, start: clampStart(timeAt(e.clientX) - drag.offset, s.lengthSec), moved: true });
  }
  function up() {
    if (drag?.moved) onMove(drag.key, drag.start);
    setDrag(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={strip}
        className="relative h-24 w-full cursor-crosshair touch-none select-none"
        onPointerDown={(e) => down(e)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => setDrag(null)}
        title={t.stripHelp}
      >
        <svg viewBox={`0 0 ${bars.length} 100`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-label={t.loudness}>
          {bars.map((e, i) => (
            <rect key={i} x={i + 0.15} y={100 - e * 100} width={0.7} height={e * 100} fill="rgba(255,255,255,0.22)" />
          ))}
        </svg>
        {snippets.map((raw, i) => {
          const s = shown(raw);
          const isActive = keyOf(s) === active;
          return (
            <div
              key={keyOf(s)}
              role="slider"
              aria-label={t.snippetStart(s.label)}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration - s.lengthSec)}
              aria-valuenow={Math.round(s.startSec)}
              aria-valuetext={formatDuration(s.startSec)}
              tabIndex={0}
              onPointerDown={(e) => {
                e.stopPropagation();
                down(e, raw);
              }}
              onKeyDown={(e) => {
                const d = e.key === "ArrowLeft" ? -bar : e.key === "ArrowRight" ? bar : 0;
                if (d) {
                  e.preventDefault();
                  onMove(keyOf(s), clampStart(s.startSec + d, s.lengthSec));
                }
              }}
              title={t.dragToMove(s.label)}
              className={`absolute bottom-0 top-0 cursor-grab rounded-sm border-x-2 active:cursor-grabbing ${isActive ? "z-10" : ""}`}
              style={{
                left: `${(s.startSec / duration) * 100}%`,
                width: `${(s.lengthSec / duration) * 100}%`,
                background: `${SNIPPET_COLORS[i % 3]}${isActive ? "44" : "22"}`,
                borderColor: SNIPPET_COLORS[i % 3],
              }}
            >
              {isActive && (
                <span className="pointer-events-none absolute left-1 top-1 whitespace-nowrap rounded-sm bg-chassis/80 px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-cream">
                  {s.label}
                </span>
              )}
            </div>
          );
        })}
        {playhead !== null && (
          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-cream" style={{ left: `${(playhead / duration) * 100}%` }} />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-engrave">
        <span>0:00</span>
        <span>{formatDuration(duration)}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {snippets.map((raw, i) => {
          const s = shown(raw);
          const key = keyOf(s);
          const detected = analysis.snippets.find((d) => d.label === key);
          const moved = detected && (s.startSec !== detected.startSec || s.lengthSec !== detected.lengthSec);
          const nudge = (d: number) => onMove(key, clampStart(s.startSec + d, s.lengthSec));
          return (
            <div
              key={key}
              onClick={() => setSelected(key)}
              onFocus={() => setSelected(key)}
              className={`flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${key === active ? "border-rule-strong bg-raised" : "border-transparent bg-panel"}`}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SNIPPET_COLORS[i % 3] }} />
              <button type="button" onClick={() => setSelected(key)} aria-pressed={key === active} className="w-24 rounded text-left text-cream focus-visible:outline-2 focus-visible:outline-cream">
                {s.label}
              </button>
              <TimeInput value={s.startSec} onCommit={(v) => onMove(key, clampStart(v, s.lengthSec))} />
              <span className="text-engrave">→ {formatDuration(s.startSec + s.lengthSec)}</span>
              <select
                value={s.lengthSec}
                onChange={(e) => {
                  const len = Number(e.target.value);
                  onLength(key, len === detected?.lengthSec ? undefined : len);
                  if (s.startSec + len > duration) onMove(key, clampStart(s.startSec, len));
                }}
                aria-label={t.snippetLength(s.label)}
                className="rounded border border-rule-strong bg-chassis px-1.5 py-0.5 text-cream"
              >
                {[...new Set([...SNIPPET_LENGTHS, detected?.lengthSec ?? 15])]
                  .filter((l) => l <= duration)
                  .sort((a, b) => a - b)
                  .map((l) => (
                    <option key={l} value={l}>
                      {l}s
                    </option>
                  ))}
              </select>
              <span className="min-w-0 flex-1 truncate text-[11px] text-engrave">{moved ? t.editedByYou : (s.reason ?? "")}</span>
              <button onClick={() => nudge(-bar)} title={project.tempoBpm ? t.barEarlier : t.secEarlier} className="rounded p-1 text-engrave hover:bg-rule hover:text-cream">
                <Minus size={12} />
              </button>
              <button onClick={() => nudge(bar)} title={project.tempoBpm ? t.barLater : t.secLater} className="rounded p-1 text-engrave hover:bg-rule hover:text-cream">
                <Plus size={12} />
              </button>
              {moved && (
                <button
                  onClick={() => {
                    onMove(key, undefined);
                    onLength(key, undefined);
                  }}
                  title={t.backToDetected}
                  className="rounded p-1 text-engrave hover:bg-rule hover:text-cream"
                >
                  <RotateCcw size={12} />
                </button>
              )}
              <button
                onClick={() => play(s)}
                disabled={demoMode}
                title={demoMode ? t.noAudioDemo : t.playSnippet}
                className="flex items-center gap-1 rounded bg-rule px-2 py-1 text-cream hover:bg-rule-strong disabled:opacity-40"
              >
                {playing === key ? <Pause size={12} /> : <Play size={12} />}
              </button>
            </div>
          );
        })}
      </div>
      {!demoMode && <audio ref={audio} src={api.audioSrc(render.path)} preload="none" />}
      <div className="text-[11px] text-engrave">{t.snippetsHelp}</div>
    </div>
  );
}

/** Which render is the master. "Auto" = the newest lossless one (kitState.ts). */
function MasterPicker({ renders, value, current, onChange }: { renders: FileEntry[]; value: string | undefined; current: FileEntry | undefined; onChange: (path: string | undefined) => void }) {
  const t = tr(T);
  const name = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const picked = value && renders.some((r) => r.path === value) ? value : "";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-rule pb-3 text-xs" title={t.masterHint}>
      <span className="font-medium text-body">{t.masterLabel}</span>
      <select
        value={picked}
        onChange={(e) => onChange(e.target.value || undefined)}
        aria-label={t.masterLabel}
        className="min-w-0 flex-1 truncate rounded border border-rule-strong bg-chassis px-1.5 py-1 text-cream"
      >
        <option value="">{`${current ? name(current.path) : ""} (${t.masterAuto})`}</option>
        {[...renders]
          .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
          .map((r) => (
            <option key={r.path} value={r.path}>
              {`${name(r.path)} · ${formatRelative(r.modifiedAtMs)}${isLossless(r.path) ? "" : ` · ${t.lossy}`}`}
            </option>
          ))}
      </select>
    </div>
  );
}

/** The optional pre-save link: https only, saved when leaving the field. */
function PreSaveInput({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const t = tr(T);
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  const valid = !shown.trim() || /^https:\/\/[^\s]+$/i.test(shown.trim());
  const commit = () => {
    if (text === null) return;
    if (valid) onChange(text.trim());
    setText(null);
  };
  return (
    <label className="mt-3 flex flex-col gap-1 border-t border-rule pt-3 text-xs">
      <span className="flex items-center gap-2">
        <span className="font-medium text-body">{t.preSave}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-engrave">{valid ? t.preSaveHint : t.preSaveInvalid}</span>
      </span>
      <input
        value={shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(null);
        }}
        placeholder="https://"
        className={`rounded border bg-chassis px-2 py-1 text-cream focus:outline-none ${valid ? "border-rule-strong focus:border-hot" : "border-warn"}`}
      />
    </label>
  );
}

/** m:ss(.s) start time you can type; commits on Enter or when leaving the field. */
function TimeInput({ value, onCommit }: { value: number; onCommit: (seconds: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const m = text.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    if (m) onCommit((m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]));
    setText(null);
  };
  return (
    <input
      value={text ?? formatDuration(value)}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
      onClick={(e) => e.stopPropagation()}
      aria-label={tr(T).startTime}
      className="w-14 rounded border border-rule-strong bg-chassis px-1.5 py-0.5 font-mono tabular-nums text-cream focus:border-hot focus:outline-none"
    />
  );
}


const T_EXPORTED = dict(
  { title: "Kit exported", inOrder: "In order", sameText: "The same text is in README.md, in the kit folder.", showFolder: "Show folder", gotIt: "Got it" },
  { title: "Kit exporté", inOrder: "Dans l'ordre", sameText: "Le même texte est dans README.md, dans le dossier du kit.", showFolder: "Ouvrir le dossier", gotIt: "Compris" },
);

/** After an export: what's in the kit and what to do with it (same text as README.md). */
function KitExportedDialog({ guide, lang, dir, onClose }: { guide: KitGuide; lang: KitLang; dir: string; onClose: () => void }) {
  // In the kit's language, like the guide it shows.
  const t = T_EXPORTED[lang];
  // Modal traps the focus, answers Escape and hands the focus back on close.
  return (
    <Modal title={t.title} onClose={onClose} width="max-w-2xl">
      <p className="text-sm text-body">{guide.intro}</p>
      <div className="mt-4 text-sm">
        <ul className="flex flex-col gap-2.5">
          {guide.items.map((i) => (
            <li key={i.file}>
              <span className="font-mono text-xs text-cream">{i.file}</span>
              <div className="text-body">
                {i.what} <span className="text-engrave">{i.todo}</span>
              </div>
            </li>
          ))}
        </ul>
        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-engrave">{t.inOrder}</h3>
        <ol className="mt-2 list-decimal pl-5 text-body">
          {guide.steps.map((s) => (
            <li key={s} className="py-0.5">
              {s}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-engrave">{t.sameText}</p>
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-rule pt-3">
        <button onClick={() => void api.revealInFileManager(dir)} className={btn}>
          <FolderOpen size={14} /> {t.showFolder}
        </button>
        <button onClick={onClose} className={btnPrimary}>
          {t.gotIt}
        </button>
      </div>
    </Modal>
  );
}

/** This kit's caption language; changing it rewrites the template captions
 * (AI drafts are flagged for a rewrite). */
function CaptionLanguage({ value, own, onChange }: { value: KitLang; own: boolean; onChange: (lang: KitLang) => void }) {
  const t = tr(T);
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-engrave" role="group" aria-label={t.captionLanguage}>
      <span>{t.captionsIn}</span>
      {(["fr", "en"] as const).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          aria-pressed={value === l}
          className={`rounded px-2 py-0.5 ${value === l ? "bg-cream text-chassis" : "border border-rule text-body hover:bg-raised"}`}
        >
          {l === "fr" ? "Français" : "English"}
        </button>
      ))}
      <span>{own ? t.forThisKit : t.fromSettings}</span>
    </div>
  );
}

/** Scrolls a field into view, bounces it once (a highlight only with reduced
 * motion) and moves keyboard focus to its input. The ring stays until focus
 * leaves the field. */
export function focusField(row: HTMLElement) {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  document.querySelectorAll(".kit-attention").forEach((el) => el.classList.remove("kit-attention", "kit-bounce"));
  row.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  // The answer box first (not the Copy/Reset buttons), else a choice
  // button, else the row itself (a project-level check).
  const target =
    row.querySelector<HTMLElement>("input, textarea, select") ?? row.querySelector<HTMLElement>("button:not([title])") ?? row;
  target.focus({ preventScroll: true });
  row.classList.add("kit-attention");
  if (!reduced) {
    row.classList.add("kit-bounce");
    row.addEventListener("animationend", () => row.classList.remove("kit-bounce"), { once: true });
  }
  const clear = (e: FocusEvent) => {
    if (row.contains(e.relatedTarget as Node | null)) return;
    row.classList.remove("kit-attention", "kit-bounce");
    row.removeEventListener("focusout", clear);
  };
  row.addEventListener("focusout", clear);
}
