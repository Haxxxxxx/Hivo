//! "In your prods" beyond the beats list (NOVEMBER-PLAN C5): a saved prod
//! also counts as yours when its file is an AIFF in a beats folder (the beats
//! list skips formats the Digger can't decode) or, when the user turned it
//! on, any audio file in the Downloads folder (a converter's usual target).
//!
//! Names only: nothing here opens a file's content. The folders come from
//! saved settings and the OS (Downloads), never from the webview. "Move to
//! beats folder" takes a file from Downloads into the first beats folder,
//! never overwriting, never through a symlink. Hivo still never downloads.

use crate::error::{app_err, path_err};
use crate::scope::{is_beat_file, resolve, Scope};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

/// Where a prod file was found.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProdPlace {
    Beats,
    Downloads,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdFile {
    pub path: String,
    /// File name without the extension: what a saved prod's title is matched to.
    pub name: String,
    pub place: ProdPlace,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProdScan {
    pub files: Vec<ProdFile>,
    /// Downloads is on in Settings (whether or not it could be read).
    pub downloads_on: bool,
    /// Downloads couldn't be read (macOS asked and was refused, no folder).
    pub downloads_unreadable: bool,
    /// The listing stopped early.
    pub capped: bool,
}

/// Downloads holds anything: a shallow look, and a cap.
const DOWNLOADS_DEPTH: usize = 2;
/// The beats folders' depth, as `beats::list_beats`.
const BEATS_DEPTH: usize = 4;
const MAX_FILES: usize = 5_000;
const MAX_VISITED: usize = 50_000;

/// AIFF: a prod format the beats list skips (no decoder in the Digger).
fn is_aiff(p: &Path) -> bool {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "aif" | "aiff")
}

/// Any audio a converter may leave (the beat formats plus AIFF).
fn is_prod_audio(p: &Path) -> bool {
    is_beat_file(p) || is_aiff(p)
}

fn hidden(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// Lists, by name, the files `keep` accepts under `root` (symlinks not followed).
fn walk(root: &Path, depth: usize, place: ProdPlace, keep: fn(&Path) -> bool, scan: &mut ProdScan, visited: &mut usize) -> bool {
    if !root.is_dir() {
        return false;
    }
    for e in WalkDir::new(root).max_depth(depth).into_iter().filter_entry(|e| e.depth() == 0 || !hidden(e.path())) {
        let Ok(e) = e else { continue };
        *visited += 1;
        if *visited > MAX_VISITED || scan.files.len() >= MAX_FILES {
            scan.capped = true;
            break;
        }
        let p = e.path();
        if e.file_type().is_file() && keep(p) {
            scan.files.push(ProdFile {
                path: p.to_string_lossy().to_string(),
                name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                place,
            });
        }
    }
    true
}

/// The candidates: AIFF in the beats folders, then (when on) audio in Downloads.
pub fn list_prod_files(beat_folders: &[PathBuf], downloads: Option<&Path>) -> ProdScan {
    let mut scan = ProdScan { downloads_on: downloads.is_some(), ..Default::default() };
    let mut visited = 0usize;
    for root in beat_folders {
        walk(root, BEATS_DEPTH, ProdPlace::Beats, is_aiff, &mut scan, &mut visited);
    }
    if let Some(d) = downloads {
        if !walk(d, DOWNLOADS_DEPTH, ProdPlace::Downloads, is_prod_audio, &mut scan, &mut visited) {
            scan.downloads_unreadable = true;
        }
    }
    scan
}

/// The Downloads folder, when the user turned it on in Settings.
fn downloads_dir(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    if !crate::settings::load(app)?.prod_match_downloads {
        return Ok(None);
    }
    Ok(app.path().download_dir().ok())
}

#[tauri::command]
pub async fn scan_prod_files(app: AppHandle) -> Result<ProdScan, String> {
    let scope = Scope::load(&app)?;
    let folders = scope.beat_folders().to_vec();
    let downloads = downloads_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_prod_files(&folders, downloads.as_deref()))
        .await
        .map_err(|e| app_err("task.failed", format!("prod scan failed: {e}")).into())
}

/// `name.ext`, else `name (2).ext`, `name (3).ext`… in `dir`: a name not taken.
fn free_name(dir: &Path, file: &Path) -> Option<PathBuf> {
    let stem = file.file_stem()?.to_string_lossy().to_string();
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..1000).map(|n| if n == 1 { dir.join(format!("{stem}{ext}")) } else { dir.join(format!("{stem} ({n}){ext}")) }).find(|p| fs::symlink_metadata(p).is_err())
}

/// Moves `src` (checked) into `dir`. A rename when it can; across drives,
/// a copy to a new file then the original is removed.
pub fn move_into(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    let dest = free_name(dir, src).ok_or_else(|| String::from(app_err("prods.noName", "no free file name in the beats folder")))?;
    if fs::rename(src, &dest).is_ok() {
        return Ok(dest);
    }
    let mut from = fs::File::open(src).map_err(|e| path_err("io.read", src, format!("could not read {}: {e}", src.display())))?;
    let mut to = fs::OpenOptions::new().write(true).create_new(true).open(&dest).map_err(|e| path_err("io.create", &dest, format!("could not create {}: {e}", dest.display())))?;
    if let Err(e) = std::io::copy(&mut from, &mut to).and_then(|_| to.sync_all()) {
        drop(to);
        let _ = fs::remove_file(&dest);
        return Err(path_err("io.write", &dest, format!("could not copy into the beats folder: {e}")).into());
    }
    fs::remove_file(src).map_err(|e| path_err("io.delete", src, format!("copied, but the original couldn't be removed: {e}")))?;
    Ok(dest)
}

/// "Move to beats folder": a prod file in Downloads into the first beats
/// folder. Only a regular audio file inside Downloads (resolved, no symlink),
/// only while Downloads is on. Answers the new path.
#[tauri::command]
pub async fn move_prod_to_beats(app: AppHandle, path: String) -> Result<String, String> {
    let scope = Scope::load(&app)?;
    let Some(downloads) = downloads_dir(&app)? else {
        return Err(app_err("prods.downloadsOff", "Turn on \"Look in Downloads\" first.").into());
    };
    let Some(target) = scope.beat_folders().first().cloned() else {
        return Err(app_err("prods.noBeatsFolder", "Link a beats folder in Settings first.").into());
    };
    let given = Path::new(&path);
    let link = fs::symlink_metadata(given).map(|m| m.file_type().is_symlink()).unwrap_or(true);
    let real = resolve(given).filter(|p| resolve(&downloads).is_some_and(|d| p.starts_with(d)));
    let Some(real) = real.filter(|p| !link && p.is_file() && is_prod_audio(p)) else {
        return Err(app_err("prods.notInDownloads", format!("That file isn't an audio file in Downloads: {path}")).with("path", path.as_str()).into());
    };
    if !target.is_dir() {
        return Err(path_err("prods.beatsFolderGone", &target, format!("The beats folder can't be reached: {}", target.display())).into());
    }
    let dest = tauri::async_runtime::spawn_blocking(move || move_into(&real, &target))
        .await
        .map_err(|e| String::from(app_err("task.failed", format!("move failed: {e}"))))??;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hivo-prods-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_aiff_in_beats_and_audio_in_downloads_by_name() {
        let root = temp("list");
        let beats = root.join("Beats");
        let dl = root.join("Downloads");
        for f in ["Beats/Night.mp3", "Beats/Dawn.aiff", "Beats/.hidden.aif", "Downloads/Night Drive.flac", "Downloads/sub/Other.wav", "Downloads/a/b/too deep.wav", "Downloads/notes.txt"] {
            let p = root.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"x").unwrap();
        }
        let scan = list_prod_files(&[beats.clone()], Some(&dl));
        let mut got: Vec<(String, ProdPlace)> = scan.files.iter().map(|f| (f.name.clone(), f.place)).collect();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            got,
            vec![("Dawn".to_string(), ProdPlace::Beats), ("Night Drive".to_string(), ProdPlace::Downloads), ("Other".to_string(), ProdPlace::Downloads)],
            "mp3 in beats is the beats list's job; hidden, too deep and non-audio are skipped"
        );
        assert!(scan.downloads_on && !scan.downloads_unreadable);
        // Off: Downloads isn't looked at.
        let off = list_prod_files(&[beats], None);
        assert!(off.files.iter().all(|f| f.place == ProdPlace::Beats) && !off.downloads_on);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn moves_without_overwriting() {
        let root = temp("move");
        let beats = root.join("Beats");
        fs::create_dir_all(&beats).unwrap();
        fs::write(beats.join("Night.flac"), b"old").unwrap();
        let src = root.join("Night.flac");
        fs::write(&src, b"new").unwrap();
        let dest = move_into(&src, &beats).unwrap();
        assert_eq!(dest, beats.join("Night (2).flac"));
        assert_eq!(fs::read(beats.join("Night.flac")).unwrap(), b"old", "never overwritten");
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        assert!(!src.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
