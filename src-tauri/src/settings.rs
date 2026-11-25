use crate::error::app_err;
use crate::models::Settings;
use crate::paths::is_remote_or_device;
use crate::scope::{fl_studio_binary, is_ffmpeg};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| app_err("config.dir", format!("could not resolve app config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| app_err("config.dir", format!("could not create config dir: {e}")))?;
    Ok(dir.join("settings.json"))
}

/// Where an unreadable settings.json was moved (`settings.json.bad-<ms>`), until
/// the webview has been told once (`take_settings_recovery`).
static RECOVERED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Folders denied in the asset scope during this run (unlinked or repointed
/// away from). Tauri has no "un-allow", so one that gets linked again stays
/// unreadable until the app restarts. Kept so the UI can say so instead of
/// the folder silently staying blank.
static FORBIDDEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Reads settings.json. One that doesn't parse is moved aside to
/// `settings.json.bad-<ms>` (kept for the user, never over an older one) and the defaults are used, so a
/// corrupt file never blocks every save and picker. Returns where it went.
fn load_from(path: &Path) -> Result<(Settings, Option<PathBuf>), String> {
    if !path.exists() {
        return Ok((Settings::default(), None));
    }
    let raw = fs::read(path).map_err(|e| app_err("settings.read", format!("could not read settings: {e}")))?;
    match serde_json::from_slice(&raw) {
        Ok(settings) => Ok((settings, None)),
        Err(parse) => {
            let bad = crate::workspace::bad_path(path);
            fs::rename(path, &bad).map_err(|e| app_err("settings.read", format!("could not parse settings ({parse}) or move them aside: {e}")))?;
            eprintln!("settings.json didn't parse ({parse}): moved to {}", bad.display());
            Ok((Settings::default(), Some(bad)))
        }
    }
}

fn store_to(path: &Path, settings: &Settings) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(settings).map_err(|e| format!("could not serialize settings: {e}"))?;
    crate::workspace::write_atomic(path, &raw)
}

/// The saved settings (what every command's scope is built from).
pub fn load(app: &AppHandle) -> Result<Settings, String> {
    let (settings, moved) = load_from(&settings_path(app)?)?;
    if let Some(bad) = moved {
        if let Ok(mut slot) = RECOVERED.lock() {
            *slot = Some(bad.to_string_lossy().to_string());
        }
    }
    Ok(settings)
}

fn store(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    store_to(&settings_path(app)?, settings)
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    load(&app)
}

/// Settings were unreadable and reset to the defaults: where the old file
/// was kept. Answers once (the app tells the user once).
#[tauri::command]
pub fn take_settings_recovery() -> Option<String> {
    RECOVERED.lock().ok().and_then(|mut slot| slot.take())
}

/// The saved folders (projects, beats, samples, export) that can't be
/// reached right now: an unplugged drive, a renamed folder. Settings marks
/// them; nothing is removed.
#[tauri::command]
pub async fn unreachable_setting_folders(app: AppHandle) -> Result<Vec<String>, String> {
    let saved = load(&app)?;
    let all: Vec<String> = saved
        .watched_folders
        .iter()
        .chain(saved.beat_folders.iter())
        .chain(saved.sample_folders.iter())
        .chain(saved.plugin_folders.iter())
        .chain(saved.output_folder.iter())
        .cloned()
        .collect();
    tauri::async_runtime::spawn_blocking(move || unreachable(all)).await.map_err(|e| e.to_string())
}

fn unreachable(folders: Vec<String>) -> Vec<String> {
    folders.into_iter().filter(|f| is_remote_or_device(f) || !Path::new(f).is_dir()).collect()
}

/// Saves the preferences the webview may set. Paths (linked folders, the
/// export folder, FL Studio, ffmpeg) are kept as saved: they change only
/// through the pickers and detection below, so a compromised webview can't
/// point the app at other folders or programs.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    let problem = apply_preferences(&mut saved, settings);
    store(&app, &saved)?;
    match problem {
        Some(message) => Err(message),
        None => Ok(saved),
    }
}

/// Same limit as the Settings field's `maxLength` (src/components/SettingsView.tsx).
const MAX_CONVERTER_CHARS: usize = 300;

/// The converter link, if it's usable: https, short, plain text. A `{url}`
/// slot is optional: without one the app opens the page and the user pastes
/// the address (converterLink in src/lib/digger.ts). None for an empty field
/// (cleared, no error).
fn converter_template(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(t) = raw.map(str::trim).filter(|t| !t.is_empty()) else { return Ok(None) };
    let ok = t.starts_with("https://") && t.chars().count() <= MAX_CONVERTER_CHARS && !t.chars().any(char::is_control);
    if ok {
        Ok(Some(t.to_string()))
    } else {
        Err(app_err("settings.badConverter", format!("The converter link must start with https:// ({MAX_CONVERTER_CHARS} characters max).")).with("max", MAX_CONVERTER_CHARS).into())
    }
}

/// Applies what the webview may set. Returns the one thing that was refused
/// (and cleared), if any; the other preferences are applied regardless.
fn apply_preferences(saved: &mut Settings, from: Settings) -> Option<String> {
    let mut problem = None;
    match converter_template(from.converter_url_template.as_deref()) {
        Ok(t) => saved.converter_url_template = t,
        Err(e) => {
            saved.converter_url_template = None;
            problem = Some(e);
        }
    }
    if matches!(from.render_format.as_str(), "wav" | "mp3" | "ogg" | "flac") {
        saved.render_format = from.render_format;
    }
    saved.favorites = from.favorites;
    saved.ai_model = from.ai_model;
    saved.ai_language = from.ai_language;
    saved.ai_include_notes = from.ai_include_notes;
    saved.dig_send_audio = from.dig_send_audio;
    saved.prod_match_downloads = from.prod_match_downloads;
    if matches!(from.caption_language.as_str(), "fr" | "en") {
        saved.caption_language = from.caption_language;
    }
    if matches!(from.ui_language.as_str(), "system" | "fr" | "en") {
        saved.ui_language = from.ui_language;
    }
    // Set once by the feedback form, then kept: it's the rate-limit key.
    if saved.install_id.is_none() {
        saved.install_id = from.install_id.filter(|id| id.len() == 36);
    }
    problem
}

/// Runs a native picker off the main thread. None = cancelled.
async fn pick(app: &AppHandle, folder: bool) -> Result<Option<PathBuf>, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let picked = if folder { dialog.blocking_pick_folder() } else { dialog.blocking_pick_file() };
        picked.and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(|e| app_err("picker.failed", format!("the picker failed: {e}")).into())
}

fn usable_folder(path: &Path) -> Result<String, String> {
    let s = path.to_string_lossy().to_string();
    if is_remote_or_device(&s) || !path.is_dir() {
        return Err(app_err("folder.notLocal", format!("not a folder on this computer: {s}")).with("path", s.as_str()).into());
    }
    Ok(s)
}

/// A folder the app may read everything in (watched, beats, samples, the
/// export folder) must be a real folder of the user's, not a whole drive,
/// the home folder or a system folder.
fn linkable_folder(app: &AppHandle, folder: &Path, what: &str) -> Result<String, String> {
    if too_broad(folder, app.path().home_dir().ok().as_deref()) {
        return Err(app_err(
            "folder.tooBroad",
            format!("Pick the folder where your {what} are, not a whole drive, your home folder or a system folder: the app can read every file in it."),
        )
        .with("what", what)
        .into());
    }
    usable_folder(folder)
}

fn add_watched(app: &AppHandle, folder: &Path) -> Result<Settings, String> {
    let folder = linkable_folder(app, folder, "projects")?;
    let mut saved = load(app)?;
    if !saved.watched_folders.contains(&folder) {
        saved.watched_folders.push(folder);
        store(app, &saved)?;
    }
    Ok(saved)
}

/// Links a projects folder the user picks.
#[tauri::command]
pub async fn pick_watched_folder(app: AppHandle) -> Result<Settings, String> {
    match pick(&app, true).await? {
        Some(folder) => add_watched(&app, &folder),
        None => load(&app),
    }
}

/// Links one of the DAW folders detection found (Settings → Auto-detect
/// DAWs, first-run screen). Only a folder Rust itself detected is accepted,
/// so the webview still can't add an arbitrary path.
#[tauri::command]
pub fn link_detected_folder(app: AppHandle, path: String) -> Result<Settings, String> {
    let found = detected_folders(&app);
    if !found.iter().any(|(_, p)| p.to_string_lossy() == path) {
        return Err(app_err("folder.notDetected", format!("not a detected DAW folder: {path}")).with("path", path.as_str()).into());
    }
    add_watched(&app, Path::new(&path))
}

/// Unlinks a folder (only ever shrinks what the app may touch).
#[tauri::command]
pub fn remove_watched_folder(app: AppHandle, folder: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    saved.watched_folders.retain(|f| f != &folder);
    store(&app, &saved)?;
    forbid_unlinked(&app, &folder, &saved);
    Ok(saved)
}

/// A linked folder that moved (drive letter changed, renamed, remounted
/// elsewhere), pointed at its new place.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repointed {
    pub settings: Settings,
    pub from: String,
    pub to: String,
}

/// Replaces one linked folder with a folder the user picks, in place. The
/// webview then moves the songs' data from the old prefix to the new one.
/// `None` when the picker was cancelled.
#[tauri::command]
pub async fn repoint_watched_folder(app: AppHandle, folder: String) -> Result<Option<Repointed>, String> {
    if !load(&app)?.watched_folders.contains(&folder) {
        return Err(app_err("folder.notLinked", format!("not a linked folder: {folder}")).with("path", folder.as_str()).into());
    }
    let Some(picked) = pick(&app, true).await? else { return Ok(None) };
    let to = linkable_folder(&app, &picked, "projects")?;
    let mut saved = load(&app)?;
    if to != folder && saved.watched_folders.contains(&to) {
        return Err(app_err("folder.alreadyLinked", format!("{to} is already linked")).with("path", to.as_str()).into());
    }
    let Some(slot) = saved.watched_folders.iter_mut().find(|f| **f == folder) else {
        return Err(app_err("folder.notLinked", format!("not a linked folder: {folder}")).with("path", folder.as_str()).into());
    };
    *slot = to.clone();
    store(&app, &saved)?;
    if to != folder {
        forbid_unlinked(&app, &folder, &saved);
    }
    Ok(Some(Repointed { settings: saved, from: folder, to }))
}

/// Adds a beats folder the user picks (the Digger's source).
#[tauri::command]
pub async fn pick_beat_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    let folder = linkable_folder(&app, &folder, "beats")?;
    let mut saved = load(&app)?;
    if !saved.beat_folders.contains(&folder) {
        saved.beat_folders.push(folder);
        store(&app, &saved)?;
    }
    Ok(saved)
}

/// The webview may read every file in a linked folder (to play renders and
/// beats), so a drive root (or a mounted volume's root), the home folder or
/// anything above it, the home's app-data folders and the system folders at
/// the top of a drive are refused.
fn too_broad(folder: &Path, home: Option<&Path>) -> bool {
    let real = folder.canonicalize().unwrap_or_else(|_| folder.to_path_buf());
    let Some(parent) = real.parent() else { return true };
    if is_mount_point(&real, parent) {
        return true;
    }
    if is_system_folder(folder) || is_system_folder(&real) {
        return true;
    }
    let Some(home) = home.map(|h| h.canonicalize().unwrap_or_else(|_| h.to_path_buf())) else { return false };
    home.starts_with(&real) || ["Library", "AppData"].iter().any(|d| real.starts_with(home.join(d)))
}

/// Breadth guard for plugin folders.
///
/// Deliberately NOT `too_broad`: that one also refuses anything under
/// `~/Library` or `AppData`, which is right for the folders the webview can
/// read every file of (watched, beats, samples, exports) but wrong here.
/// Plugin folders are walked by Rust only and never enter the asset scope,
/// and those two branches hold the standard per-user plugin locations —
/// `~/Library/Audio/Plug-Ins` on macOS and
/// `%LOCALAPPDATA%\Programs\Common\VST3` on Windows. Refusing them would
/// reject exactly where most plugins are installed.
///
/// A whole drive, a volume root, the home folder (or anything above it) and
/// a system folder at the top of a drive are still refused: walking those is
/// slow and pointless.
fn plugin_folder_too_broad(folder: &Path, home: Option<&Path>) -> bool {
    let real = folder.canonicalize().unwrap_or_else(|_| folder.to_path_buf());
    let Some(parent) = real.parent() else { return true };
    if is_mount_point(&real, parent) {
        return true;
    }
    if is_system_folder(folder) || is_system_folder(&real) {
        return true;
    }
    let Some(home) = home.map(|h| h.canonicalize().unwrap_or_else(|_| h.to_path_buf())) else { return false };
    home.starts_with(&real)
}

/// A system folder at the top of a drive (or under macOS's `/private`, where
/// `/etc`, `/var` and `/tmp` really live).
fn is_system_folder(path: &Path) -> bool {
    const SYSTEM: &[&str] = &[
        // macOS / Linux
        "applications", "bin", "boot", "cores", "dev", "etc", "home", "lib", "library", "media", "mnt", "opt",
        "private", "proc", "root", "sbin", "sys", "system", "tmp", "users", "usr", "var", "volumes",
        // Windows
        "windows", "program files", "program files (x86)", "programdata", "$recycle.bin",
    ];
    let Some(parent) = path.parent() else { return true };
    let top = parent.parent().is_none() || parent == Path::new("/private");
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    top && SYSTEM.contains(&name.as_str())
}

/// A volume's root (an external drive under /Volumes, /mnt...): on another
/// device than its parent folder.
#[cfg(unix)]
fn is_mount_point(path: &Path, parent: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(path), fs::metadata(parent)) {
        (Ok(a), Ok(b)) => a.dev() != b.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_mount_point(_path: &Path, _parent: &Path) -> bool {
    false
}

/// An unlinked folder stops being readable through the asset protocol right
/// away (the last scan allowed it), unless a folder still linked overlaps
/// it. Tauri has no "un-allow": a forbidden folder stays forbidden until the
/// app restarts, even if it's linked again in the meantime.
fn forbid_unlinked(app: &AppHandle, folder: &str, saved: &Settings) {
    let gone = PathBuf::from(folder);
    let gone_real = gone.canonicalize().unwrap_or_else(|_| gone.clone());
    let overlaps = |r: &String| {
        let r = PathBuf::from(r);
        let r_real = r.canonicalize().unwrap_or_else(|_| r.clone());
        r.starts_with(&gone) || gone.starts_with(&r) || r_real.starts_with(&gone_real) || gone_real.starts_with(&r_real)
    };
    let linked = saved.watched_folders.iter().chain(saved.beat_folders.iter()).chain(saved.output_folder.iter());
    if linked.into_iter().any(overlaps) {
        return;
    }
    let assets = app.asset_protocol_scope();
    let _ = assets.forbid_directory(&gone, true);
    if gone_real != gone {
        let _ = assets.forbid_directory(&gone_real, true);
    }
    if let Ok(mut seen) = FORBIDDEN.lock() {
        for p in [&gone, &gone_real] {
            let p = p.to_string_lossy().to_string();
            if !seen.contains(&p) {
                seen.push(p);
            }
        }
    }
}

/// Which linked folders were denied earlier in this run, so they need a
/// restart before the app can read them again. A denial covers the folder
/// and everything under it, so an overlap either way counts.
pub(crate) fn needing_restart(linked: &[String], forbidden: &[String]) -> Vec<String> {
    linked
        .iter()
        .filter(|l| {
            let l = Path::new(l.as_str());
            forbidden.iter().any(|f| {
                let f = Path::new(f.as_str());
                l.starts_with(f) || f.starts_with(l)
            })
        })
        .cloned()
        .collect()
}

/// Linked folders that are unreadable until Hivo restarts, because they were
/// unlinked or repointed away from earlier in this run and Tauri cannot undo
/// a denial. Only the folders the webview reads from are affected: sample and
/// plugin folders are walked by Rust and never enter the asset scope.
#[tauri::command]
pub fn folders_needing_restart(app: AppHandle) -> Result<Vec<String>, String> {
    let saved = load(&app)?;
    let forbidden = FORBIDDEN.lock().map(|f| f.clone()).unwrap_or_default();
    if forbidden.is_empty() {
        return Ok(Vec::new());
    }
    let linked: Vec<String> =
        saved.watched_folders.iter().chain(saved.beat_folders.iter()).chain(saved.output_folder.iter()).cloned().collect();
    Ok(needing_restart(&linked, &forbidden))
}

/// Removes a beats folder (only ever shrinks what the app may touch).
#[tauri::command]
pub fn remove_beat_folder(app: AppHandle, folder: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    saved.beat_folders.retain(|f| f != &folder);
    store(&app, &saved)?;
    forbid_unlinked(&app, &folder, &saved);
    Ok(saved)
}

/// Adds a sample library the user picks: the scanner looks up samples a
/// project stores under another path by file name in there. A whole drive
/// or the home folder would take ages to walk, so they're refused.
#[tauri::command]
pub async fn pick_sample_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    let folder = linkable_folder(&app, &folder, "samples or packs")?;
    let mut saved = load(&app)?;
    if !saved.sample_folders.contains(&folder) {
        saved.sample_folders.push(folder);
        store(&app, &saved)?;
    }
    Ok(saved)
}

/// Removes a sample library.
#[tauri::command]
pub fn remove_sample_folder(app: AppHandle, folder: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    saved.sample_folders.retain(|f| f != &folder);
    store(&app, &saved)?;
    Ok(saved)
}

/// Adds a plugin folder the user picks. Auto-detection covers the standard
/// locations and whatever FL records; this is for the rest (an own VST drive,
/// a shared library). Same refusal as the other pickers: a whole drive or the
/// home folder would take ages to walk.
#[tauri::command]
pub async fn pick_plugin_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    if plugin_folder_too_broad(&folder, app.path().home_dir().ok().as_deref()) {
        return Err(app_err(
            "folder.tooBroad",
            "Pick the folder your plugins are in, not a whole drive, your home folder or a system folder.".to_string(),
        )
        .with("what", "plugins")
        .into());
    }
    let folder = usable_folder(&folder)?;
    let mut saved = load(&app)?;
    if !saved.plugin_folders.contains(&folder) {
        saved.plugin_folders.push(folder);
        store(&app, &saved)?;
    }
    Ok(saved)
}

/// Removes a plugin folder.
#[tauri::command]
pub fn remove_plugin_folder(app: AppHandle, folder: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    saved.plugin_folders.retain(|f| f != &folder);
    store(&app, &saved)?;
    Ok(saved)
}

/// One row of the plugin folders section.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFolder {
    pub path: String,
    /// Plugins found inside (up to 9999).
    pub plugins: usize,
    /// Found on its own (standard location, or recorded by FL) rather than
    /// added by the user: shown, but not removable.
    pub auto: bool,
}

/// The plugin folders in use, user-added first, each with what it holds.
/// Read-only. The count is what tells the user a folder actually took.
#[tauri::command]
pub async fn plugin_folders(app: AppHandle) -> Result<Vec<PluginFolder>, String> {
    let saved = load(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<PluginFolder> = Vec::new();
        let mine: Vec<PathBuf> = saved.plugin_folders.iter().map(PathBuf::from).collect();
        for dir in &mine {
            out.push(PluginFolder {
                plugins: crate::resolve::count_plugins(dir),
                auto: false,
                path: dir.to_string_lossy().to_string(),
            });
        }
        for dir in crate::resolve::auto_plugin_dirs() {
            if !dir.is_dir() || mine.iter().any(|m| m == &dir) {
                continue;
            }
            let plugins = crate::resolve::count_plugins(&dir);
            // An empty standard location is noise, not information.
            if plugins > 0 {
                out.push(PluginFolder { plugins, auto: true, path: dir.to_string_lossy().to_string() });
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_output_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    let folder = linkable_folder(&app, &folder, "exports")?;
    let mut saved = load(&app)?;
    let previous = saved.output_folder.replace(folder.clone());
    store(&app, &saved)?;
    if let Some(previous) = previous.filter(|p| *p != folder) {
        forbid_unlinked(&app, &previous, &saved);
    }
    Ok(saved)
}

fn set_fl_studio(app: &AppHandle, path: &Path) -> Result<Settings, String> {
    let exe = fl_studio_binary(path)
        .ok_or_else(|| String::from(app_err("flStudio.notFl", format!("That isn't FL Studio: {}", path.display())).with("path", path.display().to_string())))?;
    let mut saved = load(app)?;
    saved.fl_studio_path = Some(exe.to_string_lossy().to_string());
    store(app, &saved)?;
    Ok(saved)
}

#[tauri::command]
pub async fn pick_fl_studio(app: AppHandle) -> Result<Settings, String> {
    match pick(&app, false).await? {
        Some(path) => set_fl_studio(&app, &path),
        None => load(&app),
    }
}

/// Fills in the FL Studio path found on this machine.
#[tauri::command]
pub fn use_detected_fl_studio(app: AppHandle) -> Result<Settings, String> {
    let found = detect_fl_studio().ok_or_else(|| String::from(app_err("flStudio.notFound", "FL Studio wasn't found. Pick it by hand.")))?;
    set_fl_studio(&app, Path::new(&found))
}

#[tauri::command]
pub async fn pick_ffmpeg(app: AppHandle) -> Result<Settings, String> {
    let Some(path) = pick(&app, false).await? else { return load(&app) };
    if !is_ffmpeg(&path) {
        return Err(app_err("ffmpeg.notFfmpeg", format!("That isn't ffmpeg: {}", path.display())).with("path", path.display().to_string()).into());
    }
    let mut saved = load(&app)?;
    saved.ffmpeg_path = Some(path.to_string_lossy().to_string());
    store(&app, &saved)?;
    Ok(saved)
}

/// Saves the ffmpeg found on this machine, once the user confirmed the path
/// Settings showed. Detected again here (never a path from the webview);
/// `shown` must be that same path, so what gets saved is what was confirmed.
#[tauri::command]
pub fn use_detected_ffmpeg(app: AppHandle, shown: String) -> Result<Settings, String> {
    let found = crate::shorts::detect_ffmpeg().ok_or_else(|| String::from(app_err("ffmpeg.notFound", "ffmpeg wasn't found. Pick it by hand.")))?;
    if found.to_string_lossy() != shown {
        return Err(app_err("ffmpeg.moved", "ffmpeg isn't where it was a moment ago. Check again.").into());
    }
    let mut saved = load(&app)?;
    saved.ffmpeg_path = Some(found.to_string_lossy().to_string());
    store(&app, &saved)?;
    Ok(saved)
}

/// Clears a path setting: "flStudio", "ffmpeg" or "outputFolder".
#[tauri::command]
pub fn clear_path_setting(app: AppHandle, which: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    let mut unlinked = None;
    match which.as_str() {
        "flStudio" => saved.fl_studio_path = None,
        "ffmpeg" => saved.ffmpeg_path = None,
        "outputFolder" => unlinked = saved.output_folder.take(),
        other => return Err(app_err("settings.unknown", format!("unknown setting: {other}")).with("name", other).into()),
    }
    store(&app, &saved)?;
    if let Some(previous) = unlinked {
        forbid_unlinked(&app, &previous, &saved);
    }
    Ok(saved)
}

/// What sample resolution needs to know about FL on this computer: the FL
/// Studio binary (from Settings, else auto-detected) and FL's user data
/// folder (`Documents/Image-Line/FL Studio`).
pub fn fl_paths(app: &AppHandle) -> (Option<String>, Option<PathBuf>) {
    let fl = crate::scope::Scope::load(app)
        .ok()
        .and_then(|s| s.fl_studio().ok())
        .map(|p| p.to_string_lossy().to_string())
        .or_else(detect_fl_studio);
    let user_data = app.path().document_dir().ok().map(|d| d.join("Image-Line").join("FL Studio"));
    (fl, user_data)
}

/// Every string value under one of FL Studio's registry keys, from BOTH hives.
///
/// HKEY_CURRENT_USER comes first and matters most: FL records the user's own
/// install and folder choices there (actions.rs already reads HKCU for the
/// default template). Reading only HKLM — which is what detection used to do —
/// finds nothing for a per-user install or a relocated data folder, which is
/// exactly the "auto-detect finds nothing at all" report.
///
/// Values are ENUMERATED rather than looked up by name: the names differ
/// between FL versions ("Shared data" became "User data"), so guessing a name
/// silently misses the folder.
#[cfg(target_os = "windows")]
pub(crate) fn fl_registry_entries(subkey: &str) -> Vec<(String, String)> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let mut out = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let Ok(key) = winreg::RegKey::predef(hive).open_subkey(subkey) else { continue };
        for name in key.enum_values().filter_map(|v| v.ok()).map(|(n, _)| n) {
            if let Ok(v) = key.get_value::<String, _>(&name) {
                if !v.trim().is_empty() {
                    out.push((name.clone(), v));
                }
            }
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn fl_registry_entries(_subkey: &str) -> Vec<(String, String)> {
    Vec::new()
}

/// The values only, for the callers that do not care which setting it was.
pub(crate) fn fl_registry_values(subkey: &str) -> Vec<String> {
    fl_registry_entries(subkey).into_iter().map(|(_, v)| v).collect()
}

/// One registry path -> the project folders worth proposing for it.
///
/// A recorded path is usually FL's user data folder, whose projects live in
/// `Projects`; some users save straight into the folder itself. `has_projects`
/// is injected so the choice is testable off-Windows.
pub(crate) fn project_dirs_for(root: &Path, has_projects: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    // Only propose a folder that actually holds projects: the same key also
    // records VST and data folders, and offering those as "your projects"
    // would be noise the user has to sift through.
    [root.join("Projects"), root.to_path_buf()]
        .into_iter()
        .find(|c| c.is_dir() && has_projects(c))
        .into_iter()
        .collect()
}

/// Project folders FL itself records on this machine, de-duplicated and in
/// registry order. Empty off Windows and when FL recorded nothing usable.
fn fl_registry_project_folders() -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    for value in fl_registry_values("SOFTWARE\\Image-Line\\Shared\\Paths") {
        for dir in project_dirs_for(Path::new(&value), &|d| count_projects(d) > 0) {
            if !out.iter().any(|(_, p)| p == &dir) {
                out.push(("FL Studio", dir));
            }
        }
    }
    out
}

/// Each DAW's usual projects folder, same names on macOS and Windows, under
/// Documents unless noted.
fn default_project_folders(docs: &Path, music: Option<&Path>) -> Vec<(&'static str, PathBuf)> {
    let mut out = vec![
        ("FL Studio", docs.join("Image-Line").join("FL Studio").join("Projects")),
        ("Studio One", docs.join("Studio One").join("Songs")),
        ("REAPER", docs.join("REAPER Media")),
        // Live has no projects folder of its own: it creates `Ableton` (User
        // Library, Factory Packs, Live Recordings) and Sets are saved around
        // it. The bare folder is safe to link: the scanner and the count
        // below skip the library folders (daws::LIBRARY_DIRS).
        ("Ableton Live", docs.join("Ableton")),
        ("Cubase", docs.join("Cubase Projects")),
        ("Cubase", docs.join("Steinberg").join("Cubase Projects")),
        ("Bitwig Studio", docs.join("Bitwig Studio").join("Projects")),
        ("Pro Tools", docs.join("Pro Tools")),
    ];
    // Ableton on macOS keeps its folder under ~/Music.
    if let Some(m) = music {
        out.push(("Ableton Live", m.join("Ableton")));
    }
    out
}

/// The default DAW folders that exist on this machine.
fn existing_folders(docs: &Path, music: Option<&Path>) -> Vec<(&'static str, PathBuf)> {
    default_project_folders(docs, music).into_iter().filter(|(_, p)| p.is_dir()).collect()
}

fn detected_folders(app: &AppHandle) -> Vec<(&'static str, PathBuf)> {
    // The default layout first, then whatever FL itself recorded. The
    // defaults alone are why a user who moved their folders saw nothing:
    // every hardcoded candidate failed is_dir() and the list came back empty.
    let mut out = match app.path().document_dir() {
        Ok(docs) => existing_folders(&docs, app.path().audio_dir().ok().as_deref()),
        Err(_) => Vec::new(),
    };
    for (daw, dir) in fl_registry_project_folders() {
        if !out.iter().any(|(_, p)| p == &dir) {
            out.push((daw, dir));
        }
    }
    out
}

/// Projects of any DAW in a folder (a few levels deep), capped: it's a hint
/// for the user, not a scan. Skips DAW content libraries (Ableton's demo
/// Sets are not your projects), like the scanner does.
fn count_projects(dir: &Path) -> usize {
    walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e.file_type().is_dir()
                || !crate::daws::LIBRARY_DIRS.contains(&e.file_name().to_string_lossy().to_lowercase().as_str())
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && crate::daws::Daw::of_project(e.path()).is_some())
        .take(999)
        .count()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFolder {
    pub daw: String,
    pub path: String,
    /// Projects found inside (up to 999).
    pub projects: usize,
    /// Already linked in Settings.
    pub linked: bool,
}

fn describe(found: Vec<(&'static str, PathBuf)>, linked: &[String]) -> Vec<DetectedFolder> {
    found
        .into_iter()
        .map(|(daw, path)| {
            let s = path.to_string_lossy().to_string();
            DetectedFolder { daw: daw.to_string(), projects: count_projects(&path), linked: linked.contains(&s), path: s }
        })
        .collect()
}

/// Every DAW's default projects folder found on this machine, to propose
/// (never linked silently). Read-only.
#[tauri::command]
pub async fn detect_daw_folders(app: AppHandle) -> Result<Vec<DetectedFolder>, String> {
    let linked = load(&app)?.watched_folders;
    let found = detected_folders(&app);
    tauri::async_runtime::spawn_blocking(move || describe(found, &linked)).await.map_err(|e| e.to_string())
}

/// Best-effort auto-detection of the FL Studio executable. This covers the
/// common install locations; the user can always override it manually since
/// FL Studio's install path/version varies a lot machine to machine.
#[tauri::command]
pub fn detect_fl_studio() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // FL's installer records the exact exe here, wherever it was installed
        // (e.g. D:\Programmes\Image-Line\FL64.exe). HKCU is checked FIRST and
        // was missing entirely: a per-user install records itself only there,
        // so this returned None and the user saw "FL Studio not found" even
        // with FL installed.
        let from_registry = fl_registry_values("SOFTWARE\\Image-Line\\Shared\\Paths")
            .into_iter()
            .find(|p| {
                let path = std::path::Path::new(p);
                path.is_file()
                    && path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_lowercase().starts_with("fl"))
                        .unwrap_or(false)
            });
        if from_registry.is_some() {
            return from_registry;
        }

        // Both Program Files roots: a 32-bit install lands in the (x86) one,
        // which this never looked at.
        let roots: Vec<String> = ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .collect();
        let roots = if roots.is_empty() { vec!["C:\\Program Files".to_string()] } else { roots };
        for program_files in roots {
            let base = std::path::Path::new(&program_files).join("Image-Line");
            let Ok(entries) = fs::read_dir(&base) else { continue };
            let mut versions: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .starts_with("fl studio")
                })
                .collect();
            versions.sort_by_key(|e| e.file_name());
            for entry in versions.into_iter().rev() {
                // FL64.exe is the 64-bit build; a 32-bit install only ships
                // FL.exe, which the old lookup ignored entirely.
                for exe_name in ["FL64.exe", "FL.exe"] {
                    let exe = entry.path().join(exe_name);
                    if exe.exists() {
                        return Some(exe.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }

    #[cfg(target_os = "macos")]
    {
        let base = std::path::Path::new("/Applications");
        if let Ok(entries) = fs::read_dir(base) {
            let mut apps: Vec<_> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    n.starts_with("fl studio") && n.ends_with(".app")
                })
                .collect();
            apps.sort_by_key(|e| e.file_name());
            for entry in apps.into_iter().rev() {
                let macos_dir = entry.path().join("Contents/MacOS");
                if let Ok(bin_entries) = fs::read_dir(&macos_dir) {
                    for bin in bin_entries.filter_map(|e| e.ok()) {
                        if bin.path().is_file() {
                            return Some(bin.path().to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        None
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same throwaway-dir convention as the other suites in this crate
    /// (actions.rs, audio.rs): no new dev-dependency just for tests.
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flsm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn with_project(dir: &Path) -> &Path {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("song.flp"), b"x").unwrap();
        dir
    }

    /// The standard per-user plugin locations live under ~/Library (macOS)
    /// and AppData (Windows). `too_broad` refuses both, which would reject
    /// exactly where most plugins are installed — so plugin folders use
    /// their own guard.
    #[test]
    fn the_usual_per_user_plugin_locations_can_be_added() {
        let home = Path::new("/Users/me");
        for p in ["/Users/me/Library/Audio/Plug-Ins/VST3", "/Users/me/AppData/Local/Programs/Common/VST3"] {
            assert!(too_broad(Path::new(p), Some(home)), "{p}: precondition, the readable-folder guard refuses it");
            assert!(!plugin_folder_too_broad(Path::new(p), Some(home)), "{p} must be addable as a plugin folder");
        }
    }

    /// Still refused: walking these is slow and pointless.
    #[test]
    fn a_plugin_folder_is_never_a_drive_the_home_folder_or_a_system_folder() {
        let home = Path::new("/Users/me");
        for p in ["/", "/Users/me", "/Users", "/etc", "/Windows"] {
            assert!(plugin_folder_too_broad(Path::new(p), Some(home)), "{p} must be refused");
        }
    }

    /// Re-linking a folder that was unlinked this run leaves it unreadable
    /// until restart (Tauri has no "un-allow"), so it must be reported.
    #[test]
    fn a_relinked_folder_is_reported_as_needing_a_restart() {
        let linked = vec!["/music/Projects".to_string(), "/music/Beats".to_string()];
        let forbidden = vec!["/music/Projects".to_string()];
        assert_eq!(needing_restart(&linked, &forbidden), vec!["/music/Projects".to_string()]);
    }

    /// A denial covers everything under the folder, so a child counts too.
    #[test]
    fn a_folder_under_a_forbidden_one_also_needs_a_restart() {
        let linked = vec!["/music/Projects/2026".to_string()];
        assert_eq!(needing_restart(&linked, &["/music/Projects".to_string()]), linked);
    }

    /// Nothing to say when the folders are unrelated: the warning must not
    /// cry wolf on every unlink.
    #[test]
    fn unrelated_folders_need_no_restart() {
        let linked = vec!["/music/Beats".to_string()];
        assert!(needing_restart(&linked, &["/music/Projects".to_string()]).is_empty());
    }

    /// A relocated FL user data folder keeps projects in `Projects`.
    #[test]
    fn registry_folder_prefers_the_projects_subfolder() {
        let root = tmp("regproj");
        with_project(&root.join("Projects"));
        let found = project_dirs_for(&root, &|d| d.join("song.flp").exists());
        assert_eq!(found, vec![root.join("Projects")]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Some users save straight into the recorded folder.
    #[test]
    fn registry_folder_falls_back_to_the_folder_itself() {
        let root = tmp("regroot");
        with_project(&root);
        let found = project_dirs_for(&root, &|d| d.join("song.flp").exists());
        assert_eq!(found, vec![root.clone()]);
        let _ = fs::remove_dir_all(&root);
    }

    /// The same registry key also records VST and data folders. Proposing
    /// those as "your projects" would be noise, so a folder with no projects
    /// is never offered.
    #[test]
    fn registry_folder_without_projects_is_not_proposed() {
        let root = tmp("regvst");
        fs::create_dir_all(root.join("VST3")).unwrap();
        let found = project_dirs_for(&root, &|d| d.join("song.flp").exists());
        assert!(found.is_empty(), "a plugin folder must not be proposed as a projects folder");
        let _ = fs::remove_dir_all(&root);
    }

    /// A stale registry entry (folder since deleted or on an unplugged drive)
    /// must not crash or be proposed.
    #[test]
    fn registry_folder_that_no_longer_exists_is_ignored() {
        let missing = std::env::temp_dir().join("flsm-does-not-exist-xyz");
        let _ = fs::remove_dir_all(&missing);
        assert!(project_dirs_for(&missing, &|_| true).is_empty());
    }

    /// Off Windows there is no registry, so detection must degrade to the
    /// default folders rather than error.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn registry_values_are_empty_off_windows() {
        assert!(fl_registry_values("SOFTWARE\\Image-Line\\Shared\\Paths").is_empty());
    }

    #[test]
    fn saving_settings_never_changes_paths() {
        let mut saved = Settings {
            watched_folders: vec!["/music/Projects".into()],
            fl_studio_path: Some("/Applications/FL Studio 2025.app/Contents/MacOS/FL Studio".into()),
            output_folder: Some("/music/Exports".into()),
            ffmpeg_path: Some("/opt/homebrew/bin/ffmpeg".into()),
            ..Settings::default()
        };
        let before = (saved.watched_folders.clone(), saved.fl_studio_path.clone(), saved.output_folder.clone(), saved.ffmpeg_path.clone());
        let from_webview = Settings {
            watched_folders: vec!["/".into(), "/Users/someone".into()],
            fl_studio_path: Some("/tmp/payload".into()),
            output_folder: Some("/Users/someone/Library/LaunchAgents".into()),
            ffmpeg_path: Some("/tmp/payload".into()),
            render_format: "plist".into(),
            ai_include_notes: true,
            ai_language: Some("French".into()),
            ..Settings::default()
        };
        apply_preferences(&mut saved, from_webview);
        assert_eq!((saved.watched_folders.clone(), saved.fl_studio_path.clone(), saved.output_folder.clone(), saved.ffmpeg_path.clone()), before);
        assert_eq!(saved.render_format, "wav", "unknown formats are ignored");
        assert!(saved.ai_include_notes);
        assert_eq!(saved.ai_language.as_deref(), Some("French"));
    }

    #[test]
    fn install_id_is_set_once_then_kept() {
        let mut saved = Settings::default();
        apply_preferences(&mut saved, Settings { install_id: Some("nope".into()), ..Settings::default() });
        assert_eq!(saved.install_id, None, "a malformed id is ignored");
        let first = "11111111-2222-4333-8444-555555555555".to_string();
        apply_preferences(&mut saved, Settings { install_id: Some(first.clone()), ..Settings::default() });
        assert_eq!(saved.install_id.as_deref(), Some(first.as_str()));
        apply_preferences(&mut saved, Settings { install_id: Some("99999999-2222-4333-8444-555555555555".into()), ..Settings::default() });
        assert_eq!(saved.install_id.as_deref(), Some(first.as_str()), "a later id never replaces the first");
        apply_preferences(&mut saved, Settings::default());
        assert_eq!(saved.install_id.as_deref(), Some(first.as_str()), "a save without it keeps it");
    }

    #[test]
    fn app_language_is_saved_and_checked() {
        let mut saved = Settings::default();
        assert_eq!(saved.ui_language, "system");
        apply_preferences(&mut saved, Settings { ui_language: "fr".into(), ..Settings::default() });
        assert_eq!(saved.ui_language, "fr");
        apply_preferences(&mut saved, Settings { ui_language: "klingon".into(), ..Settings::default() });
        assert_eq!(saved.ui_language, "fr");
    }

    #[test]
    fn converter_link_is_checked_or_cleared() {
        let mut saved = Settings::default();
        let good = "https://example.com/convert?u={url}";
        assert_eq!(apply_preferences(&mut saved, Settings { converter_url_template: Some(format!("  {good} ")), ..Settings::default() }), None);
        assert_eq!(saved.converter_url_template.as_deref(), Some(good));
        // A page without a `{url}` slot is fine: the address is pasted there.
        assert_eq!(apply_preferences(&mut saved, Settings { converter_url_template: Some("https://example.com/convert".into()), ..Settings::default() }), None);
        assert_eq!(saved.converter_url_template.as_deref(), Some("https://example.com/convert"));
        for bad in ["http://example.com/{url}", "javascript:{url}", &format!("https://x.y/{{url}}{}", "a".repeat(300)), "https://x.y/{url}\u{7}?x"] {
            saved.converter_url_template = Some(good.into());
            let problem = apply_preferences(&mut saved, Settings { converter_url_template: Some(bad.into()), ..Settings::default() });
            assert!(problem.is_some_and(|p| p.contains("https://")), "{bad}");
            assert_eq!(saved.converter_url_template, None, "cleared: {bad}");
        }
        saved.converter_url_template = Some(good.into());
        assert_eq!(apply_preferences(&mut saved, Settings { converter_url_template: Some("   ".into()), ..Settings::default() }), None);
        assert_eq!(saved.converter_url_template, None, "an empty field clears it without an error");
    }

    #[test]
    fn an_unreadable_settings_file_is_kept_aside_and_never_blocks() {
        let dir = std::env::temp_dir().join(format!("hivo-settings-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // Missing: defaults, nothing moved.
        assert!(load_from(&path).unwrap().1.is_none());
        // A crash mid-write used to leave this.
        fs::write(&path, b"{\"watchedFolders\": [\"/mus").unwrap();
        let (settings, moved) = load_from(&path).unwrap();
        assert_eq!(settings.watched_folders, Vec::<String>::new());
        let bad = moved.expect("moved aside");
        assert!(bad.file_name().unwrap().to_string_lossy().starts_with("settings.json.bad-"), "timestamped: {}", bad.display());
        assert_eq!(fs::read(&bad).unwrap(), b"{\"watchedFolders\": [\"/mus", "the broken file is kept");
        // Saving works again, atomically, and reads back.
        let saved = Settings { render_format: "mp3".into(), ..Settings::default() };
        store_to(&path, &saved).unwrap();
        let (back, moved) = load_from(&path).unwrap();
        assert_eq!((back.render_format.as_str(), moved), ("mp3", None));
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn folders_that_cant_be_reached_are_reported() {
        let here = std::env::temp_dir().to_string_lossy().to_string();
        let gone = std::env::temp_dir().join(format!("hivo-unplugged-{}", std::process::id())).to_string_lossy().to_string();
        assert_eq!(unreachable(vec![here, gone.clone(), r"\\host\share".into()]), vec![gone, r"\\host\share".to_string()]);
    }

    #[test]
    fn folders_must_be_local_directories() {
        assert!(usable_folder(Path::new(r"\\host\share")).is_err());
        assert!(usable_folder(Path::new("/definitely/not/here")).is_err());
        assert!(usable_folder(&std::env::temp_dir()).is_ok());
    }

    #[test]
    fn detects_every_daw_folder_not_just_the_first() {
        let docs = std::env::temp_dir().join(format!("flsm-detect-{}", std::process::id()));
        let _ = fs::remove_dir_all(&docs);
        let fl = docs.join("Image-Line").join("FL Studio").join("Projects");
        let s1 = docs.join("Studio One").join("Songs");
        fs::create_dir_all(fl.join("Envy")).unwrap();
        fs::create_dir_all(s1.join("Glow")).unwrap();
        fs::write(fl.join("Envy").join("Envy.flp"), b"x").unwrap();
        fs::write(s1.join("Glow").join("Glow.song"), b"x").unwrap();
        fs::write(s1.join("Glow").join("Glow (2).song"), b"x").unwrap();

        let found = describe(existing_folders(&docs, None), &[fl.to_string_lossy().to_string()]);
        let _ = fs::remove_dir_all(&docs);
        let summary: Vec<(&str, usize, bool)> = found.iter().map(|f| (f.daw.as_str(), f.projects, f.linked)).collect();
        assert_eq!(summary, vec![("FL Studio", 1, true), ("Studio One", 2, false)]);
    }

    #[test]
    fn finds_ableton_where_live_actually_puts_its_folder() {
        // Live creates `Ableton` (Documents on Windows, ~/Music on macOS) with
        // its User Library inside; Sets are saved next to it. No `Projects`.
        let root = std::env::temp_dir().join(format!("flsm-detect-live-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (docs, music) = (root.join("Documents"), root.join("Music"));
        let live = music.join("Ableton");
        fs::create_dir_all(live.join("User Library").join("Templates")).unwrap();
        fs::create_dir_all(live.join("Night Run Project")).unwrap();
        fs::create_dir_all(&docs).unwrap();
        fs::write(live.join("User Library").join("Templates").join("Default.als"), b"x").unwrap();
        fs::write(live.join("Night Run Project").join("Night Run.als"), b"x").unwrap();

        let found = describe(existing_folders(&docs, Some(&music)), &[]);
        // Windows: Live's folder sits directly under Documents (no ~/Music).
        let win = describe(existing_folders(&music, None), &[]);
        let _ = fs::remove_dir_all(&root);
        let summary: Vec<(&str, usize)> = found.iter().map(|f| (f.daw.as_str(), f.projects)).collect();
        // One real Set; the template in the User Library doesn't count.
        assert_eq!(summary, vec![("Ableton Live", 1)]);
        assert!(win.iter().any(|f| f.daw == "Ableton Live"));
    }

    #[test]
    fn only_folders_that_exist_are_proposed() {
        let docs = std::env::temp_dir().join(format!("flsm-detect-none-{}", std::process::id()));
        assert!(existing_folders(&docs, None).is_empty());
        // Every supported DAW has at least one default location.
        let daws: std::collections::HashSet<&str> = default_project_folders(Path::new("/docs"), Some(Path::new("/music"))).into_iter().map(|(d, _)| d).collect();
        for d in ["FL Studio", "Studio One", "REAPER", "Ableton Live", "Cubase", "Bitwig Studio", "Pro Tools"] {
            assert!(daws.contains(d), "{d}");
        }
    }

    #[test]
    fn a_linked_folder_is_never_a_drive_the_home_folder_or_a_system_folder() {
        let home = std::env::temp_dir().join(format!("hivo-home-{}", std::process::id()));
        let beats = home.join("Music").join("Beats");
        let caches = home.join("Library").join("Caches");
        std::fs::create_dir_all(&beats).unwrap();
        std::fs::create_dir_all(&caches).unwrap();
        assert!(too_broad(Path::new("/"), Some(&home)));
        assert!(too_broad(&home, Some(&home)));
        assert!(too_broad(home.parent().unwrap(), Some(&home)));
        assert!(too_broad(&caches, Some(&home)));
        #[cfg(unix)]
        for system in ["/usr", "/etc", "/System", "/Library", "/Applications", "/Users", "/Volumes", "/private"] {
            assert!(too_broad(Path::new(system), None), "{system}");
        }
        #[cfg(windows)]
        for system in ["C:\\", "C:\\Windows", "C:\\Program Files", "C:\\ProgramData", "C:\\Users"] {
            assert!(too_broad(Path::new(system), None), "{system}");
        }
        assert!(!too_broad(&beats, Some(&home)));
        assert!(!too_broad(&beats, None));
        let _ = std::fs::remove_dir_all(home);
    }
}
