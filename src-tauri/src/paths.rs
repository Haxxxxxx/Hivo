//! Paths that are never touched: network shares and Windows device paths.
//!
//! Project files travel between crew members, so the paths stored inside
//! them (samples, plugins, Studio One `file:` URLs) are untrusted. On
//! Windows, merely checking whether `\\host\share\kick.wav` exists makes the
//! system connect to that host and hand it the user's NTLM credentials, so
//! these paths are refused before any filesystem call. Opening and revealing
//! files goes through the same check (the webview can't call the opener's
//! open-path directly).

use crate::error::app_err;
use crate::daws::Daw;
use std::path::{Path, PathBuf};

/// `\\?\C:\…` → `C:\…` (only drive paths; real device paths stay as they are).
pub fn strip_verbatim_drive(s: &str) -> Option<&str> {
    let rest = s.strip_prefix(r"\\?\")?;
    (rest.get(1..2) == Some(":")).then_some(rest)
}

/// Windows' canonical form is `\\?\C:\…`; keep the plain `C:\…` so it
/// compares with everything else and isn't mistaken for a device path.
pub fn plain(p: PathBuf) -> PathBuf {
    if cfg!(windows) {
        if let Some(rest) = strip_verbatim_drive(&p.to_string_lossy()) {
            return PathBuf::from(rest);
        }
    }
    p
}

/// A UNC path (`\\host\share`, `//host/share`) or a device / NT path
/// (`\\?\`, `\\.\`, `\??\`), with either separator.
pub fn is_remote_or_device(path: &str) -> bool {
    let head: String = path.trim_start().chars().take(4).map(|c| if c == '\\' { '/' } else { c }).collect();
    head.starts_with("//") || head.starts_with("/??/")
}

fn refuse_remote(path: &str) -> Result<(), String> {
    if is_remote_or_device(path) {
        return Err(app_err("open.remote", "network and device paths aren't opened from Hivo").into());
    }
    Ok(())
}

fn check_project(path: &str) -> Result<(), String> {
    refuse_remote(path)?;
    if Daw::of_project(Path::new(path)).is_none() {
        return Err(app_err("open.notProject", "only DAW project files can be opened").into());
    }
    Ok(())
}

/// Opens a DAW project from a linked folder in its app (FL Studio, Live, REAPER…).
#[tauri::command]
pub fn open_project(app: tauri::AppHandle, path: String) -> Result<(), String> {
    check_project(&path)?;
    crate::scope::Scope::load(&app)?.project(&path)?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| app_err("open.failed", format!("couldn't open it: {e}")).into())
}

/// Shows a file from a linked folder or the export folder in Finder / Explorer.
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    refuse_remote(&path)?;
    crate::scope::Scope::load(&app)?.known_file(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| app_err("reveal.failed", format!("couldn't show it: {e}")).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_drive_paths_become_plain() {
        assert_eq!(strip_verbatim_drive(r"\\?\C:\Users\x\kick.wav"), Some(r"C:\Users\x\kick.wav"));
        // Real device / UNC verbatim paths are not drive paths: still refused.
        assert_eq!(strip_verbatim_drive(r"\\?\UNC\host\share\kick.wav"), None);
        assert_eq!(strip_verbatim_drive(r"C:\kick.wav"), None);
    }

    #[test]
    fn spots_network_and_device_paths() {
        for p in [
            r"\\attacker\share\kick.wav",
            "//attacker/share/kick.wav",
            r"\/attacker/share",
            r"\\?\C:\x.wav",
            r"\\?\UNC\host\share\x.wav",
            r"\\.\PhysicalDrive0",
            r"\??\UNC\host\share\x.wav",
            r"  \\host\share",
        ] {
            assert!(is_remote_or_device(p), "{p}");
        }
        for p in [r"C:\Samples\kick.wav", "/Users/someone/kick.wav", r"\Samples\kick.wav", "kick.wav", "%FLStudioUserData%\\x.wav", ""] {
            assert!(!is_remote_or_device(p), "{p}");
        }
    }

    #[test]
    fn opening_refuses_remote_paths_and_non_projects() {
        assert!(check_project(r"\\host\share\Song.flp").unwrap_err().contains("network"));
        assert!(check_project("/tmp/payload.app").unwrap_err().contains("only DAW project"));
        assert!(refuse_remote("//host/share/Song.flp").unwrap_err().contains("network"));
    }
}
