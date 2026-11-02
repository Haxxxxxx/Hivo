//! "Where each track's files live" (roadmap 1a): what's in a song's Launch
//! Kit folder. Project, backups, takes and mixdowns come from the scan.

use crate::audio::safe_name;
use crate::scanner::LAUNCH_KITS_DIR;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KitFile {
    pub path: String,
    /// Path inside the kit folder ("snippets/Hook 15s.wav").
    pub relative: String,
    pub size_bytes: u64,
}

fn kit_dir(output_folder: &str, folder_name: &str) -> PathBuf {
    Path::new(output_folder).join(LAUNCH_KITS_DIR).join(safe_name(folder_name))
}

/// Files in `<export>/Launch Kits/<song>/` (two levels: snippets/, shorts/),
/// sorted; empty if the kit was never exported.
fn list_kit(dir: &Path) -> Vec<KitFile> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut files: Vec<KitFile> = WalkDir::new(dir)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| KitFile {
            path: e.path().to_string_lossy().to_string(),
            relative: e.path().strip_prefix(dir).unwrap_or(e.path()).to_string_lossy().replace('\\', "/"),
            size_bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .collect();
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    files
}

/// The song's kit folder under the export folder from Settings.
#[tauri::command]
pub fn kit_files(app: tauri::AppHandle, folder_name: String) -> Vec<KitFile> {
    let Some(out) = crate::scope::Scope::load(&app).ok().and_then(|s| s.output_folder().map(|o| o.to_string_lossy().to_string())) else {
        return Vec::new();
    };
    list_kit(&kit_dir(&out, &folder_name))
}

/// What a song's `BandLab/` folder holds (audio attached from the phone
/// inbox, stems in `Stems/`). The song must be in a linked folder.
#[tauri::command]
pub fn bandlab_files(app: tauri::AppHandle, song_path: String) -> Vec<KitFile> {
    let Ok(scope) = crate::scope::Scope::load(&app) else { return Vec::new() };
    let Ok(folder) = crate::phone_sync::song_folder(&scope, &song_path) else { return Vec::new() };
    list_kit(&folder.join(crate::sketch::SKETCH_DIR))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_a_kit_folder() {
        let out = std::env::temp_dir().join(format!("flsm-kitfiles-{}", std::process::id()));
        let dir = kit_dir(out.to_str().unwrap(), "Night: Run");
        fs::create_dir_all(dir.join("snippets")).unwrap();
        fs::write(dir.join("metadata.json"), b"{}").unwrap();
        fs::write(dir.join("snippets").join("Hook 15s.wav"), b"x").unwrap();
        fs::write(dir.join(".DS_Store"), b"").unwrap();
        let files = list_kit(&dir);
        let _ = fs::remove_dir_all(&out);
        let rel: Vec<_> = files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(rel, vec!["metadata.json", "snippets/Hook 15s.wav"]);
        assert!(dir.ends_with("Launch Kits/Night_ Run"), "same sanitizing as the export");
    }

    #[test]
    fn missing_kit_is_empty() {
        assert!(list_kit(&kit_dir("/definitely/not/here", "Song")).is_empty());
    }
}
