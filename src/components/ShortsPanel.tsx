import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clapperboard, FolderOpen } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { drawShortLayout } from "../lib/shorts";
import { artistLine, type KitField } from "../lib/launchKit";
import type { FileEntry, ProjectInfo, Snippet } from "../types";
import { usePickedConcept } from "./CoverConcepts";
import { kitFolderName, previousKitFolder } from "../lib/kitState";
import { btn, btnPrimary } from "./ui";
import { dict, tr } from "../i18n";
import { errorText, errorReason, errorTextOr } from "../lib/errors";

const T = dict(
  {
    demo: "Sample data has no audio. Link your real project folder to render shorts.",
    noMixdown: "This song has no mixdown yet. Export a WAV or MP3 from your DAW next to the project (or into your export folder), then come back.",
    listening: "Listening to the mixdown to find the snippets…",
    unreadable: (error: string) => `Couldn't read the mixdown: ${error}`,
    tooShort: "The mixdown is shorter than 15 seconds, so there's nothing to cut.",
    chooseFolderHint: "Choose where shorts get saved (your export folder).",
    chooseFolder: "Choose export folder",
    needFfmpeg: "ffmpeg is needed (free, one install). See the steps below.",
    checkAgain: "Check again",
    confirmFound: (path: string) => `ffmpeg found at ${path}. Confirm it once in Settings before it's used.`,
    openSettings: "Open Settings",
    heading: "Shorts for Reels, TikTok and YouTube Shorts",
    previewAlt: "9:16 layout preview",
    waveformHint: "The waveform animates in the dark band",
    intro: (list: string) => `One 1080×1920 MP4 per snippet (${list || "none yet"}) with your real audio, made on this computer. Free, no upload.`,
    ready: (encoder: string) => `ffmpeg ready (${encoder})`,
    notFound: "ffmpeg not found",
    installOnce: "Install it once (free): ",
    onMac: " on Mac, ",
    onWindows: " on Windows. Then restart the app, or ",
    setPath: "set its path in Settings",
    looking: "Looking for ffmpeg…",
    rendering: (n: number) => `Rendering ${n} shorts…`,
    render: (n: number) => `Render ${n} short${n === 1 ? "" : "s"}`,
    showInFolder: "Show in folder",
  },
  {
    demo: "Les données d'exemple n'ont pas d'audio. Relie ton vrai dossier de projets pour faire le rendu des shorts.",
    noMixdown: "Ce son n'a pas encore de mixdown. Exporte un WAV ou un MP3 depuis ton DAW à côté du projet (ou dans ton dossier d'export), puis reviens.",
    listening: "Écoute du mixdown pour trouver les extraits…",
    unreadable: (error: string) => `Impossible de lire le mixdown : ${error}`,
    tooShort: "Le mixdown fait moins de 15 secondes, il n'y a rien à couper.",
    chooseFolderHint: "Choisis où enregistrer les shorts (ton dossier d'export).",
    chooseFolder: "Choisir le dossier d'export",
    needFfmpeg: "Il faut ffmpeg (gratuit, une seule install). Les étapes sont juste en dessous.",
    checkAgain: "Revérifier",
    confirmFound: (path: string) => `ffmpeg trouvé ici : ${path}. Confirme-le une fois dans les Réglages avant qu'il serve.`,
    openSettings: "Ouvrir les Réglages",
    heading: "Shorts pour Reels, TikTok et YouTube Shorts",
    previewAlt: "Aperçu de la mise en page 9:16",
    waveformHint: "La forme d'onde s'anime dans la bande sombre",
    intro: (list: string) => `Un MP4 1080×1920 par extrait (${list || "aucun pour l'instant"}) avec ton vrai audio, fait sur cet ordi. Gratuit, sans upload.`,
    ready: (encoder: string) => `ffmpeg prêt (${encoder})`,
    notFound: "ffmpeg introuvable",
    installOnce: "Installe-le une fois (gratuit) : ",
    onMac: " sur Mac, ",
    onWindows: " sur Windows. Puis redémarre l'appli, ou ",
    setPath: "indique son chemin dans les Réglages",
    looking: "Recherche de ffmpeg…",
    rendering: (n: number) => `Rendu de ${n} shorts…`,
    render: (n: number) => `Faire le rendu de ${n} short${n === 1 ? "" : "s"}`,
    showInFolder: "Afficher dans le dossier",
  },
);

/** 9:16 shorts from the snippets, rendered locally with ffmpeg (free). */
export function ShortsPanel({
  project,
  master,
  fields,
  snippets,
  analysisLoading,
  analysisError,
}: {
  project: ProjectInfo;
  /** The kit's master (kitState.ts), not just the newest render. */
  master: FileEntry | undefined;
  fields: KitField[];
  snippets: Snippet[];
  analysisLoading: boolean;
  analysisError: string | null;
}) {
  const settings = useAppStore((s) => s.settings);
  const meta = useAppStore((s) => s.workspace.songs[project.path]);
  const pickOutputFolder = useAppStore((s) => s.pickOutputFolder);
  const [checkCount, setCheckCount] = useState(0);
  const recheck = () => setCheckCount((n) => n + 1);
  const demoMode = useAppStore((s) => s.demoMode);
  const setView = useAppStore((s) => s.setView);
  const [status, setStatus] = useState<api.ShortsStatus | null>(null);
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "running" } | { kind: "done"; results: api.ShortResult[] } | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let live = true;
    api
      .shortsStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ path: null, found: null, encoder: null, error: null }));
    return () => {
      live = false;
    };
  }, [settings.ffmpegPath, checkCount]);

  const value = (id: KitField["id"]) => fields.find((f) => f.id === id)?.value ?? "";
  const layoutInput = {
    title: value("title") || project.name,
    artists: artistLine(value("artists"), value("featuring")),
    producers: value("producers"),
    key: value("key"),
    releaseDate: value("releaseDate"),
  };
  const layoutKey = JSON.stringify(layoutInput);
  const art = useCoverArt(project.path, kitFolderName(meta, layoutInput.title));
  const preview = useMemo(() => drawShortLayout(layoutInput, art), [layoutKey, art]); // eslint-disable-line react-hooks/exhaustive-deps

  async function chooseExportFolder() {
    await pickOutputFolder();
  }

  // What stops a render, in the order the user should fix it, each with a
  // one-click fix where there is one.
  const t = tr(T);
  const blocker: { message: string; action?: { label: string; run: () => void } } | null = demoMode
    ? { message: t.demo }
    : !master
      ? { message: t.noMixdown }
      : analysisLoading
        ? { message: t.listening }
        : analysisError
          ? { message: t.unreadable(analysisError) }
          : !snippets.length
            ? { message: t.tooShort }
            : !settings.outputFolder
              ? { message: t.chooseFolderHint, action: { label: t.chooseFolder, run: chooseExportFolder } }
              : status && !status.path && status.found
                ? { message: t.confirmFound(status.found), action: { label: t.openSettings, run: () => setView("settings", "ffmpeg") } }
                : status && !status.encoder
                  ? { message: t.needFfmpeg, action: { label: t.checkAgain, run: recheck } }
                  : null;

  async function render() {
    if (!settings.outputFolder || !master) return;
    setState({ kind: "running" });
    try {
      const results = await api.renderShorts({
        song: project.path,
        previousFolder: previousKitFolder(meta),
        master: master.path,
        clips: snippets.map((s) => ({ label: s.label, startSec: s.startSec, lengthSec: s.lengthSec, layoutPng: preview })),
        folderName: layoutInput.title,
      });
      setState({ kind: "done", results });
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  }

  return (
    <div className="rounded-lg border border-rule bg-panel p-4">
      <div className="mb-3 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">
        <Clapperboard size={13} /> {t.heading}
      </div>
      <div className="flex gap-4">
        <div className="shrink-0">
          <img src={preview} alt={t.previewAlt} className="h-[284px] w-[160px] rounded-md border border-rule object-cover" />
          <div className="mt-1 text-center text-[10px] text-engrave">{t.waveformHint}</div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 text-xs text-body">
          <p>{t.intro(snippets.map((s) => s.label).join(", "))}</p>
          {status?.encoder ? (
            <div className="text-emerald-300/80">{t.ready(status.encoder)}</div>
          ) : status ? (
            <div className="rounded-md border border-amber-400/20 bg-amber-500/[0.06] p-2.5 text-amber-100/80">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle size={12} /> {errorTextOr(status.error) ?? (status.found ? t.confirmFound(status.found) : t.notFound)}
              </div>
              <div className="mt-1 text-engrave">
                {t.installOnce}
                <code className="rounded bg-black/30 px-1">brew install ffmpeg</code>
                {t.onMac}
                <code className="rounded bg-black/30 px-1">winget install Gyan.FFmpeg</code>
                {t.onWindows}
                <button onClick={() => setView("settings", "ffmpeg")} className="underline">
                  {t.setPath}
                </button>
                .
              </div>
            </div>
          ) : (
            <div className="text-engrave">{t.looking}</div>
          )}
          <div>
            <button onClick={render} disabled={!!blocker || state.kind === "running"} title={blocker?.message} className={btnPrimary}>
              <Clapperboard size={14} /> {state.kind === "running" ? t.rendering(snippets.length) : t.render(snippets.length)}
            </button>
            {blocker && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-400/25 bg-amber-500/[0.07] px-2.5 py-2 text-[12px] text-amber-100/90">
                <AlertTriangle size={13} className="shrink-0 text-amber-300" />
                <span className="flex-1">{blocker.message}</span>
                {blocker.action && (
                  <button onClick={blocker.action.run} className="shrink-0 rounded bg-amber-400/20 px-2 py-1 font-medium text-amber-50 hover:bg-amber-400/30">
                    {blocker.action.label}
                  </button>
                )}
              </div>
            )}
          </div>
          {state.kind === "error" && <div className="text-red-300">{state.message}</div>}
        </div>
      </div>
      {state.kind === "done" && (
        <div className="mt-4 flex flex-wrap gap-3 border-t border-rule pt-3">
          {state.results.map((r) =>
            r.path ? (
              <div key={r.label} className="flex flex-col items-center gap-1">
                <video src={api.audioSrc(r.path)} controls preload="metadata" className="h-[256px] w-[144px] rounded-md bg-black" />
                <span className="text-[11px] text-body">{r.label}</span>
              </div>
            ) : (
              <div key={r.label} className="max-w-[200px] text-[11px] text-red-300">
                {r.label}: {errorReason(r.error)}
              </div>
            ),
          )}
          {state.results.some((r) => r.path) && (
            <button onClick={() => api.revealInFileManager(state.results.find((r) => r.path)!.path!)} className={`${btn} self-end`}>
              <FolderOpen size={14} /> {t.showInFolder}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The cover concept as the shorts' art: the one picked in this session,
 * else the saved one (where it was saved, which a title change doesn't
 * move; else in the kit's folder). Null: the generated art is used. */
function useCoverArt(path: string, folder: string): HTMLImageElement | null {
  const picked = usePickedConcept(path);
  const cover = useAppStore((s) => s.workspace.songs[path]?.launchKit?.cover);
  const demoMode = useAppStore((s) => s.demoMode);
  const [saved, setSaved] = useState<string | null>(null);
  const [art, setArt] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    setSaved(null);
    if (picked || demoMode || !cover?.savedPath) return;
    let live = true;
    api
      .readKitCover(cover?.savedPath ?? null, folder)
      .then((b64) => live && setSaved(b64))
      .catch(() => live && setSaved(null));
    return () => {
      live = false;
    };
  }, [picked, demoMode, cover?.savedPath, cover?.savedAtMs, folder]);

  const b64 = picked ?? saved;
  useEffect(() => {
    if (!b64) return setArt(null);
    let live = true;
    const img = new Image();
    img.onload = () => live && setArt(img);
    img.onerror = () => live && setArt(null);
    img.src = `data:image/jpeg;base64,${b64}`;
    return () => {
      live = false;
    };
  }, [b64]);
  return art;
}
