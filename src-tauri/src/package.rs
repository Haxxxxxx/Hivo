use crate::flp_metadata;
use crate::paths::is_remote_or_device;
use crate::render::unique_output_path;
use crate::resolve::Resolver;
use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

// Already-compressed or barely-compressible audio is stored as-is: deflating
// gigabytes of WAV takes ages for a few percent.
const STORE_EXTS: &[&str] = &["wav", "mp3", "ogg", "flac", "aif", "aiff", "m4a"];

/// What a package may hold besides the project itself: audio and sample
/// formats FL loads. A project file can name any path as a "sample", so
/// anything else (keys, documents, configs) is refused, never zipped.
const SAMPLE_EXTS: &[&str] = &[
    "wav", "mp3", "ogg", "flac", "aif", "aiff", "aifc", "m4a", "wv", "rx2", "rex", "sf2", "mid", "midi",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedFile {
    pub path: String,
    pub reason: String,
}

/// What a package would hold, shown to the user before anything is written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub project_path: String,
    pub files: Vec<PlannedFile>,
    /// Paths the project lists that will never be packaged, and why.
    pub refused: Vec<RefusedFile>,
    /// Samples the project references that couldn't be found anywhere.
    pub missing: Vec<String>,
    pub error: Option<String>,
}

/// Why a path the project names can't go in a package, if it can't. Checked
/// on the path as found and on its real location (a `kick.wav` symlink to a
/// key file is refused for what it points at).
pub(crate) fn refuse_reason(path: &Path) -> Option<&'static str> {
    fn check(p: &Path) -> Option<&'static str> {
        if is_remote_or_device(&p.to_string_lossy()) {
            return Some("network or device path");
        }
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            return Some("path climbs out of its folder");
        }
        if p.components().any(|c| matches!(c, Component::Normal(n) if n.to_string_lossy().starts_with('.'))) {
            return Some("hidden file or folder");
        }
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !SAMPLE_EXTS.iter().any(|x| ext.eq_ignore_ascii_case(x)) {
            return Some("not an audio or sample file");
        }
        None
    }
    // Re-check where the path really leads. On Windows `canonicalize` gives
    // `\\?\C:\…`, which would read as a device path and refuse every sample.
    check(path).or_else(|| fs::canonicalize(path).ok().and_then(|real| check(&crate::paths::plain(real))))
}

/// The package contents for one project: every sample that is found, is a
/// regular file, and passes `refuse_reason`.
fn plan_one(resolver: &mut Resolver, project: &Path) -> Result<PackagePlan, String> {
    let meta = flp_metadata::parse_flp_metadata(project)?;
    let (found, mut missing) = resolver.package_files(&meta.samples, project);
    let mut files = Vec::new();
    let mut refused = Vec::new();
    for path in found {
        let shown = path.to_string_lossy().to_string();
        if let Some(reason) = refuse_reason(&path) {
            refused.push(RefusedFile { path: shown, reason: reason.to_string() });
            continue;
        }
        match fs::metadata(&path) {
            Ok(m) if m.is_file() => files.push(PlannedFile {
                name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                path: shown,
                bytes: m.len(),
            }),
            _ => missing.push(shown),
        }
    }
    Ok(PackagePlan { project_path: project.to_string_lossy().to_string(), files, refused, missing, error: None })
}

/// Step 1: what each package would hold. Nothing is written.
#[tauri::command]
pub async fn package_preview(app: AppHandle, project_paths: Vec<String>) -> Result<Vec<PackagePlan>, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let (fl, user_data) = crate::settings::fl_paths(&app);
    let sample_folders = scope.sample_folders().to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let mut resolver = Resolver::new(fl).with_user_data(user_data).with_sample_folders(&sample_folders);
        project_paths
            .iter()
            .map(|p| {
                scope.fl_project(p).and_then(|project| plan_one(&mut resolver, &project)).unwrap_or_else(|error| PackagePlan {
                    project_path: p.clone(),
                    files: Vec::new(),
                    refused: Vec::new(),
                    missing: Vec::new(),
                    error: Some(error),
                })
            })
            .collect()
    })
    .await
    .map_err(|e| format!("couldn't list the package: {e}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageResult {
    pub project_path: String,
    pub zip_path: Option<String>,
    pub bytes: u64,
    /// Samples put in the package.
    pub included: u32,
    /// Samples the project references that couldn't be found anywhere.
    pub missing: Vec<String>,
    /// Paths refused for the package ("path — reason").
    pub refused: Vec<String>,
    pub error: Option<String>,
}

/// Builds a package the way FL's File → Export → Zipped loop package does:
/// the .flp plus every sample it uses, flat at the root of one zip. FL opens
/// these directly and relinks the samples by file name. Only files that are
/// in today's plan AND in `approved` (what the user saw listed) go in.
fn package_one(resolver: &mut Resolver, project: &Path, out_dir: &Path, approved: &HashSet<String>) -> Result<PackageResult, String> {
    let plan = plan_one(resolver, project)?;
    let samples: Vec<PathBuf> = plan.files.iter().filter(|f| approved.contains(&f.path)).map(|f| PathBuf::from(&f.path)).collect();
    let mut missing = plan.missing;
    let refused: Vec<String> = plan.refused.iter().map(|r| format!("{} — {}", r.path, r.reason)).collect();
    let stem = project.file_stem().unwrap_or_default().to_string_lossy().to_string();

    fs::create_dir_all(out_dir).map_err(|e| format!("could not create output folder: {e}"))?;
    let dest = unique_output_path(out_dir, &stem, "zip");
    // Write under a temporary name so a failure never leaves a half-written
    // zip that looks complete.
    let partial = dest.with_extension("zip.part");
    let result = write_zip(&partial, project, &samples);
    match result {
        Ok((included, unreadable)) => {
            fs::rename(&partial, &dest).map_err(|e| format!("could not finish package: {e}"))?;
            missing.extend(unreadable);
            Ok(PackageResult {
                project_path: project.to_string_lossy().to_string(),
                bytes: fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
                zip_path: Some(dest.to_string_lossy().to_string()),
                included,
                missing,
                refused,
                error: None,
            })
        }
        Err(e) => {
            let _ = fs::remove_file(&partial);
            Err(e)
        }
    }
}

/// Returns how many samples went in, and the ones that couldn't be read.
fn write_zip(dest: &Path, project: &Path, samples: &[PathBuf]) -> Result<(u32, Vec<String>), String> {
    let file = File::create(dest).map_err(|e| format!("could not create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(BufWriter::new(file));
    let mut names = HashSet::new();
    let mut included = 0u32;

    let mut add = |zip: &mut zip::ZipWriter<BufWriter<File>>, path: &Path, mut src: File| -> Result<bool, String> {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        // Flat layout: two different files with the same name can't both go
        // in; the first wins (FL's own export has the same limitation).
        if !names.insert(name.to_lowercase()) {
            return Ok(false);
        }
        let size = src.metadata().map(|m| m.len()).unwrap_or(0);
        let store = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| STORE_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)));
        let options = SimpleFileOptions::default()
            .compression_method(if store { CompressionMethod::Stored } else { CompressionMethod::Deflated })
            .large_file(size >= u32::MAX as u64);
        zip.start_file(name.as_str(), options)
            .map_err(|e| format!("zip error on {name}: {e}"))?;
        std::io::copy(&mut src, zip).map_err(|e| format!("could not add {name}: {e}"))?;
        Ok(true)
    };

    let project_file = File::open(project).map_err(|e| format!("could not read {}: {e}", project.display()))?;
    add(&mut zip, project, project_file)?;
    let mut unreadable = Vec::new();
    for sample in samples {
        // A sample that exists but can't be read (permission denied, e.g.
        // macOS-protected folders; or a folder, not a file) is reported like
        // a missing one instead of failing the whole song.
        match File::open(sample).ok().filter(|f| f.metadata().is_ok_and(|m| m.is_file())) {
            Some(src) => {
                if add(&mut zip, sample, src)? {
                    included += 1;
                }
            }
            None => unreadable.push(sample.to_string_lossy().to_string()),
        }
    }
    let mut inner = zip.finish().map_err(|e| format!("could not finish zip: {e}"))?;
    inner.flush().map_err(|e| format!("could not write zip: {e}"))?;
    Ok((included, unreadable))
}

/// Step 2: packages each project into `<output>/<subfolder?>/<song>.zip`,
/// emitting a `package-progress` event per song as it finishes. `approved`
/// lines up with `project_paths`: the sample paths the user confirmed.
#[tauri::command]
pub async fn package_projects(
    app: AppHandle,
    project_paths: Vec<String>,
    subfolder: Option<String>,
    approved: Vec<Vec<String>>,
) -> Result<Vec<PackageResult>, String> {
    let scope = crate::scope::Scope::load(&app)?;
    // <export folder>/Packages[/<album>]
    let mut out_dir = scope.output()?.join("Packages");
    if let Some(sub) = subfolder.as_deref().and_then(crate::scope::safe_subfolder) {
        out_dir.push(sub);
    }
    let (fl, user_data) = crate::settings::fl_paths(&app);
    let sample_folders = scope.sample_folders().to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let mut resolver = Resolver::new(fl).with_user_data(user_data).with_sample_folders(&sample_folders);
        let results: Vec<PackageResult> = project_paths
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let ok: HashSet<String> = approved.get(i).cloned().unwrap_or_default().into_iter().collect();
                let result = scope.fl_project(p).and_then(|project| package_one(&mut resolver, &project, &out_dir, &ok)).unwrap_or_else(|error| PackageResult {
                    project_path: p.clone(),
                    zip_path: None,
                    bytes: 0,
                    included: 0,
                    missing: Vec::new(),
                    refused: Vec::new(),
                    error: Some(error),
                });
                let _ = app.emit("package-progress", &result);
                result
            })
            .collect();
        results
    })
    .await
    .map_err(|e| format!("packaging failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn text_event(id: u8, s: &str) -> Vec<u8> {
        let mut payload: Vec<u8> = format!("{s}\0").encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let mut out = vec![id];
        // FL's variable-length size prefix (7 bits per byte, low bits first).
        let mut len = payload.len();
        loop {
            let byte = (len & 0x7f) as u8;
            len >>= 7;
            out.push(if len > 0 { byte | 0x80 } else { byte });
            if len == 0 {
                break;
            }
        }
        out.append(&mut payload);
        out
    }

    /// `FLSM_PACKAGE_REAL="D:\...\Song.flp" cargo test -- --nocapture package_real`
    /// Packages a real project into the temp folder (reads only).
    #[test]
    fn package_real_if_available() {
        let Ok(flp) = std::env::var("FLSM_PACKAGE_REAL") else { return };
        let out = std::env::temp_dir().join("flsm-package-real");
        let mut resolver = Resolver::new(crate::settings::detect_fl_studio());
        let plan = plan_one(&mut resolver, Path::new(&flp)).unwrap();
        let all: HashSet<String> = plan.files.iter().map(|f| f.path.clone()).collect();
        let r = package_one(&mut resolver, Path::new(&flp), &out, &all).unwrap();
        println!("{:?}: {} samples, {} bytes, missing {:?}", r.zip_path, r.included, r.bytes, r.missing);
    }

    #[test]
    fn packages_flp_and_samples_flat() {
        let root = std::env::temp_dir().join(format!("flsm-pkg-{}", std::process::id()));
        let song = root.join("Projects").join("Envy");
        fs::create_dir_all(song.join("Audio")).unwrap();
        fs::create_dir_all(root.join("Beats")).unwrap();
        fs::write(song.join("Audio").join("take1.wav"), b"vocal").unwrap();
        fs::write(root.join("Beats").join("beat.mp3"), b"beat").unwrap();

        let mut events = Vec::new();
        let ascii_version = b"25.1.6.4997\0";
        events.push(199);
        events.push(ascii_version.len() as u8);
        events.extend_from_slice(ascii_version);
        events.extend(text_event(196, &song.join("Audio").join("take1.wav").to_string_lossy()));
        events.extend(text_event(196, &root.join("Beats").join("beat.mp3").to_string_lossy()));
        events.extend(text_event(196, "C:\\gone\\lost.wav"));
        // Exists but isn't a readable file: reported, doesn't sink the package.
        events.extend(text_event(196, &root.join("Beats").to_string_lossy()));
        let mut flp = b"FLhd".to_vec();
        flp.extend_from_slice(&6u32.to_le_bytes());
        flp.extend_from_slice(&[0, 0, 1, 0, 96, 0]);
        flp.extend_from_slice(b"FLdt");
        flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
        flp.extend_from_slice(&events);
        let project = song.join("Envy.flp");
        fs::write(&project, &flp).unwrap();

        let out = root.join("out");
        let mut resolver = Resolver::new(None);
        let plan = plan_one(&mut resolver, &project).unwrap();
        assert_eq!(plan.files.len(), 2);
        let all: HashSet<String> = plan.files.iter().map(|f| f.path.clone()).collect();
        let result = package_one(&mut resolver, &project, &out, &all).unwrap();
        assert_eq!(result.included, 2);
        assert_eq!(result.missing, vec!["C:\\gone\\lost.wav".to_string()]);
        // A folder named as a sample isn't a sample.
        assert_eq!(result.refused.len(), 1);
        assert!(result.refused[0].contains("not an audio or sample file"));

        let zip_path = result.zip_path.unwrap();
        assert!(zip_path.ends_with("Envy.zip"));
        let mut archive = zip::ZipArchive::new(File::open(&zip_path).unwrap()).unwrap();
        let mut names: Vec<String> = archive.file_names().map(|n| n.unwrap().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["Envy.flp", "beat.mp3", "take1.wav"]);
        let mut content = String::new();
        archive.by_name("take1.wav").unwrap().read_to_string(&mut content).unwrap();
        assert_eq!(content, "vocal");
        assert!(!Path::new(&format!("{zip_path}.part")).exists());

        // A second package of the same song doesn't overwrite the first.
        let again = package_one(&mut resolver, &project, &out, &all).unwrap();
        assert!(again.zip_path.unwrap().ends_with("Envy (1).zip"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_hostile_project_cannot_pull_private_files_into_a_package() {
        let root = std::env::temp_dir().join(format!("flsm-pkg-hostile-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let song = root.join("Song");
        let home = root.join("home");
        fs::create_dir_all(&song).unwrap();
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(home.join(".ssh").join("id_rsa"), b"PRIVATE KEY").unwrap();
        fs::write(home.join(".ssh").join("key.wav"), b"PRIVATE KEY renamed").unwrap();
        fs::write(home.join(".env"), b"TOKEN=x").unwrap();
        fs::write(home.join("secret.txt"), b"secret").unwrap();
        fs::write(song.join("kick.wav"), b"kick").unwrap();
        fs::write(song.join("snare.wav"), b"snare").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(home.join("secret.txt"), song.join("link.wav")).unwrap();

        let mut events = Vec::new();
        let ascii_version = b"25.1.6.4997\0";
        events.push(199);
        events.push(ascii_version.len() as u8);
        events.extend_from_slice(ascii_version);
        for p in [
            home.join(".ssh").join("id_rsa"),
            home.join(".ssh").join("key.wav"),
            home.join(".env"),
            song.join("link.wav"),
            song.join("kick.wav"),
            song.join("snare.wav"),
        ] {
            events.extend(text_event(196, &p.to_string_lossy()));
        }
        events.extend(text_event(196, "\\\\attacker\\share\\loop.wav"));
        let mut flp = b"FLhd".to_vec();
        flp.extend_from_slice(&6u32.to_le_bytes());
        flp.extend_from_slice(&[0, 0, 1, 0, 96, 0]);
        flp.extend_from_slice(b"FLdt");
        flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
        flp.extend_from_slice(&events);
        let project = song.join("Bait.flp");
        fs::write(&project, &flp).unwrap();

        let mut resolver = Resolver::new(None);
        let plan = plan_one(&mut resolver, &project).unwrap();
        let planned: Vec<&str> = plan.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(planned, vec!["kick.wav", "snare.wav"], "refused: {:?}", plan.refused);
        assert!(plan.refused.len() >= 3, "{:?}", plan.refused);

        // Even if the UI "approves" every path, only planned files go in; and
        // only the approved ones of those (snare.wav wasn't approved).
        let mut approved: HashSet<String> = [".ssh/id_rsa", ".ssh/key.wav", ".env", "secret.txt"].iter().map(|n| home.join(n).to_string_lossy().to_string()).collect();
        approved.insert(song.join("link.wav").to_string_lossy().to_string());
        approved.insert(song.join("kick.wav").to_string_lossy().to_string());
        approved.insert("\\\\attacker\\share\\loop.wav".to_string());
        let result = package_one(&mut resolver, &project, &root.join("out"), &approved).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(result.zip_path.unwrap()).unwrap()).unwrap();
        let mut names: Vec<String> = archive.file_names().map(|n| n.unwrap().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["Bait.flp", "kick.wav"]);
        for i in 0..archive.len() {
            let mut body = String::new();
            let _ = archive.by_index(i).unwrap().read_to_string(&mut body);
            assert!(!body.contains("PRIVATE") && !body.contains("TOKEN") && !body.contains("secret"));
        }
        let _ = fs::remove_dir_all(&root);
    }

}
