import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { UPDATES_ENABLED } from "../lib/updater";
import { updateErrorKind } from "../lib/updaterErrors";
import { FolderPlus, Trash2, Wand2, FileSearch, PlayCircle } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import * as api from "../lib/tauri";
import { CrewPanel } from "./CrewPanel";
import { PhoneSyncSettings } from "./PhoneSyncSettings";
import { DetectedFolders } from "./DetectedFolders";
import { canRenderInApp } from "../lib/daws";
import { aiDisclosure } from "../lib/ai";
import { converterTemplateFor } from "../lib/converters";
import type { CaptionLang, RenderFormat, SpotifyStatus, YoutubeStatus } from "../types";
import { dict, tr } from "../i18n";
import { StatusDot } from "../ui";

// A stable empty list: a fresh [] in a store selector re-renders forever.
const NO_FOLDERS: string[] = [];

const T = dict(
  {
    flNotFound: "FL Studio wasn't found in its usual install folders. Pick it with Browse.",
    notConnected: "Not connected right now (unplugged drive, or the folder was moved or renamed)",
    notConnectedShort: "Not connected",
    needPaths: "Set both the FL Studio path and output folder first.",
    needFlp: "The test render needs an FL Studio project (.flp). None was found in your linked folders.",
    renderFailed: "Render failed",
    sampleData: "Sample data",
    sampleDataHint: "Preview the dashboard and library filled with generated projects — no real folder needed.",
    exitSample: "Exit sample data",
    loadSample: "Load sample data",
    projectFolders: "Project folders",
    projectFoldersHint:
      "Hivo scans these folders (recursively) for projects from FL Studio, Ableton Live, REAPER, Studio One, Pro Tools, Cubase and Bitwig.",
    addFolder: "Add project folder",
    detectTitle: "Auto-detect DAWs",
    detectHint:
      "Each DAW's default projects folder found on this computer (FL Studio, Studio One, REAPER, Ableton Live, Cubase, Bitwig, Pro Tools). Nothing is added until you click Link.",
    flExe: "FL Studio executable",
    flExeHint: "Used to run FL Studio's command-line renderer for batch export.",
    notSet: "Not set",
    detecting: "Detecting...",
    autoDetect: "Auto-detect",
    browse: "Browse",
    export: "Export",
    exportHint: "Where rendered mixdowns go, and in what format.",
    testRender: "Test render",
    testRenderHint:
      "FL Studio's command-line renderer is a community-verified, lightly documented feature. Run one test render on a real project before trusting a big batch export.",
    macOnly:
      "On a Mac, FL Studio opens its window while it renders (it may show its start screen: leave it, don't pick a project) and quits by itself when the file is written (a few minutes for a long song). Quit FL Studio before starting. If it stays open without rendering, quit it: the render gives up after 15 minutes.",
    rendering: "Rendering...",
    renderRecent: "Render most recent project",
    demoDisabled: "Disabled while viewing sample data — link a real folder first.",
    success: (path: string) => `Success — output saved to ${path}`,
    shortsIntro: "The Launch Kit renders 9:16 shorts with ffmpeg, free and on this computer. Install it once:",
    or: "or",
    lookingFfmpeg: "Looking for ffmpeg…",
    found: (path: string, encoder: string) => `Found: ${path} (${encoder})`,
    ffmpegMissing: "Not found. Install it, then restart the app, or pick it below.",
    foundAuto: "Found automatically",
    auto: "Auto",
    keySaved: "Key saved on this computer.",
    keyRemoved: "Key removed.",
    aiOff: "Off: no key yet",
    aiEnv: "On: using GEMINI_API_KEY from the environment",
    aiSaved: "On: key saved on this computer",
    aiTitle: "AI (Launch Kit drafts and checks)",
    aiIntro: "Uses Google Gemini on its free tier. Get a free key at",
    aiIntroEnd: ". Everything works without it; the AI only adds drafts and a second opinion.",
    newKey: "Paste a new key to replace it",
    pasteKey: "Paste your Gemini API key",
    save: "Save",
    remove: "Remove",
    model: "Model",
    captionLang: "Caption language (each Launch Kit can change it)",
    includeNotes: "Include notes when checking a kit",
    includeNotesHint: "Off: your notes stay on this computer. Drafts never use them.",
    keyStays: "The key stays on this computer (its own file in the app config folder, not settings.json) and is never shown again.",
    cfRemoved: "Cloudflare credentials removed.",
    cfSaved: "Saved on this computer.",
    cfOff: "Off: no Cloudflare credentials yet",
    cfEnv: "On: using CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from the environment",
    cfOn: "On: credentials saved on this computer",
    coverTitle: "Cover art (Cloudflare Workers AI, free)",
    coverIntro:
      "Paints cover concepts from the Launch Kit brief with FLUX.1 [schnell]. Cloudflare's free allowance (10,000 neurons a day) is about 170 images a day, no card needed. On the",
    coverLink: "Workers AI page of the Cloudflare dashboard",
    coverPick: ", pick",
    coverCopy: ", copy the",
    coverThen: ", then",
    coverTokenNote: " (a custom token needs Workers AI Read and Edit).",
    accountId: "Account ID (32 characters)",
    accountIdLabel: "Cloudflare account ID",
    tokenLabel: "Cloudflare API token",
    newToken: "Paste a new token to replace it",
    apiToken: "API token",
    coverPrivacy:
      "Both stay on this computer (their own owner-only file in the app config folder, not settings.json) and are never shown again. Only the image prompt is sent to Cloudflare. It's built from the cover brief's concept, imagery, palette, tags and any free text you write in it, with the song title, artist names and the Notes line taken out. No audio, no file paths.",
  },
  {
    flNotFound: "FL Studio n'a pas été trouvé dans ses dossiers d'installation habituels. Choisis-le avec Parcourir.",
    notConnected: "Pas connecté en ce moment (disque débranché, ou dossier déplacé ou renommé)",
    notConnectedShort: "Pas connecté",
    needPaths: "Indique d'abord le chemin de FL Studio et le dossier d'export.",
    needFlp: "Le rendu test a besoin d'un projet FL Studio (.flp). Aucun trouvé dans tes dossiers reliés.",
    renderFailed: "Échec du rendu",
    sampleData: "Données d'exemple",
    sampleDataHint: "Vois le tableau de bord et la bibliothèque remplis de projets générés — pas besoin de vrai dossier.",
    exitSample: "Quitter les données d'exemple",
    loadSample: "Charger les données d'exemple",
    projectFolders: "Dossiers de projets",
    projectFoldersHint:
      "Hivo fouille ces dossiers (et leurs sous-dossiers) pour trouver les projets FL Studio, Ableton Live, REAPER, Studio One, Pro Tools, Cubase et Bitwig.",
    addFolder: "Ajouter un dossier de projets",
    detectTitle: "Détecter les DAW",
    detectHint:
      "Le dossier de projets par défaut de chaque DAW trouvé sur cet ordi (FL Studio, Studio One, REAPER, Ableton Live, Cubase, Bitwig, Pro Tools). Rien n'est ajouté tant que tu ne cliques pas sur Relier.",
    flExe: "Exécutable FL Studio",
    flExeHint: "Sert à lancer le rendu en ligne de commande de FL Studio pour l'export groupé.",
    notSet: "Non défini",
    detecting: "Détection...",
    autoDetect: "Détecter",
    browse: "Parcourir",
    export: "Export",
    exportHint: "Où vont les mixdowns rendus, et dans quel format.",
    testRender: "Rendu test",
    testRenderHint:
      "Le rendu en ligne de commande de FL Studio est une fonction validée par la communauté mais peu documentée. Fais un rendu test sur un vrai projet avant de te fier à un gros export groupé.",
    macOnly:
      "Sur Mac, FL Studio ouvre sa fenêtre pendant le rendu (il peut afficher son écran d'accueil : laisse-le, ne choisis pas de projet) et se ferme tout seul quand le fichier est écrit (quelques minutes pour un long morceau). Quitte FL Studio avant de lancer. S'il reste ouvert sans faire le rendu, quitte-le : le rendu abandonne au bout de 15 minutes.",
    rendering: "Rendu en cours...",
    renderRecent: "Faire le rendu du projet le plus récent",
    demoDisabled: "Désactivé avec les données d'exemple — relie d'abord un vrai dossier.",
    success: (path: string) => `C'est bon — fichier enregistré dans ${path}`,
    shortsIntro: "Le Launch Kit fait les shorts 9:16 avec ffmpeg, gratuit et sur cet ordi. Installe-le une fois :",
    or: "ou",
    lookingFfmpeg: "Recherche de ffmpeg…",
    found: (path: string, encoder: string) => `Trouvé : ${path} (${encoder})`,
    ffmpegMissing: "Introuvable. Installe-le puis relance l'appli, ou choisis-le ci-dessous.",
    foundAuto: "Trouvé automatiquement",
    auto: "Auto",
    keySaved: "Clé enregistrée sur cet ordi.",
    keyRemoved: "Clé supprimée.",
    aiOff: "Désactivée : pas encore de clé",
    aiEnv: "Activée : utilise GEMINI_API_KEY de l'environnement",
    aiSaved: "Activée : clé enregistrée sur cet ordi",
    aiTitle: "IA (brouillons et vérifs du Launch Kit)",
    aiIntro: "Utilise Google Gemini en version gratuite. Récupère une clé gratuite sur",
    aiIntroEnd: ". Tout marche sans ; l'IA ajoute juste des brouillons et un deuxième avis.",
    newKey: "Colle une nouvelle clé pour la remplacer",
    pasteKey: "Colle ta clé API Gemini",
    save: "Enregistrer",
    remove: "Supprimer",
    model: "Modèle",
    captionLang: "Langue des textes (chaque Launch Kit peut la changer)",
    includeNotes: "Inclure les notes quand l'IA vérifie un kit",
    includeNotesHint: "Désactivé : tes notes restent sur cet ordi. Les brouillons ne les utilisent jamais.",
    keyStays:
      "La clé reste sur cet ordi (dans son propre fichier du dossier de config de l'appli, pas dans settings.json) et ne s'affiche plus jamais.",
    cfRemoved: "Identifiants Cloudflare supprimés.",
    cfSaved: "Enregistré sur cet ordi.",
    cfOff: "Désactivé : pas encore d'identifiants Cloudflare",
    cfEnv: "Activé : utilise CLOUDFLARE_ACCOUNT_ID et CLOUDFLARE_API_TOKEN de l'environnement",
    cfOn: "Activé : identifiants enregistrés sur cet ordi",
    coverTitle: "Cover (Cloudflare Workers AI, gratuit)",
    coverIntro:
      "Peint des idées de cover à partir du brief du Launch Kit avec FLUX.1 [schnell]. Le quota gratuit de Cloudflare (10 000 neurons par jour) donne environ 170 images par jour, sans carte bancaire. Sur la",
    coverLink: "page Workers AI du tableau de bord Cloudflare",
    coverPick: ", choisis",
    coverCopy: ", copie le champ",
    coverThen: ", puis",
    coverTokenNote: " (un token personnalisé doit avoir Workers AI Read et Edit).",
    accountId: "Account ID (32 caractères)",
    accountIdLabel: "ID de compte Cloudflare",
    tokenLabel: "Token API Cloudflare",
    newToken: "Colle un nouveau token pour le remplacer",
    apiToken: "Token API",
    coverPrivacy:
      "Les deux restent sur cet ordi (dans leur propre fichier, réservé à ton compte, du dossier de config de l'appli, pas dans settings.json) et ne s'affichent plus jamais. Seul le prompt de l'image est envoyé à Cloudflare. Il est construit à partir du concept, de l'imagerie, de la palette, des tags du brief de cover et de tout texte libre que tu y écris, sans le titre du son, les noms d'artistes ni la ligne Notes. Pas d'audio, pas de chemins de fichiers.",
  },
);

const IS_MAC = navigator.userAgent.includes("Mac");

const FORMATS: { id: RenderFormat; label: string }[] = [
  { id: "wav", label: "WAV" },
  { id: "mp3", label: "MP3" },
  { id: "ogg", label: "OGG" },
];

export function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const addWatchedFolder = useAppStore((s) => s.addWatchedFolder);
  const removeWatchedFolder = useAppStore((s) => s.removeWatchedFolder);
  const projects = useAppStore((s) => s.projects);
  const demoMode = useAppStore((s) => s.demoMode);
  const loadDemoData = useAppStore((s) => s.loadDemoData);
  const exitDemoMode = useAppStore((s) => s.exitDemoMode);
  const startRender = useAppStore((s) => s.startRender);
  const detectFlStudio = useAppStore((s) => s.detectFlStudio);
  const pickFlStudio = useAppStore((s) => s.pickFlStudio);
  const pickOutputFolder = useAppStore((s) => s.pickOutputFolder);
  const section = useAppStore((s) => s.settingsSection);
  const clearSettingsSection = useAppStore((s) => s.clearSettingsSection);
  const [detecting, setDetecting] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  // Each picker's error shows under its own control.
  const [flError, setFlError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const unreachable = useUnreachableFolders(settings.watchedFolders, settings.outputFolder);
  const [testState, setTestState] = useState<
    { status: "idle" } | { status: "running" } | { status: "done"; path: string } | { status: "error"; message: string }
  >({ status: "idle" });
  const t = tr(T);

  // Sent here for one section (setView("settings", id)): scroll to it once.
  useEffect(() => {
    if (!section) return;
    const el = document.getElementById(section);
    if (el) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
    clearSettingsSection();
  }, [section, clearSettingsSection]);

  async function handleAddFolder() {
    setFolderError(null);
    await addWatchedFolder().catch((e) => setFolderError(e instanceof Error ? e.message : String(e)));
  }

  async function handleRemoveFolder(folder: string) {
    setFolderError(null);
    await removeWatchedFolder(folder).catch((e) => setFolderError(e instanceof Error ? e.message : String(e)));
  }

  async function handleDetect() {
    setDetecting(true);
    setFlError(null);
    try {
      if (!(await detectFlStudio())) setFlError(tr(T).flNotFound);
    } catch (e) {
      setFlError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }

  // Pickers run in Rust, which checks the choice (FL Studio must be FL
  // Studio) before saving it.
  async function handleBrowseExecutable() {
    setFlError(null);
    await pickFlStudio().catch((e) => setFlError(e instanceof Error ? e.message : String(e)));
  }

  async function handleBrowseOutput() {
    setExportError(null);
    await pickOutputFolder().catch((e) => setExportError(e instanceof Error ? e.message : String(e)));
  }

  async function handleTestRender() {
    if (!settings.flStudioPath || !settings.outputFolder) {
      setTestState({
        status: "error",
        message: tr(T).needPaths,
      });
      return;
    }
    // The test drives FL Studio, so it needs an FL project, whatever else is linked.
    const sample = projects.find((p) => !p.isTemplate && canRenderInApp(p));
    if (!sample) {
      setTestState({
        status: "error",
        message: tr(T).needFlp,
      });
      return;
    }
    setTestState({ status: "running" });
    try {
      // Through the store, so the render panel and the "already rendering"
      // guard see it like any other export.
      await startRender([sample.path]);
      const job = useAppStore.getState().renderJobs.get(sample.path);
      if (job?.status === "done" && job.outputPath) {
        setTestState({ status: "done", path: job.outputPath });
      } else {
        setTestState({ status: "error", message: job?.message ?? tr(T).renderFailed });
      }
    } catch (e) {
      setTestState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        {/* Both languages on purpose: findable whichever one is showing. */}
        <section className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-cream">Language · Langue</h2>
            <p className="mt-0.5 text-xs text-engrave">The whole app, in English or French · Toute l'appli, en français ou en anglais</p>
          </div>
          <select
            value={settings.uiLanguage ?? "system"}
            onChange={(e) => updateSettings({ uiLanguage: e.target.value as "system" | "fr" | "en" })}
            aria-label="Language · Langue"
            className={`${field} !w-auto`}
          >
            <option value="system">System · Système</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </section>

        <UpdatesSection />

        <section className="flex items-center justify-between rounded-lg border border-rule bg-panel px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-cream">{t.sampleData}</h2>
            <p className="mt-0.5 text-xs text-engrave">{t.sampleDataHint}</p>
          </div>
          <button
            onClick={demoMode ? exitDemoMode : loadDemoData}
            className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium ${
              demoMode
                ? "border border-rule-strong text-body hover:bg-raised"
                : "bg-orange-500 text-chassis hover:bg-orange-400"
            }`}
          >
            {demoMode ? t.exitSample : t.loadSample}
          </button>
        </section>

        <section id="folders">
          <h2 className="text-sm font-semibold text-cream">{t.projectFolders}</h2>
          <p className="mt-1 text-xs text-engrave">{t.projectFoldersHint}</p>
          <div className="mt-3 flex flex-col gap-2">
            {settings.watchedFolders.map((folder) => (
              <div
                key={folder}
                className="flex items-center justify-between gap-2 rounded-md border border-rule bg-raised px-3 py-2 text-sm text-body"
              >
                <FolderName folder={folder} unreachable={unreachable.has(folder)} />
                <button
                  onClick={() => handleRemoveFolder(folder)}
                  className="shrink-0 rounded p-1 text-engrave hover:bg-rule hover:text-red-300"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              onClick={handleAddFolder}
              className="flex items-center justify-center gap-2 rounded-md border border-dashed border-rule-strong py-2.5 text-sm text-engrave hover:border-orange-400/40 hover:text-orange-300"
            >
              <FolderPlus size={15} />
              {t.addFolder}
            </button>
          </div>
          {folderError && <div className="mt-2 text-xs text-missing">{folderError}</div>}
        </section>

        <SampleFoldersSection />

        <BeatFoldersSection />

        <section>
          <h2 className="text-sm font-semibold text-cream">{t.detectTitle}</h2>
          <p className="mt-1 text-xs text-engrave">{t.detectHint}</p>
          <div className="mt-3">
            <DetectedFolders />
          </div>
        </section>

        <div id="crew">
          <CrewPanel />
        </div>

        <AiSettings />

        <ShortsSettings />

        <CoverSettings />

        <YoutubeSettings />
        <SpotifySettings />

        <DiggerSettings />

        <PhoneSyncSettings />

        <section id="fl">
          <h2 className="text-sm font-semibold text-cream">{t.flExe}</h2>
          <p className="mt-1 text-xs text-engrave">{t.flExeHint}</p>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={settings.flStudioPath ?? ""}
              placeholder={t.notSet}
              className="flex-1 truncate rounded-md border border-rule bg-raised px-3 py-2 text-sm text-body placeholder:text-engrave"
            />
            <button
              onClick={handleDetect}
              disabled={detecting}
              className="flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-sm text-body hover:bg-raised"
            >
              <Wand2 size={14} />
              {detecting ? t.detecting : t.autoDetect}
            </button>
            <button
              onClick={handleBrowseExecutable}
              className="flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-sm text-body hover:bg-raised"
            >
              <FileSearch size={14} />
              {t.browse}
            </button>
          </div>
          {flError && <div className="mt-2 text-xs text-missing">{flError}</div>}
        </section>

        <section id="export">
          <h2 className="text-sm font-semibold text-cream">{t.export}</h2>
          <p className="mt-1 text-xs text-engrave">{t.exportHint}</p>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={settings.outputFolder ?? ""}
              placeholder={t.notSet}
              className="flex-1 truncate rounded-md border border-rule bg-raised px-3 py-2 text-sm text-body placeholder:text-engrave"
            />
            <button
              onClick={handleBrowseOutput}
              className="flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-sm text-body hover:bg-raised"
            >
              <FileSearch size={14} />
              {t.browse}
            </button>
          </div>
          {settings.outputFolder && unreachable.has(settings.outputFolder) && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-warn">
              <StatusDot color="var(--color-warn)" size={6} />
              {t.notConnected}
            </div>
          )}
          {exportError && <div className="mt-2 text-xs text-missing">{exportError}</div>}

          <div className="mt-3 flex gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                onClick={() => updateSettings({ renderFormat: f.id })}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  settings.renderFormat === f.id
                    ? "border-orange-400/50 bg-orange-500/15 text-orange-300"
                    : "border-rule text-body hover:bg-raised"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-rule bg-panel p-4">
          <h2 className="text-sm font-semibold text-cream">{t.testRender}</h2>
          <p className="mt-1 text-xs text-engrave">{t.testRenderHint}</p>
          {IS_MAC && <p className="mt-1 text-xs text-amber-300/80">{t.macOnly}</p>}
          <button
            onClick={handleTestRender}
            disabled={testState.status === "running" || demoMode}
            className="mt-3 flex items-center gap-1.5 rounded-md bg-rule px-3 py-2 text-sm text-cream hover:bg-rule-strong disabled:opacity-50"
          >
            <PlayCircle size={15} />
            {testState.status === "running" ? t.rendering : t.renderRecent}
          </button>
          {demoMode && <div className="mt-2 text-xs text-engrave">{t.demoDisabled}</div>}
          {testState.status === "done" && <div className="mt-2 text-xs text-emerald-400">{t.success(testState.path)}</div>}
          {testState.status === "error" && (
            <div className="mt-2 text-xs text-red-300">{testState.message}</div>
          )}
        </section>
      </div>
    </div>
  );
}

/** ffmpeg for the Launch Kit's 9:16 shorts: found automatically, or set here. */
function ShortsSettings() {
  const settings = useAppStore((s) => s.settings);
  const pickFfmpeg = useAppStore((s) => s.pickFfmpeg);
  const clearPathSetting = useAppStore((s) => s.clearPathSetting);
  const [status, setStatus] = useState<api.ShortsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.shortsStatus().then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [settings.ffmpegPath]);

  async function browse() {
    setError(null);
    await pickFfmpeg().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }
  const t = tr(T);

  return (
    <section id="ffmpeg">
      <h2 className="text-sm font-semibold text-cream">Shorts (ffmpeg)</h2>
      <p className="mt-1 text-xs text-engrave">
        {t.shortsIntro}{" "}
        <code className="rounded bg-rule px-1">brew install ffmpeg</code> (Mac) {t.or}{" "}
        <code className="rounded bg-rule px-1">winget install Gyan.FFmpeg</code> (Windows).
      </p>
      <div className={`mt-3 text-xs ${status?.encoder ? "text-emerald-300" : "text-engrave"}`}>
        {!status
          ? t.lookingFfmpeg
          : status.encoder
            ? t.found(status.path ?? "", status.encoder)
            : status.error ?? t.ffmpegMissing}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input value={settings.ffmpegPath ?? ""} readOnly placeholder={t.foundAuto} aria-label="ffmpeg" className={field} />
        <button onClick={browse} className="shrink-0 rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
          {t.browse}
        </button>
        {settings.ffmpegPath && (
          <button onClick={() => void clearPathSetting("ffmpeg")} className="shrink-0 rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
            {t.auto}
          </button>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
    </section>
  );
}

/** The saved folders (any of `folders`) that can't be reached right now,
 * asked from Rust each time the list changes. Empty in a browser tab. */
function useUnreachableFolders(...folders: (string[] | string | null | undefined)[]): Set<string> {
  const key = folders.flat().filter(Boolean).join("\n");
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    api
      .unreachableSettingFolders()
      .then((list) => live && setMissing(new Set(list)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return missing;
}

/** A saved folder's path, with a warning LED when it can't be reached. */
function FolderName({ folder, unreachable }: { folder: string; unreachable: boolean }) {
  const t = tr(T);
  return (
    <span className="flex min-w-0 items-center gap-2" title={unreachable ? `${folder} · ${t.notConnected}` : folder}>
      {unreachable && <StatusDot color="var(--color-warn)" size={6} />}
      <span className="truncate">{folder}</span>
      {unreachable && <span className="shrink-0 text-[11px] text-warn">{t.notConnectedShort}</span>}
    </span>
  );
}

const field =
  "w-full rounded-md border border-rule bg-raised px-3 py-2 text-sm text-cream placeholder:text-engrave focus:border-orange-400/50 focus:outline-none";

/** Gemini key (write-only from here), model and copy language. */
function AiSettings() {
  const aiStatus = useAppStore((s) => s.aiStatus);
  const refreshAiStatus = useAppStore((s) => s.refreshAiStatus);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const t = tr(T);

  async function saveKey(value: string | null) {
    setMessage(null);
    try {
      await api.setAiKey(value);
      await refreshAiStatus();
      setKey("");
      setMessage({ kind: "ok", text: value ? t.keySaved : t.keyRemoved });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const status = !aiStatus?.configured ? t.aiOff : aiStatus.source === "env" ? t.aiEnv : t.aiSaved;

  return (
    <section id="ai">
      <h2 className="text-sm font-semibold text-cream">{t.aiTitle}</h2>
      <p className="mt-1 text-xs text-engrave">
        {t.aiIntro}{" "}
        <button onClick={() => api.openExternal("https://aistudio.google.com/apikey")} className="text-orange-300 underline">
          aistudio.google.com/apikey
        </button>
        {t.aiIntroEnd}
      </p>
      <div className={`mt-3 text-xs ${aiStatus?.configured ? "text-emerald-300" : "text-engrave"}`}>{status}</div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={aiStatus?.configured ? t.newKey : t.pasteKey}
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
        <button onClick={() => saveKey(key)} disabled={!key.trim()} className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40">
          {t.save}
        </button>
        {aiStatus?.source === "settings" && (
          <button onClick={() => saveKey(null)} className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
            {t.remove}
          </button>
        )}
      </div>
      {message && <div className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</div>}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs text-engrave">
          {t.model}
          <input
            defaultValue={settings.aiModel ?? ""}
            onBlur={(e) => updateSettings({ aiModel: e.target.value.trim() || null })}
            placeholder={aiStatus?.defaultModel ?? "gemini-3.8-flash"}
            className={`${field} mt-1`}
          />
        </label>
        <label className="text-xs text-engrave">
          {t.captionLang}
          <select
            value={settings.captionLanguage ?? "fr"}
            onChange={(e) => updateSettings({ captionLanguage: e.target.value as CaptionLang })}
            className={`${field} mt-1`}
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-body">
        <input
          type="checkbox"
          checked={!!settings.aiIncludeNotes}
          onChange={(e) => updateSettings({ aiIncludeNotes: e.target.checked })}
          className="mt-0.5 accent-orange-500"
        />
        <span>
          {t.includeNotes}
          <span className="block text-[11px] text-engrave">{t.includeNotesHint}</span>
        </span>
      </label>
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">
        {t.keyStays}{" "}
        {aiDisclosure(!!settings.aiIncludeNotes)}
      </p>
    </section>
  );
}

/** Where the Workers AI page offers "Use REST API": account ID + token template. */
const CF_WORKERS_AI_URL = "https://dash.cloudflare.com/?to=/:account/ai/workers-ai";

/** Cloudflare account ID + API token for FLUX cover concepts (write-only). */
function CoverSettings() {
  const coverStatus = useAppStore((s) => s.coverStatus);
  const refreshCoverStatus = useAppStore((s) => s.refreshCoverStatus);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const t = tr(T);

  async function save(remove: boolean) {
    setMessage(null);
    try {
      await api.setCoverCredentials(remove ? null : accountId, remove ? null : token);
      await refreshCoverStatus();
      setAccountId("");
      setToken("");
      setMessage({ kind: "ok", text: remove ? t.cfRemoved : t.cfSaved });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const status = !coverStatus?.configured ? t.cfOff : coverStatus.source === "env" ? t.cfEnv : t.cfOn;

  // Use REST API, Account ID and Create a Workers AI API Token are the
  // dashboard's own (English) labels.
  return (
    <section id="cover">
      <h2 className="text-sm font-semibold text-cream">{t.coverTitle}</h2>
      <p className="mt-1 text-xs leading-relaxed text-engrave">
        {t.coverIntro}{" "}
        <button onClick={() => api.openExternal(CF_WORKERS_AI_URL)} className="text-orange-300 underline">
          {t.coverLink}
        </button>
        {t.coverPick} <span className="text-body">Use REST API</span>
        {t.coverCopy} <span className="text-body">Account ID</span>
        {t.coverThen} <span className="text-body">Create a Workers AI API Token</span>
        {t.coverTokenNote}
      </p>
      <div className={`mt-3 text-xs ${coverStatus?.configured ? "text-emerald-300" : "text-engrave"}`}>{status}</div>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
        <input
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder={t.accountId}
          aria-label={t.accountIdLabel}
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={coverStatus?.configured ? t.newToken : t.apiToken}
          aria-label={t.tokenLabel}
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
        <div className="flex gap-2">
          <button
            onClick={() => save(false)}
            disabled={!accountId.trim() || !token.trim()}
            className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40"
          >
            {t.save}
          </button>
          {coverStatus?.source === "settings" && (
            <button onClick={() => save(true)} className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
              {t.remove}
            </button>
          )}
        </div>
      </div>
      {message && <div className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</div>}
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">{t.coverPrivacy}</p>
    </section>
  );
}

const T_YT = dict(
  {
    title: "YouTube search (Digger, free)",
    intro:
      "Shows YouTube results inside the Digger. The free quota is about 100 searches a day (repeat searches are remembered for a few hours). In the",
    link: "Google Cloud console",
    steps: ", turn on YouTube Data API v3, then create an API key under Credentials. Without a key, the Digger still opens YouTube searches in your browser.",
    off: "No key: searches open in your browser.",
    env: "Using YOUTUBE_API_KEY from the environment.",
    on: "Key saved. Results show inside the Digger.",
    paste: "Paste a YouTube Data API key",
    newKey: "Paste a new key to replace it",
    label: "YouTube API key",
    save: "Save",
    remove: "Remove",
    saved: "Key saved.",
    removed: "Key removed.",
    privacy:
      "The key stays on this computer (its own owner-only file in the app config folder, not settings.json) and is never shown again. Only the search words go to YouTube. Nothing is ever downloaded.",
  },
  {
    title: "Recherche YouTube (Digger, gratuit)",
    intro:
      "Affiche les résultats YouTube dans le Digger. Le quota gratuit permet environ 100 recherches par jour (une même recherche est gardée en mémoire quelques heures). Dans la",
    link: "console Google Cloud",
    steps: ", active YouTube Data API v3, puis crée une clé API dans Credentials. Sans clé, le Digger ouvre quand même les recherches YouTube dans ton navigateur.",
    off: "Pas de clé : les recherches s'ouvrent dans ton navigateur.",
    env: "Utilise YOUTUBE_API_KEY de l'environnement.",
    on: "Clé enregistrée. Les résultats s'affichent dans le Digger.",
    paste: "Colle une clé YouTube Data API",
    newKey: "Colle une nouvelle clé pour la remplacer",
    label: "Clé API YouTube",
    save: "Enregistrer",
    remove: "Retirer",
    saved: "Clé enregistrée.",
    removed: "Clé retirée.",
    privacy:
      "La clé reste sur cet ordi (dans son propre fichier, réservé à ton compte, du dossier de config de l'appli, pas dans settings.json) et ne s'affiche plus jamais. Seuls les mots de la recherche partent vers YouTube. Rien n'est jamais téléchargé.",
  },
);

const YT_CONSOLE_URL = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";

/** YouTube Data API key for the Digger's search (write-only from here). */
function YoutubeSettings() {
  const [status, setStatus] = useState<YoutubeStatus | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const t = tr(T_YT);

  useEffect(() => {
    let live = true;
    api.youtubeStatus().then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function save(value: string | null) {
    setMessage(null);
    try {
      await api.setYoutubeKey(value);
      setStatus(await api.youtubeStatus());
      setKey("");
      setMessage({ kind: "ok", text: value ? t.saved : t.removed });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const line = !status?.configured ? t.off : status.source === "env" ? t.env : t.on;

  return (
    <section id="youtube">
      <h2 className="text-sm font-semibold text-cream">{t.title}</h2>
      <p className="mt-1 text-xs leading-relaxed text-engrave">
        {t.intro}{" "}
        <button onClick={() => api.openExternal(YT_CONSOLE_URL)} className="text-orange-300 underline">
          {t.link}
        </button>
        {t.steps}
      </p>
      <div className={`mt-3 text-xs ${status?.configured ? "text-emerald-300" : "text-engrave"}`}>{line}</div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={status?.configured ? t.newKey : t.paste}
          aria-label={t.label}
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
        <button onClick={() => save(key)} disabled={!key.trim()} className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40">
          {t.save}
        </button>
        {status?.source === "settings" && (
          <button onClick={() => save(null)} className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
            {t.remove}
          </button>
        )}
      </div>
      {message && <div className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</div>}
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">{t.privacy}</p>
    </section>
  );
}

const T_SPOTIFY = dict(
  {
    title: "Spotify (People, free)",
    intro: "Lets \"Look up profiles\" on a person search Spotify directly (small artists are there long before MusicBrainz) and fetch the artist picture; followers and popularity come too when Spotify shares them with your app (newer apps in development mode don't get them). Without credentials, the Spotify artist ID still comes from MusicBrainz when it has the link. In the",
    link: "Spotify developer dashboard",
    steps: ", create an app (any name, redirect URI unused) and copy its Client ID and Client secret.",
    off: "No credentials: MusicBrainz only.",
    env: "Using SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET from the environment.",
    on: "Credentials saved. Lookups search Spotify too.",
    clientId: "Client ID",
    clientSecret: "Client secret",
    newPair: "Paste a new pair to replace it",
    save: "Save",
    remove: "Remove",
    saved: "Credentials saved.",
    removed: "Credentials removed.",
    privacy:
      "Stored on this computer in their own owner-only file, never shown again. Only the artist name searched goes to Spotify. Nothing is written to your Spotify account.",
  },
  {
    title: "Spotify (Personnes, gratuit)",
    intro: "Permet à « Chercher les profils » sur une personne de chercher directement sur Spotify (les petits artistes y sont bien avant MusicBrainz) et de récupérer la photo d'artiste ; abonnés et popularité viennent aussi quand Spotify les partage avec ton appli (les applis récentes en mode développement ne les ont pas). Sans identifiants, l'ID artiste Spotify vient quand même de MusicBrainz quand il a le lien. Dans le",
    link: "tableau de bord développeur Spotify",
    steps: ", crée une appli (n'importe quel nom, l'URI de redirection ne sert pas) et copie son Client ID et son Client secret.",
    off: "Pas d'identifiants : MusicBrainz seulement.",
    env: "Utilise SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET de l'environnement.",
    on: "Identifiants enregistrés. Les recherches passent aussi par Spotify.",
    clientId: "Client ID",
    clientSecret: "Client secret",
    newPair: "Colle une nouvelle paire pour la remplacer",
    save: "Enregistrer",
    remove: "Retirer",
    saved: "Identifiants enregistrés.",
    removed: "Identifiants retirés.",
    privacy:
      "Gardés sur cet ordi dans leur propre fichier réservé à ton compte, jamais réaffichés. Seul le nom d'artiste cherché part vers Spotify. Rien n'est écrit sur ton compte Spotify.",
  },
);

const SPOTIFY_DASHBOARD_URL = "https://developer.spotify.com/dashboard";

/** Spotify app credentials for People lookups (write-only from here). */
function SpotifySettings() {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const t = tr(T_SPOTIFY);

  useEffect(() => {
    let live = true;
    api.spotifyStatus().then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function save(clear: boolean) {
    setMessage(null);
    try {
      await api.setSpotifyCredentials(clear ? null : clientId, clear ? null : secret);
      setStatus(await api.spotifyStatus());
      setClientId("");
      setSecret("");
      setMessage({ kind: "ok", text: clear ? t.removed : t.saved });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  const line = !status?.configured ? t.off : status.source === "env" ? t.env : t.on;

  return (
    <section id="spotify">
      <h2 className="text-sm font-semibold text-cream">{t.title}</h2>
      <p className="mt-1 text-xs leading-relaxed text-engrave">
        {t.intro}{" "}
        <button onClick={() => api.openExternal(SPOTIFY_DASHBOARD_URL)} className="text-orange-300 underline">
          {t.link}
        </button>
        {t.steps}
      </p>
      <div className={`mt-3 text-xs ${status?.configured ? "text-emerald-300" : "text-engrave"}`}>{line}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={status?.configured ? t.newPair : t.clientId}
          aria-label={t.clientId}
          autoComplete="off"
          spellCheck={false}
          className={`${field} min-w-[200px] flex-1`}
        />
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t.clientSecret}
          aria-label={t.clientSecret}
          autoComplete="off"
          spellCheck={false}
          className={`${field} min-w-[200px] flex-1`}
        />
        <button onClick={() => save(false)} disabled={!clientId.trim() || !secret.trim()} className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40">
          {t.save}
        </button>
        {status?.source === "settings" && (
          <button onClick={() => save(true)} className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
            {t.remove}
          </button>
        )}
      </div>
      {message && <div className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</div>}
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">{t.privacy}</p>
    </section>
  );
}

const T_DIGGER = dict(
  {
    title: "Digger",
    converter: "Converter link (opens in your browser)",
    placeholder: "https://example.com/convert?u={url}",
    save: "Save",
    remove: "Remove",
    saved: "Link saved. Each YouTube result in the Digger gets a Convert button, with the video address pre-filled.",
    savedPaste: "Link saved. Each YouTube result in the Digger gets a Convert button; Hivo opens the page and copies the video address for you to paste.",
    recognizedExample: "Video link found inside the address and replaced by {url}: the address will be pre-filled on the site.",
    recognizedKnown: (site: string) => `${site} recognized: its link format is known, the video address will be pre-filled.`,
    knownPaste: (site: string) => `${site} recognized: no pre-fill format is known for it, so Hivo opens the page and copies the video address for you to paste.`,
    removed: "Link removed.",
    howTo:
      "The converter page's address. Hivo can't type into another site's page, so the video address is pre-filled only when the site reads it from its own link. Easiest: paste a video link on the site once, then copy the browser's address bar here; if the video link is in it, Hivo swaps it for {url} itself. Otherwise Hivo opens the page and copies the video address for you to paste.",
    disclosure:
      "Hivo opens this link with the video address and nothing else. The site, its terms and what you do with the file are between you and it; Hivo never downloads audio.",
  },
  {
    title: "Digger",
    converter: "Lien de conversion (s'ouvre dans ton navigateur)",
    placeholder: "https://example.com/convert?u={url}",
    save: "Enregistrer",
    remove: "Retirer",
    saved: "Lien enregistré. Chaque résultat YouTube du Digger a un bouton Convertir, avec l'adresse de la vidéo pré-remplie.",
    savedPaste: "Lien enregistré. Chaque résultat YouTube du Digger a un bouton Convertir ; Hivo ouvre la page et copie l'adresse de la vidéo pour que tu la colles.",
    recognizedExample: "Lien de vidéo trouvé dans l'adresse et remplacé par {url} : l'adresse sera pré-remplie sur le site.",
    recognizedKnown: (site: string) => `${site} reconnu : son format de lien est connu, l'adresse de la vidéo sera pré-remplie.`,
    knownPaste: (site: string) => `${site} reconnu : aucun format de pré-remplissage connu pour lui, donc Hivo ouvre la page et copie l'adresse de la vidéo pour que tu la colles.`,
    removed: "Lien retiré.",
    howTo:
      "L'adresse de la page de conversion. Hivo ne peut pas écrire dans la page d'un autre site : l'adresse de la vidéo n'est pré-remplie que si le site la lit dans son propre lien. Le plus simple : colle un lien de vidéo sur le site une fois, puis copie ici la barre d'adresse du navigateur ; si le lien de la vidéo s'y trouve, Hivo le remplace par {url} tout seul. Sinon Hivo ouvre la page et copie l'adresse de la vidéo pour que tu la colles.",
    disclosure:
      "Hivo ouvre ce lien avec l'adresse de la vidéo et rien d'autre. Le site, ses conditions et ce que tu fais du fichier, c'est entre toi et lui ; Hivo ne télécharge jamais d'audio.",
  },
);

/** Same limit as `MAX_CONVERTER_CHARS` in src-tauri/src/settings.rs. */
const MAX_CONVERTER_CHARS = 300;

/** The Digger's converter link: a user-provided https url with `{url}`
 * where the video address goes. Checked in Rust (cleared when unusable). */
function DiggerSettings() {
  const saved = useAppStore((s) => s.settings.converterUrlTemplate ?? "");
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [value, setValue] = useState(saved);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const t = tr(T_DIGGER);

  useEffect(() => {
    setValue(saved);
  }, [saved]);

  async function save(next: string | null) {
    setMessage(null);
    // An example address (with a video link inside) or a known site's home
    // page becomes the {url} template; anything else is saved as typed.
    const raw = next?.trim() ?? "";
    const pick = raw ? converterTemplateFor(raw) : null;
    const template = pick?.template ?? "";
    try {
      await updateSettings({ converterUrlTemplate: template || undefined }, { report: false });
      const text = !template
        ? t.removed
        : pick?.recognized === "example"
          ? t.recognizedExample
          : pick?.recognized === "known" && pick.site
            ? t.recognizedKnown(pick.site.name)
            : pick?.site && !template.includes("{url}")
              ? t.knownPaste(pick.site.name)
              : template.includes("{url}")
                ? t.saved
                : t.savedPaste;
      setMessage({ kind: "ok", text });
    } catch (e) {
      // Rust cleared it: keep the store in step, then say why.
      await updateSettings({ converterUrlTemplate: undefined }).catch(() => {});
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <section id="digger">
      <h2 className="text-sm font-semibold text-cream">{t.title}</h2>
      <label className="mt-3 block text-xs text-body" htmlFor="converter-link">
        {t.converter}
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-engrave">{t.howTo}</p>
      <form
        className="mt-1 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value);
        }}
      >
        <input
          id="converter-link"
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t.placeholder}
          maxLength={MAX_CONVERTER_CHARS}
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
        <button type="submit" disabled={value.trim() === saved} className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40">
          {t.save}
        </button>
        {saved && (
          <button type="button" onClick={() => void save(null)} className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised">
            {t.remove}
          </button>
        )}
      </form>
      {message && <div className={`mt-2 text-xs ${message.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{message.text}</div>}
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">{t.disclosure}</p>
    </section>
  );
}

const T_BEATS = dict(
  {
    title: "Beats folders",
    hint: "Raw beats (mp3, wav… often downloaded from YouTube), no vocals on top. They only show up in the Digger, never in your songs, stats or the crew.",
    add: "Add a beats folder",
    remove: (f: string) => `Remove ${f}`,
  },
  {
    title: "Dossiers de prods",
    hint: "Des prods brutes (mp3, wav… souvent récupérées sur YouTube), sans voix dessus. Elles n'apparaissent que dans le Digger, jamais dans tes sons, tes stats ni le crew.",
    add: "Ajouter un dossier de prods",
    remove: (f: string) => `Retirer ${f}`,
  },
);

/** Beats folders (the Digger's source), next to the project folders. */
function BeatFoldersSection() {
  const folders = useAppStore((s) => s.settings.beatFolders ?? NO_FOLDERS);
  const add = useAppStore((s) => s.addBeatFolder);
  const remove = useAppStore((s) => s.removeBeatFolder);
  const [error, setError] = useState<string | null>(null);
  const t = tr(T_BEATS);
  const unreachable = useUnreachableFolders(folders);

  function run(action: Promise<void>) {
    setError(null);
    void action.catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  return (
    <section id="beats">
      <h2 className="text-sm font-semibold text-cream">{t.title}</h2>
      <p className="mt-1 text-xs text-engrave">{t.hint}</p>
      <div className="mt-3 flex flex-col gap-2">
        {folders.map((folder) => (
          <div key={folder} className="flex items-center justify-between gap-2 rounded-md border border-rule bg-raised px-3 py-2 text-sm text-body">
            <FolderName folder={folder} unreachable={unreachable.has(folder)} />
            <button onClick={() => run(remove(folder))} aria-label={t.remove(folder)} className="shrink-0 rounded p-1 text-engrave hover:bg-rule hover:text-red-300">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          onClick={() => run(add())}
          className="flex items-center justify-center gap-2 rounded-md border border-dashed border-rule-strong py-2.5 text-sm text-engrave hover:border-orange-400/40 hover:text-orange-300"
        >
          <FolderPlus size={15} />
          {t.add}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-missing">{error}</div>}
    </section>
  );
}

const T_SAMPLES = dict(
  {
    title: "Sample libraries",
    hint: "Where your packs and samples live on this computer (a Splice folder, a Packs drive…). A project saved on another computer stores its own paths; a sample with the same file name found in here counts as moved instead of missing. Nothing in these folders is listed or played.",
    add: "Add a sample library",
    remove: (f: string) => `Remove ${f}`,
  },
  {
    title: "Banques de samples",
    hint: "Là où tes packs et samples sont rangés sur cet ordi (un dossier Splice, un disque de packs…). Un projet sauvé sur un autre ordi garde ses propres chemins ; un sample du même nom trouvé ici compte comme déplacé plutôt que manquant. Rien dans ces dossiers n'est listé ni joué.",
    add: "Ajouter une banque de samples",
    remove: (f: string) => `Retirer ${f}`,
  },
);

/** Sample libraries: where the scanner looks up samples a project stores
 * under another path. Adding or removing one rescans. */
function SampleFoldersSection() {
  const folders = useAppStore((s) => s.settings.sampleFolders ?? NO_FOLDERS);
  const add = useAppStore((s) => s.addSampleFolder);
  const remove = useAppStore((s) => s.removeSampleFolder);
  const [error, setError] = useState<string | null>(null);
  const t = tr(T_SAMPLES);
  const unreachable = useUnreachableFolders(folders);

  function run(action: Promise<void>) {
    setError(null);
    void action.catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  return (
    <section id="samples">
      <h2 className="text-sm font-semibold text-cream">{t.title}</h2>
      <p className="mt-1 text-xs text-engrave">{t.hint}</p>
      <div className="mt-3 flex flex-col gap-2">
        {folders.map((folder) => (
          <div key={folder} className="flex items-center justify-between gap-2 rounded-md border border-rule bg-raised px-3 py-2 text-sm text-body">
            <FolderName folder={folder} unreachable={unreachable.has(folder)} />
            <button onClick={() => run(remove(folder))} aria-label={t.remove(folder)} className="shrink-0 rounded p-1 text-engrave hover:bg-rule hover:text-red-300">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          onClick={() => run(add())}
          className="flex items-center justify-center gap-2 rounded-md border border-dashed border-rule-strong py-2.5 text-sm text-engrave hover:border-orange-400/40 hover:text-orange-300"
        >
          <FolderPlus size={15} />
          {t.add}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-missing">{error}</div>}
    </section>
  );
}

const T_UPDATES = dict(
  {
    hint: "Checked at launch, then once a day while Hivo stays open. An update downloads, installs and restarts the app in one click.",
    offline: "Couldn't reach the update server. Check your internet connection and try again.",
    failed: "The update didn't go through. Try again later.",
    check: "Check for updates",
    checking: "Checking…",
    upToDate: "You're up to date.",
    available: (v: string) => `Hivo ${v} is available.`,
    install: "Update and restart",
    downloading: (pct: number | null) => `Downloading…${pct === null ? "" : ` ${pct}%`}`,
    restarting: "Installed, restarting…",
    devBuild: "Development build: updates are off here. Install a release to test them.",
    readOnly: "Hivo is running from a read-only place (the disk image, or the copy macOS makes of a downloaded app). Move it to Applications with Finder, open it from there, and try again.",
  },
  {
    hint: "Vérifié au lancement, puis une fois par jour tant que Hivo reste ouvert. Une mise à jour se télécharge, s'installe et relance l'appli en un clic.",
    offline: "Impossible de joindre le serveur de mises à jour. Vérifie ta connexion internet et réessaie.",
    failed: "La mise à jour n'est pas passée. Réessaie plus tard.",
    devBuild: "Version de développement : les mises à jour sont désactivées ici. Installe une release pour les tester.",
    readOnly: "Hivo tourne depuis un emplacement en lecture seule (l'image disque, ou la copie que macOS fait d'une appli téléchargée). Déplace-le dans Applications avec le Finder, ouvre-le de là et réessaie.",
    check: "Vérifier les mises à jour",
    checking: "Vérification…",
    upToDate: "Tu as la dernière version.",
    available: (v: string) => `Hivo ${v} est disponible.`,
    install: "Mettre à jour et redémarrer",
    downloading: (pct: number | null) => `Téléchargement…${pct === null ? "" : ` ${pct} %`}`,
    restarting: "Installé, redémarrage…",
  },
);

/** The running version and a manual update check (the store owns the state,
 * so the strip in App.tsx and this line never disagree). */
function UpdatesSection() {
  const update = useAppStore((s) => s.update);
  const checkUpdate = useAppStore((s) => s.checkUpdate);
  const installUpdate = useAppStore((s) => s.installUpdate);
  const [version, setVersion] = useState<string | null>(null);
  // Nothing to say before the first click (the startup check is silent).
  const [checked, setChecked] = useState(false);
  const t = tr(T_UPDATES);

  useEffect(() => {
    let live = true;
    // A browser tab has no app version to show.
    getVersion().then((v) => live && setVersion(v)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function check() {
    await checkUpdate();
    setChecked(true);
  }

  const { status } = update;
  const pct = update.progress === undefined ? null : Math.round(update.progress * 100);
  const line =
    status === "available" && update.version
      ? t.available(update.version)
      : status === "downloading"
        ? t.downloading(pct)
        : status === "ready"
          ? t.restarting
          : status === "error"
            ? { readOnly: t.readOnly, network: t.offline, other: t.failed }[updateErrorKind(update.error)]
            : checked && status === "idle"
              ? t.upToDate
              : null;

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-cream">Hivo{version ? ` ${version}` : ""}</h2>
          <p className="mt-0.5 text-xs text-engrave">{UPDATES_ENABLED ? t.hint : t.devBuild}</p>
        </div>
        <button
          onClick={() => void check()}
          disabled={!UPDATES_ENABLED || status === "checking" || status === "downloading" || status === "ready"}
          className="shrink-0 rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "checking" ? t.checking : t.check}
        </button>
      </div>
      {line !== null && (
        <div className="mt-2 flex items-center gap-3 text-xs">
          <span className={status === "error" ? "text-red-300" : status === "available" ? "text-cream" : "text-emerald-300"} title={status === "error" ? update.error : undefined}>{line}</span>
          {status === "available" && (
            <button
              onClick={() => void installUpdate()}
              className="shrink-0 rounded-md border border-rule-strong px-3 py-1.5 text-xs text-cream hover:bg-raised"
            >
              {t.install}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

