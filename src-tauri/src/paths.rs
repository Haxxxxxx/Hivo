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

/// A Windows path as it's compared: `/` read as `\`, the verbatim prefixes
/// dropped (`\\?\UNC\nas\share` → `\\nas\share`, `\\?\C:\` → `C:\`),
/// lowercased, without a trailing separator. None for the other device and
/// NT forms (`\\.\`, `\??\`, `\\?\Volume{…}`), which never compare equal to
/// anything. Pure text: the same answer on every platform.
pub fn windows_key(path: &str) -> Option<String> {
    let s = path.replace('/', "\\").to_lowercase();
    let s = if let Some(rest) = s.strip_prefix(r"\\?\unc\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.get(1..2) != Some(":") {
            return None;
        }
        rest.to_string()
    } else if s.starts_with(r"\\.\") || s.starts_with(r"\??\") {
        return None;
    } else {
        s
    };
    let trimmed = s.trim_end_matches('\\');
    // `\\` alone, or a drive root (`C:\` → `c:`), keeps what it needs.
    Some(if trimmed.len() < 2 { s } else { trimmed.to_string() })
}

/// Whether `real`, a resolved path that is a network path (what Windows'
/// `canonicalize` gives for a file on a mapped drive: `Z:\Samples\kick.wav`
/// → `\\?\UNC\nas\share\Samples\kick.wav`), lies inside one of `roots`, the
/// folders linked in Settings resolved the same way. Whole components only
/// (`\\nas\share2` isn't inside `\\nas\share`), any case, either separator,
/// with or without the verbatim prefix. A link inside a linked folder that
/// leads anywhere else resolves outside every root, so it stays refused.
pub fn unc_inside(real: &str, roots: &[String]) -> bool {
    // `\\server\share\…` with a server and a share, nothing that climbs.
    fn unc(path: &str) -> Option<String> {
        let key = windows_key(path)?;
        let mut parts = key.strip_prefix(r"\\")?.split('\\');
        let (server, share) = (parts.next()?, parts.next()?);
        let fine = !server.is_empty() && !share.is_empty() && !matches!(server, "?" | ".") && parts.all(|p| !p.is_empty() && p != "." && p != "..");
        fine.then_some(key)
    }
    let Some(real) = unc(real) else { return false };
    roots
        .iter()
        .filter_map(|r| unc(r))
        .any(|root| real == root || real.strip_prefix(root.as_str()).is_some_and(|rest| rest.starts_with('\\')))
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
    fn windows_keys_compare_any_spelling() {
        assert_eq!(windows_key(r"\\?\UNC\NAS\Share\Samples\").as_deref(), Some(r"\\nas\share\samples"));
        assert_eq!(windows_key("//nas/share/Samples").as_deref(), Some(r"\\nas\share\samples"));
        assert_eq!(windows_key(r"\\?\unc\nas\share").as_deref(), Some(r"\\nas\share"));
        assert_eq!(windows_key(r"\\?\C:\Samples\\").as_deref(), Some(r"c:\samples"));
        assert_eq!(windows_key(r"C:\").as_deref(), Some("c:"));
        for p in [r"\\.\PhysicalDrive0", r"\??\UNC\nas\share", r"\\?\Volume{1234}\x", r"\\?\GLOBALROOT\x"] {
            assert_eq!(windows_key(p), None, "{p}");
        }
    }

    #[test]
    fn a_mapped_drive_is_inside_its_linked_folder_and_nothing_else_is() {
        // Settings has `Z:\Samples` and `Y:\Crew\Projects`; Z: and Y: are
        // mapped to shares, so both resolve to UNC paths.
        let roots = vec![r"\\?\UNC\nas\music\Samples".to_string(), r"\\?\UNC\nas\crew\Projects\".to_string()];
        for ok in [
            r"\\?\UNC\nas\music\Samples\Drums\Kick.wav",
            r"\\?\UNC\NAS\Music\samples\Drums\Kick.wav",
            r"\\nas\music\Samples\Kick.wav",
            "//nas/music/Samples/Kick.wav",
            r"\\?\UNC\nas\crew\Projects\Envy\Audio\take.wav",
        ] {
            assert!(unc_inside(ok, &roots), "{ok}");
        }
        for refused in [
            // Another share, a sibling folder, a prefix that isn't a component.
            r"\\?\UNC\nas\private\id_rsa.wav",
            r"\\?\UNC\nas\music\Other\Kick.wav",
            r"\\?\UNC\nas\music\Samples2\Kick.wav",
            r"\\?\UNC\nas\musicx\Samples\Kick.wav",
            r"\\?\UNC\attacker\music\Samples\Kick.wav",
            // A junction or symlink in `Z:\Samples` that leads to another
            // host or share resolves there: outside every root.
            r"\\?\UNC\elsewhere\users\x\Kick.wav",
            // Climbing back out, empty components, device forms.
            r"\\?\UNC\nas\music\Samples\..\Other\Kick.wav",
            r"\\nas\music\Samples\\Kick.wav",
            r"\??\UNC\nas\music\Samples\Kick.wav",
            r"\\.\UNC\nas\music\Samples\Kick.wav",
            r"\\?\Volume{1234}\Samples\Kick.wav",
            // Not network paths at all: handled by the plain checks.
            r"C:\Samples\Kick.wav",
        ] {
            assert!(!unc_inside(refused, &roots), "{refused}");
        }
        // No linked folder on a share: nothing on a share is inside.
        assert!(!unc_inside(r"\\?\UNC\nas\music\Samples\Kick.wav", &[]));
        // A root that isn't a share path never matches one.
        assert!(!unc_inside(r"\\?\UNC\nas\music\Samples\Kick.wav", &[r"C:\Samples".to_string(), r"\\".to_string(), r"\\nas".to_string()]));
    }

    #[test]
    fn opening_refuses_remote_paths_and_non_projects() {
        assert!(check_project(r"\\host\share\Song.flp").unwrap_err().contains("network"));
        assert!(check_project("/tmp/payload.app").unwrap_err().contains("only DAW project"));
        assert!(refuse_remote("//host/share/Song.flp").unwrap_err().contains("network"));
    }
}
