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
        .map_err(|e| format!("could not resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Where an unreadable settings.json was moved (`settings.json.bad`), until
/// the webview has been told once (`take_settings_recovery`).
static RECOVERED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Reads settings.json. One that doesn't parse is moved aside to
/// `settings.json.bad` (kept for the user) and the defaults are used, so a
/// corrupt file never blocks every save and picker. Returns where it went.
fn load_from(path: &Path) -> Result<(Settings, Option<PathBuf>), String> {
    if !path.exists() {
        return Ok((Settings::default(), None));
    }
    let raw = fs::read(path).map_err(|e| format!("could not read settings: {e}"))?;
    match serde_json::from_slice(&raw) {
        Ok(settings) => Ok((settings, None)),
        Err(parse) => {
            let bad = crate::workspace::sibling(path, "bad");
            fs::rename(path, &bad).map_err(|e| format!("could not parse settings ({parse}) or move them aside: {e}"))?;
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
        Err(format!("The converter link must start with https:// ({MAX_CONVERTER_CHARS} characters max)."))
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
    .map_err(|e| format!("the picker failed: {e}"))
}

fn usable_folder(path: &Path) -> Result<String, String> {
    let s = path.to_string_lossy().to_string();
    if is_remote_or_device(&s) || !path.is_dir() {
        return Err(format!("not a folder on this computer: {s}"));
    }
    Ok(s)
}

fn add_watched(app: &AppHandle, folder: &Path) -> Result<Settings, String> {
    let folder = usable_folder(folder)?;
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
        return Err(format!("not a detected DAW folder: {path}"));
    }
    add_watched(&app, Path::new(&path))
}

/// Unlinks a folder (only ever shrinks what the app may touch).
#[tauri::command]
pub fn remove_watched_folder(app: AppHandle, folder: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    saved.watched_folders.retain(|f| f != &folder);
    store(&app, &saved)?;
    Ok(saved)
}

/// Adds a beats folder the user picks (the Digger's source).
#[tauri::command]
pub async fn pick_beat_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    if too_broad_for_beats(&folder, app.path().home_dir().ok().as_deref()) {
        return Err("Pick the folder where your beats are, not a whole drive or your home folder: the app can play every file in it.".to_string());
    }
    let folder = usable_folder(&folder)?;
    let mut saved = load(&app)?;
    if !saved.beat_folders.contains(&folder) {
        saved.beat_folders.push(folder);
        store(&app, &saved)?;
    }
    Ok(saved)
}

/// The webview may read every file in a beats folder (to play the beats), so
/// a drive root, the home folder or anything above it is refused.
fn too_broad_for_beats(folder: &Path, home: Option<&Path>) -> bool {
    let real = folder.canonicalize().unwrap_or_else(|_| folder.to_path_buf());
    if real.parent().is_none() {
        return true;
    }
    home.map(|h| h.canonicalize().unwrap_or_else(|_| h.to_path_buf())).is_some_and(|h| h.starts_with(&real))
}

/// Removes a beats folder (only ever shrinks what the app may touch).
#[tauri::command]
pub fn remove_beat_folder(app: AppHandle, folder: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    saved.beat_folders.retain(|f| f != &folder);
    store(&app, &saved)?;
    Ok(saved)
}

/// Adds a sample library the user picks: the scanner looks up samples a
/// project stores under another path by file name in there. A whole drive
/// or the home folder would take ages to walk, so they're refused.
#[tauri::command]
pub async fn pick_sample_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    if too_broad_for_beats(&folder, app.path().home_dir().ok().as_deref()) {
        return Err("Pick the folder where your samples or packs are, not a whole drive or your home folder.".to_string());
    }
    let folder = usable_folder(&folder)?;
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

#[tauri::command]
pub async fn pick_output_folder(app: AppHandle) -> Result<Settings, String> {
    let Some(folder) = pick(&app, true).await? else { return load(&app) };
    let folder = usable_folder(&folder)?;
    let mut saved = load(&app)?;
    saved.output_folder = Some(folder);
    store(&app, &saved)?;
    Ok(saved)
}

fn set_fl_studio(app: &AppHandle, path: &Path) -> Result<Settings, String> {
    let exe = fl_studio_binary(path).ok_or_else(|| format!("That isn't FL Studio: {}", path.display()))?;
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
    let found = detect_fl_studio().ok_or("FL Studio wasn't found. Pick it by hand.")?;
    set_fl_studio(&app, Path::new(&found))
}

#[tauri::command]
pub async fn pick_ffmpeg(app: AppHandle) -> Result<Settings, String> {
    let Some(path) = pick(&app, false).await? else { return load(&app) };
    if !is_ffmpeg(&path) {
        return Err(format!("That isn't ffmpeg: {}", path.display()));
    }
    let mut saved = load(&app)?;
    saved.ffmpeg_path = Some(path.to_string_lossy().to_string());
    store(&app, &saved)?;
    Ok(saved)
}

/// Clears a path setting: "flStudio", "ffmpeg" or "outputFolder".
#[tauri::command]
pub fn clear_path_setting(app: AppHandle, which: String) -> Result<Settings, String> {
    let mut saved = load(&app)?;
    match which.as_str() {
        "flStudio" => saved.fl_studio_path = None,
        "ffmpeg" => saved.ffmpeg_path = None,
        "outputFolder" => saved.output_folder = None,
        other => return Err(format!("unknown setting: {other}")),
    }
    store(&app, &saved)?;
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
    let Ok(docs) = app.path().document_dir() else { return Vec::new() };
    let music = app.path().audio_dir().ok();
    existing_folders(&docs, music.as_deref())
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
        // (e.g. D:\Programmes\Image-Line\FL64.exe).
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let from_registry = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Image-Line\\Shared\\Paths")
            .and_then(|k| k.get_value::<String, _>("FL Studio"))
            .ok()
            .filter(|p| std::path::Path::new(p).exists());
        if from_registry.is_some() {
            return from_registry;
        }

        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let base = std::path::Path::new(&program_files).join("Image-Line");
        if let Ok(entries) = fs::read_dir(&base) {
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
                let exe = entry.path().join("FL64.exe");
                if exe.exists() {
                    return Some(exe.to_string_lossy().to_string());
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
        assert_eq!(bad, dir.join("settings.json.bad"));
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
    fn a_beats_folder_is_never_a_drive_or_the_home_folder() {
        let home = std::env::temp_dir().join(format!("hivo-home-{}", std::process::id()));
        let beats = home.join("Music").join("Beats");
        std::fs::create_dir_all(&beats).unwrap();
        assert!(too_broad_for_beats(Path::new("/"), Some(&home)));
        assert!(too_broad_for_beats(&home, Some(&home)));
        assert!(too_broad_for_beats(home.parent().unwrap(), Some(&home)));
        assert!(!too_broad_for_beats(&beats, Some(&home)));
        assert!(!too_broad_for_beats(&beats, None));
        let _ = std::fs::remove_dir_all(home);
    }
}
