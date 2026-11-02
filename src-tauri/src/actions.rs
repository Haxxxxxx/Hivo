use crate::daws::{self, Daw};
use crate::models::TemplateInfo;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn validate_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name can't be empty".to_string());
    }
    if name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        || name == "."
        || name == ".."
    {
        return Err(r#"name can't contain / \ : * ? " < > |"#.to_string());
    }
    // Windows drops a trailing dot or space from a file name (so "Envy."
    // would become another file than the one asked for), and refuses its
    // device names ("CON", "nul.flp") in any folder.
    if name.ends_with('.') || name.chars().any(char::is_control) {
        return Err("name can't end with a dot or contain control characters".to_string());
    }
    if is_reserved_on_windows(name) {
        return Err(format!("\"{name}\" is a name Windows reserves; pick another"));
    }
    Ok(name)
}

/// CON, PRN, AUX, NUL, COM1-9, LPT1-9, alone or before an extension.
fn is_reserved_on_windows(name: &str) -> bool {
    let head = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
    matches!(head.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((head.starts_with("COM") || head.starts_with("LPT")) && head.len() == 4 && head.as_bytes()[3].is_ascii_digit() && head.as_bytes()[3] != b'0')
}

/// `<dir>/<base>.<ext>`, or `<base> (2).<ext>`, `(3)`… if taken.
pub(crate) fn free_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{base} ({n}).{ext}")))
        .find(|p| !p.exists())
        .expect("unbounded range always yields a free path")
}

/// Copies `from` to a NEW file `to`: fails if anything (a file, a symlink)
/// is already there, so a copy can never overwrite or write through a link
/// that appeared after a check. A half-written copy is removed.
pub(crate) fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    copy_new(from, to).map_err(|e| format!("could not copy {} → {}: {e}", from.display(), to.display()))
}

fn copy_new(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut src = fs::File::open(from)?;
    let mut dst = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    let copied = std::io::copy(&mut src, &mut dst).and_then(|_| dst.sync_all());
    if copied.is_err() {
        drop(dst);
        let _ = fs::remove_file(to);
    }
    copied
}

/// Copies `from` to `<dir>/<base>.<ext>`, or `<base> (2).<ext>`… : the
/// first name that's free at the moment the file is created (create_new),
/// not at the moment it was checked.
fn copy_to_free_path(from: &Path, dir: &Path, base: &str, ext: &str) -> Result<PathBuf, String> {
    let names = std::iter::once(format!("{base}.{ext}")).chain((2..1000).map(|n| format!("{base} ({n}).{ext}")));
    for name in names {
        let to = dir.join(name);
        match copy_new(from, &to) {
            Ok(()) => return Ok(to),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not copy {} → {}: {e}", from.display(), to.display())),
        }
    }
    Err(format!("no free name for \"{base}.{ext}\" in {}", dir.display()))
}

/// Where FL keeps its factory templates. Windows: `<install>/Data/Templates`.
/// macOS: somewhere inside the `.app` bundle (the exe is in
/// `Contents/MacOS`), so look for a `Data/Templates` folder in the bundle
/// rather than hardcoding a layout that varies between FL versions.
fn factory_templates_dir(fl_studio_path: &str) -> Option<PathBuf> {
    let exe = Path::new(fl_studio_path);
    let windows_layout = exe.parent()?.join("Data").join("Templates");
    if windows_layout.is_dir() {
        return Some(windows_layout);
    }
    let bundle = exe.ancestors().find(|a| a.extension().is_some_and(|x| x.eq_ignore_ascii_case("app")))?;
    walkdir::WalkDir::new(bundle.join("Contents"))
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
        .find(|e| {
            e.file_type().is_dir()
                && e.file_name() == "Templates"
                && e.path().parent().and_then(Path::file_name).is_some_and(|n| n == "Data")
        })
        .map(|e| e.path().to_path_buf())
}

/// FL Studio from Settings, if it's set and is FL Studio.
pub(crate) fn fl_from_settings(app: &tauri::AppHandle) -> Option<String> {
    crate::scope::Scope::load(app).ok()?.fl_studio().ok().map(|p| p.to_string_lossy().to_string())
}

/// FL's factory templates: `<templates>/<category>/<name>/<name>.flp`.
#[tauri::command]
pub fn list_templates(app: tauri::AppHandle) -> Vec<TemplateInfo> {
    templates_for(fl_from_settings(&app))
}

fn templates_for(fl_studio_path: Option<String>) -> Vec<TemplateInfo> {
    let Some(base) = fl_studio_path.as_deref().and_then(factory_templates_dir) else {
        return Vec::new();
    };
    let mut templates: Vec<TemplateInfo> = walkdir::WalkDir::new(&base)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("flp"))
        })
        .map(|e| {
            let path = e.path();
            let category = path
                .strip_prefix(&base)
                .ok()
                .and_then(|rel| rel.components().next())
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .unwrap_or_default();
            TemplateInfo {
                name: path.file_stem().unwrap_or_default().to_string_lossy().to_string(),
                category,
                path: path.to_string_lossy().to_string(),
            }
        })
        .collect();
    templates.sort_by(|a, b| (&a.category, &a.name).cmp(&(&b.category, &b.name)));
    templates
}

/// The template FL itself uses for File → New, from its registry settings.
#[tauri::command]
pub fn default_template(app: tauri::AppHandle) -> Option<String> {
    default_template_for(fl_from_settings(&app))
}

fn default_template_for(fl_studio_path: Option<String>) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let install_dir = Path::new(fl_studio_path.as_deref()?).parent()?.to_path_buf();
        let image_line = winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("SOFTWARE\\Image-Line")
            .ok()?;
        // Newest "FL Studio NN" key first.
        let mut versions: Vec<String> = image_line
            .enum_keys()
            .filter_map(|k| k.ok())
            .filter(|k| k.starts_with("FL Studio "))
            .collect();
        versions.sort_by_key(|k| k[10..].parse::<u32>().unwrap_or(0));
        versions.into_iter().rev().find_map(|v| {
            let raw: String = image_line
                .open_subkey(format!("{v}\\General"))
                .ok()?
                .get_value("Template")
                .ok()?;
            let path = raw.replace("%FLStudioFactoryData%", &install_dir.to_string_lossy());
            Path::new(&path).exists().then_some(path)
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = fl_studio_path;
        None
    }
}

/// New song from a template, laid out the way FL does it:
/// `<parent>/<name>/<name>.flp`. Returns the new .flp path.
#[tauri::command]
pub fn create_project(app: tauri::AppHandle, template_path: String, parent_folder: String, name: String) -> Result<String, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let fl = fl_from_settings(&app);
    let parent = scope.folder_in_roots(&parent_folder)?;
    check_template(&scope, fl, &template_path)?;
    // The song folder may already exist (or be a symlink planted there):
    // what it really points at must still be inside a linked folder.
    create_in(&template_path, &parent, &name, |dir| scope.folder_in_roots(&dir.to_string_lossy()).map(|_| ()))
}

/// A template is an .flp from FL's factory templates, FL's own default
/// template, or a project in a linked folder. Nothing else is copied.
pub(crate) fn check_template(scope: &crate::scope::Scope, fl: Option<String>, template_path: &str) -> Result<(), String> {
    let template = Path::new(template_path);
    let is_flp = template.extension().is_some_and(|e| e.eq_ignore_ascii_case("flp"));
    let real = template.canonicalize().map_err(|_| format!("template not found: {template_path}"))?;
    let factory = fl.as_deref().and_then(factory_templates_dir).and_then(|d| d.canonicalize().ok());
    let allowed = factory.is_some_and(|d| real.starts_with(d))
        || default_template_for(fl).is_some_and(|d| Path::new(&d).canonicalize().is_ok_and(|d| d == real))
        || scope.fl_project(template_path).is_ok();
    if !is_flp || !allowed {
        return Err(format!("not an FL Studio template: {template_path}"));
    }
    Ok(())
}

/// `in_scope` is called on the parent folder and on the song folder once it
/// exists: both resolve (symlinks followed) inside a linked folder, or
/// nothing is created.
fn create_in(template_path: &str, parent_folder: &Path, name: &str, in_scope: impl Fn(&Path) -> Result<(), String>) -> Result<String, String> {
    let name = validate_name(name)?;
    let template = Path::new(template_path);
    if !template.is_file() {
        return Err(format!("template not found: {template_path}"));
    }
    in_scope(parent_folder)?;
    let dir = parent_folder.join(name);
    let target = dir.join(format!("{name}.flp"));
    if fs::symlink_metadata(&target).is_ok() {
        return Err(format!("a project named \"{name}\" already exists there"));
    }
    match fs::create_dir(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("could not create project folder: {e}")),
    }
    in_scope(&dir)?;
    copy_file(template, &target).map_err(|e| {
        if target.exists() {
            format!("a project named \"{name}\" already exists there")
        } else {
            e
        }
    })?;
    Ok(target.to_string_lossy().to_string())
}

/// The project file's own extension, as written (`flp`, `als`, `RPP`…).
fn project_ext(path: &Path) -> Result<String, String> {
    Daw::of_project(path).ok_or_else(|| format!("not a project file: {}", path.display()))?;
    Ok(path.extension().unwrap_or_default().to_string_lossy().to_string())
}

/// "Save as new version": copy the project next to itself under a new name,
/// sharing the same Audio/ and Samples/ folders.
#[tauri::command]
pub fn duplicate_project(app: tauri::AppHandle, project_path: String, new_name: String) -> Result<String, String> {
    crate::scope::Scope::load(&app)?.project(&project_path)?;
    duplicate(project_path, new_name)
}

fn duplicate(project_path: String, new_name: String) -> Result<String, String> {
    let new_name = validate_name(&new_name)?;
    let src = Path::new(&project_path);
    let dir = src.parent().ok_or("invalid project path")?;
    let ext = project_ext(src)?;
    let target = dir.join(format!("{new_name}.{ext}"));
    if target.exists() {
        return Err(format!("\"{new_name}.{ext}\" already exists in that folder"));
    }
    copy_file(src, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Bring a backup back as a *new* project file next to the project, never
/// overwriting the current version. It gets the project's extension, so a
/// REAPER `.rpp-bak` comes back as `.rpp` and a Cubase `.bak` as `.cpr`.
/// FL's `Envy (overwritten at 16h12).flp` becomes `Envy - restored 16h12.flp`;
/// other DAWs' timestamps are dropped (`Envy - restored.als`).
#[tauri::command]
pub fn restore_backup(app: tauri::AppHandle, backup_path: String, project_path: String) -> Result<String, String> {
    let scope = crate::scope::Scope::load(&app)?;
    scope.project(&project_path)?;
    // Only a backup the last scan listed (the scan only walks linked folders).
    if !crate::scanner::is_listed_backup(Path::new(&backup_path)) || scope.known_file(&backup_path).is_err() {
        return Err(format!("not a backup of a linked project: {backup_path}"));
    }
    restore(backup_path, project_path)
}

fn restore(backup_path: String, project_path: String) -> Result<String, String> {
    let backup = Path::new(&backup_path);
    let project = Path::new(&project_path);
    let dir = project.parent().ok_or("invalid project path")?;
    let project_name = project.file_stem().unwrap_or_default().to_string_lossy();
    let ext = project_ext(project)?;
    let daw = Daw::of_backup_file(backup)
        .or_else(|| Daw::of_project(backup))
        .ok_or_else(|| format!("not a backup file: {backup_path}"))?;

    let when = if daw == Daw::FlStudio {
        let stem = backup.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let base_len = daws::backup_base_name(daw, &stem).len();
        stem.get(base_len..)
            .unwrap_or_default()
            .trim()
            .trim_start_matches('(')
            .replace(')', "")
            .replace("overwritten at ", "")
            .replace("autosaved at ", "")
    } else {
        String::new()
    };
    let base = if when.is_empty() {
        format!("{project_name} - restored")
    } else {
        format!("{project_name} - restored {when}")
    };
    let target = copy_to_free_path(backup, dir, &base, &ext)?;
    Ok(target.to_string_lossy().to_string())
}

/// Whether cleanup may delete `path`: a plain file (no `..` tricks) that
/// looks like a backup and that the last scan actually listed as one. Names
/// with quotes, backslashes or control characters are refused outright:
/// nothing legitimate needs them, and they're what breaks out of a quoted
/// string in a script.
fn may_trash(path: &Path, listed: impl Fn(&Path) -> bool) -> bool {
    let name_ok = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .is_some_and(|n| !n.chars().any(|c| c == '"' || c == '\\' || c.is_control()));
    name_ok
        && !path.components().any(|c| matches!(c, std::path::Component::ParentDir))
        && daws::is_backup_file(path)
        && listed(path)
        && fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// Whether deleting on this path's drive may skip the Recycle Bin / Trash:
/// Windows deletes permanently on removable and network drives, macOS has
/// no Trash on network volumes. Unknown counts as risky.
#[cfg(windows)]
pub fn may_delete_permanently(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};
    // GetDriveTypeW results (WindowsProgramming): fixed disks are the safe ones.
    const DRIVE_FIXED: u32 = 3;
    let root = match path.components().next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => format!("{}:\\", d as char),
            _ => return true, // UNC and device paths: network or unknown
        },
        _ => return true,
    };
    let wide: Vec<u16> = std::ffi::OsStr::new(&root).encode_wide().chain(Some(0)).collect();
    unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(wide.as_ptr()) != DRIVE_FIXED }
}

#[cfg(target_os = "macos")]
pub fn may_delete_permanently(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return true };
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
        return true;
    }
    // External drives keep their own .Trashes; network volumes have none.
    (st.f_flags & libc::MNT_LOCAL as u32) == 0
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn may_delete_permanently(_path: &Path) -> bool {
    false
}

/// The backups among `paths` whose deletion may be permanent (removable or
/// network drive), so the UI can say so before anything is deleted.
#[tauri::command]
pub fn backups_on_risky_volumes(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| may_delete_permanently(Path::new(p))).collect()
}

/// Every path must be a listed backup; ones on a drive without a Recycle Bin
/// only with the user's explicit OK.
fn check_cleanup(paths: &[String], allow_permanent: bool, listed: impl Fn(&Path) -> bool, risky: impl Fn(&Path) -> bool) -> Result<(), String> {
    if let Some(p) = paths.iter().find(|p| !may_trash(Path::new(p), &listed)) {
        return Err(format!("refusing to delete non-backup file: {p}"));
    }
    if !allow_permanent {
        if let Some(p) = paths.iter().find(|p| risky(Path::new(p))) {
            return Err(format!("{p} is on a removable or network drive, where it would be deleted permanently"));
        }
    }
    Ok(())
}

/// Send backups to the Recycle Bin / Trash (recoverable). Refuses anything
/// the last scan didn't list as a backup, so a bad call can't touch real
/// projects; refuses backups on drives without a Recycle Bin unless
/// `allow_permanent` (the user confirmed a permanent delete).
#[tauri::command]
pub async fn trash_backups(app: tauri::AppHandle, paths: Vec<String>, allow_permanent: Option<bool>) -> Result<u32, String> {
    // Listed by the last scan AND inside a folder that's still linked now
    // (a folder unlinked since that scan is off limits).
    let scope = crate::scope::Scope::load(&app)?;
    trash_listed(paths, allow_permanent, |p| scope.known_file(&p.to_string_lossy()).is_ok()).await
}

async fn trash_listed(paths: Vec<String>, allow_permanent: Option<bool>, linked: impl Fn(&Path) -> bool) -> Result<u32, String> {
    let listed = |p: &Path| crate::scanner::is_listed_backup(p) && linked(p);
    check_cleanup(&paths, allow_permanent.unwrap_or(false), listed, may_delete_permanently)?;
    let count = paths.len() as u32;
    tauri::async_runtime::spawn_blocking(move || {
        #[allow(unused_mut)]
        let mut ctx = trash::TrashContext::default();
        // NSFileManager, not Finder via AppleScript: no script built from
        // file names, and no Finder automation permission prompt.
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            ctx.set_delete_method(DeleteMethod::NsFileManager);
        }
        ctx.delete_all(&paths)
    })
    .await
    .map_err(|e| format!("cleanup failed: {e}"))?
    .map_err(|e| format!("could not move backups to the Recycle Bin: {e}"))?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_names() {
        assert!(validate_name("").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("..").is_err());
        assert_eq!(validate_name("  Envy v2 ").unwrap(), "Envy v2");
        for bad in ["Envy.", "Envy. ", "CON", "con", "nul.flp", "Com1", "LPT9", "AUX .x", "Tab\there"] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        for ok in ["Console", "COM0", "COM10", "Envy v2.1", "Lpt", "Nulle part"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn restore_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("flsm-restore-{}", std::process::id()));
        fs::create_dir_all(dir.join("Backup")).unwrap();
        let project = dir.join("Envy.flp");
        let backup = dir.join("Backup").join("Envy (overwritten at 16h12).flp");
        fs::write(&project, b"current").unwrap();
        fs::write(&backup, b"old").unwrap();

        let p = project.to_string_lossy().to_string();
        let b = backup.to_string_lossy().to_string();
        let first = restore(b.clone(), p.clone()).unwrap();
        let second = restore(b, p).unwrap();

        assert!(first.ends_with("Envy - restored 16h12.flp"), "{first}");
        assert!(second.ends_with("Envy - restored 16h12 (2).flp"), "{second}");
        assert_eq!(fs::read(&project).unwrap(), b"current");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("flsm-copynew-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("a.flp");
        let to = dir.join("b.flp");
        fs::write(&from, b"new").unwrap();
        fs::write(&to, b"mine").unwrap();
        assert!(copy_file(&from, &to).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"mine");
        let free = copy_to_free_path(&from, &dir, "b", "flp").unwrap();
        assert!(free.ends_with("b (2).flp"), "{}", free.display());
        assert_eq!(fs::read(&free).unwrap(), b"new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn create_refuses_a_song_folder_linked_out_of_scope() {
        let dir = std::env::temp_dir().join(format!("flsm-create-link-{}", std::process::id()));
        let linked = dir.join("linked");
        let outside = dir.join("outside");
        fs::create_dir_all(&linked).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let template = dir.join("template.flp");
        fs::write(&template, b"template bytes").unwrap();
        std::os::unix::fs::symlink(&outside, linked.join("Envy")).unwrap();
        let root = linked.canonicalize().unwrap();
        let in_scope = |p: &Path| {
            if p.canonicalize().is_ok_and(|r| r.starts_with(&root)) { Ok(()) } else { Err("out of scope".to_string()) }
        };
        assert!(create_in(&template.to_string_lossy(), &linked, "Envy", in_scope).is_err());
        assert!(!outside.join("Envy.flp").exists());
        assert!(create_in(&template.to_string_lossy(), &linked, "Other", in_scope).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_and_versions_projects_without_clobbering() {
        let dir = std::env::temp_dir().join(format!("flsm-create-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let template = dir.join("template.flp");
        fs::write(&template, b"template bytes").unwrap();
        let t = template.to_string_lossy().to_string();
        let parent = dir.to_string_lossy().to_string();

        let created = create_in(&t, Path::new(&parent), "Envy", |_| Ok(())).unwrap();
        assert!(created.ends_with(&format!("Envy{}Envy.flp", std::path::MAIN_SEPARATOR)), "{created}");
        assert_eq!(fs::read(&created).unwrap(), b"template bytes");
        // Same name again must fail, not overwrite.
        fs::write(&created, b"my work").unwrap();
        assert!(create_in(&t, Path::new(&parent), "Envy", |_| Ok(())).is_err());
        assert_eq!(fs::read(&created).unwrap(), b"my work");

        let v2 = duplicate(created.clone(), "Envy v2".into()).unwrap();
        assert_eq!(fs::read(&v2).unwrap(), b"my work");
        assert!(duplicate(created, "Envy v2".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_refuses_real_projects() {
        for p in ["D:\\Projects\\Envy\\Envy.flp", "/m/Wave Project/Wave.als", "/m/Tide/Tide.rpp", "/m/Fade/Fade.cpr", "/m/Envy/Backup/cover.png"] {
            let result = tauri::async_runtime::block_on(trash_listed(vec![p.to_string()], None, |_| true));
            assert!(result.is_err(), "{p}");
        }
        // One real project in the batch refuses the whole batch.
        let mixed = vec!["/m/Tide/Tide.rpp-bak".to_string(), "/m/Tide/Tide.rpp".to_string()];
        assert!(tauri::async_runtime::block_on(trash_listed(mixed, None, |_| true)).is_err());
    }

    #[test]
    fn trash_needs_a_listed_plain_backup_file() {
        let dir = std::env::temp_dir().join(format!("flsm-trash-guard-{}", std::process::id()));
        // A real project inside a linked root that happens to be called "Backup".
        let real = dir.join("Backup").join("Envy").join("Envy.flp");
        let backup = dir.join("Backup").join("Envy").join("Backup").join("Envy (overwritten at 16h12).flp");
        let folder = dir.join("Tide").join("old.bak");
        fs::create_dir_all(backup.parent().unwrap()).unwrap();
        fs::create_dir_all(&folder).unwrap();
        fs::write(&real, b"my work").unwrap();
        fs::write(&backup, b"old").unwrap();
        let only_backup = |p: &Path| p == backup;
        let anything = |_: &Path| true;

        assert!(may_trash(&backup, only_backup));
        // Name heuristics alone pass for the real project; the scan list doesn't.
        assert!(daws::is_backup_file(&real));
        assert!(!may_trash(&real, only_backup));
        // `..` back out of a backup folder, a directory named like a backup.
        let sneaky = backup.parent().unwrap().join("..").join("Envy.flp");
        assert!(!may_trash(&sneaky, anything));
        assert!(!may_trash(&folder, anything));
        // Never-scanned paths are refused by the real command.
        let b = backup.to_string_lossy().to_string();
        assert!(tauri::async_runtime::block_on(trash_listed(vec![b], Some(true), |_| true)).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"old");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_accepts_every_daws_backups() {
        let dir = std::env::temp_dir().join(format!("flsm-trash-{}", std::process::id()));
        let files = [
            "Envy/Backup/Envy (overwritten at 16h12).flp",
            "Wave Project/Backup/Wave [2026-10-12 143005].als",
            "Tide/Tide.rpp-bak",
            "Fade/Fade-01.bak",
            "Rush/Session File Backups/Rush.bak.001.ptx",
            "Glow/History/Glow (2).song",
        ];
        let paths: Vec<String> = files
            .iter()
            .map(|rel| {
                let p = dir.join(rel);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(&p, b"x").unwrap();
                p.to_string_lossy().to_string()
            })
            .collect();
        for p in &paths {
            assert!(daws::is_backup_file(Path::new(p)), "{p}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicates_keep_the_projects_extension() {
        let dir = std::env::temp_dir().join(format!("flsm-dup-als-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("Wave.als");
        fs::write(&src, b"gz bytes").unwrap();
        let s = src.to_string_lossy().to_string();
        let v2 = duplicate(s.clone(), "Wave v2".into()).unwrap();
        assert!(v2.ends_with("Wave v2.als"), "{v2}");
        assert_eq!(fs::read(&v2).unwrap(), b"gz bytes");
        assert!(duplicate(s, "Wave v2".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restores_ableton_reaper_and_cubase_backups_as_projects() {
        let dir = std::env::temp_dir().join(format!("flsm-restore-daws-{}", std::process::id()));
        let w = |rel: &str, bytes: &[u8]| {
            let p = dir.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, bytes).unwrap();
            p.to_string_lossy().to_string()
        };
        let wave = w("Wave Project/Wave.als", b"current");
        let wave_bak = w("Wave Project/Backup/Wave [2026-10-12 143005].als", b"old");
        let tide = w("Tide/Tide.rpp", b"current");
        let tide_bak = w("Tide/Tide.rpp-bak", b"old");
        let fade = w("Fade/Fade.cpr", b"current");
        let fade_bak = w("Fade/Fade-01.bak", b"old");

        let restored = restore(wave_bak.clone(), wave.clone()).unwrap();
        assert!(restored.ends_with(&format!("Wave Project{}Wave - restored.als", std::path::MAIN_SEPARATOR)), "{restored}");
        assert_eq!(fs::read(&restored).unwrap(), b"old");
        let again = restore(wave_bak, wave.clone()).unwrap();
        assert!(again.ends_with("Wave - restored (2).als"), "{again}");

        let restored = restore(tide_bak, tide).unwrap();
        assert!(restored.ends_with("Tide - restored.rpp"), "{restored}");
        let restored = restore(fade_bak, fade).unwrap();
        assert!(restored.ends_with("Fade - restored.cpr"), "{restored}");

        assert_eq!(fs::read(&wave).unwrap(), b"current");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_refuses_names_that_could_break_out_of_a_script() {
        let dir = std::env::temp_dir().join(format!("flsm-trash-names-{}", std::process::id()));
        let backup_dir = dir.join("Envy").join("Backup");
        fs::create_dir_all(&backup_dir).unwrap();
        let anything = |_: &Path| true;
        let normal = backup_dir.join("Envy (overwritten at 16h12).flp");
        fs::write(&normal, b"x").unwrap();
        assert!(may_trash(&normal, anything));
        for name in [
            "x\" & (do shell script \"touch /tmp/pwned\") & \".flp",
            "Envy\\(overwritten at 16h12).flp",
            "Envy (overwritten\nat 16h12).flp",
        ] {
            let p = backup_dir.join(name);
            // Some of these names can't exist on every filesystem; the guard refuses them regardless.
            let _ = fs::write(&p, b"x");
            assert!(!may_trash(&p, anything), "{name:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backups_on_a_removable_or_network_drive_need_an_explicit_ok() {
        let listed = |_: &Path| true;
        // Real files; the volume rule is mocked (the "USB" folder is a drive
        // without a Recycle Bin).
        let dir = std::env::temp_dir().join(format!("flsm-trash-volume-{}", std::process::id()));
        let usb = dir.join("USB").join("Envy").join("Backup").join("Envy (overwritten at 16h12).flp");
        let local = dir.join("Local").join("Tide").join("Tide.rpp-bak");
        for f in [&usb, &local] {
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, b"x").unwrap();
        }
        let both = vec![usb.to_string_lossy().to_string(), local.to_string_lossy().to_string()];
        let on_usb = |p: &Path| p.starts_with(dir.join("USB"));
        assert!(check_cleanup(&both, false, listed, on_usb).unwrap_err().contains("permanently"));
        assert!(check_cleanup(&both, true, listed, on_usb).is_ok());
        assert!(check_cleanup(&both[1..], false, listed, on_usb).is_ok());
        // The temp folder is on a local disk: the real detector agrees.
        assert!(!may_delete_permanently(&local));
        assert!(backups_on_risky_volumes(vec![local.to_string_lossy().to_string()]).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_songs_and_templates_stay_inside_settings() {
        let f = crate::scope::tests::fixture("create");
        let s = |p: &Path| p.to_string_lossy().to_string();
        // Parent folder: a linked folder only.
        assert!(f.scope.folder_in_roots(&s(&f.root)).is_ok());
        assert!(f.scope.folder_in_roots(&s(&f.outside)).is_err());
        assert!(f.scope.folder_in_roots(&s(&f.root.join("..").join("Elsewhere"))).is_err());
        // Template: an .flp from a linked folder (no FL Studio set here).
        assert!(check_template(&f.scope, None, &s(&f.root.join("Envy").join("Envy.flp"))).is_ok());
        assert!(check_template(&f.scope, None, &s(&f.outside.join("Other.flp"))).is_err(), "outside");
        assert!(check_template(&f.scope, None, &s(&f.outside.join("secret.txt"))).is_err(), "not an .flp");
        assert!(check_template(&f.scope, None, &s(&f.root.join("Wave Project").join("Wave.als"))).is_err(), "not FL");
        // Restore: only a backup the scan listed.
        assert!(!crate::scanner::is_listed_backup(&f.outside.join("secret.txt")));
    }
}
