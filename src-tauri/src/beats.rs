//! Beats for the Digger: raw beats (mp3/wav, often downloaded from YouTube)
//! in the beats folders from Settings. They're listed and played, never
//! treated as projects, never shared with the crew.

use crate::scope::{is_beat_file, Scope};
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;
use walkdir::WalkDir;

/// One beat file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatFile {
    pub path: String,
    /// File name without the extension ("Night Drive - Dark Trap Beat (prod. X)").
    pub name: String,
    pub folder: String,
    pub size_bytes: u64,
    pub modified_at_ms: i64,
}

/// How deep to look inside a beats folder.
const MAX_DEPTH: usize = 4;
/// Enough for any crew's beats; protects against a whole drive picked by mistake.
const MAX_BEATS: usize = 5_000;
/// Entries looked at, beats or not: a huge folder can't stall the scan.
const MAX_VISITED: usize = 100_000;

pub fn list_beats(folders: &[std::path::PathBuf]) -> Vec<BeatFile> {
    let mut out = Vec::new();
    let mut visited = 0usize;
    'roots: for root in folders {
        // Phone memos linked to beats (`_memos`) aren't beats.
        let walker = WalkDir::new(root)
            .max_depth(MAX_DEPTH)
            .into_iter()
            .filter_entry(|e| !(e.depth() == 1 && e.file_type().is_dir() && e.file_name() == crate::phone_inbox::BEAT_MEMOS_DIR));
        for e in walker.filter_map(|e| e.ok()) {
            visited += 1;
            if out.len() >= MAX_BEATS || visited > MAX_VISITED {
                break 'roots;
            }
            let p = e.path();
            if !e.file_type().is_file() || !is_beat_file(p) || is_hidden(p) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            out.push(BeatFile {
                path: p.to_string_lossy().to_string(),
                name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                folder: p.parent().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
                size_bytes: meta.len(),
                modified_at_ms: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            });
        }
    }
    out.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms).then_with(|| a.name.cmp(&b.name)));
    out
}

fn is_hidden(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// The beats in the beats folders, newest first. Lets the webview play them
/// (asset protocol) inside those folders only.
#[tauri::command]
pub async fn scan_beats(app: AppHandle) -> Result<Vec<BeatFile>, String> {
    let scope = Scope::load(&app)?;
    let folders = scope.beat_folders().to_vec();
    let assets = tauri::Manager::asset_protocol_scope(&app);
    for f in &folders {
        let _ = assets.allow_directory(f, true);
    }
    tauri::async_runtime::spawn_blocking(move || list_beats(&folders))
        .await
        .map_err(|e| format!("beat scan failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_only_beats_newest_first() {
        let root = std::env::temp_dir().join(format!("flsm-beats-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("YouTube").join("dark")).unwrap();
        fs::write(root.join("Night Drive (prod. X).mp3"), b"x").unwrap();
        fs::write(root.join("YouTube").join("dark").join("Cold Room.wav"), b"x").unwrap();
        fs::write(root.join("cover.jpg"), b"x").unwrap();
        fs::write(root.join("Session.flp"), b"x").unwrap();
        fs::write(root.join(".hidden.mp3"), b"x").unwrap();
        fs::write(root.join("song.m4a"), b"x").unwrap();
        let mut names: Vec<String> = list_beats(&[root.clone()]).into_iter().map(|b| b.name).collect();
        let _ = fs::remove_dir_all(&root);
        names.sort();
        assert_eq!(names, vec!["Cold Room", "Night Drive (prod. X)"]);
    }

    #[test]
    fn a_beat_must_live_in_a_beats_folder() {
        let root = std::env::temp_dir().join(format!("flsm-beat-scope-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("beats")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("beats").join("a.mp3"), b"x").unwrap();
        fs::write(root.join("other").join("b.mp3"), b"x").unwrap();
        fs::write(root.join("beats").join("c.txt"), b"x").unwrap();
        let s = crate::models::Settings { beat_folders: vec![root.join("beats").to_string_lossy().to_string()], ..Default::default() };
        let scope = Scope::from_settings(&s);
        let ok = scope.beat(&root.join("beats").join("a.mp3").to_string_lossy());
        let outside = scope.beat(&root.join("other").join("b.mp3").to_string_lossy());
        let climb = scope.beat(&root.join("beats").join("..").join("other").join("b.mp3").to_string_lossy());
        let not_audio = scope.beat(&root.join("beats").join("c.txt").to_string_lossy());
        let _ = fs::remove_dir_all(&root);
        assert!(ok.is_ok());
        assert!(outside.is_err() && climb.is_err() && not_audio.is_err());
    }
}
