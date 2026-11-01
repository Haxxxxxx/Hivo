import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  DetectedFolder,
  AiStatus,
  AudioAnalysis,
  CoverImage,
  CoverStatus,
  PackagePlan,
  PackageResult,
  InboxList,
  InboxStatus,
  ProjectInfo,
  RenderEvent,
  Settings,
  Snippet,
  TemplateInfo,
  Workspace,
  BeatFile,
  YoutubeStatus,
  YoutubeVideo,
  DigResult,
  DigDeeperResult,
  Lead,
  SavedLead,
  LookupCandidate,
  LookupProfile,
  LookupSource,
  SpotifyStatus,
  PhoneSyncStatus,
  PhonePairing,
  PhoneSyncRequest,
} from "../types";

/** Scans the linked folders and export folder saved in Settings (Rust reads them). */
export async function scanProjects(): Promise<ProjectInfo[]> {
  return invoke("scan_projects");
}

export async function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

/** Saves preferences. Path settings are kept as saved (they change only
 * through the pickers below); returns what's saved. */
export async function saveSettings(settings: Settings): Promise<Settings> {
  return invoke("save_settings", { settings });
}

// Path settings: native pickers and detection run in Rust, so the webview
// can never point the app at other folders or programs. Each returns the
// saved settings (unchanged if the picker was cancelled).
export const pickWatchedFolder = (): Promise<Settings> => invoke("pick_watched_folder");
/** Links a folder detection found (Rust refuses anything it didn't detect). */
export const linkDetectedFolder = (path: string): Promise<Settings> => invoke("link_detected_folder", { path });
export const removeWatchedFolder = (folder: string): Promise<Settings> => invoke("remove_watched_folder", { folder });
export const pickOutputFolder = (): Promise<Settings> => invoke("pick_output_folder");
/** Beats folders (the Digger), picked natively like project folders. */
export const pickBeatFolder = (): Promise<Settings> => invoke("pick_beat_folder");
export const removeBeatFolder = (folder: string): Promise<Settings> => invoke("remove_beat_folder", { folder });
/** Sample libraries: where moved packs are looked up by file name. */
export const pickSampleFolder = (): Promise<Settings> => invoke("pick_sample_folder");
export const removeSampleFolder = (folder: string): Promise<Settings> => invoke("remove_sample_folder", { folder });
export const scanBeats = (): Promise<BeatFile[]> => invoke("scan_beats");
/** Whether a YouTube Data API key is set (the key itself never comes back). */
export const youtubeStatus = (): Promise<YoutubeStatus> => invoke("youtube_status");
/** Whether the app runs from a read-only place on macOS ("dmg", "translocated") or null. */
export const appLocation = (): Promise<{ readOnly: "dmg" | "translocated" | null }> => invoke("app_location");
/** Saves (or, with null, removes) the YouTube key. */
export const setYoutubeKey = (key: string | null): Promise<void> => invoke("set_youtube_key", { key });
/** YouTube music-video search (Rust side, cached for a few hours). */
export const youtubeSearch = (query: string): Promise<YoutubeVideo[]> => invoke("youtube_search", { query });
/** The dig: Rust checks the beats, analyses them and builds the Gemini prompts. */
export const digBeats = (beats: string[], language: "fr" | "en"): Promise<DigResult> => invoke("dig_beats", { request: { beats, language } });
/** "Go deeper": one more web search seeded by the dig, skipping the urls already
 * found, or new searches told the titles already shown. The seed is the four
 * analysis fields: `heard` is what the dig said, not part of it. */
export const digDeeper = (
  { summary, traits, tempo, queries }: DigResult["analysis"],
  exclude: string[],
  foundTitles: string[],
  searchesDone: string[],
  likedTitles: string[],
  language: "fr" | "en",
): Promise<DigDeeperResult> =>
  invoke("dig_deeper", { request: { analysis: { summary, traits, tempo, queries }, exclude, foundTitles, searchesDone, likedTitles, language } });
/** Writes `<first beats folder>/_leads/<slug>-<hash>.md` (text only, never
 * audio); returns the file's path. Saving the same url again overwrites it. */
export const saveLead = (lead: Lead): Promise<string> => invoke("save_lead", { lead });
/** The leads saved in the beats folders' `_leads`, newest first, with their facts. */
export const listLeads = (): Promise<SavedLead[]> => invoke("list_leads");
/** Deletes one lead file (must be inside a beats folder's `_leads`). */
export const deleteLead = (path: string): Promise<void> => invoke("delete_lead", { path });

/** Artist profile lookup (Rust: lookup.rs): MusicBrainz, Deezer, iTunes, and Spotify with credentials. */
export const lookupArtists = (query: string): Promise<LookupCandidate[]> => invoke("lookup_artists", { query });
export const lookupProfile = (source: LookupSource, id: string): Promise<LookupProfile> => invoke("lookup_profile", { source, id });
export const spotifyStatus = (): Promise<SpotifyStatus> => invoke("spotify_status");
export const setSpotifyCredentials = (clientId: string | null, clientSecret: string | null): Promise<void> =>
  invoke("set_spotify_credentials", { clientId, clientSecret });
export const pickFlStudio = (): Promise<Settings> => invoke("pick_fl_studio");
export const useDetectedFlStudio = (): Promise<Settings> => invoke("use_detected_fl_studio");
export const pickFfmpeg = (): Promise<Settings> => invoke("pick_ffmpeg");
export const clearPathSetting = (which: "flStudio" | "ffmpeg" | "outputFolder"): Promise<Settings> => invoke("clear_path_setting", { which });

export async function getWorkspace(): Promise<Workspace | null> {
  return invoke("get_workspace");
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  return invoke("save_workspace", { workspace });
}

/** What the "can't read your workspace" strip can offer. */
export interface WorkspaceFiles {
  hasBackup: boolean;
  backupSavedAtMs: number | null;
}
export const workspaceFiles = (): Promise<WorkspaceFiles> => invoke("workspace_files");
/** Puts `workspace.json.bak` back (the unreadable file is kept as `.bad`). */
export const restoreWorkspaceBackup = (): Promise<Workspace> => invoke("restore_workspace_backup");
/** "Start fresh": the unreadable workspace is kept as `workspace.json.bad`. */
export const setAsideWorkspace = (): Promise<void> => invoke("set_aside_workspace");
/** Shows the app's config folder (workspace.json, settings.json) in Finder / Explorer. */
export const showConfigFolder = (): Promise<void> => invoke("show_config_folder");
/** settings.json didn't parse and was reset: where the old file was kept (answers once). */
export const takeSettingsRecovery = (): Promise<string | null> => invoke("take_settings_recovery");
/** Saved folders (projects, beats, samples, export) that can't be reached right now. */
export const unreachableSettingFolders = (): Promise<string[]> => invoke("unreachable_setting_folders");

export async function detectFlStudio(): Promise<string | null> {
  return invoke("detect_fl_studio");
}

/** Every DAW's default projects folder on this computer (read-only). */
export async function detectDawFolders(): Promise<DetectedFolder[]> {
  return invoke("detect_daw_folders");
}

/** FL Studio, the format and the export folder come from Settings on the Rust side. */
export async function renderProjects(args: { projectPaths: string[]; subfolder?: string; outputNames?: string[] }): Promise<void> {
  return invoke("render_projects", args);
}

export function onRenderProgress(
  handler: (event: RenderEvent) => void,
): Promise<UnlistenFn> {
  return listen<RenderEvent>("render-progress", (e) => handler(e.payload));
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  return invoke("list_templates");
}

export async function defaultTemplate(): Promise<string | null> {
  return invoke("default_template");
}

export async function createProject(args: {
  templatePath: string;
  parentFolder: string;
  name: string;
}): Promise<string> {
  return invoke("create_project", args);
}

// BandLab sketches (src-tauri/src/sketch.rs): they arrive from the phone
// (phoneInboxFileSketch below).
/** Copies the template to `<song>/<song>.flp` beside the sketch's BandLab
 * folder; returns the new .flp path. */
/** What "Continue in FL Studio" made: the new .flp, the clips laid out on its
 * playlist (0 = the template alone), and why / what was converted. */
export interface Continued {
  flp: string;
  clips: number;
  note: string | null;
}
export const continueSketch = (sketchPath: string, templatePath: string): Promise<Continued> => invoke("continue_sketch", { sketchPath, templatePath });

export async function duplicateProject(projectPath: string, newName: string): Promise<string> {
  return invoke("duplicate_project", { projectPath, newName });
}

export async function restoreBackup(backupPath: string, projectPath: string): Promise<string> {
  return invoke("restore_backup", { backupPath, projectPath });
}

/** Moves listed backups to the Recycle Bin / Trash. Backups on a drive
 * without one are refused unless `allowPermanent` (the user said so). */
export async function trashBackups(paths: string[], allowPermanent = false): Promise<number> {
  return invoke("trash_backups", { paths, allowPermanent });
}

/** The backups among `paths` on a removable or network drive, where deleting is permanent. */
export async function backupsOnRiskyVolumes(paths: string[]): Promise<string[]> {
  return invoke("backups_on_risky_volumes", { paths });
}

/** What each package would hold. Nothing is written. */
export async function packagePreview(projectPaths: string[]): Promise<PackagePlan[]> {
  return invoke("package_preview", { projectPaths });
}

/** Zipped loop packages (.flp + samples, flat) — FL opens these directly.
 * `approved` lines up with `projectPaths`: the sample paths the user confirmed. */
export async function packageProjects(args: { projectPaths: string[]; subfolder?: string; approved: string[][] }): Promise<PackageResult[]> {
  return invoke("package_projects", args);
}

export function onPackageProgress(handler: (result: PackageResult) => void): Promise<UnlistenFn> {
  return listen<PackageResult>("package-progress", (e) => handler(e.payload));
}

/** Duration, loudness curve and the strongest snippets of a mixdown. */
export async function analyzeAudio(path: string, bpm: number | null): Promise<AudioAnalysis> {
  return invoke("analyze_audio", { path, bpm });
}

/** Writes `<export folder>/Launch Kits/<folderName>` (text files, master
 * copy, snippet clips). The folder name is sanitized on the Rust side. */
export async function exportLaunchKit(args: {
  folderName: string;
  files: { name: string; content: string }[];
  master: string | null;
  masterName: string;
  clips: Snippet[];
}): Promise<string> {
  return invoke("export_launch_kit", args);
}

/** Whether a Gemini key is set (never the key itself). */
export async function aiStatus(): Promise<AiStatus> {
  return invoke("ai_status");
}

/** Saves the Gemini key on this machine; null removes it. */
export async function setAiKey(key: string | null): Promise<void> {
  return invoke("set_ai_key", { key });
}

/** A Launch Kit draft or check (retries and a backup model on the Rust
 * side). Rust builds the prompt from these typed facts; it refuses unknown
 * keys and drops notes unless Settings allows them. */
export async function aiKit(request: {
  kind: "draft" | "review";
  model: string | null;
  language: string | null;
  context: object;
  fields: Record<string, string>;
}): Promise<{ model: string; data: unknown }> {
  return invoke("ai_kit", { request });
}

export interface ShortsStatus {
  /** Where ffmpeg was found; null = not installed / not found. */
  path: string | null;
  encoder: string | null;
  error: string | null;
}

export async function shortsStatus(): Promise<ShortsStatus> {
  return invoke("shorts_status");
}

export interface ShortResult {
  label: string;
  path: string | null;
  error: string | null;
}

/** Renders 9:16 MP4s into `<export folder>/Launch Kits/<folderName>/shorts/`. */
export async function renderShorts(args: {
  master: string;
  clips: { label: string; startSec: number; lengthSec: number; layoutPng: string }[];
  folderName: string;
}): Promise<ShortResult[]> {
  return invoke("render_shorts", args);
}

/** Whether Cloudflare Workers AI credentials are set (never the values). */
export async function coverStatus(): Promise<CoverStatus> {
  return invoke("cover_status");
}

/** Saves the Cloudflare account ID + API token on this machine; both null
 * removes them. */
export async function setCoverCredentials(accountId: string | null, token: string | null): Promise<void> {
  return invoke("set_cover_credentials", { accountId, token });
}

/** One FLUX.1 [schnell] cover concept (retries on the Rust side). */
export async function generateCover(prompt: string, seed: number | null): Promise<CoverImage> {
  return invoke("generate_cover", { prompt, seed });
}

/** Writes `<export folder>/Launch Kits/<folderName>/cover-concept.jpg`. */
export async function saveCover(args: { folderName: string; imageB64: string }): Promise<string> {
  return invoke("save_cover", args);
}

export interface KitFile {
  path: string;
  /** Inside the kit folder, e.g. "snippets/Hook 15s.wav". */
  relative: string;
  sizeBytes: number;
}

/** What's in `<export folder>/Launch Kits/<folderName>/` (empty if never exported). */
export async function kitFiles(folderName: string): Promise<KitFile[]> {
  return invoke("kit_files", { folderName });
}

/** URL the webview can stream a local audio file from (asset protocol). */
export function audioSrc(path: string): string {
  return convertFileSrc(path);
}



/** Opens a DAW project in its app. Rust refuses network paths and non-projects. */
export async function openInFlStudio(path: string): Promise<void> {
  await invoke("open_project", { path });
}

/** Opens an https link in the default browser. */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

/** Shows a file in Finder / Explorer. Rust refuses network paths. */
export async function revealInFileManager(path: string): Promise<void> {
  await invoke("reveal_path", { path });
}

// ---- Phone sync (src-tauri/src/phone_sync.rs, docs/PHONE-SYNC.md) ----
export const phoneSyncStatus = (): Promise<PhoneSyncStatus> => invoke("phone_sync_status");
/** Opens (true) or closes (false) the local network port; saved. */
export const phoneSyncEnable = (on: boolean): Promise<PhoneSyncStatus> => invoke("phone_sync_enable", { on });
/** A new device and its QR url. The key in it is never returned again. */
export const phoneSyncPair = (): Promise<PhonePairing> => invoke("phone_sync_pair");
export const phoneSyncForget = (deviceId: string): Promise<PhoneSyncStatus> => invoke("phone_sync_forget", { deviceId });
/** Answers a forwarded request: a body, or a short error ("demo", "busy"). */
export const phoneSyncReply = (id: string, reply: { body: unknown } | { error: string }): Promise<void> =>
  invoke("phone_sync_reply", { id, body: "body" in reply ? reply.body : null, error: "error" in reply ? reply.error : null });
export function onPhoneSyncRequest(handler: (request: PhoneSyncRequest) => void): Promise<UnlistenFn> {
  return listen<PhoneSyncRequest>("phone-sync-request", (e) => handler(e.payload));
}

// Phone inbox (src-tauri/src/phone_inbox.rs, docs/PHONE-SYNC.md v1.1). Items
// are named by id; Rust resolves every path from Settings.
/** Sample data on screen: the phone's uploads and ideas are refused while on. */
export const phoneSyncSetDemo = (on: boolean): Promise<void> => invoke("phone_sync_set_demo", { on });
export const phoneInboxList = (): Promise<InboxList> => invoke("phone_inbox_list");
/** `<parentFolder>/<name>/BandLab/` with the sketch's audio (zips unpacked); returns the sketch's key. */
export const phoneInboxFileSketch = (id: string, parentFolder: string, name: string): Promise<string> =>
  invoke("phone_inbox_file_sketch", { id, parentFolder, name });
/** Copies a memo (or a sketch's audio) into `<song folder>/Voice memos/`; returns the copies. */
export const phoneInboxAttachSong = (id: string, songPath: string): Promise<string[]> => invoke("phone_inbox_attach_song", { id, songPath });
export const phoneInboxMark = (id: string, status: InboxStatus, filedTo: string | null = null): Promise<void> =>
  invoke("phone_inbox_mark", { id, status, filedTo });
export const phoneInboxRemove = (id: string): Promise<void> => invoke("phone_inbox_remove", { id });
export function onPhoneInboxChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("phone-inbox-changed", () => handler());
}
