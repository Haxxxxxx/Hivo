use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// The workspace is the app's own data — song statuses, tags, notes and
// albums — none of which FL Studio stores. The frontend owns its shape;
// the backend just persists it next to settings.json, with one rotating
// backup (`workspace.json.bak`, the copy the last save replaced) and a way
// out when the file can't be read: restore the backup, or set the broken
// file aside as `workspace.json.bad` and start fresh.

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir)
}

fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("workspace.json"))
}

/// `workspace.json` → `workspace.json.<suffix>`.
pub(crate) fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".");
    name.push(suffix);
    path.with_file_name(name)
}

fn file_label(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// Write-then-rename, so a crash mid-write never leaves a half-written file
/// in place of the old one (settings.json uses it too).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = sibling(path, "tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("could not write {}: {e}", file_label(path)))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save {}: {e}", file_label(path))
    })
}

fn read_from(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let raw = fs::read(path).map_err(|e| format!("could not read workspace: {e}"))?;
    serde_json::from_slice(&raw).map_err(|e| format!("could not parse workspace: {e}"))
}

/// Saves the workspace; the file being replaced becomes the backup first.
/// A backup that can't be written doesn't block the save (it's logged).
fn save_to(path: &Path, workspace: &serde_json::Value) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(workspace).map_err(|e| format!("could not serialize workspace: {e}"))?;
    // The new content is on disk before anything is touched (disk full = no change).
    let tmp = sibling(path, "tmp");
    fs::write(&tmp, &raw).map_err(|e| format!("could not write workspace: {e}"))?;
    if path.exists() {
        let bak = sibling(path, "bak");
        let bak_tmp = sibling(path, "bak.tmp");
        if let Err(e) = fs::copy(path, &bak_tmp).and_then(|_| fs::rename(&bak_tmp, &bak)) {
            eprintln!("workspace backup failed: {e}");
            let _ = fs::remove_file(&bak_tmp);
        }
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save workspace: {e}")
    })
}

/// The unreadable file goes aside (`.bad`, replacing an older one), never deleted.
fn set_aside(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bad = sibling(path, "bad");
    fs::rename(path, &bad).map_err(|e| format!("could not move the unreadable workspace aside: {e}"))?;
    Ok(Some(bad))
}

/// Puts the backup back: it must read, the current file is set aside first,
/// and the backup itself stays (restoring twice gives the same result).
fn restore_from_backup(path: &Path) -> Result<serde_json::Value, String> {
    let bak = sibling(path, "bak");
    if !bak.exists() {
        return Err("there's no backup of your workspace".to_string());
    }
    let raw = fs::read(&bak).map_err(|e| format!("could not read the backup: {e}"))?;
    let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| format!("the backup can't be read either: {e}"))?;
    set_aside(path)?;
    write_atomic(path, &raw)?;
    Ok(value)
}

#[tauri::command]
pub fn get_workspace(app: AppHandle) -> Result<serde_json::Value, String> {
    read_from(&workspace_path(&app)?)
}

#[tauri::command]
pub fn save_workspace(app: AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    save_to(&workspace_path(&app)?, &workspace)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFiles {
    /// A backup (`workspace.json.bak`) exists.
    pub has_backup: bool,
    /// When it was written (ms since epoch), if known.
    pub backup_saved_at_ms: Option<u64>,
}

/// What the "can't read your workspace" strip can offer.
#[tauri::command]
pub fn workspace_files(app: AppHandle) -> Result<WorkspaceFiles, String> {
    let bak = sibling(&workspace_path(&app)?, "bak");
    let meta = fs::metadata(&bak).ok().filter(|m| m.is_file());
    let backup_saved_at_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(WorkspaceFiles { has_backup: meta.is_some(), backup_saved_at_ms })
}

/// "Restore backup": returns the restored workspace.
#[tauri::command]
pub fn restore_workspace_backup(app: AppHandle) -> Result<serde_json::Value, String> {
    restore_from_backup(&workspace_path(&app)?)
}

/// "Start fresh": the unreadable file is kept as `workspace.json.bad`.
#[tauri::command]
pub fn set_aside_workspace(app: AppHandle) -> Result<(), String> {
    set_aside(&workspace_path(&app)?).map(|_| ())
}

/// "Show folder": the app's config folder (workspace.json, settings.json and
/// their backups) in Finder / Explorer. No argument: the folder is Rust's own.
#[tauri::command]
pub fn show_config_folder(app: AppHandle) -> Result<(), String> {
    let path = workspace_path(&app)?;
    if path.exists() {
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("couldn't show it: {e}"))
    } else {
        tauri_plugin_opener::open_path(config_dir(&app)?, None::<&str>).map_err(|e| format!("couldn't show it: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hivo-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn each_save_keeps_the_previous_file_as_the_backup() {
        let d = dir("bak");
        let path = d.join("workspace.json");
        save_to(&path, &json!({"version": 2, "n": 1})).unwrap();
        assert!(!sibling(&path, "bak").exists(), "nothing to back up on the first save");
        save_to(&path, &json!({"version": 2, "n": 2})).unwrap();
        save_to(&path, &json!({"version": 2, "n": 3})).unwrap();
        assert_eq!(read_from(&path).unwrap()["n"], 3);
        assert_eq!(read_from(&sibling(&path, "bak")).unwrap()["n"], 2, "one rotating backup: the file just replaced");
        assert!(!sibling(&path, "tmp").exists() && !sibling(&path, "bak.tmp").exists());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_broken_workspace_can_be_restored_from_the_backup() {
        let d = dir("restore");
        let path = d.join("workspace.json");
        assert!(restore_from_backup(&path).is_err(), "no backup yet");
        save_to(&path, &json!({"version": 2, "n": 1})).unwrap();
        save_to(&path, &json!({"version": 2, "n": 2})).unwrap();
        fs::write(&path, b"{\"version\": 2, \"so").unwrap();
        assert!(read_from(&path).unwrap_err().contains("parse"));

        let restored = restore_from_backup(&path).unwrap();
        assert_eq!(restored["n"], 1);
        assert_eq!(read_from(&path).unwrap()["n"], 1);
        assert_eq!(fs::read(sibling(&path, "bad")).unwrap(), b"{\"version\": 2, \"so", "the broken file is kept");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn a_backup_that_doesnt_read_is_never_restored() {
        let d = dir("badbak");
        let path = d.join("workspace.json");
        fs::write(&path, b"broken").unwrap();
        fs::write(sibling(&path, "bak"), b"also broken").unwrap();
        assert!(restore_from_backup(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken", "nothing moved");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn starting_fresh_sets_the_broken_file_aside() {
        let d = dir("fresh");
        let path = d.join("workspace.json");
        fs::write(&path, b"broken").unwrap();
        assert_eq!(set_aside(&path).unwrap(), Some(sibling(&path, "bad")));
        assert_eq!(read_from(&path).unwrap(), serde_json::Value::Null, "reads as a new workspace");
        assert_eq!(fs::read(sibling(&path, "bad")).unwrap(), b"broken");
        assert_eq!(set_aside(&path).unwrap(), None);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn atomic_writes_replace_the_whole_file() {
        let d = dir("atomic");
        let path = d.join("settings.json");
        write_atomic(&path, b"first, and a long one").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!sibling(&path, "tmp").exists());
        let _ = fs::remove_dir_all(d);
    }
}
