//! Launch Kit folders under `<export folder>/Launch Kits/`: which song owns
//! which folder, and writing into them without following symlinks.
//!
//! Every export, saved cover and short goes through `resolve_kit_dir`, so
//! two songs with the same kit title never share a folder ("Title (2)"),
//! and a song only ever cleans up the folders its own manifest names it
//! the owner of. A case-only rename ("night run" → "Night Run") lands in
//! the same folder on a case-insensitive file system (APFS, NTFS), so the
//! cleanup never treats that folder as an old one.

use crate::error::{app_err, path_err};
use crate::audio::safe_name;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// What an export wrote, kept in the kit folder so the next export removes
/// its own leftovers (an old master name, renamed snippets) and nothing else.
pub const KIT_MANIFEST: &str = ".hivo-kit.json";
/// "Title (2)" … "Title (50)": past that, something's wrong.
const MAX_TWINS: u32 = 50;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct KitManifest {
    /// `kit_owner` of the song this folder belongs to. Missing in kits
    /// exported before ownership existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

/// A song's owner id: FNV-1a 64-bit over its path (the workspace key), as
/// hex. Not a secret, just a stable tag.
pub fn kit_owner(song_path: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in song_path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Whether two folder names are the same folder on a case-insensitive file
/// system (the default on macOS and Windows). Pure, so it's testable on any
/// file system.
pub fn names_collide(a: &str, b: &str) -> bool {
    a == b || a.to_lowercase() == b.to_lowercase()
}

/// Whether `a` and `b` are the same folder on disk. None when either can't
/// be resolved (then the caller assumes the worst).
pub fn same_path(a: &Path, b: &Path) -> Option<bool> {
    Some(a.canonicalize().ok()? == b.canonicalize().ok()?)
}

pub fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// The manifest in `dir`, if there is a readable one that isn't a symlink.
pub fn read_manifest(dir: &Path) -> Option<KitManifest> {
    let path = dir.join(KIT_MANIFEST);
    if is_link(&path) {
        return None;
    }
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

pub fn write_manifest(dir: &Path, manifest: &KitManifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    write_new(&dir.join(KIT_MANIFEST), text.as_bytes()).map_err(|e| path_err("io.write", &dir.join(KIT_MANIFEST), format!("could not write {KIT_MANIFEST}: {e}")))
}

/// Clears `path` for a fresh file: a regular file is removed, nothing there
/// is fine, anything else (a symlink, a folder) is refused.
pub fn clear_target(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => fs::remove_file(path),
        Ok(_) => Err(io::Error::other(format!("{} is a link or a folder, not a file", path.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Writes `bytes` to a new file at `path` (create-new: never through a
/// symlink, even one that appears after the check).
pub fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    clear_target(path)?;
    let mut f = OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    f.flush()
}

/// Copies `src` into a new file at `dest` (same rules as `write_new`).
pub fn copy_new(src: &Path, dest: &Path) -> io::Result<()> {
    clear_target(dest)?;
    let mut from = fs::File::open(src)?;
    let mut to = OpenOptions::new().write(true).create_new(true).open(dest)?;
    io::copy(&mut from, &mut to)?;
    to.flush()
}

/// A subfolder of a kit (`snippets/`, `shorts/`), created; a symlink is refused.
pub fn sub_dir(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let sub = dir.join(name);
    if is_link(&sub) {
        return Err(path_err("io.link", &sub, format!("{} is a link: refusing to write through it", sub.display())));
    }
    fs::create_dir_all(&sub).map_err(|e| path_err("io.create", &sub, format!("could not create {}: {e}", sub.display())))?;
    Ok(sub)
}

/// `<output>/Launch Kits`, created. Refused when it's a symlink or resolves
/// outside the export folder.
pub fn kits_root(output: &Path) -> Result<PathBuf, String> {
    let kits = output.join(crate::scanner::LAUNCH_KITS_DIR);
    if is_link(&kits) {
        return Err(path_err("io.link", &kits, format!("{} is a link: refusing to write through it", kits.display())));
    }
    fs::create_dir_all(&kits).map_err(|e| path_err("io.create", &kits, format!("could not create {}: {e}", kits.display())))?;
    let (Ok(out), Ok(real)) = (output.canonicalize(), kits.canonicalize()) else {
        return Err(app_err("kit.outputUnreachable", "the export folder can't be reached").into());
    };
    if real.parent() != Some(out.as_path()) {
        return Err(app_err("kit.outsideOutput", "the Launch Kits folder isn't inside the export folder").into());
    }
    Ok(kits)
}

/// A kit folder must be a real folder directly inside the kits root.
pub fn check_kit_dir(kits: &Path, dir: &Path) -> Result<(), String> {
    if is_link(dir) {
        return Err(path_err("io.link", dir, format!("{} is a link: refusing to write through it", dir.display())));
    }
    let (Ok(root), Ok(real)) = (kits.canonicalize(), dir.canonicalize()) else {
        return Err(path_err("io.unreachable", dir, format!("could not reach {}", dir.display())));
    };
    if real.parent() != Some(root.as_path()) || !real.is_dir() {
        return Err(path_err("kit.notKitFolder", dir, format!("{} isn't a kit folder", dir.display())));
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Claim {
    /// Ours already (or ours to take: the folder our last export recorded).
    Mine,
    /// Nothing there, or an empty folder nobody claimed.
    Free,
    /// Another song's, or something the user made.
    Taken,
}

fn claim_of(dir: &Path, owner: &str, previous: Option<&str>) -> Claim {
    let Ok(meta) = fs::symlink_metadata(dir) else { return Claim::Free };
    if !meta.file_type().is_dir() {
        return Claim::Taken;
    }
    let manifest = read_manifest(dir);
    if let Some(o) = manifest.as_ref().and_then(|m| m.owner.as_deref()) {
        return if o == owner { Claim::Mine } else { Claim::Taken };
    }
    // No owner yet: a kit from before ownership, or a folder holding only
    // a cover saved before the first export. Ours only if the app recorded
    // it as this song's last kit folder.
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if previous.is_some_and(|p| names_collide(&safe_name(p), &name)) {
        return Claim::Mine;
    }
    let empty = fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false);
    if manifest.is_none() && empty { Claim::Free } else { Claim::Taken }
}

/// The on-disk name of `dir` when it differs from the asked one only by
/// case (a case-insensitive file system keeps the first spelling).
fn on_disk_name(kits: &Path, dir: &Path) -> Option<String> {
    let want = dir.file_name()?.to_string_lossy().to_string();
    fs::read_dir(kits).ok()?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).find(|n| *n != want && names_collide(n, &want) && same_path(&kits.join(n), dir) == Some(true))
}

/// The folder this song's kit lives in for `title`: `<kits>/<title>`, or
/// `<title> (2)`… when another song already has that one. Created and
/// claimed (a manifest naming the owner) before it's returned.
pub fn resolve_kit_dir(output: &Path, title: &str, owner: &str, previous: Option<&str>) -> Result<PathBuf, String> {
    let kits = kits_root(output)?;
    let base = safe_name(title);
    let names: Vec<String> = (1..=MAX_TWINS).map(|n| if n == 1 { base.clone() } else { format!("{base} ({n})") }).collect();
    let claims: Vec<Claim> = names.iter().map(|n| claim_of(&kits.join(n), owner, previous)).collect();
    // The folder this song already has wins over a free one, so a kit
    // doesn't hop to "Title" when another song's "Title" goes away.
    let pick = claims.iter().position(|c| *c == Claim::Mine).or_else(|| claims.iter().position(|c| *c == Claim::Free));
    if let Some(i) = pick {
        let name = &names[i];
        let mut dir = kits.join(name);
        fs::create_dir_all(&dir).map_err(|e| path_err("io.create", &dir, format!("could not create {}: {e}", dir.display())))?;
        // A case-only title change: rename the folder to the new spelling.
        if let Some(old) = on_disk_name(&kits, &dir) {
            let tmp = kits.join(format!(".{name}.renaming"));
            if fs::rename(kits.join(&old), &tmp).is_ok() && fs::rename(&tmp, &dir).is_err() {
                let _ = fs::rename(&tmp, kits.join(&old));
                dir = kits.join(old);
            }
        }
        check_kit_dir(&kits, &dir)?;
        let mut manifest = read_manifest(&dir).unwrap_or_default();
        if manifest.owner.as_deref() != Some(owner) {
            manifest.owner = Some(owner.to_string());
            write_manifest(&dir, &manifest)?;
        }
        return Ok(dir);
    }
    Err(app_err("kit.tooMany", format!("too many Launch Kits are called {base}")).with("name", base.as_str()).into())
}

/// A manifest entry the cleanup may remove: a plain file name, or one in
/// `snippets/`, of a type an export writes. The manifest is a file on disk,
/// so it's checked like any input: no other folder, no other kind of file.
pub fn kit_entry(entry: &str) -> bool {
    let parts: Vec<&str> = entry.split('/').collect();
    let name = match parts.as_slice() {
        [name] => *name,
        ["snippets", name] => *name,
        _ => return false,
    };
    let ok_part = |p: &str| !p.is_empty() && p != "." && p != ".." && safe_name(p) == p;
    if !parts.iter().all(|p| ok_part(p)) {
        return false;
    }
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "txt" | "json" | "csv" | "md" | "wav" | "aif" | "aiff" | "flac" | "mp3" | "ogg" | "m4a")
}

/// Removes what the manifest in `dir` lists, except `keep`. With `whole`
/// (an old folder of this song), the manifest and the emptied folders go
/// too; anything the user put there (cover art, shorts) stays. Nothing is
/// removed through a symlinked folder.
pub fn remove_previous(dir: &Path, keep: &[String], whole: bool) {
    if is_link(dir) {
        return;
    }
    let snippets_linked = is_link(&dir.join("snippets"));
    for entry in read_manifest(dir).map(|m| m.files).unwrap_or_default() {
        if !kit_entry(&entry) || keep.contains(&entry) || (snippets_linked && entry.starts_with("snippets/")) {
            continue;
        }
        let path = dir.join(&entry);
        // "Ana - night run.wav" when "Ana - Night Run.wav" was just written:
        // the same file on a case-insensitive file system (or unknown).
        if keep.iter().any(|k| names_collide(k, &entry) && same_path(&dir.join(k), &path) != Some(false)) {
            continue;
        }
        // Only plain files: never a folder, never what a link points to.
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) {
            let _ = fs::remove_file(path);
        }
    }
    if !snippets_linked {
        // Only succeeds when empty.
        let _ = fs::remove_dir(dir.join("snippets"));
    }
    if whole {
        let _ = fs::remove_file(dir.join(KIT_MANIFEST));
        let _ = fs::remove_dir(dir);
    }
}

/// Cleans this song's other kit folders (after a title change). A folder
/// that is `dir` itself (a case-only rename) is never touched, and when
/// that can't be told for sure, the names just written are kept.
pub fn clean_old_kits(kits: &Path, dir: &Path, owner: &str, written: &[String]) {
    let Ok(entries) = fs::read_dir(kits) else { return };
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if is_link(&path) || !path.is_dir() {
            continue;
        }
        let other = entry.file_name().to_string_lossy().to_string();
        let collide = names_collide(&other, &name);
        match same_path(&path, dir) {
            Some(true) => continue,
            None if collide => continue,
            _ => {}
        }
        if read_manifest(&path).and_then(|m| m.owner).as_deref() != Some(owner) {
            continue;
        }
        remove_previous(&path, if collide { written } else { &[] }, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flsm-kits-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn owner_ids_are_stable_and_distinct() {
        assert_eq!(kit_owner("/p/a.flp"), kit_owner("/p/a.flp"));
        assert_ne!(kit_owner("/p/a.flp"), kit_owner("/p/b.flp"));
        assert_eq!(kit_owner("").len(), 16);
    }

    #[test]
    fn names_collide_ignores_case_only() {
        assert!(names_collide("night run", "Night Run"));
        assert!(names_collide("Été", "ÉTÉ"));
        assert!(!names_collide("Night Run", "Night Run (2)"));
    }

    #[test]
    fn two_songs_with_one_title_get_two_folders() {
        let out = temp("twins");
        let a = resolve_kit_dir(&out, "Night Run", &kit_owner("/a.flp"), None).unwrap();
        let b = resolve_kit_dir(&out, "Night Run", &kit_owner("/b.flp"), None).unwrap();
        assert!(a.ends_with("Night Run"));
        assert!(b.ends_with("Night Run (2)"));
        // Asking again lands in the same folder each time.
        assert_eq!(resolve_kit_dir(&out, "Night Run", &kit_owner("/b.flp"), None).unwrap(), b);
        assert_eq!(read_manifest(&a).unwrap().owner, Some(kit_owner("/a.flp")));
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn an_unowned_folder_is_claimed_only_through_the_recorded_one() {
        let out = temp("legacy");
        let kits = kits_root(&out).unwrap();
        let legacy = kits.join("Night Run");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(KIT_MANIFEST), r#"{"files":["README.md"]}"#).unwrap();
        // Another song with the same title doesn't get it.
        assert!(resolve_kit_dir(&out, "Night Run", &kit_owner("/b.flp"), None).unwrap().ends_with("Night Run (2)"));
        // The song whose last export went there does, and keeps its list.
        let a = resolve_kit_dir(&out, "Night Run", &kit_owner("/a.flp"), Some("Night Run")).unwrap();
        assert_eq!(a, legacy);
        let m = read_manifest(&a).unwrap();
        assert_eq!((m.owner, m.files), (Some(kit_owner("/a.flp")), vec!["README.md".to_string()]));
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn cleanup_only_touches_folders_this_song_owns() {
        let out = temp("owned");
        let (a, b) = (kit_owner("/a.flp"), kit_owner("/b.flp"));
        let old_a = resolve_kit_dir(&out, "Old", &a, None).unwrap();
        write_manifest(&old_a, &KitManifest { owner: Some(a.clone()), files: vec!["README.md".into()] }).unwrap();
        fs::write(old_a.join("README.md"), b"a").unwrap();
        let other_b = resolve_kit_dir(&out, "Other", &b, None).unwrap();
        write_manifest(&other_b, &KitManifest { owner: Some(b.clone()), files: vec!["README.md".into()] }).unwrap();
        fs::write(other_b.join("README.md"), b"b").unwrap();

        let new_a = resolve_kit_dir(&out, "New", &a, None).unwrap();
        clean_old_kits(&kits_root(&out).unwrap(), &new_a, &a, &[]);
        assert!(!old_a.exists());
        assert!(other_b.join("README.md").exists());
        let _ = fs::remove_dir_all(&out);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused() {
        use std::os::unix::fs::symlink;
        let out = temp("links");
        let elsewhere = temp("links-target");
        fs::write(elsewhere.join("README.md"), b"precious").unwrap();
        let kits = kits_root(&out).unwrap();

        // A kit folder that is a link.
        symlink(&elsewhere, kits.join("Linked")).unwrap();
        assert!(check_kit_dir(&kits, &kits.join("Linked")).is_err());
        assert!(resolve_kit_dir(&out, "Linked", &kit_owner("/a.flp"), Some("Linked")).unwrap().ends_with("Linked (2)"));

        // A file inside a kit that is a link: refused, the target untouched.
        let dir = resolve_kit_dir(&out, "Real", &kit_owner("/a.flp"), None).unwrap();
        symlink(elsewhere.join("README.md"), dir.join("README.md")).unwrap();
        assert!(write_new(&dir.join("README.md"), b"x").is_err());
        assert_eq!(fs::read(elsewhere.join("README.md")).unwrap(), b"precious");

        // snippets/ as a link.
        symlink(&elsewhere, dir.join("snippets")).unwrap();
        assert!(sub_dir(&dir, "snippets").is_err());
        // The cleanup never deletes through it.
        write_manifest(&dir, &KitManifest { owner: Some(kit_owner("/a.flp")), files: vec!["snippets/README.md".into()] }).unwrap();
        remove_previous(&dir, &[], true);
        assert!(elsewhere.join("README.md").exists());

        // A Launch Kits root that is a link.
        let out2 = temp("links-root");
        symlink(&elsewhere, out2.join(crate::scanner::LAUNCH_KITS_DIR)).unwrap();
        assert!(kits_root(&out2).is_err());
        for d in [out, out2, elsewhere] {
            let _ = fs::remove_dir_all(d);
        }
    }
}
