import type { DashboardLayout } from "./lib/dashboardLayout";

export interface FileEntry {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

/** One song: the main .flp plus what FL keeps around it (see scanner.rs). */
export interface StemsInfo {
  folder: string;
  count: number;
  bytes: number;
  newestMs: number;
}

/** "bandlab" = a BandLab sketch: `<song>/BandLab/` audio with no project yet
 * (keyed by that folder's path, see src-tauri/src/sketch.rs). */
export type DawId = "fl-studio" | "ableton" | "reaper" | "studio-one" | "pro-tools" | "cubase" | "bitwig" | "bandlab";

/** A DAW's default projects folder found on this computer (Settings → Auto-detect DAWs). */
export interface DetectedFolder {
  daw: string;
  path: string;
  /** Projects found inside (up to 999). */
  projects: number;
  /** Already linked. */
  linked: boolean;
}

export interface ProjectInfo {
  path: string;
  /** Why nothing could be read from inside the project (damaged, oversized
   * or hostile file). The project is still listed. */
  readError?: string;
  name: string;
  folder: string;
  sizeBytes: number;
  modifiedAtMs: number;
  root: string;
  // Read directly out of the .flp binary (best-effort — see
  // src-tauri/src/flp_metadata.rs). Empty/untrusted values come back null.
  genre: string | null;
  artist: string | null;
  tempoBpm: number | null;
  timeSigNum: number | null;
  timeSigDenom: number | null;
  flVersion: string | null;
  isTemplate: boolean;
  /** FL's auto-backups of this project, newest first. */
  backups: FileEntry[];
  /** Mixdowns next to the .flp (e.g. Envy.wav), newest first. */
  renders: FileEntry[];
  recordingsCount: number;
  recordingsBytes: number;
  /** Which DAW the project belongs to (missing from pre-multi-DAW data = FL Studio). */
  daw?: DawId;
  /** The DAW version that saved it, when readable ("Ableton Live 11.3.4"). */
  dawVersion?: string | null;
  /** Title and comment from FL Studio's project info (File → Project info). */
  flpTitle?: string | null;
  comment?: string | null;
  /** Exported stems: a stems folder next to the project, or FL's split-mixer
   * export (`<name>_<track>.wav`, two or more) beside the .flp. */
  stems: StemsInfo | null;
  plugins: PluginInfo[];
  samples: SampleInfo[];
  /** Named mixer tracks + recorded-take labels ("Lead Voices - Nova"). */
  trackNames: string[];
  /** Mixdowns in the export folder named after this song that weren't
   * counted: another linked song has the same name, and the file name can't
   * say which one it came from. */
  ambiguousExports?: number;
  /** A cloud placeholder (iCloud Drive, OneDrive, Dropbox): not downloaded
   * to this computer, so it isn't opened (that would download it). What's
   * read from inside comes from an earlier read, when there was one. */
  inCloud?: boolean;
}

/** What `scan_projects` returns: the projects, and the linked folders that
 * couldn't be read right now (their songs are missing, not moved). */
export interface ScanResult {
  projects: ProjectInfo[];
  unreachable: string[];
  /** Symlinked folders / junctions the walk didn't follow: how many, and a
   * few of them. */
  skippedLinks?: number;
  skippedLinkExamples?: string[];
}

export interface PluginInfo {
  name: string;
  vendor: string | null;
  /** Third-party only; null for FL's native plugins. */
  installed: boolean | null;
}

/** ok = where the project says; relocated = found by name in the song's
 * folder (project was moved, FL can usually find it); missing = gone. */
export type SampleStatus = "ok" | "relocated" | "missing";

export interface SampleInfo {
  path: string;
  status: SampleStatus;
}

export interface TemplateInfo {
  name: string;
  category: string;
  path: string;
}

export interface Settings {
  watchedFolders: string[];
  flStudioPath: string | null;
  outputFolder: string | null;
  renderFormat: RenderFormat;
  favorites: string[];
  /** Gemini model id; null = the default. */
  aiModel: string | null;
  /** Language for AI-written copy; null = English. */
  aiLanguage: string | null;
  /** Send the song's notes with "Check kit" (off by default). */
  aiIncludeNotes: boolean;
  /** Language of Launch Kit captions and the kit README (overridable per kit). */
  captionLanguage: CaptionLang;
  /** The app's language: follow the system, or French / English. */
  uiLanguage?: "system" | "fr" | "en";
  /** Folders of raw beats (the Digger). Changed only through the Rust picker. */
  beatFolders?: string[];
  /** Sample libraries (packs, Splice…): the scanner finds samples stored
   * under another path in there by file name. Changed only through the Rust picker. */
  sampleFolders?: string[];
  /** The Digger sends a 30 s low-quality excerpt of each picked beat to Gemini (off by default). */
  digSendAudio?: boolean;
  /** ffmpeg for shorts; null = found automatically. */
  ffmpegPath: string | null;
  /** A uuid made once on this install: the feedback form's rate-limit key (nothing else). */
  installId?: string;
  /** The Digger's optional converter link: an https url with `{url}` where
   * the video address goes. Opened in the browser; Hivo never calls it. */
  converterUrlTemplate?: string;
}

export type RenderFormat = "wav" | "mp3" | "ogg";

export type RenderStatus = "queued" | "rendering" | "done" | "error";

export interface RenderEvent {
  projectPath: string;
  projectName: string;
  status: RenderStatus;
  /** An error (Rust's English message); warnings are the fields below. */
  message: string | null;
  outputPath: string | null;
  /** Samples staged from where the scan found them (moved). */
  movedSamples?: number;
  /** Stored sample paths that couldn't be staged: silent in the mixdown. */
  missingSamples?: string[];
}

// ---- Workspace: the app's own data, which FL Studio doesn't store ----

/** The song lifecycle (docs/ROADMAP.md): one stage at a time. */
export type SongStatus = "creation" | "production" | "prep" | "release" | "promotion";

/** "Ana moved it to Prep meanwhile": the two moves, until the owner picks one. */
/** One stage change: the stage the song entered and when. */
export interface StageLogEntry {
  stage: SongStatus;
  atMs: number;
}

export interface StageConflict {
  mine: SongStatus | null;
  theirs: SongStatus | null;
  /** Who made the crew's move (user id), when known. */
  by: string | null;
  /** The crew row's version carrying their move. */
  at: string;
}

export interface SongMeta {
  status?: SongStatus;
  /** The stage before the lifecycle migration (idea/wip/mixing/mastering/done). */
  legacyStatus?: string;
  /** When the stage last changed (here or on the crew board). Display and
   * a one-time tiebreak for songs shared before stage versions. */
  stageUpdatedAtMs?: number;
  /** The crew row's version (stage_updated_at) this stage is based on. */
  stageBaseAt?: string;
  /** A local stage move the crew hasn't received yet. */
  stagePending?: boolean;
  /** A crewmate moved the song while this computer's move was waiting. */
  stageConflict?: StageConflict;
  /** The crewmate (user id) whose move on the crew board set the current
   * stage (its time is `stageUpdatedAtMs`). Cleared by a move of mine. */
  stageMovedBy?: string;
  /** Every stage the song entered, oldest first (`src/lib/stageLog.ts`).
   * Starts empty: nothing before the log existed is guessed. Local only. */
  stageLog?: StageLogEntry[];
  /** Shared with the crew (opt-in per song). */
  shared?: boolean;
  /** Stable id of this song in the crew database, set on first share. Kept
   * after unsharing (with `shared: false`) so the next sync deletes the row. */
  shareId?: string;
  /** The crew and account it's shared with/by. A share belongs to one crew
   * and one account: other crews and other sign-ins on this machine never
   * push or delete it. Missing = shared before scoping (adopted on next sync). */
  shareCrewId?: string;
  shareUserId?: string;
  /** The title the crew sees; empty = cleaned-up project file name. */
  shareTitle?: string;
  tags?: string[];
  notes?: string;
  /** Musical key, e.g. "Am", "F#". FL doesn't store one. */
  key?: string;
  /** Hidden from the library, board and stats (the yearly "clear out"). */
  archived?: boolean;
  /** The pipeline column it sits in (a column of its stage, see
   * src/lib/pipeline.ts). Missing or stale = the first column of its stage. */
  column?: string;
  credits?: Credit[];
  pitches?: Pitch[];
  launchKit?: LaunchKitMeta;
  /** The song's BandLab project link (https only, see src/lib/sketch.ts).
   * Local only: never shared with the crew. */
  bandlabUrl?: string;
}

// ---- Launch Kit ----

export type KitFieldId =
  | "title"
  | "artists"
  | "producers"
  | "genre"
  | "bpm"
  | "key"
  | "duration"
  | "explicit"
  | "releaseDate"
  | "coverBrief"
  | "captions"
  // Distribution (what DistroKid, TuneCore, CD Baby, Amuse… ask for)
  | "featuring"
  | "songwriters"
  | "label"
  | "copyright"
  | "language"
  | "isrc"
  | "upc"
  | "releaseTitle"
  | "releaseType"
  | "trackNumber";

/** The user's side of a launch kit. Everything else is regenerated from the
 * project each time, so the .flp stays the source of truth. */
/** Languages captions are written in. */
export type CaptionLang = "fr" | "en";

export interface LaunchKitMeta {
  /** This kit's caption language, when it differs from Settings. */
  captionLanguage?: CaptionLang;
  /** Values the user typed over the generated ones. */
  edits?: Partial<Record<KitFieldId, string>>;
  /** Snippet label → start (s), when moved off the detected spot. */
  snippetStarts?: Record<string, number>;
  /** Snippet label → length (s), when changed from the detected one. */
  snippetLengths?: Record<string, number>;
  /** Set by "Accept all"; cleared by any later edit. */
  acceptedAtMs?: number;
  /** What the kit was accepted against (master file, credits, release:
   * `acceptFingerprint`): a change outside the kit undoes "Accepted". */
  acceptedFingerprint?: string;
  /** Where `edits.releaseDate` came from: kept from a suggestion (accept or
   * export pins it) or typed. A suggestion never beats the release's date. */
  releaseDatePin?: "suggested" | "typed";
  /** The mixdown picked as the master (a path among the song's renders);
   * unset = the newest lossless render, else the newest. */
  master?: string;
  /** The last export: when, what (`exportFingerprint`) and the folder name
   * it went to (so a re-export after a rename cleans up the old one). */
  exported?: { atMs: number; fingerprint: string; folder: string };
  /** The user marked the final 3000 × 3000 cover as ready. */
  finalCoverDone?: boolean;
  /** A pre-save link (https). Captions mention a pre-save only when set. */
  preSaveUrl?: string;
  /** Opt-in: the credited people's platform IDs (Spotify artist ID…) go
   * into the exported kit (artist-ids.md, distributor sheet, metadata). */
  includeArtistIds?: boolean;
  ai?: KitAiMeta;
  /** The picked cover concept: small metadata only, never image bytes
   * (the image itself is cover-concept.jpg in the kit folder). */
  cover?: KitCoverMeta;
}

export interface KitCoverMeta {
  /** FLUX seed and prompt that made it, so "more like this" can follow up. */
  seed: number;
  prompt: string;
  /** Index into COVER_VARIANTS (src/lib/cover.ts). */
  variant: number;
  /** Where "Save to kit" wrote it, if it did. */
  savedPath?: string;
  savedAtMs?: number;
}

export interface AiFieldReview {
  verdict: "ok" | "check" | "wrong";
  /** How sure the model is of its verdict, 0–1. */
  confidence: number;
  reason: string;
  suggestion?: string;
  /** The value that was checked; a different current value = stale. */
  checkedValue: string;
}

export interface KitAiMeta {
  /** AI-written text, used unless the user edited the field. */
  drafts?: {
    captions: string;
    coverBrief: string;
    model: string;
    atMs: number;
    /** The facts the text was written for; if they change, it's outdated. */
    basis?: { title: string; artists: string; releaseDate: string; language?: CaptionLang };
  };
  review?: { fields: Partial<Record<KitFieldId, AiFieldReview>>; model: string; atMs: number };
}

export interface AiStatus {
  configured: boolean;
  source: "env" | "settings" | null;
  defaultModel: string;
}

/** Whether Cloudflare Workers AI credentials are set (never the values). */
export interface CoverStatus {
  configured: boolean;
  source: "env" | "settings" | null;
  model: string;
}

/** One FLUX concept, as returned by `generate_cover`. */
export interface CoverImage {
  /** Base64 JPEG. Kept in memory only, never in the workspace. */
  imageB64: string;
  seed: number;
  /** False if Cloudflare refused the seed (the image is unseeded). */
  seedApplied: boolean;
  width: number | null;
  height: number | null;
}

export interface Snippet {
  /** Shown and used for file names ("Hook 30s"); follows the length. */
  label: string;
  startSec: number;
  lengthSec: number;
  /** Why it was picked ("comes back 3 times"), from the analysis. */
  reason?: string;
  /** The detected snippet's label: the key the user's edits are stored under. */
  key?: string;
}

/** The mixdown file itself, for the distributor checks. */
export interface MasterSpec {
  container: string;
  sampleRate: number;
  channels: number;
  /** null for lossy formats (MP3/OGG). */
  bitsPerSample: number | null;
  /** Highest absolute sample, 0–1 (1 = 0 dBFS). */
  peak: number;
  clippedSamples: number;
}

export interface AudioAnalysis {
  durationSec: number;
  windowSec: number;
  /** Loudness per window, loudest = 1. */
  energy: number[];
  snippets: Snippet[];
  /** Estimated from the audio (Krumhansl–Schmuckler); missing for sample data. */
  key?: { key: string; confidence: number } | null;
  /** Missing for sample data. */
  master?: MasterSpec;
}

/** A collaborator or contact. Aliases are how they appear in track names
 * ("NV", "Novah" for Nova). */
export interface Person {
  id: string;
  name: string;
  aliases: string[];
  contact: string;
  notes: string;
  /** Looked-up profiles (People → Look up profiles). Local only: never
   * shared with the crew. */
  mbid?: string | null;
  links?: PlatformLink[];
  spotify?: SpotifyDetails | null;
  /** ISO date of the last lookup. */
  lookedUpAt?: string;
}

/** What a by-name match (Deezer, Apple Music) says about the artist it
 * found, so two artists with the same name can be told apart. */
export interface MatchInfo {
  fans: number | null;
  albums: number | null;
  genre: string | null;
  topTrack: string | null;
}

/** A profile on one platform (Rust: lookup.rs): the link, rebuilt from the
 * id for known platforms, and the id distributors ask for. */
export interface PlatformLink {
  platform: string;
  label: string;
  category: "streaming" | "social" | "other";
  url: string;
  id: string | null;
  source: "musicbrainz" | "deezer" | "itunes" | "manual";
  /** false: found by name only (Deezer, Apple Music), the user hasn't
   * confirmed it's the same artist; its id doesn't count yet. Missing on
   * links stored before 0.6.3 (see `linkVerified` in src/lib/profiles.ts). */
  verified?: boolean;
  matchInfo?: MatchInfo;
}

export interface SpotifyDetails {
  id: string;
  /** null when Spotify doesn't return them (newer apps in development mode
   * get artist objects without followers, popularity or genres). */
  followers: number | null;
  popularity: number | null;
  genres: string[];
  imageUrl: string | null;
}

export type LookupSource = "musicbrainz" | "spotify";

/** One artist to pick from (MusicBrainz, or Spotify with credentials). */
export interface LookupCandidate {
  source: LookupSource;
  id: string;
  name: string;
  disambiguation: string;
  country: string;
  kind: string;
  score: number;
  followers: number | null;
}

export interface LookupProfile {
  source: LookupSource;
  mbid: string | null;
  name: string;
  links: PlatformLink[];
  spotify: SpotifyDetails | null;
  /** "no credentials", or Spotify's error, when a Spotify link exists but no details. */
  spotifyNote: string | null;
}

export interface SpotifyStatus {
  configured: boolean;
  source: string | null;
}

export interface Credit {
  personId: string;
  role: string;
  /** Percentage share, if agreed. */
  split?: number;
}

export type PitchOutcome = "sent" | "listened" | "interested" | "placed" | "sold" | "passed";

/** "Sent this beat to X on date — what happened." */
export interface Pitch {
  id: string;
  personId: string;
  /** yyyy-mm-dd */
  date: string;
  outcome: PitchOutcome;
  note?: string;
}

export interface PackageResult {
  projectPath: string;
  zipPath: string | null;
  bytes: number;
  included: number;
  missing: string[];
  /** Paths refused for the package ("path — reason"). */
  refused?: string[];
  error: string | null;
}

/** What a package would hold, shown before anything is written. */
export interface PackagePlan {
  projectPath: string;
  files: { path: string; name: string; bytes: number }[];
  /** Paths the project lists that are never packaged (not audio, hidden, network…). */
  refused: { path: string; reason: string }[];
  missing: string[];
  error: string | null;
}

export type AlbumKind = "album" | "ep" | "single" | "mixtape";

export interface Album {
  id: string;
  title: string;
  kind: AlbumKind;
  color: string;
  /** ISO date (yyyy-mm-dd), or null if no target date yet. */
  releaseDate: string | null;
  notes: string;
  /** Ordered tracklist, by .flp path. */
  trackPaths: string[];
  createdAtMs: number;
  /** Shared with the crew (the release and its shared tracks). */
  shared?: boolean;
  /** Its id in the crew database, set on first share; kept after unsharing
   * (with `shared: false`) so the next sync deletes the row. */
  shareId?: string;
  shareCrewId?: string;
  shareUserId?: string;
}

export interface Workspace {
  /** 2 = roadmap lifecycle stages (see migrateWorkspace). */
  version: 2;
  /** Keyed by .flp path. */
  songs: Record<string, SongMeta>;
  albums: Album[];
  people: Person[];
  /** The user's pipeline columns. Missing = one column per stage. */
  pipeline?: PipelineConfig;
  /** Shared releases deleted here: their crew rows are deleted on the next sync. */
  deletedReleaseShares?: { id: string; crewId?: string; userId?: string }[];
  /** How the "Me" dashboard is arranged. Missing = the default
   * (src/lib/dashboardLayout.ts); normalized on read, never on load. */
  dashboard?: DashboardLayout;
  /** Notes on the Digger's saved prods, by lead url hash (`leadHash`). Kept
   * here, not in the lead files, so re-saving a prod never wipes them. */
  leadNotes?: Record<string, string>;
  /** Notes on beats (Settings → Beats folders), by file path. */
  beatNotes?: Record<string, string>;
  /** The size of each tracked beat (noted, or linked to a saved prod by
   * hand), so a moved or renamed file finds its notes and links again on the
   * next complete scan (`relinkBeatNotes`). */
  beatNoteSizes?: Record<string, number>;
  /** Tombstones of beat notes/links moved to another path, by old path:
   * dropped once a later complete scan finds the new path, undone (the note
   * restored) if the old path comes back first. */
  beatNoteMoves?: Record<string, BeatMove>;
  /** Saved prod (lead hash) → the beat file that is it (path), set by hand
   * ("This is…"); null = "not in your prods", overriding the name match.
   * Follows the beat when it moves (`relinkBeatNotes`); a path the scan
   * no longer has falls back to the name match (`matchBeat`). */
  leadBeats?: Record<string, string | null>;
  /** Songs and beats that moved to a new path (relinks, renames, "Continue
   * in FL Studio"), kept a few days for the phone's `/v1/snapshot`
   * `renamed` list, so its pending note edits follow (src/lib/phoneSync.ts). */
  phoneRenames?: { kind: "song" | "beat"; from: string; to: string; at: number }[];
  /** Set only on generated sample data (src/lib/sampleData.ts): a workspace
   * carrying it is never written to disk. */
  sample?: true;
}

/** A pipeline column. Columns sit on the fixed lifecycle stages: putting a
 * song in a column sets that stage, so crew sync, "finished", stalled and the
 * calendar keep working. null = Unsorted. */
export interface PipelineColumn {
  id: string;
  name: string;
  stage: SongStatus | null;
}

export interface PipelineConfig {
  /** Display order. Every stage (and Unsorted) keeps at least one column. */
  columns: PipelineColumn[];
  /** Hand-sorted card order per column id (.flp paths). Songs not listed
   * follow, most recently saved first. */
  order: Record<string, string[]>;
}

/** Whether the newest mixdown is newer than the last save of the project. */
export type RenderFreshness = "fresh" | "stale" | "none";

// ---- Crew (Supabase, EU) — rows as stored in supabase/migrations/*_crew.sql ----

export interface CrewCredit {
  name: string;
  role: string;
  split: number | null;
}

/** A song's shared metadata. Never audio, file paths, samples or notes. */
export interface CrewSongRow {
  id: string;
  crew_id: string;
  owner_id: string;
  title: string;
  stage: SongStatus | null;
  bpm: number | null;
  musical_key: string | null;
  tags: string[];
  credits: CrewCredit[];
  release_date: string | null;
  has_mixdown: boolean;
  /** The newest mixdown is at least as new as the last save. Null: no
   * mixdown, or sent by a Hivo from before this column (freshness unknown). */
  mixdown_fresh?: boolean | null;
  kit_accepted: boolean;
  last_saved_at: string | null;
  stage_updated_at: string;
  stage_updated_by?: string | null;
  /** The crew board column it sits in (null: its stage's first column). */
  column_id?: string | null;
  /** Hand-placed position in its column (null: not placed by hand). */
  board_order?: number | null;
  updated_at?: string;
}

/** A release shared with the crew (releases). Only its owner edits it. */
export interface CrewReleaseRow {
  id: string;
  crew_id: string;
  owner_id: string;
  title: string;
  kind: AlbumKind;
  color: string | null;
  release_date: string | null;
  /** Crew song ids, in tracklist order. */
  song_ids: string[];
  updated_at?: string;
}

/** A crew board column (crew_columns). Only the owner edits them. */
export interface CrewColumnRow {
  id: string;
  crew_id: string;
  name: string;
  stage: SongStatus | null;
  position: number;
}

/** An open invite code (owners only; row-level security returns none to members). */
export interface CrewInvite {
  code: string;
  crew_id: string;
  expires_at: string;
  max_uses: number;
  uses: number;
}

export interface CrewMemberRow {
  crew_id: string;
  user_id: string;
  display_name: string;
  role: "owner" | "member";
  joined_at?: string;
}

export interface CrewSummary {
  id: string;
  name: string;
  role: "owner" | "member";
  displayName: string;
}

/** A raw beat in a beats folder (src-tauri/src/beats.rs). */
export interface BeatFile {
  path: string;
  /** File name without extension. */
  name: string;
  folder: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

/** A beat's notes (or a lead's link) moved from one path to another: kept
 * until the move is confirmed, so the note comes back if the old path does. */
export interface BeatMove {
  to: string;
  size: number;
  /** The note as it was moved (absent when only lead links moved). */
  text?: string;
}

/** The beats scan (src-tauri/src/beats.rs BeatScan). */
export interface BeatScan {
  beats: BeatFile[];
  /** Beats found, including those past the cap. */
  total: number;
  /** The scan stopped early: `total` is a floor. */
  capped: boolean;
  /** Audio files in formats the Digger can't read (opus, aac…). */
  ignored: number;
  /** Beats folders (or folders in them) that couldn't be read: their beats
   * are missing from `beats`, not gone. */
  unreachable: number;
}

/** One beat's offline analysis (src-tauri/src/beats.rs analyze_beats). */
export interface BeatAnalysis {
  path: string;
  facts: BeatFacts | null;
  error: string | null;
}

export interface YoutubeStatus {
  configured: boolean;
  source: "env" | "settings" | null;
}

/** One YouTube search result. `url` and `thumbnail` are rebuilt in Rust from a checked video ID. */
export interface YoutubeVideo {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  url: string;
  thumbnail: string;
}

/** What the dig measured on one beat (src-tauri/src/digger.rs BeatFacts). */
export interface BeatFacts {
  name: string;
  durationSec: number;
  /** Decoding stopped at 10 minutes: shown as "10:00+". */
  durationCapped?: boolean;
  bpm: number | null;
  /** "name" = written in the file name, "audio" = estimated (may be half or double). */
  bpmSource: "name" | "audio" | null;
  key: string | null;
  loudnessDb: number | null;
  hitsPerSec: number | null;
}

export interface WebLink {
  url: string;
  site: string;
  text: string;
  /** The url is the page itself, not a Google redirect that couldn't be
   * followed: only resolved links can be saved or converted. */
  resolved: boolean;
}

/** A picked beat the dig couldn't analyse. */
export interface FailedBeat {
  name: string;
  error: string;
}

/** The dig: what the picked beats share, searches, and beats found on the web. */
export interface DigResult {
  model: string;
  audioSent: boolean;
  beats: BeatFacts[];
  /** Picked beats that couldn't be analysed (the dig went on without them). */
  failed: FailedBeat[];
  /** `heard`: what Gemini heard in the excerpts, only when they were sent. */
  analysis: { summary: string; traits: string[]; tempo: string; queries: string[]; heard?: string };
  web: WebLink[];
  webSearches: string[];
  webError: string | null;
}

/** A found beat saved as a text file in the beats folder (src-tauri/src/leads.rs
 * Lead): the link, what the card showed and the dig's facts. Never audio. */
export interface Lead {
  url: string;
  title: string;
  /** The channel (YouTube) or the site (web link). */
  producer: string;
  /** "2024", or "" when unknown. */
  year: string;
  source: "youtube" | "web";
  bpm: number | null;
  key: string | null;
  traits: string[];
  summary: string | null;
}

/** A lead on disk: the url hash in its file name (`leadHash`), its path, and
 * its facts read back from the file (`url` is "" when the file holds no https
 * link any more). */
export interface SavedLead extends Lead {
  hash: string;
  path: string;
  modifiedAtMs: number;
  /** "YYYY-MM-DD" as written when saved, or "". */
  savedOn: string;
  /** A `.md` in `_leads` that doesn't read as a lead (no hash): shown so it
   * can be revealed or deleted. */
  unrecognised?: boolean;
}

/** One "Go deeper" round: more web links, seeded by the dig's analysis, or
 * (when the key has no Google Search) new YouTube searches instead. */
export interface DigDeeperResult {
  web: WebLink[];
  webSearches: string[];
  webError: string | null;
  queries: string[];
}

// ---- Phone sync (docs/PHONE-SYNC.md) ----

/** A paired phone as Rust reports it (never its key). */
export interface PhoneDevice {
  id: string;
  /** Set by the phone's first hello; null = paired, never connected. */
  name: string | null;
  appVersion: string | null;
  pairedAtMs: number;
  lastSeenMs: number | null;
  /** Paired on another port than the one open now: it needs a new QR (Re-pair). */
  needsNewQr: boolean;
  /** Its Hivo is older (major.minor) than this computer's. Absent from older builds. */
  phoneOutdated?: boolean;
  /** Paired before protocol 1.2 (its key was in the QR): "Re-pair to upgrade security". */
  legacyPairing?: boolean;
}

export interface PhoneSyncStatus {
  on: boolean;
  port: number | null;
  /** Private IPv4 addresses, best first. */
  addresses: string[];
  devices: PhoneDevice[];
  /** Why the listener couldn't start, if it couldn't. */
  error: string | null;
}

/** A pairing QR (v1.2): a one-time token and this computer's public key, never the device key. */
export interface PhonePairing {
  deviceId: string;
  url: string;
  issuedAtMs: number;
  /** The QR stops working then (and once a phone used it). */
  expiresAtMs: number;
}

/** A decrypted /v1/snapshot or /v1/notes request, forwarded by Rust. */
/** Phone inbox (docs/PHONE-SYNC.md v1.1, src-tauri/src/phone_inbox.rs). */
export type InboxItemType = "idea" | "memo" | "sketch";
export type InboxStatus = "new" | "filed" | "dismissed";

export interface InboxTarget {
  kind: "prod" | "beat" | "song";
  id: string;
  title: string;
}

export interface InboxFile {
  /** The phone's file name. */
  name: string;
  size: number;
  /** In the inbox folder (playable through the asset protocol). */
  path: string;
  /** Deleted by hand since it arrived. */
  missing: boolean;
}

export interface InboxItem {
  /** `<deviceId>.<itemId>`. */
  id: string;
  itemId: string;
  deviceId: string;
  phoneName: string;
  itemType: InboxItemType;
  title: string;
  text: string;
  /** What the phone aimed it at, if anything. */
  target: InboxTarget | null;
  createdAt: number;
  updatedAt: number;
  receivedAt: number | null;
  durationMs: number | null;
  status: InboxStatus;
  /** Where it went: a sketch's BandLab folder, a memo's copy, or `<kind>:<id>`. */
  filedTo: string | null;
  filedAt: number | null;
  /** "song" (a new sketch song), "folder" (copied into a song's folder),
   * "link" (a memo linked to a beat/prod, copied into `_memos`); null when
   * filed before this was recorded. */
  filedAs: "song" | "folder" | "link" | null;
  /** The durable copy of a memo linked to a beat or a prod. */
  copiedTo: string | null;
  files: InboxFile[];
}

/** An item still arriving from the phone (it holds space in the inbox). */
export interface IncomingItem {
  id: string;
  itemType: InboxItemType;
  title: string;
  phoneName: string;
  fileCount: number;
  filesDone: number;
  receivedBytes: number;
  /** Declared sizes of the files started so far. */
  totalBytes: number;
  updatedAt: number;
}

export interface InboxList {
  items: InboxItem[];
  /** Still arriving (not in `items`). */
  receiving: number;
  incoming: IncomingItem[];
}

/** What filing a sketch as a new song made (src-tauri/src/phone_inbox.rs). */
export interface FiledSketch {
  /** The song's key: its BandLab folder. */
  key: string;
  /** Audio copied as it came (the mixdown when stems came with it). */
  audio: number;
  /** Audio unpacked from zips. */
  stems: number;
  /** The stems went to `BandLab/Stems/`, apart from the mixdown. */
  stemsApart: boolean;
}

export interface PhoneSyncRequest {
  id: string;
  path: string;
  body: unknown;
  phoneName: string;
}
