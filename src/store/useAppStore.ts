import { create } from "zustand";
import { dict, tr } from "../i18n";
import * as api from "../lib/tauri";
import * as updater from "../lib/updater";
import { generateSampleProjects, generateSampleWorkspace } from "../lib/sampleData";
import { ALBUM_COLORS, EMPTY_WORKSPACE, migrateWorkspace, newId, newerWorkspaceVersion } from "../lib/songs";
import { logStageChanges } from "../lib/stageLog";
import { addColumn, moveCard, moveColumn, removeColumn, renameColumn } from "../lib/pipeline";
import type { DashboardLayout } from "../lib/dashboardLayout";
import { applyRelinks, findRelinks, isUnder, rootRelinks, type Relink } from "../lib/relink";
import { setNote } from "../lib/notes";
import { relinkBeatNotes } from "../lib/digger";
import { canRenderInApp, dawOf, splitRenderable } from "../lib/daws";
import type {
  DetectedFolder,
  CaptionLang,
  FiledSketch,
  PackagePlan,
  PackageResult,
  Person,
  Pitch,
  Album,
  ProjectInfo,
  RenderEvent,
  RenderStatus,
  Settings,
  SongMeta,
  AiStatus,
  CoverStatus,
  KitCoverMeta,
  KitAiMeta,
  LaunchKitMeta,
  KitFieldId,
  SongStatus,
  Workspace,
} from "../types";

import type { FeedbackDraft } from "../lib/feedback";

const DEFAULT_SETTINGS: Settings = {
  watchedFolders: [],
  flStudioPath: null,
  outputFolder: null,
  renderFormat: "wav",
  favorites: [],
  aiModel: null,
  aiLanguage: null,
  aiIncludeNotes: false,
  captionLanguage: "fr",
  uiLanguage: "system",
  ffmpegPath: null,
};

export type View =
  | "dashboard"
  | "library"
  | "pipeline"
  | "albums"
  | "people"
  | "launch"
  | "calendar"
  | "settings"
  // The crew section of the menu (CrewSection).
  // Raw beats + finding similar ones (DiggerView).
  | "digger"
  // Ideas, memos and BandLab exports from the phone (InboxView).
  | "inbox"
  | "crewBoard"
  | "crewReleases"
  | "crewMembers"
  | "crewSettings";
export type SortKey = "modified" | "name" | "status" | "tempo" | "key" | "versions";
export type SortDir = "asc" | "desc";
/** "unsorted" = songs with no status yet. */
export type StatusFilter = SongStatus | "unsorted" | null;

export interface RenderJob {
  status: RenderStatus;
  message: string | null;
  outputPath: string | null;
}

interface RenderOptions {
  /** Render into `<output folder>/<subfolder>` (album exports). */
  subfolder?: string;
  /** Output file names, aligned with the paths ("01 - Envy"). */
  names?: string[];
}

interface NewProjectDraft {
  albumId: string | null;
  status: SongStatus;
}

/** In-app updates (src/lib/updater.ts): one check at startup, then Settings. */
export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  /** The newer version found; stays set through download and install errors. */
  version?: string;
  /** 0..1 while downloading, when the server said how big the file is. */
  progress?: number;
  error?: string;
  /** The install was stopped because the workspace couldn't be saved first. */
  blockedBySave?: boolean;
}

/** Why the workspace is read-only (the strip above the view). */
export type WorkspaceIssue =
  /** workspace.json couldn't be read or parsed. `canReset`: it reads but
   * doesn't parse, so Start fresh / Restore may set it aside; false = it
   * can't be read at all (it may be fine): only Retry. */
  | { kind: "unreadable"; detail: string; hasBackup: boolean; canReset: boolean }
  /** A newer Hivo saved it: shown, never saved over by this version. */
  | { kind: "newer"; version: number };

/** How often a running app looks for an update again (the first look is at launch). */
export const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

interface AppState {
  view: View;
  settings: Settings;
  settingsLoaded: boolean;
  /** Settings couldn't be read (or were reset) at launch. */
  startupError: string | null;
  /** The last scan failed (cleared by the next one that works). */
  scanError: string | null;
  /** An action failed (a render, a settings save…); never overwrites the others. */
  actionError: string | null;
  /** The last workspace save failed: the banner's message (Dismiss clears it). */
  saveError: string | null;
  /** Edits not on disk since the last good save: why the last save failed.
   * Only a save that works clears it (never Dismiss), so the "not saving"
   * strip and the close / update guards keep holding. */
  unsavedChanges: string | null;
  dismissErrors: () => void;
  /** Try the failed save (or the failed workspace read) again. */
  retrySave: () => Promise<void>;
  /** Why the workspace is read-only, with what the strip can offer. */
  workspaceIssue: WorkspaceIssue | null;
  /** Unreadable workspace: put `workspace.json.bak` back. */
  restoreWorkspaceBackup: () => Promise<void>;
  /** Unreadable workspace: keep it as `workspace.json.bad-<ms>` and save what's in
   * memory (an empty workspace plus the edits made since) from now on. */
  startFreshWorkspace: () => Promise<void>;
  showConfigFolder: () => Promise<void>;
  /** DAW default folders found on this computer; null = not looked yet. */
  detectedFolders: DetectedFolder[] | null;
  /** Looking for DAW folders failed (not the same as "none found"). */
  detectError: string | null;
  workspace: Workspace;
  /** False if the stored workspace couldn't be read — see loadWorkspace. */
  workspaceWritable: boolean;
  projects: ProjectInfo[];
  scanning: boolean;
  /** Linked folders the last scan couldn't read (unplugged drive, unmounted
   * share): their songs are missing for now, never taken for moved. */
  unreachable: string[];
  /** A linked folder that moved: pick its new place (native picker in Rust);
   * every song's data under it follows. */
  repointFolder: (folder: string) => Promise<void>;
  /** Rescan; a failure shows in the error banner instead of being thrown
   * (window focus, after a render). */
  rescanOrReport: () => Promise<void>;
  /** Songs whose record followed a rename/move in the last scan (shown once). */
  relinked: Relink[];
  /** The last records moved to new paths (a rename, "Continue in FL Studio"):
   * what's open elsewhere (the session window) follows them. */
  lastRelinks: Relink[];
  dismissRelinked: () => void;
  search: string;
  selected: Set<string>;
  renderJobs: Map<string, RenderJob>;
  rendering: boolean;
  unlisten: (() => void) | null;
  demoMode: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  statusFilter: StatusFilter;
  tagFilter: string | null;
  pluginFilter: string | null;
  /** Only songs with missing plugins or samples. */
  problemsOnly: boolean;
  showArchived: boolean;
  packaging: boolean;
  /** Results of the last package run; null hides the panel. */
  packageResults: PackageResult[] | null;
  /** Files each package would hold, waiting for the user to confirm. */
  packagePlan: { plans: PackagePlan[]; subfolder?: string; skipped: PackageResult[] } | null;
  favoritesOnly: boolean;
  showTemplates: boolean;
  /** Song open in the detail drawer. */
  detailPath: string | null;
  openAlbumId: string | null;
  openPersonId: string | null;
  /** Song shown in the Launch Kit view. */
  launchPath: string | null;
  newProject: NewProjectDraft | null;
  /** What the feedback form opens on ("Report this" on an error prefills it). */
  feedback: FeedbackDraft | null;
  update: UpdateState;
  /** `quiet`: the startup check; being offline is normal then, so a failure
   * is logged, not shown. */
  checkUpdate: (opts?: { quiet?: boolean }) => Promise<void>;
  /** Download, install and restart into the version `update.version`. */
  installUpdate: () => Promise<void>;
  /** "Later": hide the notice for this session. */
  dismissUpdate: () => void;
  /** Settings section to scroll to on arrival (SettingsView clears it). */
  settingsSection: string | null;

  /** A different view closes the song drawer; `section` deep-links into Settings. */
  setView: (view: View, section?: string) => void;
  clearSettingsSection: () => void;
  setSearch: (search: string) => void;
  /** Back to the whole library (search, stage, tag, plugin and toggle filters). */
  resetLibraryFilters: () => void;
  /** The Library's folder tree: the branch shown (a folder path), or all. */
  folderFilter: string | null;
  setFolderFilter: (folder: string | null) => void;
  init: () => Promise<void>;
  /** Preferences only: paths go through the pickers below (Rust owns them).
   * A failed save puts back what settings.json holds and is reported in the
   * banner; `{ report: false }` throws instead (the caller shows it). */
  updateSettings: (
    patch: Partial<Omit<Settings, "watchedFolders" | "flStudioPath" | "outputFolder" | "ffmpegPath">>,
    opts?: { report?: boolean },
  ) => Promise<void>;
  /** Native picker (in Rust); links the folder and scans it. */
  addWatchedFolder: () => Promise<void>;
  /** Look for every DAW's default projects folder (never links anything). */
  detectFolders: () => Promise<void>;
  /** Link one detected folder (the user confirmed it) and scan it. */
  linkDetected: (path: string) => Promise<void>;
  removeWatchedFolder: (folder: string) => Promise<void>;
  /** Beats folders (the Digger). */
  addBeatFolder: () => Promise<void>;
  removeBeatFolder: (folder: string) => Promise<void>;
  /** Sample libraries (rescans: sample statuses depend on them). */
  addSampleFolder: () => Promise<void>;
  removeSampleFolder: (folder: string) => Promise<void>;
  pickOutputFolder: () => Promise<void>;
  pickFlStudio: () => Promise<void>;
  /** Fill in the FL Studio found on this machine; false if none was found
   * (failing to save it throws). */
  detectFlStudio: () => Promise<boolean>;
  pickFfmpeg: () => Promise<void>;
  clearPathSetting: (which: "flStudio" | "ffmpeg" | "outputFolder") => Promise<void>;
  rescan: () => Promise<void>;
  toggleSelected: (path: string) => void;
  selectAll: (paths: string[]) => void;
  clearSelection: () => void;
  startRender: (paths?: string[], options?: RenderOptions) => Promise<void>;
  dismissRenderPanel: () => void;
  loadDemoData: () => void;
  exitDemoMode: () => Promise<void>;
  toggleFavorite: (path: string) => void;
  setSort: (key: SortKey) => void;
  setStatusFilter: (status: StatusFilter) => void;
  setTagFilter: (tag: string | null) => void;
  setPluginFilter: (plugin: string | null) => void;
  setProblemsOnly: (value: boolean) => void;
  setShowArchived: (value: boolean) => void;
  /** Lists what each package would hold (packagePlan); nothing is written yet. */
  startPackage: (paths: string[], subfolder?: string) => Promise<void>;
  /** Zip the confirmed files into `<export folder>/Packages[/subfolder]`. */
  confirmPackage: (approved: string[][]) => Promise<void>;
  cancelPackage: () => void;
  dismissPackageResults: () => void;
  setFavoritesOnly: (value: boolean) => void;
  setShowTemplates: (value: boolean) => void;
  openDetail: (path: string | null) => void;
  openAlbum: (id: string | null) => void;
  openPerson: (id: string | null) => void;
  openLaunchKit: (path: string | null) => void;
  /** undefined resets the field to its generated value. */
  setKitEdit: (path: string, id: KitFieldId, value: string | undefined) => void;
  /** Several fields at once; null clears every edit (back to generated). */
  setKitEdits: (path: string, edits: Partial<Record<KitFieldId, string>> | null) => void;
  setSnippetStart: (path: string, label: string, startSec: number | undefined) => void;
  /** Change a snippet's length (undefined = back to the detected length). */
  setSnippetLength: (path: string, label: string, lengthSec: number | undefined) => void;
  /** "Accept all": `fingerprint` is what it was accepted against (kitState.ts). */
  acceptKit: (path: string, fingerprint?: string) => void;
  /** Keeps the suggested release date on the song (accept, export): marked as
   * a suggestion, so a date set on its release later wins. */
  pinKitReleaseDate: (path: string, date: string) => void;
  /** Small kit settings that aren't field values (master, export record,
   * final cover, pre-save link). Doesn't touch "Accepted". */
  patchKit: (path: string, patch: Partial<LaunchKitMeta>) => void;
  /** Merge AI drafts/review into a song's kit. */
  setKitAi: (path: string, patch: Partial<KitAiMeta>) => void;
  /** null until loaded; whether a Gemini key is set. */
  aiStatus: AiStatus | null;
  refreshAiStatus: () => Promise<void>;
  /** Set or clear the picked cover concept (metadata only). */
  setKitCover: (path: string, cover: KitCoverMeta | undefined) => void;
  /** This kit's caption language; undefined = the one in Settings. */
  setKitCaptionLanguage: (path: string, lang: CaptionLang | undefined) => void;
  /** Opt-in: the credited people's profile IDs go into the exported kit. */
  setKitIncludeArtistIds: (path: string, on: boolean) => void;
  /** null until loaded; whether Cloudflare credentials are set. */
  coverStatus: CoverStatus | null;
  refreshCoverStatus: () => Promise<void>;
  openNewProject: (draft?: Partial<NewProjectDraft>) => void;
  closeNewProject: () => void;
  openFeedback: (draft?: Partial<FeedbackDraft>) => void;
  closeFeedback: () => void;

  // Song metadata
  updateSong: (path: string, patch: Partial<SongMeta>) => void;
  setStatus: (paths: string[], status: SongStatus | undefined) => void;

  // Pipeline columns (src/lib/pipeline.ts; shared by board, list and table)
  renamePipelineColumn: (id: string, name: string) => void;
  addPipelineColumn: (name: string, stage: SongStatus | null) => void;
  removePipelineColumn: (id: string) => void;
  movePipelineColumn: (id: string, toIndex: number) => void;
  /** `songs` = the songs on the board (for the column's current order). */
  movePipelineCard: (songs: ProjectInfo[], path: string, columnId: string, beforePath: string | null) => void;

  // Dashboard layout (the "Me" dashboard's blocks: order, hidden, looks, widths)
  setDashboardLayout: (layout: DashboardLayout) => void;
  /** Back to the default arrangement (drops the stored layout). */
  resetDashboardLayout: () => void;

  // Albums
  createAlbum: (title: string) => string;
  updateAlbum: (id: string, patch: Partial<Omit<Album, "id">>) => void;
  deleteAlbum: (id: string) => void;
  /** Crew sync: forget deleted-release markers once their rows are gone. */
  clearDeletedReleaseShares: (ids: string[]) => void;
  /** Crew sync: this release's crew row must be deleted on that crew's next sync. */
  markReleaseShareDeleted: (entry: { id: string; crewId?: string; userId?: string }) => void;

  // People (collaborators & contacts), credits and pitches
  createPerson: (name: string, aliases?: string[]) => string;
  updatePerson: (id: string, patch: Partial<Omit<Person, "id">>) => void;
  /** Notes on a saved prod (by lead hash) or a beat (by file path); empty removes. */
  setLeadNote: (hash: string, text: string) => void;
  setBeatNote: (path: string, text: string) => void;
  /** After a beats scan: notes follow renamed/moved beats, noted beats' sizes are remembered. */
  syncBeatNotes: (beats: { path: string; name: string; sizeBytes: number }[]) => void;
  /** A saved prod's beat set by hand: a path, null ("not in your prods"), or undefined (back to the name match). */
  setLeadBeat: (hash: string, path: string | null | undefined) => void;
  /** Also removes their credits and pitches. */
  deletePerson: (id: string) => void;
  addPitch: (path: string, pitch: Omit<Pitch, "id">) => void;
  updatePitch: (path: string, id: string, patch: Partial<Omit<Pitch, "id">>) => void;
  removePitch: (path: string, id: string) => void;
  addTracks: (albumId: string, paths: string[]) => void;
  removeTrack: (albumId: string, path: string) => void;
  moveTrack: (albumId: string, from: number, to: number) => void;

  // File actions (write to disk, then rescan)
  createProject: (args: {
    name: string;
    templatePath: string;
    parentFolder: string;
    albumId: string | null;
    status: SongStatus;
  }) => Promise<string>;
  /** File a sketch from the phone inbox into `<parentFolder>/<name>/BandLab/`
   * (a sketch song in Creation); returns its key. */
  fileInboxSketch: (args: { itemId: string; parentFolder: string; name: string; bandlabUrl?: string }) => Promise<FiledSketch>;
  /** "Continue in FL Studio": create the .flp from a template next to the
   * sketch and move the song's data (stage, notes, credits, share, release
   * slot, favorite) to it. Returns the new .flp path. */
  continueSketch: (sketchPath: string, templatePath: string) => Promise<api.Continued>;
  duplicateProject: (path: string, newName: string) => Promise<string>;
  restoreBackup: (backupPath: string, projectPath: string) => Promise<string>;
  trashBackups: (paths: string[], allowPermanent?: boolean) => Promise<number>;
}

/** Flush a pending debounced workspace save (set once the store exists).
 * Resolves false while edits aren't on disk (unsavedChanges says why), even
 * after the banner was dismissed. */
let flushPending: () => Promise<boolean> = () => Promise.resolve(true);
export const flushWorkspace = () => flushPending();
/** Edits were made while the stored workspace couldn't be read (they live
 * only in memory until "Start fresh"; a reload or restore drops them, and
 * says so). */
let editedWhileUnreadable = false;

/** The update was stopped before installing: the workspace didn't save. */
class UnsavedBeforeUpdate extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsavedBeforeUpdate";
  }
}

/** The workspace save currently being written, if any. */
let savingNow: Promise<void> | null = null;
/** The real favorites while sample data is shown (sample stars stay in memory). */
let realFavorites: string[] | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The daily update re-check (started once by init). */
let updateTimer: ReturnType<typeof setInterval> | null = null;
let scanSeq = 0;

/** Errors the store throws (shown as they are in the UI). */
const STORE_ERRORS = dict(
  {
    sampleExport: "This is sample data: link a real project folder in Settings before exporting.",
    sample: "This is sample data: link a real project folder first.",
    needFl: "Set your FL Studio executable path in Settings first.",
    needExport: "Set an export folder in Settings first.",
    needExportForPackages: "Set an export folder in Settings first: packages go in <export folder>/Packages.",
    exportRunning: "An export is already running.",
    packaging: "Already packaging.",
    notLoaded: "Your workspace isn't loaded yet: try again in a moment.",
    nothingToPackage: "Nothing to package.",
    repointReadOnly:
      "Your workspace can't be saved right now, so its songs couldn't follow the folder. Nothing was changed: sort out the strip at the top first, then try again.",
    newerReadOnly: "This workspace was saved by a newer Hivo: update Hivo to edit it. That change wasn't made.",
    updateUnsaved: (why: string) => `The update was stopped because your changes couldn't be saved first. ${why}`,
  },
  {
    sampleExport: "Ce sont des données d'exemple : lie un vrai dossier de projets dans les Réglages avant d'exporter.",
    sample: "Ce sont des données d'exemple : lie d'abord un vrai dossier de projets.",
    needFl: "Indique d'abord le chemin de FL Studio dans les Réglages.",
    needExport: "Choisis d'abord un dossier d'export dans les Réglages.",
    needExportForPackages: "Choisis d'abord un dossier d'export dans les Réglages : les paquets vont dans <dossier d'export>/Packages.",
    exportRunning: "Un export est déjà en cours.",
    repointReadOnly:
      "Ton espace de travail ne peut pas être enregistré pour l'instant, donc ses sons n'ont pas pu suivre le dossier. Rien n'a changé : règle d'abord le bandeau en haut, puis réessaie.",
    newerReadOnly: "Cet espace de travail a été enregistré par un Hivo plus récent : mets Hivo à jour pour le modifier. Cette modification n'a pas été faite.",
    updateUnsaved: (why: string) => `La mise à jour a été arrêtée parce que tes modifications n'ont pas pu être enregistrées avant. ${why}`,
    packaging: "Paquet déjà en cours.",
    notLoaded: "Ton espace de travail n'est pas encore chargé : réessaie dans un instant.",
    nothingToPackage: "Rien à empaqueter.",
  },
);

const STORE_TEXT = dict(
  {
    renderFlOnly: (daw: string, tip: string) => `Rendering from Hivo works with FL Studio projects. Export this one from ${daw}: ${tip}`,
    notFl: (daw: string) => `Not an FL Studio project. Export it from ${daw}.`,
    packageFlOnly: (daw: string) => `Packaging works with FL Studio projects. In ${daw}, use its own "collect and save" feature.`,
    saveFailed: (e: string) => `Couldn't save your changes (stages, notes, releases): ${e}`,
    scanFailed: (e: string) => `Scanning failed: ${e}`,
    settingsUnreadable: (e: string) => `Couldn't read your settings, using the defaults for now: ${e}`,
    settingsReset: (bad: string) =>
      `Your settings file couldn't be read, so Hivo started from the default settings: link your folders again in Settings. The old file is kept as ${bad}.`,
    settingsSaveFailed: (e: string) => `Couldn't save that setting, it's back to what was saved: ${e}`,
    droppedEdits: "Your workspace loaded. The changes made while it couldn't be read were not kept.",
    untitledAlbum: "Untitled album",
  },
  {
    renderFlOnly: (daw: string, tip: string) => `Le rendu depuis Hivo marche avec les projets FL Studio. Exporte celui-ci depuis ${daw} : ${tip}`,
    notFl: (daw: string) => `Pas un projet FL Studio. Exporte-le depuis ${daw}.`,
    packageFlOnly: (daw: string) => `Les paquets marchent avec les projets FL Studio. Dans ${daw}, utilise sa propre fonction « rassembler et enregistrer ».`,
    saveFailed: (e: string) => `Impossible d'enregistrer tes modifications (étapes, notes, sorties) : ${e}`,
    scanFailed: (e: string) => `Échec de l'analyse des dossiers : ${e}`,
    settingsUnreadable: (e: string) => `Impossible de lire tes réglages, les réglages par défaut sont utilisés pour l'instant : ${e}`,
    settingsReset: (bad: string) =>
      `Ton fichier de réglages était illisible, Hivo a donc repris les réglages par défaut : relie à nouveau tes dossiers dans les Réglages. L'ancien fichier est gardé sous ${bad}.`,
    settingsSaveFailed: (e: string) => `Impossible d'enregistrer ce réglage, il est revenu à ce qui était enregistré : ${e}`,
    droppedEdits: "Ton espace de travail est chargé. Les modifications faites pendant qu'il était illisible n'ont pas été gardées.",
    untitledAlbum: "Album sans titre",
  },
);

/** A workspace read from disk, ready to apply in one `set`. */
export type LoadedWorkspace =
  | { ok: true; workspace: Workspace; changed: boolean; newer: number | null }
  | { ok: false; detail: string; hasBackup: boolean; canReset: boolean };

/** Turns what `get_workspace` returned into the workspace to show. */
export function fromStored(stored: Workspace | null): LoadedWorkspace {
  if (!stored) return { ok: true, workspace: EMPTY_WORKSPACE, changed: false, newer: null };
  const newer = newerWorkspaceVersion(stored);
  const { workspace, changed } = migrateWorkspace(stored);
  // Whatever was on disk, it's never sample data.
  const { sample: _sample, ...real } = workspace;
  return { ok: true, workspace: real, changed: changed && newer === null, newer };
}

async function readWorkspace(): Promise<LoadedWorkspace> {
  try {
    return fromStored(await api.getWorkspace());
  } catch (e) {
    const files = await api.workspaceFiles().catch(() => null);
    return { ok: false, detail: String(e), hasBackup: !!files?.hasBackup, canReset: !!files?.canReset };
  }
}


export const useAppStore = create<AppState>((set, get) => {
  /** Apply a change to the workspace and persist it (debounced, so typing
   * notes doesn't write the file on every keystroke). Sample-data edits
   * stay in memory so they never clobber the real workspace. */
  function mutateWorkspace(fn: (ws: Workspace) => Workspace, { quiet = false }: { quiet?: boolean } = {}) {
    // Saved by a newer Hivo: edits would never reach the disk, so none are
    // made (and the user hears why, unless it's housekeeping).
    if (get().workspaceIssue?.kind === "newer" && !get().demoMode) {
      if (!quiet) set({ actionError: tr(STORE_ERRORS).newerReadOnly });
      return;
    }
    // Every stage change, from anywhere, lands in the song's stage log here.
    const prev = get().workspace;
    const next = logStageChanges(prev, fn(prev), Date.now());
    set({ workspace: next });
    if (get().demoMode || next.sample) return;
    if (!get().workspaceWritable) {
      if (get().workspaceIssue?.kind === "unreadable") editedWhileUnreadable = true;
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persistWorkspace(), 400);
  }

  /** Write the workspace now (the debounced save, or a flush on close). */
  async function persistWorkspace() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    // Re-check at fire time: sample data may have been loaded meanwhile. The
    // `sample` flag is the last guard: generated data never reaches the disk.
    const { demoMode, workspaceWritable, workspace } = get();
    if (demoMode || !workspaceWritable || workspace.sample) return;
    const write = api
      .saveWorkspace(workspace)
      .then(() => {
        if (get().saveError || get().unsavedChanges) set({ saveError: null, unsavedChanges: null });
      })
      .catch((e) => {
        console.error("saving workspace failed", e);
        const why = tr(STORE_TEXT).saveFailed(String(e));
        set({ saveError: why, unsavedChanges: why });
      });
    savingNow = write;
    await write;
    if (savingNow === write) savingNow = null;
  }
  // On close: write a pending save, or wait for the one being written.
  // False = it failed (the caller keeps the window open once).
  flushPending = async () => {
    if (saveTimer) await persistWorkspace();
    else if (savingNow) await savingNow;
    return get().unsavedChanges === null;
  };

  /** The real favorites to put back when leaving sample data (and forget them). */
  function takeRealFavorites(): Partial<AppState> {
    const favorites = realFavorites;
    realFavorites = null;
    return favorites ? { settings: { ...get().settings, favorites } } : {};
  }

  /** Shows a workspace read from disk, in one `set` with `extra` (leaving
   * sample data passes `demoMode: false` here, so there's never a moment
   * where sample data is on screen with saving on). */
  function applyLoaded(loaded: LoadedWorkspace, extra: Partial<AppState> = {}) {
    // Edits made while the file couldn't be read existed only in memory.
    const dropped = editedWhileUnreadable;
    editedWhileUnreadable = false;
    const droppedNote = dropped ? { actionError: tr(STORE_TEXT).droppedEdits } : {};
    if (!loaded.ok) {
      // Never save over a workspace we couldn't read — that would wipe the
      // user's albums and statuses. The strip offers restore / start fresh.
      // Still unreadable on a retry: the edits made meanwhile stay in memory.
      const s = get();
      const keep = s.workspaceIssue?.kind === "unreadable" && !s.demoMode && !s.workspace.sample;
      editedWhileUnreadable = keep && dropped;
      set({
        ...extra,
        workspace: keep ? s.workspace : EMPTY_WORKSPACE,
        workspaceWritable: false,
        workspaceIssue: { kind: "unreadable", detail: loaded.detail, hasBackup: loaded.hasBackup, canReset: loaded.canReset },
      });
      return;
    }
    if (loaded.newer !== null) {
      set({ ...extra, ...droppedNote, workspace: loaded.workspace, workspaceWritable: false, workspaceIssue: { kind: "newer", version: loaded.newer } });
      return;
    }
    set({ ...extra, ...droppedNote, workspace: loaded.workspace, workspaceWritable: true, workspaceIssue: null });
    // Save the upgraded shape once, so the migration doesn't rerun.
    if (loaded.changed) void api.saveWorkspace(loaded.workspace).catch((e) => console.error("saving migrated workspace failed", e));
  }

  /** Leaving sample data: the real workspace is read first, then swapped in
   * with `demoMode: false` in the same `set`. Anything that changes the
   * workspace meanwhile changes sample data, which is never saved. */
  async function leaveSampleData(extra: Partial<AppState> = {}) {
    const loaded = await readWorkspace();
    applyLoaded(loaded, {
      ...extra,
      ...takeRealFavorites(),
      demoMode: false,
      projects: [],
      selected: new Set(),
      detailPath: null,
      openAlbumId: null,
      launchPath: null,
    });
  }

  /** Take the path settings Rust saved; keep this session's other preferences
   * (sample-data favorites stay in memory). */
  function keepPaths(saved: Settings) {
    const { watchedFolders, flStudioPath, outputFolder, ffmpegPath, beatFolders, sampleFolders } = saved;
    set((s) => ({ settings: { ...s.settings, watchedFolders, flStudioPath, outputFolder, ffmpegPath, beatFolders, sampleFolders } }));
  }

  /** A folder was linked: leave sample data if needed, then scan. */
  async function linked(saved: Settings) {
    // Leaving sample data: drop its fake albums/people before anything
    // can be saved over the real workspace.
    if (get().demoMode) await leaveSampleData();
    keepPaths(saved);
    await scanOrReport();
  }

  /** Records moved to new paths (lib/relink.ts): the workspace, favorites,
   * and the open drawer and Launch Kit follow. */
  function followRelinks(relinks: Relink[]) {
    const map = new Map(relinks.map((r) => [r.from, r.to]));
    // The session window follows too (sessionBridge.ts).
    set({ lastRelinks: relinks });
    mutateWorkspace((ws) => applyRelinks(ws, relinks));
    const favs = get().settings.favorites;
    if (favs.some((f) => map.has(f))) void get().updateSettings({ favorites: favs.map((f) => map.get(f) ?? f) });
    const open = get().detailPath;
    const kit = get().launchPath;
    set({
      detailPath: open && map.has(open) ? map.get(open)! : open,
      // The Launch Kit follows a "Save as" too, instead of showing another song.
      launchPath: kit && map.has(kit) ? map.get(kit)! : kit,
    });
  }

  function scanOrReport() {
    return get()
      .rescan()
      .then(() => {
        if (get().scanError) set({ scanError: null });
      })
      .catch((e) => set({ scanError: tr(STORE_TEXT).scanFailed(String(e)) }));
  }

  function mutateAlbum(id: string, fn: (album: Album) => Album) {
    mutateWorkspace((ws) => ({
      ...ws,
      albums: ws.albums.map((a) => (a.id === id ? fn(a) : a)),
    }));
  }

  /** Start fresh / Restore only touch a file that reads but doesn't parse:
   * one that can't be read at all may be the only good copy. */
  function resettable() {
    const issue = get().workspaceIssue;
    return issue?.kind === "unreadable" && issue.canReset;
  }

  async function loadWorkspace() {
    // Sample data on screen: the real workspace is read when leaving it.
    if (get().demoMode) return;
    applyLoaded(await readWorkspace());
  }

  return {
    view: "dashboard",
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
    startupError: null,
    scanError: null,
    actionError: null,
    saveError: null,
    unsavedChanges: null,
    // Hides the messages only: unsavedChanges stays until a save works.
    dismissErrors: () => set({ startupError: null, scanError: null, actionError: null, saveError: null }),
    retrySave: async () => {
      // Unreadable (or from a newer Hivo): read it again rather than write
      // over it. Once it reads, saves resume on the stored copy.
      if (!get().workspaceWritable) {
        await loadWorkspace();
        return;
      }
      await persistWorkspace();
    },
    workspaceIssue: null,
    restoreWorkspaceBackup: async () => {
      if (!resettable()) return;
      applyLoaded(fromStored(await api.restoreWorkspaceBackup()));
    },
    startFreshWorkspace: async () => {
      if (!resettable() || get().demoMode) return;
      await api.setAsideWorkspace();
      // What's in memory (an empty workspace plus any edits made since) is
      // what gets saved from now on.
      editedWhileUnreadable = false;
      set({ workspaceWritable: true, workspaceIssue: null });
      await persistWorkspace();
    },
    showConfigFolder: () => api.showConfigFolder(),
    detectedFolders: null,
    detectError: null,
    workspace: EMPTY_WORKSPACE,
    workspaceWritable: false,
    projects: [],
    scanning: false,
    unreachable: [],
    rescanOrReport: () => scanOrReport(),
    repointFolder: async (folder) => {
      if (get().demoMode) throw new Error(tr(STORE_ERRORS).sample);
      // The records under the folder must move in the same step as the
      // folder, or they're orphaned: refused until the workspace saves.
      if (!get().workspaceWritable) throw new Error(tr(STORE_ERRORS).repointReadOnly);
      const moved = await api.repointWatchedFolder(folder);
      if (!moved) return;
      keepPaths(moved.settings);
      // Every record under the old folder moves to the same place under the
      // new one (stage, notes, credits, crew share, release slots, favorites).
      const relinks = rootRelinks(get().workspace, moved.from, moved.to);
      if (relinks.length) followRelinks(relinks);
      const filter = get().folderFilter;
      if (filter && isUnder(`${filter}/x`, moved.from)) set({ folderFilter: null });
      await scanOrReport();
    },
    relinked: [],
    lastRelinks: [],
    dismissRelinked: () => set({ relinked: [] }),
    search: "",
    selected: new Set(),
    renderJobs: new Map(),
    rendering: false,
    unlisten: null,
    demoMode: false,
    sortKey: "modified",
    sortDir: "desc",
    statusFilter: null,
    tagFilter: null,
    pluginFilter: null,
    problemsOnly: false,
    showArchived: false,
    packaging: false,
    packageResults: null,
    packagePlan: null,
    favoritesOnly: false,
    showTemplates: false,
    detailPath: null,
    openAlbumId: null,
    openPersonId: null,
    launchPath: null,
    newProject: null,
    feedback: null,
    update: { status: "idle" },

    checkUpdate: async ({ quiet = false } = {}) => {
      const { status } = get().update;
      if (status === "checking" || status === "downloading" || status === "ready") return;
      set({ update: { status: "checking" } });
      try {
        const found = await updater.checkForUpdate();
        set({ update: found ? { status: "available", version: found.version } : { status: "idle" } });
      } catch (e) {
        if (quiet) {
          console.warn("update check failed", e);
          set({ update: { status: "idle" } });
          return;
        }
        set({ update: { status: "error", error: e instanceof Error ? e.message : String(e) } });
      }
    },

    installUpdate: async () => {
      const { status, version } = get().update;
      if (!version || status === "downloading" || status === "ready") return;
      set({ update: { status: "downloading", version } });
      try {
        await updater.installUpdate(
          ({ downloaded, total, finished }) =>
            set({ update: { status: finished ? "ready" : "downloading", version, progress: total ? downloaded / total : undefined } }),
          // Never restart over edits that aren't on disk: stop the update instead.
          async () => {
            if (!(await flushWorkspace())) throw new UnsavedBeforeUpdate(tr(STORE_ERRORS).updateUnsaved(get().unsavedChanges ?? ""));
          },
        );
      } catch (e) {
        const blockedBySave = e instanceof UnsavedBeforeUpdate ? { blockedBySave: true } : {};
        set({ update: { status: "error", version, error: e instanceof Error ? e.message : String(e), ...blockedBySave } });
      }
    },

    dismissUpdate: () => {
      void updater.discardUpdate();
      set({ update: { status: "idle" } });
    },
    settingsSection: null,

    setView: (view, section) =>
      set((s) => ({
        view,
        settingsSection: section ?? null,
        // Only an actual change of screen closes the drawer.
        detailPath: s.view === view ? s.detailPath : null,
      })),
    clearSettingsSection: () => set({ settingsSection: null }),
    setSearch: (search) => set({ search }),
    resetLibraryFilters: () =>
      set({ search: "", statusFilter: null, tagFilter: null, pluginFilter: null, problemsOnly: false, favoritesOnly: false, showArchived: false, folderFilter: null }),
    folderFilter: null,
    setFolderFilter: (folderFilter) => set({ folderFilter }),

    init: async () => {
      let settings: Settings;
      try {
        settings = await api.getSettings();
      } catch (e) {
        settings = { ...DEFAULT_SETTINGS };
        set({ startupError: tr(STORE_TEXT).settingsUnreadable(String(e)) });
      }
      // settings.json didn't parse: Rust kept it aside and started from the
      // defaults. Said once, with where the old file is.
      const keptAs = await api.takeSettingsRecovery().catch(() => null);
      if (keptAs) set({ startupError: tr(STORE_TEXT).settingsReset(keptAs) });
      // First run on a machine with FL installed: fill the path in for them.
      if (!settings.flStudioPath) {
        settings = (await api.useDetectedFlStudio().catch(() => null)) ?? settings;
      }
      set({ settings });
      await loadWorkspace();
      get().refreshAiStatus();
      get().refreshCoverStatus();
      set({ settingsLoaded: true });
      // An update check at launch, then once a day while the app stays open
      // (never for sample data or a browser tab). Quiet: offline is normal.
      if (updater.UPDATES_ENABLED && !updateTimer) {
        if (!get().demoMode) void get().checkUpdate({ quiet: true });
        updateTimer = setInterval(() => {
          if (!get().demoMode) void get().checkUpdate({ quiet: true });
        }, UPDATE_RECHECK_MS);
      }

      if (!get().unlisten) {
        const unlisten = await api.onRenderProgress((event: RenderEvent) => {
          set((state) => {
            const next = new Map(state.renderJobs);
            next.set(event.projectPath, {
              status: event.status,
              message: event.message,
              outputPath: event.outputPath,
            });
            return { renderJobs: next };
          });
        });
        set({ unlisten });
      }

      if (settings.watchedFolders.length > 0) {
        await scanOrReport();
      } else {
        // Fresh machine: propose every DAW folder found (the user links them).
        await get().detectFolders();
      }
    },

    updateSettings: async (patch, { report = true } = {}) => {
      const merged = { ...get().settings, ...patch };
      set({ settings: merged });
      try {
        // Sample-data stars never reach settings.json.
        await api.saveSettings(realFavorites ? { ...merged, favorites: realFavorites } : merged);
      } catch (e) {
        // Back to what settings.json holds (Rust may have saved part of it),
        // so the screen never shows a setting that isn't saved.
        const saved = await api.getSettings().catch(() => null);
        // (Sample-data stars stay in memory.)
        if (saved) set((s) => ({ settings: { ...saved, favorites: realFavorites ? s.settings.favorites : saved.favorites } }));
        if (!report) throw e;
        set({ actionError: tr(STORE_TEXT).settingsSaveFailed(e instanceof Error ? e.message : String(e)) });
      }
    },

    addWatchedFolder: async () => {
      const before = get().settings.watchedFolders;
      const next = await api.pickWatchedFolder();
      if (next.watchedFolders.length !== before.length) await linked(next);
    },

    detectFolders: async () => {
      // A failure isn't "nothing found": say what went wrong instead.
      try {
        set({ detectedFolders: await api.detectDawFolders(), detectError: null });
      } catch (e) {
        set({ detectedFolders: [], detectError: e instanceof Error ? e.message : String(e) });
      }
    },

    linkDetected: async (path) => {
      await linked(await api.linkDetectedFolder(path));
      set((s) => ({ detectedFolders: s.detectedFolders?.map((f) => (f.path === path ? { ...f, linked: true } : f)) ?? null }));
    },

    removeWatchedFolder: async (folder) => {
      const next = await api.removeWatchedFolder(folder);
      keepPaths(next);
      await scanOrReport();
      // Unlinking a detected folder makes it a proposal again.
      await get().detectFolders();
    },

    addBeatFolder: async () => keepPaths(await api.pickBeatFolder()),
    removeBeatFolder: async (folder) => keepPaths(await api.removeBeatFolder(folder)),
    addSampleFolder: async () => {
      const before = get().settings.sampleFolders?.length ?? 0;
      keepPaths(await api.pickSampleFolder());
      if ((get().settings.sampleFolders?.length ?? 0) !== before) await get().rescan();
    },
    removeSampleFolder: async (folder) => {
      keepPaths(await api.removeSampleFolder(folder));
      await get().rescan();
    },

    pickOutputFolder: async () => {
      const before = get().settings.outputFolder;
      const next = await api.pickOutputFolder();
      keepPaths(next);
      if (next.outputFolder !== before) await get().rescan();
    },

    pickFlStudio: async () => keepPaths(await api.pickFlStudio()),

    detectFlStudio: async () => {
      if (!(await api.detectFlStudio())) return false;
      const next = await api.useDetectedFlStudio();
      keepPaths(next);
      return !!next.flStudioPath;
    },

    pickFfmpeg: async () => keepPaths(await api.pickFfmpeg()),

    clearPathSetting: async (which) => {
      keepPaths(await api.clearPathSetting(which));
      if (which === "outputFolder") await get().rescan();
    },

    rescan: async () => {
      if (get().demoMode) return;
      const folders = get().settings.watchedFolders;
      if (folders.length === 0) {
        set({ projects: [], unreachable: [] });
        return;
      }
      // Scans can overlap (window focus + adding a folder); only the newest
      // one may write, so a slow stale scan can't hide a new folder.
      const id = ++scanSeq;
      set({ scanning: true });
      try {
        const { projects, unreachable } = await api.scanProjects();
        if (id === scanSeq && !get().demoMode) {
          // Renamed/moved .flp files keep their stage, tags, notes, credits,
          // crew share and album slot (lib/relink.ts). Only on the real,
          // writable workspace, never sample data. Songs under a linked
          // folder that's unreachable right now are missing, not moved.
          const relinks = get().workspaceWritable ? findRelinks(projects, get().workspace, folders, unreachable) : [];
          if (relinks.length) {
            followRelinks(relinks);
            set({ relinked: [...get().relinked, ...relinks] });
          }
          set({ projects, unreachable });
        }
      } finally {
        if (id === scanSeq) set({ scanning: false });
      }
    },

    toggleSelected: (path) =>
      set((state) => {
        const next = new Set(state.selected);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return { selected: next };
      }),

    selectAll: (paths) => set({ selected: new Set(paths) }),

    clearSelection: () => set({ selected: new Set() }),

    startRender: async (paths, options) => {
      const { settings, selected, demoMode } = get();
      if (demoMode) {
        throw new Error(tr(STORE_ERRORS).sampleExport);
      }
      if (!settings.flStudioPath) {
        throw new Error(tr(STORE_ERRORS).needFl);
      }
      if (!settings.outputFolder) {
        throw new Error(tr(STORE_ERRORS).needExport);
      }
      const requested = paths ?? Array.from(selected);
      if (requested.length === 0) return;
      if (get().rendering) throw new Error(tr(STORE_ERRORS).exportRunning);
      // Rendering from the app drives FL Studio; other DAWs' songs are
      // listed as skipped with where to export them instead.
      const byPath = new Map(get().projects.map((p) => [p.path, p]));
      const { paths: projectPaths, names: outputNames, skipped } = splitRenderable(requested, byPath, options?.names);
      if (projectPaths.length === 0) {
        const daw = dawOf(byPath.get(requested[0]) ?? {});
        throw new Error(tr(STORE_TEXT).renderFlOnly(daw.label, daw.exportTip));
      }


      const seedJobs = new Map(get().renderJobs);
      for (const path of projectPaths) {
        seedJobs.set(path, { status: "queued", message: null, outputPath: null });
      }
      for (const path of skipped) {
        const daw = dawOf(byPath.get(path) ?? {});
        seedJobs.set(path, { status: "error", message: tr(STORE_TEXT).notFl(daw.label), outputPath: null });
      }
      set({ renderJobs: seedJobs, rendering: true });

      try {
        // FL Studio, the format and the export folder are read from Settings in Rust.
        await api.renderProjects({ projectPaths, subfolder: options?.subfolder, outputNames });
      } catch (e) {
        // Failed before (or while) FL Studio reported progress: mark the rows
        // that never finished, so the panel doesn't read "complete".
        const jobs = new Map(get().renderJobs);
        for (const path of projectPaths) {
          const job = jobs.get(path);
          if (job && (job.status === "queued" || job.status === "rendering")) jobs.set(path, { ...job, status: "error", message: String(e) });
        }
        set({ renderJobs: jobs });
        throw e;
      } finally {
        set({ rendering: false });
        // Pick up the new mixdowns (freshness badges, playback).
        void scanOrReport();
      }
    },

    dismissRenderPanel: () => set({ renderJobs: new Map() }),

    loadDemoData: () => {
      // Flush a pending real save now, before the workspace is swapped.
      // (persistWorkspace reads the workspace synchronously, before the swap.)
      if (saveTimer) void persistWorkspace();
      realFavorites ??= get().settings.favorites;
      const projects = generateSampleProjects();
      set({
        demoMode: true,
        projects,
        workspace: generateSampleWorkspace(projects),
        selected: new Set(),
        detailPath: null,
        openAlbumId: null,
        launchPath: null,
        // Stay on the page (from Settings, show the data: the Dashboard).
        view: get().view === "settings" ? "dashboard" : get().view,
      });
      get().resetLibraryFilters();
    },

    exitDemoMode: async () => {
      if (!get().demoMode) return;
      // Real workspace first, then demoMode off in the same set (B3).
      await leaveSampleData();
      get().resetLibraryFilters();
      await scanOrReport();
    },

    toggleFavorite: (path) => {
      const current = get().settings;
      const isFavorite = current.favorites.includes(path);
      const favorites = isFavorite
        ? current.favorites.filter((p) => p !== path)
        : [...current.favorites, path];
      // Sample songs have fake paths: keep their stars out of settings.json.
      if (get().demoMode) set({ settings: { ...current, favorites } });
      else void get().updateSettings({ favorites });
    },

    setSort: (key) =>
      set((state) => ({
        sortKey: key,
        sortDir: state.sortKey === key && state.sortDir === "desc" ? "asc" : "desc",
      })),

    setStatusFilter: (statusFilter) => set({ statusFilter }),
    setTagFilter: (tagFilter) => set({ tagFilter }),
    setPluginFilter: (pluginFilter) => set({ pluginFilter }),
    setProblemsOnly: (problemsOnly) => set({ problemsOnly }),
    setShowArchived: (showArchived) => set({ showArchived }),

    startPackage: async (paths, subfolder) => {
      const { settings, demoMode, packaging } = get();
      if (demoMode) throw new Error(tr(STORE_ERRORS).sample);
      if (!settings.outputFolder) throw new Error(tr(STORE_ERRORS).needExportForPackages);
      if (packaging) throw new Error(tr(STORE_ERRORS).packaging);
      if (paths.length === 0) return;
      // Packages are FL's flat .flp + samples zips; other DAWs are reported as skipped.
      const byPath = new Map(get().projects.map((p) => [p.path, p]));
      const skippedResults = paths
        .filter((p) => !canRenderInApp(byPath.get(p) ?? {}))
        .map((p) => ({
          projectPath: p,
          zipPath: null,
          bytes: 0,
          included: 0,
          missing: [],
          error: tr(STORE_TEXT).packageFlOnly(dawOf(byPath.get(p) ?? {}).label),
        }));
      paths = paths.filter((p) => canRenderInApp(byPath.get(p) ?? {}));
      if (paths.length === 0) {
        set({ packageResults: skippedResults });
        throw new Error(skippedResults[0]?.error ?? tr(STORE_ERRORS).nothingToPackage);
      }
      const plans = await api.packagePreview(paths);
      set({ packagePlan: { plans, subfolder, skipped: skippedResults }, packageResults: null });
    },

    cancelPackage: () => set({ packagePlan: null }),

    confirmPackage: async (approved) => {
      const { settings, packaging, packagePlan } = get();
      if (!packagePlan || packaging || !settings.outputFolder) return;
      const { plans, subfolder, skipped: skippedResults } = packagePlan;
      const paths = plans.map((p) => p.projectPath);
      set({ packaging: true, packageResults: skippedResults, packagePlan: null });
      // Results stream in per song so the panel can show progress.
      const unlisten = await api.onPackageProgress((r) =>
        set((s) => ({ packageResults: [...(s.packageResults ?? []), r] })),
      );
      try {
        await api.packageProjects({ projectPaths: paths, subfolder, approved });
      } finally {
        unlisten();
        set({ packaging: false });
      }
    },

    dismissPackageResults: () => set({ packageResults: null }),
    setFavoritesOnly: (value) => set({ favoritesOnly: value }),
    setShowTemplates: (value) => set({ showTemplates: value }),
    openDetail: (detailPath) => set({ detailPath }),
    // Same rule as setView: an actual change of screen closes the song drawer.
    openAlbum: (openAlbumId) => set((s) => ({ openAlbumId, view: "albums", settingsSection: null, detailPath: s.view === "albums" ? s.detailPath : null })),
    openPerson: (openPersonId) => set((s) => ({ openPersonId, view: "people", settingsSection: null, detailPath: s.view === "people" ? s.detailPath : null })),
    openLaunchKit: (launchPath) => set({ launchPath, view: "launch", detailPath: null }),

    setKitEdit: (path, id, value) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      const edits = { ...kit.edits };
      if (value === undefined) delete edits[id];
      else edits[id] = value;
      // A date the user sets is theirs (never silently replaced by the release's).
      const releaseDatePin = id === "releaseDate" ? (value === undefined ? undefined : "typed") : kit.releaseDatePin;
      get().updateSong(path, { launchKit: { ...kit, edits, releaseDatePin, acceptedAtMs: undefined } });
    },

    pinKitReleaseDate: (path, date) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      if (kit.edits?.releaseDate) return;
      get().updateSong(path, { launchKit: { ...kit, edits: { ...kit.edits, releaseDate: date }, releaseDatePin: "suggested" } });
    },

    patchKit: (path, patch) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      get().updateSong(path, { launchKit: { ...kit, ...patch } });
    },

    setSnippetStart: (path, label, startSec) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      const snippetStarts = { ...kit.snippetStarts };
      if (startSec === undefined) delete snippetStarts[label];
      else snippetStarts[label] = startSec;
      get().updateSong(path, { launchKit: { ...kit, snippetStarts, acceptedAtMs: undefined } });
    },

    setSnippetLength: (path, label, lengthSec) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      const snippetLengths = { ...kit.snippetLengths };
      if (lengthSec === undefined) delete snippetLengths[label];
      else snippetLengths[label] = lengthSec;
      get().updateSong(path, { launchKit: { ...kit, snippetLengths, acceptedAtMs: undefined } });
    },

    setKitEdits: (path, edits) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      const releaseDatePin = edits === null ? undefined : edits.releaseDate !== undefined ? "typed" : kit.releaseDatePin;
      get().updateSong(path, { launchKit: { ...kit, edits: edits === null ? {} : { ...kit.edits, ...edits }, releaseDatePin, acceptedAtMs: undefined } });
    },

    acceptKit: (path, fingerprint) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      get().updateSong(path, { launchKit: { ...kit, acceptedAtMs: Date.now(), acceptedFingerprint: fingerprint } });
    },

    setKitAi: (path, patch) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      // New or discarded drafts change the text, so the kit needs reviewing again.
      const acceptedAtMs = "drafts" in patch ? undefined : kit.acceptedAtMs;
      get().updateSong(path, { launchKit: { ...kit, acceptedAtMs, ai: { ...kit.ai, ...patch } } });
    },

    aiStatus: null,
    refreshAiStatus: async () => {
      const aiStatus = await api.aiStatus().catch(() => null);
      set({ aiStatus });
    },
    setKitCover: (path, cover) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      get().updateSong(path, { launchKit: { ...kit, cover } });
    },
    setKitCaptionLanguage: (path, captionLanguage) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      get().updateSong(path, { launchKit: { ...kit, captionLanguage, acceptedAtMs: undefined } });
    },
    setKitIncludeArtistIds: (path, on) => {
      const kit = get().workspace.songs[path]?.launchKit ?? {};
      get().updateSong(path, { launchKit: { ...kit, includeArtistIds: on || undefined } });
    },
    coverStatus: null,
    refreshCoverStatus: async () => {
      const coverStatus = await api.coverStatus().catch(() => null);
      set({ coverStatus });
    },
    openNewProject: (draft) =>
      set({ newProject: { albumId: null, status: "creation", ...draft } }),
    closeNewProject: () => set({ newProject: null }),
    openFeedback: (draft) => set({ feedback: { category: "idea", message: "", ...draft } }),
    closeFeedback: () => set({ feedback: null }),

    updateSong: (path, patch) =>
      mutateWorkspace((ws) => {
        // A local stage change waits to be sent to the crew (crew sync
        // sends it with the version it was made on). Crew moves applied here
        // carry their own sync fields.
        const stamped: Partial<SongMeta> =
          "status" in patch && patch.stagePending === undefined ? { ...patch, stageUpdatedAtMs: Date.now(), stagePending: true, stageMovedBy: undefined } : { ...patch };
        // A new stage from anywhere but the board drops the column pin.
        if ("status" in patch && !("column" in patch) && patch.status !== ws.songs[path]?.status) stamped.column = undefined;
        return { ...ws, songs: { ...ws.songs, [path]: { ...ws.songs[path], ...stamped } } };
      }),

    renamePipelineColumn: (id, name) => mutateWorkspace((ws) => renameColumn(ws, id, name)),
    addPipelineColumn: (name, stage) => mutateWorkspace((ws) => addColumn(ws, name, stage)),
    removePipelineColumn: (id) => mutateWorkspace((ws) => removeColumn(ws, id)),
    movePipelineColumn: (id, toIndex) => mutateWorkspace((ws) => moveColumn(ws, id, toIndex)),
    movePipelineCard: (songs, path, columnId, beforePath) => mutateWorkspace((ws) => moveCard(ws, songs, path, columnId, beforePath)),

    setDashboardLayout: (layout) => mutateWorkspace((ws) => ({ ...ws, dashboard: layout })),
    resetDashboardLayout: () =>
      mutateWorkspace((ws) => {
        const next = { ...ws };
        delete next.dashboard;
        return next;
      }),

    setStatus: (paths, status) =>
      mutateWorkspace((ws) => {
        const songs = { ...ws.songs };
        const now = Date.now();
        for (const p of paths) songs[p] = { ...songs[p], status, column: songs[p]?.column && songs[p]?.status === status ? songs[p].column : undefined, stageUpdatedAtMs: now, stagePending: true, stageMovedBy: undefined };
        return { ...ws, songs };
      }),

    createAlbum: (title) => {
      const id = newId();
      mutateWorkspace((ws) => ({
        ...ws,
        albums: [
          ...ws.albums,
          {
            id,
            title: title.trim() || tr(STORE_TEXT).untitledAlbum,
            kind: "album",
            color: ALBUM_COLORS[ws.albums.length % ALBUM_COLORS.length],
            releaseDate: null,
            notes: "",
            trackPaths: [],
            createdAtMs: Date.now(),
          },
        ],
      }));
      return id;
    },

    updateAlbum: (id, patch) => mutateAlbum(id, (a) => ({ ...a, ...patch })),

    createPerson: (name, aliases = []) => {
      const id = newId();
      mutateWorkspace((ws) => ({
        ...ws,
        people: [...ws.people, { id, name: name.trim() || "Someone", aliases, contact: "", notes: "" }],
      }));
      return id;
    },

    setLeadNote: (hash, text) => mutateWorkspace((ws) => ({ ...ws, leadNotes: setNote(ws.leadNotes, hash, text) })),
    setBeatNote: (path, text) => mutateWorkspace((ws) => ({ ...ws, beatNotes: setNote(ws.beatNotes, path, text) })),
    syncBeatNotes: (beats) => {
      const ws = get().workspace;
      if (!ws.beatNotes || Object.keys(ws.beatNotes).length === 0) return;
      const moved = relinkBeatNotes(ws.beatNotes, ws.beatNoteSizes, beats);
      const notes = moved?.notes ?? ws.beatNotes;
      const sizes: Record<string, number> = {};
      const byPath = new Map(beats.map((b) => [b.path, b.sizeBytes]));
      // Sizes of noted beats only; a noted beat missing from this scan keeps its last size.
      for (const p of Object.keys(notes)) {
        const s = byPath.get(p) ?? moved?.sizes[p] ?? ws.beatNoteSizes?.[p];
        if (s !== undefined) sizes[p] = s;
      }
      const same = !moved && JSON.stringify(sizes) === JSON.stringify(ws.beatNoteSizes ?? {});
      if (!same) mutateWorkspace((w) => ({ ...w, beatNotes: notes, beatNoteSizes: sizes }), { quiet: true });
    },
    setLeadBeat: (hash, path) =>
      mutateWorkspace((ws) => {
        const next = { ...(ws.leadBeats ?? {}) };
        if (path === undefined) delete next[hash];
        else next[hash] = path;
        return { ...ws, leadBeats: next };
      }),

    updatePerson: (id, patch) =>
      mutateWorkspace((ws) => ({ ...ws, people: ws.people.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

    deletePerson: (id) => {
      mutateWorkspace((ws) => {
        const songs: Workspace["songs"] = {};
        for (const [path, meta] of Object.entries(ws.songs)) {
          songs[path] = {
            ...meta,
            credits: meta.credits?.filter((c) => c.personId !== id),
            pitches: meta.pitches?.filter((p) => p.personId !== id),
          };
        }
        return { ...ws, songs, people: ws.people.filter((p) => p.id !== id) };
      });
      if (get().openPersonId === id) set({ openPersonId: null });
    },

    addPitch: (path, pitch) => {
      const pitches = get().workspace.songs[path]?.pitches ?? [];
      get().updateSong(path, { pitches: [...pitches, { ...pitch, id: newId() }] });
    },

    updatePitch: (path, id, patch) => {
      const pitches = get().workspace.songs[path]?.pitches ?? [];
      get().updateSong(path, { pitches: pitches.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
    },

    removePitch: (path, id) => {
      const pitches = get().workspace.songs[path]?.pitches ?? [];
      get().updateSong(path, { pitches: pitches.filter((p) => p.id !== id) });
    },

    deleteAlbum: (id) => {
      mutateWorkspace((ws) => {
        const gone = ws.albums.find((a) => a.id === id);
        // Shared (or unshared and not synced yet): remember it, so the crew
        // sync deletes its row too.
        const tomb = gone?.shareId
          ? [...(ws.deletedReleaseShares ?? []), { id: gone.shareId, crewId: gone.shareCrewId, userId: gone.shareUserId }]
          : ws.deletedReleaseShares;
        return { ...ws, albums: ws.albums.filter((a) => a.id !== id), deletedReleaseShares: tomb };
      });
      if (get().openAlbumId === id) set({ openAlbumId: null });
    },

    markReleaseShareDeleted: (entry) =>
      mutateWorkspace((ws) => ({ ...ws, deletedReleaseShares: [...(ws.deletedReleaseShares ?? []), entry] })),

    clearDeletedReleaseShares: (ids) =>
      mutateWorkspace((ws) => ({ ...ws, deletedReleaseShares: (ws.deletedReleaseShares ?? []).filter((d) => !ids.includes(d.id)) })),

    addTracks: (albumId, paths) =>
      mutateAlbum(albumId, (a) => ({
        ...a,
        trackPaths: [...a.trackPaths, ...paths.filter((p) => !a.trackPaths.includes(p))],
      })),

    removeTrack: (albumId, path) =>
      mutateAlbum(albumId, (a) => ({ ...a, trackPaths: a.trackPaths.filter((p) => p !== path) })),

    moveTrack: (albumId, from, to) =>
      mutateAlbum(albumId, (a) => {
        if (to < 0 || to >= a.trackPaths.length) return a;
        const tracks = [...a.trackPaths];
        const [moved] = tracks.splice(from, 1);
        tracks.splice(to, 0, moved);
        return { ...a, trackPaths: tracks };
      }),

    createProject: async ({ name, templatePath, parentFolder, albumId, status }) => {
      const path = await api.createProject({ templatePath, parentFolder, name });
      get().updateSong(path, { status });
      if (albumId) get().addTracks(albumId, [path]);
      // The file exists now: a failed rescan is reported, never thrown (a
      // retry would only say "already exists").
      await scanOrReport();
      return path;
    },

    fileInboxSketch: async ({ itemId, parentFolder, name, bandlabUrl }) => {
      if (get().demoMode) throw new Error(tr(STORE_ERRORS).sample);
      // The song's stage and link go in the workspace: refuse before Rust
      // makes the folder, or the song would come back without them.
      if (!get().workspaceWritable) throw new Error(tr(STORE_ERRORS).notLoaded);
      const filed = await api.phoneInboxFileSketch(itemId, parentFolder, name);
      get().updateSong(filed.key, { status: "creation", ...(bandlabUrl ? { bandlabUrl } : {}) });
      await get().rescan();
      return filed;
    },

    continueSketch: async (sketchPath, templatePath) => {
      if (get().demoMode) throw new Error(tr(STORE_ERRORS).sample);
      const done = await api.continueSketch(sketchPath, templatePath);
      // Exactly a rename: the sketch's record now belongs to the .flp.
      if (get().workspaceWritable) followRelinks([{ from: sketchPath, to: done.flp, reason: "renamed" }]);
      await get().rescan();
      return done;
    },

    duplicateProject: async (path, newName) => {
      const created = await api.duplicateProject(path, newName);
      // The new version inherits the song's stage, tags, key, notes and
      // credits: not its crew share (one share id per song), Launch Kit or
      // archive flag.
      const meta = get().workspace.songs[path];
      if (meta) {
        const { tags, status, key, notes, credits } = meta;
        get().updateSong(created, { tags, status, key, notes, credits: credits?.map((c) => ({ ...c })) });
      }
      // The copy exists now: a failed rescan is reported, never thrown.
      await scanOrReport();
      return created;
    },

    restoreBackup: async (backupPath, projectPath) => {
      const created = await api.restoreBackup(backupPath, projectPath);
      await get().rescan();
      return created;
    },

    trashBackups: async (paths, allowPermanent) => {
      const count = await api.trashBackups(paths, allowPermanent);
      await get().rescan();
      return count;
    },
  };
});
