//! What commands may touch, decided in Rust from the saved settings.
//!
//! The webview is treated as untrusted (security audit, Batch 0 item 7):
//! every root, executable and output folder comes from settings.json, read
//! here, never from IPC arguments. Paths a command does receive (a project,
//! a mixdown, a template) are checked against those roots. The path
//! settings themselves only change through native pickers or detection run
//! in Rust (settings.rs), so the webview can't widen them either.

use crate::daws::Daw;
use crate::models::Settings;
use crate::paths::is_remote_or_device;
use std::path::{Component, Path, PathBuf};

/// Checks use resolved paths (symlinks and `..` followed); commands get
/// back the path as given, so it matches what the scan listed.
pub struct Scope {
    /// Linked project folders, as saved.
    folders: Vec<PathBuf>,
    /// The same, resolved.
    roots: Vec<PathBuf>,
    /// The export folder (renders, packages, Launch Kits): as saved, resolved.
    output: Option<(PathBuf, PathBuf)>,
    /// Beats folders (the Digger), as saved and resolved. Separate from the
    /// project folders: beats are never projects, songs never beats.
    beat_folders: Vec<PathBuf>,
    beat_roots: Vec<PathBuf>,
    /// Sample libraries, resolved: walked by the scanner's resolver only.
    sample_folders: Vec<PathBuf>,
    fl_studio: Option<String>,
    ffmpeg: Option<String>,
    pub render_format: String,
    pub ai_include_notes: bool,
    pub dig_send_audio: bool,
}

/// `path` with symlinks and `..` resolved. A path that doesn't exist yet
/// resolves through its nearest existing parent.
fn resolve(path: &Path) -> Option<PathBuf> {
    if is_remote_or_device(&path.to_string_lossy()) || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    if let Ok(real) = path.canonicalize() {
        return Some(plain(real));
    }
    let parent = resolve(path.parent()?)?;
    Some(parent.join(path.file_name()?))
}

use crate::paths::plain;

fn inside(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// Audio Hivo can decode (symphonia: wav, mp3, ogg, flac, and m4a = AAC or
/// ALAC in MP4) and the webview can play.
pub fn is_beat_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "wav" | "mp3" | "ogg" | "flac" | "m4a")
}

/// Audio a beats folder may hold that the Digger can't read (no decoder, or
/// the webview can't play it): counted, so the list can say so.
pub fn is_unsupported_audio(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "opus" | "aac" | "wma" | "aif" | "aiff" | "webm" | "weba" | "alac" | "ape")
}

fn denied(what: &str, path: &str) -> String {
    format!("{what} isn't inside a folder linked in Settings: {path}")
}

impl Scope {
    pub fn from_settings(s: &Settings) -> Self {
        Self {
            folders: s.watched_folders.iter().map(PathBuf::from).filter(|f| resolve(f).is_some()).collect(),
            roots: s.watched_folders.iter().filter_map(|f| resolve(Path::new(f))).collect(),
            output: s.output_folder.as_deref().and_then(|f| Some((PathBuf::from(f), resolve(Path::new(f))?))),
            beat_folders: s.beat_folders.iter().map(PathBuf::from).filter(|f| resolve(f).is_some()).collect(),
            beat_roots: s.beat_folders.iter().filter_map(|f| resolve(Path::new(f))).collect(),
            sample_folders: s.sample_folders.iter().filter_map(|f| resolve(Path::new(f))).collect(),
            fl_studio: s.fl_studio_path.clone(),
            ffmpeg: s.ffmpeg_path.clone(),
            render_format: s.render_format.clone(),
            ai_include_notes: s.ai_include_notes,
            dig_send_audio: s.dig_send_audio,
        }
    }

    pub fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        Ok(Self::from_settings(&crate::settings::load(app)?))
    }

    fn in_roots(&self, path: &Path) -> bool {
        self.roots.iter().any(|r| inside(path, r))
    }

    fn in_output(&self, path: &Path) -> bool {
        self.output.as_ref().is_some_and(|(_, o)| inside(path, o))
    }

    /// A lead file (`_leads/` inside a beats folder): the one thing the app
    /// shows from a beats folder besides the beats themselves.
    fn in_beat_leads(&self, path: &Path) -> bool {
        self.beat_roots.iter().any(|r| inside(path, &r.join(crate::leads::LEADS_DIR)))
    }

    /// A phone memo copied into a beats folder's `_memos` (linked to a beat
    /// or a saved prod, phone_inbox.rs): shown and revealed like a lead.
    fn in_beat_memos(&self, path: &Path) -> bool {
        self.beat_roots.iter().any(|r| inside(path, &r.join(crate::phone_inbox::BEAT_MEMOS_DIR)))
    }

    /// A DAW project file inside a linked folder.
    pub fn project(&self, path: &str) -> Result<PathBuf, String> {
        let real = resolve(Path::new(path)).filter(|p| self.in_roots(p)).ok_or_else(|| denied("That project", path))?;
        if Daw::of_project(&real).is_none() || !real.is_file() {
            return Err(format!("not a project file: {path}"));
        }
        Ok(PathBuf::from(path))
    }

    /// An FL Studio project inside a linked folder (render, package).
    pub fn fl_project(&self, path: &str) -> Result<PathBuf, String> {
        let p = self.project(path)?;
        if Daw::of_project(&p) != Some(Daw::FlStudio) {
            return Err(format!("not an FL Studio project: {path}"));
        }
        Ok(p)
    }

    /// A folder inside a linked folder (where a new song goes).
    pub fn folder_in_roots(&self, path: &str) -> Result<PathBuf, String> {
        resolve(Path::new(path))
            .filter(|p| self.in_roots(p) && p.is_dir())
            .map(|_| PathBuf::from(path))
            .ok_or_else(|| denied("That folder", path))
    }

    /// Any file in a linked folder or the export folder (what the app shows,
    /// plays or analyzes: projects, renders, kit files), or a saved lead or
    /// a phone memo in a beats folder's `_leads` / `_memos`.
    pub fn known_file(&self, path: &str) -> Result<PathBuf, String> {
        resolve(Path::new(path))
            .filter(|p| self.in_roots(p) || self.in_output(p) || self.in_beat_leads(p) || self.in_beat_memos(p))
            .map(|_| PathBuf::from(path))
            .ok_or_else(|| denied("That file", path))
    }

    /// A lead file in a beats folder's `_leads` (the one file the app may
    /// delete there).
    pub fn lead_file(&self, path: &str) -> Result<PathBuf, String> {
        let real = resolve(Path::new(path)).filter(|p| self.in_beat_leads(p)).ok_or_else(|| denied("That lead", path))?;
        if real.extension().and_then(|e| e.to_str()) != Some("md") || !real.is_file() {
            return Err(format!("not a lead file: {path}"));
        }
        Ok(real)
    }

    /// An audio file (a mixdown) in a linked folder or the export folder.
    pub fn audio(&self, path: &str) -> Result<PathBuf, String> {
        let p = self.known_file(path)?;
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "wav" | "mp3" | "ogg" | "flac") {
            return Err(format!("not a mixdown: {path}"));
        }
        Ok(p)
    }

    /// A beat (an audio file) inside a beats folder (the Digger).
    pub fn beat(&self, path: &str) -> Result<PathBuf, String> {
        let real = resolve(Path::new(path))
            .filter(|p| self.beat_roots.iter().any(|r| inside(p, r)))
            .ok_or_else(|| format!("That beat isn't inside a beats folder linked in Settings: {path}"))?;
        if !is_beat_file(&real) || !real.is_file() {
            return Err(format!("not a beat (mp3, wav, ogg, flac or m4a): {path}"));
        }
        // The resolved path: what was checked is what gets opened.
        Ok(real)
    }

    /// The beats folders, as saved.
    pub fn beat_folders(&self) -> &[PathBuf] {
        &self.beat_folders
    }

    /// The sample libraries, resolved.
    pub fn sample_folders(&self) -> &[PathBuf] {
        &self.sample_folders
    }

    /// The export folder from Settings, as saved.
    pub fn output(&self) -> Result<&Path, String> {
        self.output.as_ref().map(|(o, _)| o.as_path()).ok_or_else(|| "Set an export folder in Settings first.".to_string())
    }

    /// The linked folders, as saved (what the scan walks).
    pub fn folders(&self) -> &[PathBuf] {
        &self.folders
    }

    pub fn output_folder(&self) -> Option<&Path> {
        self.output.as_ref().map(|(o, _)| o.as_path())
    }

    /// The FL Studio executable from Settings, if it is one.
    pub fn fl_studio(&self) -> Result<PathBuf, String> {
        let set = self.fl_studio.as_deref().ok_or("FL Studio isn't set (see Settings).")?;
        fl_studio_binary(Path::new(set)).ok_or_else(|| format!("The FL Studio path in Settings isn't FL Studio: {set}"))
    }

    /// The ffmpeg path from Settings, if it is ffmpeg.
    pub fn ffmpeg(&self) -> Option<PathBuf> {
        self.ffmpeg.as_deref().map(Path::new).filter(|p| is_ffmpeg(p)).map(Path::to_path_buf)
    }
}

/// FL Studio's executable for `path`: `FL64.exe` / `FL.exe` on Windows, the
/// binary inside an `FL Studio*.app` bundle on macOS (the bundle itself is
/// accepted too). None if it isn't FL Studio.
pub fn fl_studio_binary(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    let is_fl_app = |p: &Path| p.file_name().is_some_and(|n| {
        let n = n.to_string_lossy().to_lowercase();
        n.starts_with("fl studio") && n.ends_with(".app")
    });
    if is_fl_app(path) && path.is_dir() {
        let bin_dir = path.join("Contents").join("MacOS");
        return std::fs::read_dir(&bin_dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.is_file());
    }
    if !path.is_file() {
        return None;
    }
    let windows_exe = matches!(name.as_str(), "fl64.exe" | "fl.exe" | "fl64 (scaled).exe");
    // <FL Studio*.app>/Contents/MacOS/<binary>
    let in_bundle = path.parent().filter(|d| d.ends_with("Contents/MacOS")).and_then(|d| d.parent()?.parent()).is_some_and(is_fl_app);
    (windows_exe || in_bundle).then(|| path.to_path_buf())
}

/// An `ffmpeg` / `ffmpeg.exe` file.
pub fn is_ffmpeg(path: &Path) -> bool {
    path.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("ffmpeg"))
        && path.extension().is_none_or(|e| e.eq_ignore_ascii_case("exe"))
        && path.is_file()
}

/// One folder name under the export folder (an album's renders or
/// packages): no separators, no `..`, no leading dots. None if nothing usable is left.
pub fn safe_subfolder(sub: &str) -> Option<String> {
    let name = sub.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let name = name.trim().trim_start_matches('.').trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::fs;

    pub struct Fixture {
        pub dir: PathBuf,
        pub root: PathBuf,
        pub out: PathBuf,
        pub outside: PathBuf,
        pub scope: Scope,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// A linked folder with one FL and one Ableton project, an export folder
    /// with a render, and a folder outside both with a project and a file.
    pub fn fixture(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("flsm-scope-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("Projects");
        let out = dir.join("Exports");
        let outside = dir.join("Elsewhere");
        for d in [root.join("Envy"), root.join("Wave Project"), out.clone(), outside.clone()] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(root.join("Envy").join("Envy.flp"), b"FLhd").unwrap();
        fs::write(root.join("Wave Project").join("Wave.als"), b"x").unwrap();
        fs::write(out.join("Envy.wav"), b"RIFF").unwrap();
        fs::write(outside.join("Other.flp"), b"FLhd").unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        let settings = Settings {
            watched_folders: vec![root.to_string_lossy().to_string()],
            output_folder: Some(out.to_string_lossy().to_string()),
            ..Settings::default()
        };
        let scope = Scope::from_settings(&settings);
        Fixture { dir, root, out, outside, scope }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn projects_must_be_inside_a_linked_folder() {
        let f = fixture("projects");
        assert!(f.scope.project(&s(&f.root.join("Envy").join("Envy.flp"))).is_ok());
        assert!(f.scope.project(&s(&f.outside.join("Other.flp"))).is_err());
        let climb = f.root.join("Envy").join("..").join("..").join("Elsewhere").join("Other.flp");
        assert!(f.scope.project(&s(&climb)).is_err(), "`..` can't climb out");
        assert!(f.scope.project(&s(&f.out.join("Envy.wav"))).is_err(), "not a project");
        assert!(f.scope.fl_project(&s(&f.root.join("Wave Project").join("Wave.als"))).is_err(), "not FL");
        assert!(f.scope.project(r"\\host\share\Envy.flp").is_err());
    }

    #[test]
    fn a_symlink_out_of_a_linked_folder_is_refused() {
        let f = fixture("symlink");
        #[cfg(unix)]
        {
            let link = f.root.join("Envy").join("Sneaky.flp");
            std::os::unix::fs::symlink(f.outside.join("Other.flp"), &link).unwrap();
            assert!(f.scope.project(&s(&link)).is_err());
            let dir_link = f.root.join("Linked");
            std::os::unix::fs::symlink(&f.outside, &dir_link).unwrap();
            assert!(f.scope.known_file(&s(&dir_link.join("secret.txt"))).is_err());
        }
    }

    #[test]
    fn files_and_mixdowns_come_from_linked_or_export_folders() {
        let f = fixture("files");
        assert!(f.scope.audio(&s(&f.out.join("Envy.wav"))).is_ok());
        assert!(f.scope.known_file(&s(&f.outside.join("secret.txt"))).is_err());
        assert!(f.scope.audio(&s(&f.root.join("Envy").join("Envy.flp"))).is_err(), "not audio");
        assert!(f.scope.folder_in_roots(&s(&f.root)).is_ok());
        assert!(f.scope.folder_in_roots(&s(&f.outside)).is_err());
        assert_eq!(f.scope.output().unwrap(), f.out.as_path());
        assert!(Scope::from_settings(&Settings::default()).output().is_err());
    }

    #[test]
    fn a_beats_folder_only_reveals_its_leads() {
        let f = fixture("leads");
        let beats = f.dir.join("Beats");
        fs::create_dir_all(beats.join("_leads")).unwrap();
        fs::write(beats.join("_leads").join("night-8fd69810.md"), b"# Night").unwrap();
        fs::write(beats.join("kick.wav"), b"RIFF").unwrap();
        let settings = Settings { beat_folders: vec![s(&beats)], ..Settings::default() };
        let scope = Scope::from_settings(&settings);
        assert!(scope.known_file(&s(&beats.join("_leads").join("night-8fd69810.md"))).is_ok());
        assert!(scope.known_file(&s(&beats.join("kick.wav"))).is_err(), "beats themselves go through `beat()`");
        assert!(scope.known_file(&s(&beats.join("_leads").join("..").join("kick.wav"))).is_err());
        assert!(scope.known_file(&s(&f.outside.join("secret.txt"))).is_err());
        assert!(f.scope.known_file(&s(&beats.join("_leads").join("night-8fd69810.md"))).is_err(), "no beats folder linked");
    }

    #[test]
    fn only_fl_studio_and_ffmpeg_binaries_are_accepted() {
        let f = fixture("binaries");
        let fake = f.outside.join("payload.sh");
        fs::write(&fake, b"#!/bin/sh").unwrap();
        assert!(fl_studio_binary(&fake).is_none());
        assert!(fl_studio_binary(Path::new("/usr/bin/true")).is_none());
        let win = f.outside.join("FL64.exe");
        fs::write(&win, b"MZ").unwrap();
        assert_eq!(fl_studio_binary(&win), Some(win.clone()));
        let app = f.outside.join("FL Studio 2025.app");
        fs::create_dir_all(app.join("Contents").join("MacOS")).unwrap();
        fs::write(app.join("Contents").join("MacOS").join("FL Studio"), b"x").unwrap();
        assert_eq!(fl_studio_binary(&app), Some(app.join("Contents").join("MacOS").join("FL Studio")));
        assert!(fl_studio_binary(&app.join("Contents").join("MacOS").join("FL Studio")).is_some());

        let ff = f.outside.join("ffmpeg");
        fs::write(&ff, b"x").unwrap();
        assert!(is_ffmpeg(&ff));
        assert!(!is_ffmpeg(&fake));
        let settings = Settings { fl_studio_path: Some(s(&fake)), ffmpeg_path: Some(s(&fake)), ..Settings::default() };
        let scope = Scope::from_settings(&settings);
        assert!(scope.fl_studio().is_err());
        assert!(scope.ffmpeg().is_none());
    }

    #[test]
    fn subfolders_cannot_climb() {
        assert_eq!(safe_subfolder("..").as_deref(), None);
        assert_eq!(safe_subfolder("../../etc").as_deref(), Some("_.._etc"));
        assert_eq!(safe_subfolder(" .hidden ").as_deref(), Some("hidden"));
        assert_eq!(safe_subfolder("Night Run (EP)").as_deref(), Some("Night Run (EP)"));
        assert_eq!(safe_subfolder("   ").as_deref(), None);
    }

    /// The checks each command runs before touching anything (render,
    /// package, analyze, shorts, open, reveal), with hostile inputs.
    #[test]
    fn every_command_refuses_paths_outside_settings() {
        let f = fixture("commands");
        let outside_flp = s(&f.outside.join("Other.flp"));
        let climb = s(&f.root.join("..").join("Elsewhere").join("Other.flp"));
        let secret = s(&f.outside.join("secret.txt"));
        // render_projects / package_preview / package_projects
        for p in [&outside_flp, &climb] {
            assert!(f.scope.fl_project(p).is_err(), "{p}");
        }
        assert!(f.scope.fl_project(&s(&f.root.join("Wave Project").join("Wave.als"))).is_err(), "FL only");
        assert!(f.scope.fl_studio().is_err(), "no FL Studio set = no render");
        // analyze_audio / export_launch_kit master / render_shorts master
        assert!(f.scope.audio(&secret).is_err());
        let outside_wav = f.outside.join("mix.wav");
        fs::write(&outside_wav, b"RIFF").unwrap();
        assert!(f.scope.audio(&s(&outside_wav)).is_err());
        // open_project / reveal_path / duplicate_project / restore_backup
        assert!(f.scope.project(&outside_flp).is_err());
        assert!(f.scope.known_file(&secret).is_err());
        assert!(f.scope.known_file(&s(&f.out.join("Envy.wav"))).is_ok());
        // Album subfolders and names can't climb out of the export folder.
        assert!(safe_subfolder("..").is_none());
        let name = crate::audio::safe_name("../../Library/LaunchAgents/x");
        assert!(!name.contains(['/', '\\']) && !name.starts_with('.'), "{name}");
    }
}
