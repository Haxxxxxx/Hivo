use serde::{Deserialize, Serialize};

/// A file on disk related to a project (a backup .flp, a rendered mixdown…).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub modified_at_ms: i64,
}

/// A song's exported stems: a `Stems` folder next to the project, or FL's
/// split-mixer export (`<project>_<track>.wav`, two or more) beside the .flp.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StemsInfo {
    /// The folder holding them (the stems folder, or the project folder).
    pub folder: String,
    pub count: u32,
    pub bytes: u64,
    pub newest_ms: i64,
}

/// One song: the main .flp plus everything FL Studio keeps around it.
/// Backups (FL's `Backup/<name> (overwritten at 16h12).flp` files) are
/// grouped under their project instead of being listed as projects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    /// Why nothing could be read from inside the project, when that happened
    /// (damaged, oversized or hostile file). The project is still listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_error: Option<String>,
    pub name: String,
    pub folder: String,
    pub size_bytes: u64,
    pub modified_at_ms: i64,
    pub root: String,
    pub genre: Option<String>,
    pub artist: Option<String>,
    pub tempo_bpm: Option<f64>,
    pub time_sig_num: Option<u8>,
    pub time_sig_denom: Option<u8>,
    pub fl_version: Option<String>,
    /// Which DAW the project belongs to (by file type).
    pub daw: crate::daws::Daw,
    /// The DAW version that saved it, when the file says ("Ableton Live 11.3.4").
    pub daw_version: Option<String>,
    /// Lives under a `Templates` folder — FL's user-template location.
    pub is_template: bool,
    /// Newest first.
    pub backups: Vec<FileEntry>,
    /// Audio files next to the .flp whose name starts with the project name
    /// (e.g. `Envy.wav` beside `Envy.flp`). Newest first.
    pub renders: Vec<FileEntry>,
    /// Recorded takes in the sibling `Audio/` folder (FL names them
    /// `<project>_<date>_<track>.wav`).
    pub recordings_count: u32,
    pub recordings_bytes: u64,
    /// Title and comment from FL Studio's project info, if filled in.
    pub flp_title: Option<String>,
    pub comment: Option<String>,
    pub stems: Option<StemsInfo>,
    pub plugins: Vec<PluginInfo>,
    pub samples: Vec<SampleInfo>,
    /// Named mixer tracks and recorded-take labels ("Lead Voices - Nova"),
    /// minus generic ones. Collaborator names usually live here.
    pub track_names: Vec<String>,
    /// Mixdowns in the export folder named after this song that weren't
    /// counted: another linked song has the same name, and an export's file
    /// name doesn't say which one it came from.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub ambiguous_exports: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// What a scan found: the projects, and the linked folders that couldn't
/// be read right now (unplugged drive, unmounted share, renamed folder).
/// Songs under those are missing from `projects` because their folder is
/// gone, not because they were moved or deleted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub projects: Vec<ProjectInfo>,
    pub unreachable: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub name: String,
    pub vendor: Option<String>,
    /// Third-party plugins only: whether it's installed on this machine.
    /// `None` for FL's native plugins (always available).
    pub installed: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SampleStatus {
    /// At the path the project stores.
    Ok,
    /// Not there, but a file with the same name is inside the song's folder
    /// (the project was moved) — FL can usually find it.
    Relocated,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleInfo {
    /// Resolved path (%FLStudioUserData% etc. expanded).
    pub path: String,
    pub status: SampleStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub name: String,
    pub category: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub watched_folders: Vec<String>,
    pub fl_studio_path: Option<String>,
    pub output_folder: Option<String>,
    pub render_format: String,
    #[serde(default)]
    pub favorites: Vec<String>,
    /// Gemini model id; None = the default (ai::DEFAULT_MODEL).
    #[serde(default)]
    pub ai_model: Option<String>,
    /// Language for AI-written captions and briefs ("English", "French"…).
    #[serde(default)]
    pub ai_language: Option<String>,
    /// Send the song's notes with "Check kit" (off by default).
    #[serde(default)]
    pub ai_include_notes: bool,
    /// Launch Kit caption language, "fr" or "en" (French by default).
    #[serde(default = "default_caption_language")]
    pub caption_language: String,
    /// ffmpeg for shorts; None = found automatically.
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    /// The app's language: "system", "fr" or "en".
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    /// Folders of raw beats (mp3/wav from YouTube & co.): the Digger's
    /// source. Not songs: never scanned as projects.
    #[serde(default)]
    pub beat_folders: Vec<String>,
    /// The user's sample libraries (packs, Splice folder…). Only walked by
    /// the scanner to find samples a project stores under another path:
    /// nothing in them is ever opened or listed in the UI.
    #[serde(default)]
    pub sample_folders: Vec<String>,
    /// The Digger may send a short, low-quality excerpt of each picked beat
    /// to Gemini (off by default; disclosed in the UI).
    #[serde(default)]
    pub dig_send_audio: bool,
    /// A uuid made once on this install: the feedback form's rate-limit
    /// key, nothing else. Kept once set.
    #[serde(default)]
    pub install_id: Option<String>,
    /// The Digger's optional converter link, user-configured: an https url
    /// with `{url}` where the video address goes. Opened in the browser,
    /// never called by Hivo.
    #[serde(default)]
    pub converter_url_template: Option<String>,
}

fn default_caption_language() -> String {
    "fr".to_string()
}

fn default_ui_language() -> String {
    "system".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            watched_folders: Vec::new(),
            fl_studio_path: None,
            output_folder: None,
            render_format: "wav".to_string(),
            favorites: Vec::new(),
            ai_model: None,
            ai_language: None,
            ai_include_notes: false,
            caption_language: default_caption_language(),
            ffmpeg_path: None,
            ui_language: default_ui_language(),
            beat_folders: Vec::new(),
            sample_folders: Vec::new(),
            dig_send_audio: false,
            install_id: None,
            converter_url_template: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RenderStatus {
    Queued,
    Rendering,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderEvent {
    pub project_path: String,
    pub project_name: String,
    pub status: RenderStatus,
    pub message: Option<String>,
    pub output_path: Option<String>,
}
