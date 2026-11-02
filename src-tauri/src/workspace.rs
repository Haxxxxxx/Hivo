use crate::error::app_err;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// The workspace is the app's own data — song statuses, tags, notes and
// albums — none of which FL Studio stores. The frontend owns its shape;
// the backend just persists it next to settings.json, with one rotating
// backup (`workspace.json.bak`, the copy the last save replaced) and a way
// out when the file doesn't parse: restore the backup, or set the broken
// file aside as `workspace.json.bad-<ms>` and start fresh. A file that can't
// be *read* (permissions, a locked or offline disk) may be perfectly good:
// both ways out refuse it, only Retry is offered. Every file here is
// owner-only (0600 on unix): it holds notes and paths.

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| app_err("config.dir", format!("could not resolve app config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| app_err("config.dir", format!("could not create config dir: {e}")))?;
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

/// Write-then-rename, owner-only, so a crash mid-write never leaves a
/// half-written file in place of the old one (settings.json, last-dig.json
/// and beat-facts.json use it too).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::cover::write_private(path, bytes)
        .map_err(|e| app_err("io.save", format!("could not save {}: {e}", file_label(path))).with("name", file_label(path)).into())
}

/// `workspace.json` → `workspace.json.bad-<ms>`: an unreadable file is kept
/// under a new name every time, never over an older one.
pub(crate) fn bad_path(path: &Path) -> PathBuf {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut n = 0u32;
    loop {
        let suffix = if n == 0 { format!("bad-{ms}") } else { format!("bad-{ms}-{n}") };
        let candidate = sibling(path, &suffix);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Owner-only, like the file it copies (an older one may be wider).
fn restrict(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Left by "Start fresh": the backup (the last good copy) isn't rotated
/// until a save replaces a file that holds real data.
fn fresh_marker(path: &Path) -> PathBuf {
    sibling(path, "fresh")
}

/// The file holds songs, releases or people (not just a fresh, empty start).
fn holds_data(path: &Path) -> bool {
    let Ok(value) = read_from(path) else { return false };
    let songs = value.get("songs").and_then(|v| v.as_object()).is_some_and(|o| !o.is_empty());
    let list = |k: &str| value.get(k).and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty());
    songs || list("albums") || list("people")
}

/// Why "Start fresh" / "Restore backup" can't touch the file now: it parses
/// (nothing to fix), or it can't be read at all (it may be fine: a
/// permission, a locked or offline disk). None = it doesn't parse, or it's
/// missing.
fn reset_refusal(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    match fs::read(path) {
        Err(e) => Some(
            app_err("workspace.unreadableNow", format!("your workspace can't be read right now ({e}), so nothing was changed. Fix that and try Retry"))
                .into(),
        ),
        Ok(raw) => match serde_json::from_slice::<serde_json::Value>(&raw) {
            Ok(_) => Some(app_err("workspace.readsFine", "your workspace reads fine now, so nothing was changed. Try Retry").into()),
            Err(_) => None,
        },
    }
}

fn read_from(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let raw = fs::read(path).map_err(|e| app_err("workspace.read", format!("could not read workspace: {e}")))?;
    serde_json::from_slice(&raw).map_err(|e| app_err("workspace.parse", format!("could not parse workspace: {e}")).into())
}

/// Saves the workspace; the file being replaced becomes the backup first.
/// A backup that can't be written doesn't block the save (it's logged).
fn save_to(path: &Path, workspace: &serde_json::Value) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(workspace).map_err(|e| format!("could not serialize workspace: {e}"))?;
    // The new content is on disk before anything is touched (disk full = no change).
    let tmp = sibling(path, "tmp");
    crate::cover::write_private_in_place(&tmp, &raw).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        String::from(app_err("workspace.write", format!("could not write workspace: {e}")))
    })?;
    let fresh = fresh_marker(path);
    // After "Start fresh", the backup is the last good copy: it stays until
    // the file being replaced holds real data.
    if path.exists() && (!fresh.exists() || holds_data(path)) {
        let bak = sibling(path, "bak");
        let bak_tmp = sibling(path, "bak.tmp");
        match fs::copy(path, &bak_tmp).and_then(|_| restrict(&bak_tmp)).and_then(|_| fs::rename(&bak_tmp, &bak)) {
            Ok(()) => {
                let _ = fs::remove_file(&fresh);
            }
            Err(e) => {
                eprintln!("workspace backup failed: {e}");
                let _ = fs::remove_file(&bak_tmp);
            }
        }
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        String::from(app_err("workspace.write", format!("could not save workspace: {e}")))
    })
}

/// "Start fresh": the file that doesn't parse goes aside (`.bad-<ms>`,
/// never over an older one), never deleted. A file that parses, or can't
/// be read at all, is refused.
fn set_aside(path: &Path) -> Result<Option<PathBuf>, String> {
    if let Some(why) = reset_refusal(path) {
        return Err(why);
    }
    let moved = move_aside(path)?;
    // The backup is the last good copy: keep it through the first saves.
    if moved.is_some() {
        let _ = crate::cover::write_private_in_place(&fresh_marker(path), b"");
    }
    Ok(moved)
}

fn move_aside(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bad = bad_path(path);
    fs::rename(path, &bad).map_err(|e| app_err("workspace.moveAside", format!("could not move the unreadable workspace aside: {e}")))?;
    Ok(Some(bad))
}

/// Puts the backup back: it must read, the current file is set aside first,
/// and the backup itself stays (restoring twice gives the same result).
fn restore_from_backup(path: &Path) -> Result<serde_json::Value, String> {
    let bak = sibling(path, "bak");
    if !bak.exists() {
        return Err(app_err("workspace.noBackup", "there's no backup of your workspace").into());
    }
    let raw = fs::read(&bak).map_err(|e| app_err("workspace.backupUnreadable", format!("could not read the backup: {e}")))?;
    let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| app_err("workspace.backupUnreadable", format!("the backup can't be read either: {e}")))?;
    if let Some(why) = reset_refusal(path) {
        return Err(why);
    }
    move_aside(path)?;
    write_atomic(path, &raw)?;
    let _ = fs::remove_file(fresh_marker(path));
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
    /// `workspace.json` reads but doesn't parse: "Start fresh" and "Restore
    /// backup" may move it aside. False when it can't be read at all (it may
    /// be fine), when it parses, or when it's missing.
    pub can_reset: bool,
}

/// What the "can't read your workspace" strip can offer.
#[tauri::command]
pub fn workspace_files(app: AppHandle) -> Result<WorkspaceFiles, String> {
    let path = workspace_path(&app)?;
    let bak = sibling(&path, "bak");
    let meta = fs::metadata(&bak).ok().filter(|m| m.is_file());
    let backup_saved_at_ms = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let can_reset = path.exists() && reset_refusal(&path).is_none();
    Ok(WorkspaceFiles { has_backup: meta.is_some(), backup_saved_at_ms, can_reset })
}

/// "Restore backup": returns the restored workspace.
#[tauri::command]
pub fn restore_workspace_backup(app: AppHandle) -> Result<serde_json::Value, String> {
    restore_from_backup(&workspace_path(&app)?)
}

/// "Start fresh": the unreadable file is kept as `workspace.json.bad-<ms>`.
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
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| app_err("reveal.failed", format!("couldn't show it: {e}")).into())
    } else {
        tauri_plugin_opener::open_path(config_dir(&app)?, None::<&str>).map_err(|e| app_err("reveal.failed", format!("couldn't show it: {e}")).into())
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
        let bad = bad_files(&path);
        assert_eq!(bad.len(), 1);
        assert_eq!(fs::read(&bad[0]).unwrap(), b"{\"version\": 2, \"so", "the broken file is kept");
        let _ = fs::remove_dir_all(d);
    }

    /// Every `workspace.json.bad-<ms>` next to `path`.
    fn bad_files(path: &Path) -> Vec<PathBuf> {
        let prefix = format!("{}.bad-", path.file_name().unwrap().to_string_lossy());
        let mut found: Vec<PathBuf> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&prefix)))
            .collect();
        found.sort();
        found
    }

    #[test]
    fn a_file_that_cant_be_read_is_never_set_aside_or_restored_over() {
        let d = dir("io");
        let path = d.join("workspace.json");
        save_to(&path, &json!({"version": 2, "n": 1})).unwrap();
        save_to(&path, &json!({"version": 2, "n": 2})).unwrap();
        // A file that parses: nothing to fix.
        assert!(set_aside(&path).unwrap_err().contains("reads fine"));
        assert!(restore_from_backup(&path).unwrap_err().contains("reads fine"));
        // A read error (here: a folder where the file should be) is not a
        // parse error: the file may be fine, so it stays where it is.
        let blocked = d.join("blocked.json");
        fs::create_dir_all(&blocked).unwrap();
        fs::write(sibling(&blocked, "bak"), b"{\"version\": 2}").unwrap();
        assert!(read_from(&blocked).unwrap_err().contains("could not read"));
        assert!(reset_refusal(&blocked).unwrap().contains("can't be read right now"));
        assert!(set_aside(&blocked).is_err());
        assert!(restore_from_backup(&blocked).is_err());
        assert!(blocked.is_dir() && bad_files(&blocked).is_empty(), "nothing moved");
        assert_eq!(read_from(&path).unwrap()["n"], 2);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn every_bad_file_is_kept_under_its_own_name() {
        let d = dir("bads");
        let path = d.join("workspace.json");
        fs::write(&path, b"broken once").unwrap();
        set_aside(&path).unwrap();
        fs::write(&path, b"broken twice").unwrap();
        set_aside(&path).unwrap();
        let bad = bad_files(&path);
        assert_eq!(bad.len(), 2, "the second never replaces the first");
        let mut contents: Vec<Vec<u8>> = bad.iter().map(|p| fs::read(p).unwrap()).collect();
        contents.sort();
        assert_eq!(contents, vec![b"broken once".to_vec(), b"broken twice".to_vec()]);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn starting_fresh_keeps_the_last_good_backup_until_real_data_is_saved() {
        let d = dir("keepbak");
        let path = d.join("workspace.json");
        let good = json!({"version": 2, "songs": {"/music/a.flp": {"status": "prep"}}, "albums": [], "people": []});
        save_to(&path, &good).unwrap();
        save_to(&path, &good).unwrap();
        fs::write(&path, b"{\"broken").unwrap();
        set_aside(&path).unwrap();
        let empty = json!({"version": 2, "songs": {}, "albums": [], "people": []});
        save_to(&path, &empty).unwrap();
        save_to(&path, &empty).unwrap();
        assert_eq!(read_from(&sibling(&path, "bak")).unwrap(), good, "empty saves never rotate the good backup away");
        let real = json!({"version": 2, "songs": {"/music/b.flp": {"status": "creation"}}, "albums": [], "people": []});
        save_to(&path, &real).unwrap();
        assert_eq!(read_from(&sibling(&path, "bak")).unwrap(), good, "the file replaced was still empty");
        save_to(&path, &real).unwrap();
        assert_eq!(read_from(&sibling(&path, "bak")).unwrap(), real, "rotation resumes once real data was saved");
        assert!(!fresh_marker(&path).exists());
        let _ = fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("perms");
        let path = d.join("workspace.json");
        fs::write(&path, b"{\"version\": 2}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        save_to(&path, &json!({"version": 2, "n": 1})).unwrap();
        save_to(&path, &json!({"version": 2, "n": 2})).unwrap();
        for p in [path.clone(), sibling(&path, "bak")] {
            assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600, "{}", p.display());
        }
        write_atomic(&d.join("settings.json"), b"{}").unwrap();
        assert_eq!(fs::metadata(d.join("settings.json")).unwrap().permissions().mode() & 0o777, 0o600);
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
        let moved = set_aside(&path).unwrap().unwrap();
        assert_eq!(bad_files(&path), vec![moved.clone()]);
        assert_eq!(read_from(&path).unwrap(), serde_json::Value::Null, "reads as a new workspace");
        assert_eq!(fs::read(&moved).unwrap(), b"broken");
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
