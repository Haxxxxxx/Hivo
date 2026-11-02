use crate::error::app_err;
use crate::daws::{self, Daw};
use crate::flp_metadata::FlpMetadata;
use crate::models::{FileEntry, ProjectInfo, SampleInfo, ScanResult, StemsInfo};
use crate::resolve::{fold, Probe, Resolver};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const AUDIO_EXTS: &[&str] = &["wav", "mp3", "ogg", "flac"];

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn file_entry(path: &Path) -> Option<FileEntry> {
    let meta = fs::metadata(path).ok()?;
    Some(FileEntry {
        path: path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        modified_at_ms: modified_ms(&meta),
    })
}

fn stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}


/// FL names backups `<project> (overwritten at 16h12).flp` or
/// `<project> (autosaved at 16h43)_2.flp`; recover `<project>`.
pub(crate) fn backup_base_name(stem: &str) -> &str {
    for marker in [" (overwritten at ", " (autosaved at "] {
        if let Some(i) = stem.find(marker) {
            return &stem[..i];
        }
    }
    stem
}

/// FL names recorded takes `<project>_<YYYY-MM-DD HH-MM-SS>_<mixer track>`,
/// plus `_2` / ` - Part_1` / ` (consolidated)` suffixes. Returns the mixer
/// track part ("Lead Voices - Nova").
pub(crate) fn recording_label(stem: &str) -> Option<String> {
    // Find "_YYYY-MM-DD HH-MM-SS_" by shape rather than by project name, so
    // takes recorded under an older project name still work.
    let bytes = stem.as_bytes();
    let is_stamp = |s: &[u8]| {
        s.len() == 19
            && s.iter().enumerate().all(|(i, &c)| match i {
                4 | 7 | 13 | 16 => c == b'-',
                10 => c == b' ',
                _ => c.is_ascii_digit(),
            })
    };
    let start = (0..bytes.len().saturating_sub(20))
        .find(|&i| bytes[i] == b'_' && is_stamp(&bytes[i + 1..i + 20]) && bytes.get(i + 20) == Some(&b'_'))?;
    let mut label = stem[start + 21..].trim();
    for suffix in [" (consolidated)"] {
        label = label.strip_suffix(suffix).unwrap_or(label);
    }
    if let Some(i) = label.find(" - Part_") {
        label = &label[..i];
    }
    if let Some((head, tail)) = label.rsplit_once('_') {
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            label = head;
        }
    }
    let label = label.trim();
    (!is_generic_track_name(label)).then(|| label.to_string())
}

/// "Insert 9", "REC", "Master"… carry no information.
fn is_generic_track_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower.is_empty() || ["rec", "master", "mixer", "current", "untitled"].contains(&lower.as_str()) {
        return true;
    }
    lower
        .strip_prefix("insert")
        .is_some_and(|rest| rest.trim().chars().all(|c| c.is_ascii_digit()))
}

fn push_track_name(names: &mut Vec<String>, name: &str) {
    let name = name.trim();
    if !is_generic_track_name(name) && !names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        names.push(name.to_string());
    }
}

fn by_newest(a: &FileEntry, b: &FileEntry) -> std::cmp::Ordering {
    b.modified_at_ms.cmp(&a.modified_at_ms)
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Normalizes an exported file's stem back to the song name it came from:
/// "03 - Envy" (release export) and "Envy (2)" (name clash) → "envy".
pub(crate) fn export_song_key(stem: &str) -> String {
    let mut s = stem.trim();
    if let Some((num, rest)) = s.split_once(" - ") {
        if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
            s = rest;
        }
    }
    if let Some(open) = s.rfind(" (") {
        let inner = &s[open + 2..];
        if inner.ends_with(')') && inner[..inner.len() - 1].chars().all(|c| c.is_ascii_digit()) && inner.len() > 1 {
            s = &s[..open];
        }
    }
    fold(s)
}

/// Mixdowns exported by this app land in the export folder, not next to
/// the project; index them by song name so they count as the song's render.
/// Where the Launch Kit exports go, inside the export folder.
pub(crate) const LAUNCH_KITS_DIR: &str = "Launch Kits";

fn index_exports(output_folder: Option<&str>) -> HashMap<String, Vec<FileEntry>> {
    let mut index: HashMap<String, Vec<FileEntry>> = HashMap::new();
    let Some(dir) = output_folder else { return index };
    // Launch kits hold copies of masters, not new mixdowns: indexing them
    // would make a kit's own copy the song's "latest render".
    let walker = WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| !(e.depth() == 1 && e.file_type().is_dir() && e.file_name() == LAUNCH_KITS_DIR));
    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if entry.file_type().is_file() && has_ext(path, AUDIO_EXTS) {
            if let Some(fe) = file_entry(path) {
                index.entry(export_song_key(&stem_of(path))).or_default().push(fe);
            }
        }
    }
    index
}

/// `stem` is the song's name, or the name followed by a separator ("Envy",
/// "Envy (master)", "Envy_v2", "Envy - final"). `name` is folded already
/// (`resolve::fold`); "Envyous" is another song.
#[cfg(test)]
fn named_after(stem: &str, name: &str) -> bool {
    let stem = fold(stem);
    match stem.strip_prefix(name) {
        Some(rest) => rest.is_empty() || rest.starts_with(|c: char| !c.is_alphanumeric()),
        None => false,
    }
}

/// The songs of one folder by folded name (two projects can share one:
/// `Envy.flp` and `Envy.als`), to hand each file to its song in one pass.
struct FolderSongs<'a> {
    by_name: HashMap<&'a str, Vec<usize>>,
}

impl<'a> FolderSongs<'a> {
    fn new(names: &'a [String]) -> Self {
        let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
        for (k, n) in names.iter().enumerate() {
            by_name.entry(n.as_str()).or_default().push(k);
        }
        Self { by_name }
    }

    /// Which songs a file (its folded stem) is named after: the longest
    /// song name it starts with, followed by nothing or a character that
    /// isn't a letter or digit ("Envy v2.wav" is "Envy v2"'s, not "Envy"'s,
    /// when both sit in the folder). Also whether a `_` follows the name
    /// (FL's split-mixer export, `<name>_<track>`). Only the stem's own word
    /// boundaries are looked up, so this is linear in the stem, not in the
    /// number of songs.
    fn owner(&self, stem: &str) -> Option<(&[usize], bool)> {
        let ends = stem
            .char_indices()
            .filter(|&(i, c)| i > 0 && !c.is_alphanumeric())
            .map(|(i, _)| i)
            .chain(std::iter::once(stem.len()));
        let ends: Vec<usize> = ends.collect();
        ends.iter().rev().find_map(|&end| {
            let owners = self.by_name.get(&stem[..end])?;
            Some((owners.as_slice(), stem[end..].starts_with('_')))
        })
    }
}

/// Whether `needle` appears in `hay` as whole words: bounded by the start,
/// the end or a character that isn't a letter or digit. Both lowercased.
fn has_words(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(i) = hay[from..].find(needle) {
        let at = from + i;
        let end = at + needle.len();
        let before = hay[..at].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        let after = hay[end..].chars().next().is_none_or(|c| !c.is_alphanumeric());
        if before && after {
            return true;
        }
        from = at + hay[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// A stems folder: "Stems", "Envy stems", "STEM - Envy". Not "Systems" or
/// "Ecosystem".
fn is_stems_dir(name: &str) -> bool {
    let name = name.to_lowercase();
    has_words(&name, "stems") || has_words(&name, "stem")
}

/// Folder names that hold templates in the DAWs Hivo reads (FL "Templates",
/// REAPER "ProjectTemplates", Cubase "Project Templates", Pro Tools
/// "Session Templates"). Whole folder names only: "Love Template" is a song.
const TEMPLATE_DIRS: &[&str] = &["templates", "template", "project templates", "projecttemplates", "session templates"];

/// One folder's entries, collected by the walk from its own file types (no
/// stat per entry): visible files, never dot-files (macOS `._` AppleDouble
/// twins, `.DS_Store`), and subfolders.
#[derive(Default)]
struct DirList {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}

/// Every folder the walk went through, listed once: renders, stems,
/// recordings, sketches and the sample lookup reuse it instead of listing
/// the song folders again.
#[derive(Default)]
struct Listing {
    dirs: HashMap<PathBuf, DirList>,
    /// Symlinked folders and junctions: not followed (they can loop, or lead
    /// out of the linked folder), so what's in them isn't listed.
    links: Vec<PathBuf>,
}

impl Listing {
    fn files(&self, dir: &Path) -> &[PathBuf] {
        self.dirs.get(dir).map_or(&[], |d| d.files.as_slice())
    }

    fn subdirs(&self, dir: &Path) -> &[PathBuf] {
        self.dirs.get(dir).map_or(&[], |d| d.dirs.as_slice())
    }

    /// A folder below `dir` by relative name ("Audio", "Samples/Recorded"),
    /// in any case.
    fn sub<'a>(&'a self, dir: &'a Path, rel: &str) -> Option<&'a Path> {
        let mut at = dir;
        for part in rel.split('/') {
            at = self.subdirs(at).iter().find(|d| d.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(part))).map(PathBuf::as_path)?;
        }
        Some(at)
    }

    fn sub_files(&self, dir: &Path, rel: &str) -> &[PathBuf] {
        self.sub(dir, rel).map_or(&[], |d| self.files(d))
    }

    /// Files in `dir` and up to two folders below it: where the sample lookup
    /// looks for a moved sample.
    fn song_folder_files(&self, dir: &Path) -> Vec<&PathBuf> {
        let mut out: Vec<&PathBuf> = Vec::new();
        let mut level: Vec<&Path> = vec![dir];
        for depth in 0..3 {
            let mut next = Vec::new();
            for d in level {
                out.extend(self.files(d));
                if depth < 2 {
                    next.extend(self.subdirs(d).iter().map(PathBuf::as_path));
                }
            }
            level = next;
        }
        out
    }
}

/// A project file the walk found; it's read once the walk is done.
struct Found {
    path: PathBuf,
    daw: Daw,
    root: usize,
    size: u64,
    modified_ms: i64,
    stamp: Option<daws::Stamp>,
    /// A cloud placeholder (or an iCloud `.name.icloud` stand-in): never opened.
    cloud: bool,
}

impl Found {
    fn new(path: PathBuf, daw: Daw, root: usize, meta: &fs::Metadata) -> Self {
        Self {
            path,
            daw,
            root,
            size: meta.len(),
            modified_ms: modified_ms(meta),
            stamp: Some(daws::stamp_of(meta)),
            cloud: daws::is_cloud_placeholder(meta),
        }
    }
}

/// What a scan found: the projects, and the symlinked folders it skipped.
struct Scanned {
    projects: Vec<ProjectInfo>,
    links: Vec<PathBuf>,
}

/// Reads one project, containing a reader panic. Returns the metadata, why
/// it couldn't be read, and whether it's only in the cloud.
fn read_found(f: &Found) -> (FlpMetadata, Option<String>, bool) {
    // A corrupt, oversized or hostile project never fails the whole scan:
    // it's listed with no metadata and the reason. A reader bug (panic) is
    // contained the same way (release builds unwind, see Cargo.toml). Reads
    // are cached by size and mtime (daws.rs).
    match std::panic::catch_unwind(|| daws::read_project_at(f.daw, &f.path, f.stamp, f.cloud)) {
        Ok(daws::ProjectRead::Read(Ok(meta))) => (meta, None, f.cloud),
        Ok(daws::ProjectRead::Read(Err(e))) => (FlpMetadata::default(), Some(e), f.cloud),
        Ok(daws::ProjectRead::InCloud) => (FlpMetadata::default(), None, true),
        Err(_) => (FlpMetadata::default(), Some("the reader crashed on this file (damaged or unusual project)".to_string()), false),
    }
}

/// A project that failed to read and was saved this recently is probably
/// being written (FL saving it): it's read again once, `REREAD_AFTER` later.
const REREAD_IF_YOUNGER_MS: i64 = 2_000;
const REREAD_AFTER: std::time::Duration = std::time::Duration::from_millis(500);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolved samples, per project: (project stamp, resolver context, song
/// folder fingerprint, the samples, the existence checks they rest on).
/// Reused while none of them changes: the checks are made again on every
/// scan (metadata only, see `ProbeCheck`), so a sample deleted or restored
/// outside the song folder shows on the next scan. A sample added to a
/// library at a new path still waits for the index to be rebuilt
/// (`LIBRARY_TTL` in resolve.rs).
type SamplesEntry = (daws::Stamp, u64, u64, Vec<SampleInfo>, Vec<Probe>);
static RESOLVED_SAMPLES: std::sync::Mutex<Option<HashMap<PathBuf, SamplesEntry>>> = std::sync::Mutex::new(None);

/// Re-checks a cached resolution's probes on this scan. A path in a folder
/// the walk just listed is answered from the listing when it's there; any
/// other answer (outside the linked folders, or not listed under that exact
/// spelling) is a stat. Each path is checked once per scan.
struct ProbeCheck<'a> {
    listing: &'a Listing,
    /// Every listed file, by its path as spelled (built on first use).
    listed: Option<HashSet<&'a std::ffi::OsStr>>,
    stats: HashMap<(std::ffi::OsString, bool), bool>,
}

impl<'a> ProbeCheck<'a> {
    fn new(listing: &'a Listing) -> Self {
        Self { listing, listed: None, stats: HashMap::new() }
    }

    fn now(&mut self, probe: &Probe) -> bool {
        let listing = self.listing;
        // Listed files are regular files (or links to one): a hit either way.
        if self.listed.get_or_insert_with(|| listing.dirs.values().flat_map(|d| d.files.iter().map(|f| f.as_os_str())).collect()).contains(probe.path.as_os_str()) {
            return true;
        }
        *self.stats.entry((probe.path.as_os_str().to_os_string(), probe.file)).or_insert_with(|| if probe.file { probe.path.is_file() } else { probe.path.exists() })
    }

    fn hold(&mut self, probes: &[Probe]) -> bool {
        probes.iter().all(|p| self.now(p) == p.hit)
    }
}

/// A fingerprint of the file names in a song folder (what the moved-sample
/// lookup searches).
fn folder_fingerprint(files: &[&PathBuf]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut names: Vec<&PathBuf> = files.to_vec();
    names.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    names.hash(&mut h);
    h.finish()
}

/// Whether a symlink (or junction) points at a folder (Some(true)) or a
/// file (Some(false)). On Windows the link's own entry says so, so its
/// target (maybe a network share) is never looked up.
fn link_kind(path: &Path, file_type: fs::FileType) -> Option<bool> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        // Junctions carry the directory attribute, so they're symlink dirs too.
        let _ = path;
        Some(!file_type.is_symlink_file())
    }
    #[cfg(not(windows))]
    {
        let _ = file_type;
        let meta = fs::metadata(path).ok()?;
        meta.is_dir().then_some(true).or(meta.is_file().then_some(false))
    }
}

/// What the walk collected: every folder's listing, the projects, the
/// backups (file, DAW, backup-only file type), the `<song>/BandLab` folders
/// (with their linked root), and the paths seen (lowercased).
type Walked = (Listing, Vec<Found>, Vec<(PathBuf, Daw, bool)>, Vec<(PathBuf, String)>, HashSet<String>);

fn walk(folders: &[String]) -> Walked {
    let mut listing = Listing::default();
    let mut seen = HashSet::new();
    let mut found: Vec<Found> = Vec::new();
    // (file, DAW, backup-only file type)
    let mut backups: Vec<(PathBuf, Daw, bool)> = Vec::new();
    // (`<song>/BandLab` folder, its linked root)
    let mut sketch_dirs: Vec<(PathBuf, String)> = Vec::new();
    // iCloud stand-ins (`.Envy.flp.icloud`): (the file they stand for, root, their metadata)
    let mut stubs: Vec<(PathBuf, usize, fs::Metadata)> = Vec::new();
    // Folders already walked (overlapping linked folders), any case.
    let mut walked: HashSet<String> = HashSet::new();

    for (ri, root) in folders.iter().enumerate() {
        let root_path = Path::new(root);
        // Unreachable right now: reported by `unreachable_roots`.
        if !reachable(root_path) {
            continue;
        }
        // Ableton's library folders hold presets and demo sets, not songs.
        let mut it = WalkDir::new(root_path).into_iter().filter_entry(|e| {
            !(e.depth() > 0 && e.file_type().is_dir() && daws::LIBRARY_DIRS.contains(&e.file_name().to_string_lossy().to_lowercase().as_str()))
        });
        while let Some(entry) = it.next() {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let file_type = entry.file_type();
            if entry.depth() == 0 || file_type.is_dir() {
                if entry.depth() > 0 {
                    if let Some(parent) = path.parent() {
                        listing.dirs.entry(parent.to_path_buf()).or_default().dirs.push(path.to_path_buf());
                    }
                }
                // A folder an overlapping linked folder already went through.
                if !walked.insert(path.to_string_lossy().to_lowercase()) {
                    it.skip_current_dir();
                    continue;
                }
                listing.dirs.entry(path.to_path_buf()).or_default();
                if entry.depth() == 0 {
                    continue;
                }
            }
            let Some(parent) = path.parent() else { continue };
            let name = entry.file_name().to_string_lossy();
            if file_type.is_symlink() {
                // Never followed: a linked folder is counted, a linked file
                // is listed (a render can be one) but never read as a project.
                match link_kind(path, file_type) {
                    Some(true) => listing.links.push(path.to_path_buf()),
                    Some(false) if !name.starts_with('.') => listing.dirs.entry(parent.to_path_buf()).or_default().files.push(path.to_path_buf()),
                    _ => {}
                }
                continue;
            }
            if file_type.is_dir() {
                // `<song>/BandLab/` below the root: maybe a sketch (checked
                // once every project is known, see `sketch_of`).
                if entry.depth() >= 2 && entry.file_name() == crate::sketch::SKETCH_DIR {
                    sketch_dirs.push((path.to_path_buf(), root.clone()));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            // Dot-files aren't songs, renders, stems or takes: macOS
            // metadata twins (`._Envy.flp`) from unzipped packages or exFAT
            // drives, `.DS_Store`. Except iCloud's stand-in for a file that
            // isn't downloaded, which is listed as that file.
            if name.starts_with('.') {
                if let Some(real) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".icloud")).filter(|n| !n.is_empty()) {
                    if let Ok(meta) = entry.metadata() {
                        stubs.push((parent.join(real), ri, meta));
                    }
                }
                continue;
            }
            listing.dirs.entry(parent.to_path_buf()).or_default().files.push(path.to_path_buf());
            // Backup-only files: .rpp-bak, Cubase .bak, Studio One .autosave.
            let (daw, backup_only) = match (Daw::of_project(path), Daw::of_backup_file(path)) {
                (Some(d), _) => (d, false),
                (None, Some(d)) => (d, true),
                _ => continue,
            };
            if path.components().any(|c| c.as_os_str() == "__MACOSX") {
                continue;
            }
            // Overlapping linked folders would otherwise list a file twice.
            if !seen.insert(path.to_string_lossy().to_lowercase()) {
                continue;
            }
            if backup_only || daws::is_backup_project(path, root_path, daw) {
                backups.push((path.to_path_buf(), daw, backup_only));
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            found.push(Found::new(path.to_path_buf(), daw, ri, &meta));
        }
    }

    // A project that's only in iCloud: listed under its real name (its
    // stage and notes are keyed by that), never downloaded.
    for (path, ri, meta) in stubs {
        let Some(daw) = Daw::of_project(&path) else { continue };
        let root = Path::new(&folders[ri]);
        if path.components().any(|c| c.as_os_str() == "__MACOSX") || daws::is_backup_project(&path, root, daw) {
            continue;
        }
        if !seen.insert(path.to_string_lossy().to_lowercase()) {
            continue;
        }
        found.push(Found { path, daw, root: ri, size: 0, modified_ms: modified_ms(&meta), stamp: None, cloud: true });
    }
    (listing, found, backups, sketch_dirs, seen)
}

#[cfg(test)]
fn scan(folders: &[String], output_folder: Option<&str>) -> Vec<ProjectInfo> {
    scan_with(folders, output_folder, Resolver::new(crate::settings::detect_fl_studio())).projects
}

fn scan_with(folders: &[String], output_folder: Option<&str>, mut resolver: Resolver) -> Scanned {
    let exports = index_exports(output_folder);
    let (listing, mut found, backups, sketch_dirs, mut seen) = walk(folders);

    // Read every project; one that failed while it was being saved gets a
    // second chance a moment later (all of them after one wait).
    let mut reads: Vec<(FlpMetadata, Option<String>, bool)> = found.iter().map(read_found).collect();
    let now = now_ms();
    let retry: Vec<usize> = (0..found.len())
        .filter(|&i| reads[i].1.is_some() && !reads[i].2 && now - found[i].modified_ms < REREAD_IF_YOUNGER_MS)
        .collect();
    if !retry.is_empty() {
        std::thread::sleep(REREAD_AFTER);
        for i in retry {
            if let Ok(meta) = fs::metadata(&found[i].path) {
                let f = &mut found[i];
                *f = Found::new(std::mem::take(&mut f.path), f.daw, f.root, &meta);
                reads[i] = read_found(&found[i]);
            }
        }
    }

    let context = resolver.context_key();
    let mut probe_check = ProbeCheck::new(&listing);
    let mut fingerprints: HashMap<PathBuf, u64> = HashMap::new();
    let mut projects: Vec<ProjectInfo> = Vec::with_capacity(found.len());
    for (f, (flp, read_error, in_cloud)) in found.into_iter().zip(reads) {
        let root = &folders[f.root];
        let folder = f.path.parent().map(Path::to_path_buf).unwrap_or_default();
        let samples = if flp.samples.is_empty() {
            Vec::new()
        } else {
            let fingerprint = *fingerprints.entry(folder.clone()).or_insert_with(|| folder_fingerprint(&listing.song_folder_files(&folder)));
            let cached = f.stamp.and_then(|stamp| {
                let cache = RESOLVED_SAMPLES.lock().unwrap_or_else(|e| e.into_inner());
                cache
                    .as_ref()?
                    .get(&f.path)
                    .filter(|(s, c, fp, _, probes)| *s == stamp && *c == context && *fp == fingerprint && probe_check.hold(probes))
                    .map(|e| e.3.clone())
            });
            cached.unwrap_or_else(|| {
                resolver.prime_song_folder(&folder, || {
                    let mut names = HashMap::new();
                    for p in listing.song_folder_files(&folder) {
                        if let Some(n) = crate::resolve::lower_file_name(p) {
                            names.entry(n).or_insert_with(|| p.clone());
                        }
                    }
                    names
                });
                let (samples, probes) = resolver.samples_traced(&flp.samples, &f.path);
                if let Some(stamp) = f.stamp {
                    let mut cache = RESOLVED_SAMPLES.lock().unwrap_or_else(|e| e.into_inner());
                    cache.get_or_insert_with(HashMap::new).insert(f.path.clone(), (stamp, context, fingerprint, samples.clone(), probes));
                }
                samples
            })
        };
        projects.push(ProjectInfo {
            path: f.path.to_string_lossy().to_string(),
            name: stem_of(&f.path),
            folder: folder.to_string_lossy().to_string(),
            size_bytes: f.size,
            modified_at_ms: f.modified_ms,
            root: root.clone(),
            genre: non_empty(flp.genre),
            artist: non_empty(flp.artist),
            tempo_bpm: flp.tempo_bpm,
            time_sig_num: flp.time_sig_num,
            time_sig_denom: flp.time_sig_denom,
            fl_version: if f.daw == Daw::FlStudio { flp.fl_version.clone() } else { None },
            daw: f.daw,
            daw_version: flp.fl_version.clone(),
            is_template: under_template_dir(&f.path, Path::new(root)),
            backups: Vec::new(),
            renders: Vec::new(),
            recordings_count: 0,
            recordings_bytes: 0,
            flp_title: non_empty(flp.title.clone()),
            comment: non_empty(flp.comment.clone()),
            stems: None,
            plugins: resolver.plugins(&flp.plugins),
            samples,
            track_names: {
                let mut names = Vec::new();
                for n in &flp.mixer_names {
                    push_track_name(&mut names, n);
                }
                names
            },
            read_error,
            ambiguous_exports: 0,
            in_cloud,
        });
    }

    // Index projects by the folder they live in.
    let mut by_folder: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in projects.iter().enumerate() {
        by_folder.entry(p.folder.to_lowercase()).or_default().push(i);
    }

    // A backup belongs to a project of the same DAW in its folder or up to
    // two folders up (`Backup/`, `History/`, `Session File Backups/`, or next
    // to it for .rpp-bak / Cubase .bak) with the same base name. If names
    // don't match (renamed since), it goes to the only such project in the
    // folder holding its backup folder. Generic backup-only types (.bak)
    // need the name to match.
    for (backup, daw, backup_only) in backups {
        let file_name = backup.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let base = daws::backup_base_name(daw, &file_name);
        let home = daws::backup_home_dir(&backup, daw).map(|d| d.to_string_lossy().to_lowercase());
        let owner = backup.ancestors().skip(1).take(3).find_map(|dir| {
            let key = dir.to_string_lossy().to_lowercase();
            let candidates: Vec<usize> = by_folder.get(&key)?.iter().copied().filter(|&i| projects[i].daw == daw).collect();
            let fallback_here = !backup_only && home.as_deref() == Some(key.as_str());
            candidates
                .iter()
                .copied()
                .find(|&i| projects[i].name.eq_ignore_ascii_case(&base))
                .or_else(|| (fallback_here && candidates.len() == 1).then(|| candidates[0]))
        });
        if let (Some(i), Some(entry)) = (owner, file_entry(&backup)) {
            projects[i].backups.push(entry);
        }
    }

    // Export-folder mixdowns are matched by name only: when two linked
    // songs share a name, a file there could be either's, so neither gets it.
    let mut name_counts: HashMap<String, usize> = HashMap::new();
    for p in projects.iter().filter(|p| !p.is_template) {
        *name_counts.entry(fold(&p.name)).or_default() += 1;
    }

    // Renders sit next to the .flp; recordings in the sibling Audio/ folder.
    for indices in by_folder.values() {
        let dir = PathBuf::from(&projects[indices[0]].folder);
        // Every song name in this folder: a file goes to the longest one it's
        // named after (versions: "Envy", "Envy v2", "Envy v2 final"), each
        // file looked at once.
        let names: Vec<String> = indices.iter().map(|&j| fold(&projects[j].name)).collect();
        let songs = FolderSongs::new(&names);
        // Per song (position in `indices`): its files next to the project,
        // with whether they're `<name>_<track>` split-mixer exports.
        let mut beside: Vec<Vec<(&PathBuf, bool)>> = vec![Vec::new(); indices.len()];
        for p in listing.files(&dir).iter().filter(|p| has_ext(p, AUDIO_EXTS)) {
            if let Some((owners, split)) = songs.owner(&fold(&stem_of(p))) {
                for &k in owners {
                    beside[k].push((p, split));
                }
            }
        }
        // FL's recorded takes, `Audio/<name>_<date>_<track>.wav`.
        let mut takes: Vec<Vec<&PathBuf>> = vec![Vec::new(); indices.len()];
        for p in listing.sub_files(&dir, "Audio").iter().filter(|p| has_ext(p, AUDIO_EXTS)) {
            if let Some((owners, true)) = songs.owner(&fold(&stem_of(p))) {
                for &k in owners {
                    takes[k].push(p);
                }
            }
        }
        // A stems folder belongs to the song it's named after (whole words,
        // the longest song name that fits: "Envy v2 Stems" is "Envy v2"'s),
        // else to the only song in the folder.
        let mut stem_dir_of: Vec<Option<&PathBuf>> = vec![None; indices.len()];
        let stem_dirs: Vec<&PathBuf> = listing
            .subdirs(&dir)
            .iter()
            .filter(|d| d.file_name().is_some_and(|n| is_stems_dir(&n.to_string_lossy())))
            .collect();
        for &d in &stem_dirs {
            let dname = d.file_name().map(|n| fold(&n.to_string_lossy())).unwrap_or_default();
            let best = names.iter().enumerate().filter(|(_, n)| has_words(&dname, n)).map(|(k, n)| (n.len(), k)).max();
            if let Some((len, _)) = best {
                for (k, n) in names.iter().enumerate() {
                    if n.len() == len && has_words(&dname, n) && stem_dir_of[k].is_none() {
                        stem_dir_of[k] = Some(d);
                    }
                }
            }
        }
        if indices.len() == 1 && stem_dir_of[0].is_none() {
            stem_dir_of[0] = stem_dirs.first().copied();
        }
        let mut per_daw: HashMap<Daw, usize> = HashMap::new();
        for &j in indices {
            *per_daw.entry(projects[j].daw).or_default() += 1;
        }

        for (k, &i) in indices.iter().enumerate() {
            let name = &names[k];
            // FL's split-mixer export: `<name>_<track>.wav`, one per track.
            // Two or more of them are stems, not mixdowns.
            let split: Vec<PathBuf> = beside[k].iter().filter(|(_, s)| *s).map(|(p, _)| (*p).clone()).collect();
            let split_are_stems = split.len() >= 2;
            let mut renders: Vec<FileEntry> = beside[k]
                .iter()
                .filter(|(_, s)| !(split_are_stems && *s))
                .filter_map(|(p, _)| file_entry(p))
                .collect();
            // Each DAW's own export folder (Pro Tools "Bounced Files", Studio
            // One "Mixdown"…): files named after the song, or any audio there
            // if it's the only project of that DAW in the folder.
            let daw = projects[i].daw;
            let alone = per_daw.get(&daw).copied() == Some(1);
            let owns = |p: &Path| songs.owner(&fold(&stem_of(p))).is_some_and(|(owners, _)| owners.contains(&k));
            for sub in daw.render_dirs() {
                renders.extend(
                    listing
                        .sub_files(&dir, sub)
                        .iter()
                        .filter(|p| has_ext(p, AUDIO_EXTS) && (alone || owns(p)))
                        .filter_map(|p| file_entry(p)),
                );
            }
            projects[i].stems = if let Some(sd) = stem_dir_of[k] {
                stems_info(sd, listing.files(sd))
            } else if split_are_stems {
                stems_info(&dir, &split)
            } else {
                None
            };
            if let Some(exported) = exports.get(name) {
                if name_counts.get(name).copied().unwrap_or(0) > 1 {
                    projects[i].ambiguous_exports = exported.len() as u32;
                } else {
                    renders.extend(exported.iter().cloned());
                }
            }
            renders.sort_by(by_newest);
            projects[i].renders = renders;

            if daw != Daw::FlStudio {
                // The DAW's recordings folder belongs to the project when it's
                // the only project of that DAW in the folder.
                if alone {
                    for sub in daw.recording_dirs() {
                        for rec in listing.sub_files(&dir, sub).iter().filter(|p| has_ext(p, AUDIO_EXTS)) {
                            if let Ok(meta) = fs::metadata(rec) {
                                projects[i].recordings_count += 1;
                                projects[i].recordings_bytes += meta.len();
                            }
                        }
                    }
                }
                projects[i].backups.sort_by(by_newest);
                continue;
            }
            for rec in &takes[k] {
                if let Ok(meta) = fs::metadata(rec) {
                    projects[i].recordings_count += 1;
                    projects[i].recordings_bytes += meta.len();
                }
                if let Some(label) = recording_label(&stem_of(rec)) {
                    push_track_name(&mut projects[i].track_names, &label);
                }
            }
            projects[i].backups.sort_by(by_newest);
        }
    }

    // Sketches last: they're not in `by_folder`, so the render pass above
    // never sees them (their audio is listed by `sketch_of`).
    for (dir, root) in sketch_dirs {
        if !seen.insert(dir.to_string_lossy().to_lowercase()) {
            continue;
        }
        if let Some(sketch) = sketch_of(&dir, &root, &listing) {
            projects.push(sketch);
        }
    }

    merge_plugin_aliases(&mut projects);
    projects.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Scanned { projects, links: listing.links }
}

/// A BandLab sketch: `X/BandLab/` holding at least one audio file, with no
/// DAW project directly in X (once there's one, X is that project's folder
/// and BandLab/ just holds its source audio). Keyed by the BandLab folder's
/// path; named after X. Nothing is read from inside the audio here.
fn sketch_of(bandlab: &Path, root: &str, listing: &Listing) -> Option<ProjectInfo> {
    let song = bandlab.parent()?;
    if bandlab.components().any(|c| c.as_os_str() == "__MACOSX") {
        return None;
    }
    if listing.files(song).iter().any(|p| Daw::of_project(p).is_some()) {
        return None;
    }
    let mut audio: Vec<FileEntry> = listing
        .files(bandlab)
        .iter()
        .filter(|p| crate::sketch::is_sketch_audio(p))
        .filter_map(|p| file_entry(p))
        .collect();
    if audio.is_empty() {
        return None;
    }
    audio.sort_by(by_newest);
    Some(ProjectInfo {
        path: bandlab.to_string_lossy().to_string(),
        read_error: None,
        name: song.file_name()?.to_string_lossy().to_string(),
        folder: song.to_string_lossy().to_string(),
        size_bytes: audio.iter().map(|f| f.size_bytes).sum(),
        modified_at_ms: audio[0].modified_at_ms,
        root: root.to_string(),
        genre: None,
        artist: None,
        tempo_bpm: None,
        time_sig_num: None,
        time_sig_denom: None,
        fl_version: None,
        daw: Daw::Bandlab,
        daw_version: None,
        is_template: false,
        backups: Vec::new(),
        renders: audio,
        recordings_count: 0,
        recordings_bytes: 0,
        flp_title: None,
        comment: None,
        stems: None,
        plugins: Vec::new(),
        samples: Vec::new(),
        track_names: Vec::new(),
        ambiguous_exports: 0,
        in_cloud: false,
    })
}

/// Scans run on every window focus and can overlap (focus + adding a
/// folder): each gets a number, and only the newest one to finish so far
/// replaces what the last scan listed (`remember_scan`).
static SCAN_SEQ: AtomicU64 = AtomicU64::new(0);
static REMEMBERED_SEQ: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

/// Remembers scan `seq`'s results unless a newer scan already did. Returns
/// whether it did.
fn remember_if_newest(seq: u64, projects: &[ProjectInfo]) -> bool {
    let mut newest = REMEMBERED_SEQ.lock().unwrap_or_else(|e| e.into_inner());
    if seq <= *newest {
        return false;
    }
    *newest = seq;
    remember_scan(projects);
    true
}

/// Where the read cache is saved, and whether it was loaded this launch.
const READ_CACHE_FILE: &str = "read-cache.json";
static READ_CACHE_LOADED: std::sync::Once = std::sync::Once::new();

/// Scans the linked folders and the export folder from Settings (never
/// folders named by the webview: the backup cleanup trusts this listing).
#[tauri::command]
pub async fn scan_projects(app: AppHandle) -> Result<ScanResult, String> {
    let seq = SCAN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let scope = crate::scope::Scope::load(&app)?;
    let folders: Vec<String> = scope.folders().iter().map(|f| f.to_string_lossy().to_string()).collect();
    // Every linked folder as saved (the scope drops the ones that can't be
    // resolved, e.g. a drive letter that's gone): the webview needs to know
    // which are unreachable, so their songs aren't taken for moved or deleted.
    let linked = crate::settings::load(&app)?.watched_folders;
    let output_folder = scope.output_folder().map(|o| o.to_string_lossy().to_string());
    // Let the webview stream renders from linked folders and the export
    // folder (in-app playback) without opening the asset protocol to the
    // whole disk.
    let assets = app.asset_protocol_scope();
    for folder in folders.iter().chain(output_folder.iter()) {
        let _ = assets.allow_directory(folder, true);
    }
    let (fl, user_data) = crate::settings::fl_paths(&app);
    let sample_folders = scope.sample_folders().to_vec();
    let cache_file = app.path().app_config_dir().ok().map(|d| d.join(READ_CACHE_FILE));
    let (scanned, unreachable) = tauri::async_runtime::spawn_blocking(move || {
        if let Some(file) = &cache_file {
            READ_CACHE_LOADED.call_once(|| daws::load_read_cache(file));
        }
        let resolver = Resolver::new(fl).with_user_data(user_data).with_sample_folders(&sample_folders);
        let scanned = scan_with(&folders, output_folder.as_deref(), resolver);
        if remember_if_newest(seq, &scanned.projects) {
            if let Some(file) = &cache_file {
                // Not fatal: the next launch reads the projects again.
                if let Err(e) = daws::save_read_cache(file) {
                    eprintln!("{e}");
                }
            }
        }
        (scanned, unreachable_roots(&linked))
    })
        .await
        .map_err(|e| app_err("task.failed", format!("scan failed: {e}")))?;
    let skipped_links = scanned.links.len() as u32;
    let skipped_link_examples = scanned.links.iter().take(3).map(|p| p.to_string_lossy().to_string()).collect();
    Ok(ScanResult { projects: scanned.projects, unreachable, skipped_links, skipped_link_examples })
}

/// The same plugin reports different names per format — FabFilter's CLAP
/// build says "Pro-Q 4", the VST3 "FabFilter Pro-Q 4". When the
/// vendor-prefixed name exists elsewhere in the library, use it, so usage
/// counts aren't split.
fn merge_plugin_aliases(projects: &mut [ProjectInfo]) {
    let names: HashSet<String> = projects.iter().flat_map(|p| &p.plugins).map(|p| p.name.clone()).collect();
    for project in projects.iter_mut() {
        for plugin in project.plugins.iter_mut() {
            if let Some(vendor) = &plugin.vendor {
                let prefixed = format!("{vendor} {}", plugin.name);
                if !plugin.name.starts_with(vendor.as_str()) && names.contains(&prefixed) {
                    plugin.name = prefixed;
                }
            }
        }
        // A song using both formats keeps one entry (installed if either is).
        let mut merged: Vec<crate::models::PluginInfo> = Vec::new();
        for plugin in project.plugins.drain(..) {
            match merged.iter_mut().find(|m| m.name == plugin.name) {
                Some(existing) => {
                    if plugin.installed == Some(true) {
                        existing.installed = Some(true);
                    }
                }
                None => merged.push(plugin),
            }
        }
        project.plugins = merged;
    }
}

/// Under a templates folder (FL "Templates", REAPER "ProjectTemplates",
/// Pro Tools "Session Templates", Cubase "Project Templates"…).
fn under_template_dir(path: &Path, root: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut comps: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    comps.pop();
    comps.iter().any(|c| TEMPLATE_DIRS.contains(&c.trim()))
}

/// Audio files among `files` as a stems summary; None if there are none.
fn stems_info(folder: &Path, files: &[PathBuf]) -> Option<StemsInfo> {
    let audio: Vec<FileEntry> = files.iter().filter(|p| has_ext(p, AUDIO_EXTS)).filter_map(|p| file_entry(p)).collect();
    (!audio.is_empty()).then(|| StemsInfo {
        folder: folder.to_string_lossy().to_string(),
        count: audio.len() as u32,
        bytes: audio.iter().map(|f| f.size_bytes).sum(),
        newest_ms: audio.iter().map(|f| f.modified_at_ms).max().unwrap_or(0),
    })
}

/// A linked folder that can be listed right now. Network and device paths
/// are never touched (on Windows a lookup sends the user's credentials).
fn reachable(root: &Path) -> bool {
    !crate::paths::is_remote_or_device(&root.to_string_lossy()) && fs::read_dir(root).is_ok()
}

/// The linked folders that can't be listed right now (unplugged drive,
/// unmounted share, folder renamed or deleted), in the order they're linked.
pub(crate) fn unreachable_roots(linked: &[String]) -> Vec<String> {
    linked.iter().filter(|f| !reachable(Path::new(f))).cloned().collect()
}

/// Backups the last scan listed. Cleanup only deletes paths from this set,
/// so the webview can never point it at a real project.
static LISTED_BACKUPS: std::sync::Mutex<Option<HashSet<PathBuf>>> = std::sync::Mutex::new(None);

fn remember_scan(projects: &[ProjectInfo]) {
    let listed: HashSet<PathBuf> = projects.iter().flat_map(|p| p.backups.iter().map(|b| PathBuf::from(&b.path))).collect();
    *LISTED_BACKUPS.lock().unwrap_or_else(|e| e.into_inner()) = Some(listed);
    let scanned: HashSet<PathBuf> = projects.iter().map(|p| PathBuf::from(&p.path)).collect();
    daws::prune_read_cache(&scanned);
    if let Some(cache) = RESOLVED_SAMPLES.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        cache.retain(|p, _| scanned.contains(p));
    }
}

/// Whether the last scan listed `path` as some project's backup.
pub fn is_listed_backup(path: &Path) -> bool {
    LISTED_BACKUPS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|set| set.contains(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SampleStatus;

    #[test]
    fn a_bandlab_folder_without_a_project_is_a_sketch() {
        let root = std::env::temp_dir().join(format!("flsm-sketch-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let w = |rel: &str| {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        };
        // A sketch: BandLab/ with audio, nothing else.
        w("Night Run/BandLab/Night Run mixdown.mp3");
        w("Night Run/BandLab/Vox stem.wav");
        w("Night Run/BandLab/notes.txt");
        // Continued in FL: the .flp makes it the FL project, BandLab/ is its source audio.
        w("Envy/Envy.flp");
        w("Envy/BandLab/Envy idea.mp3");
        // BandLab/ with no audio isn't anything.
        w("Empty/BandLab/readme.txt");
        // Directly in the linked folder: not a song folder.
        w("BandLab/Loose.mp3");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(projects.len(), 2, "{names:?}");

        let sketch = projects.iter().find(|p| p.name == "Night Run").expect("the sketch is listed");
        assert_eq!(sketch.daw, Daw::Bandlab);
        assert!(sketch.path.ends_with("BandLab"), "{}", sketch.path);
        assert!(Path::new(&sketch.folder).ends_with("Night Run"));
        assert_eq!(sketch.renders.len(), 2, "audio only: {:?}", sketch.renders);
        assert_eq!(sketch.modified_at_ms, sketch.renders[0].modified_at_ms);
        assert!(sketch.plugins.is_empty() && sketch.samples.is_empty() && sketch.backups.is_empty() && !sketch.is_template);

        let envy = projects.iter().find(|p| p.name == "Envy").unwrap();
        assert_eq!(envy.daw, Daw::FlStudio);
        assert!(envy.renders.is_empty(), "BandLab audio isn't the FL project's mixdown");
    }

    #[test]
    fn launch_kit_copies_are_not_renders() {
        let out = std::env::temp_dir().join(format!("flsm-exports-{}", std::process::id()));
        let kit = out.join(LAUNCH_KITS_DIR).join("Envy");
        fs::create_dir_all(&kit).unwrap();
        fs::write(out.join("Envy.wav"), b"x").unwrap();
        fs::write(kit.join("Envy.wav"), b"x").unwrap();
        let index = index_exports(out.to_str());
        let _ = fs::remove_dir_all(&out);
        let renders = &index[&export_song_key("Envy")];
        assert_eq!(renders.len(), 1);
        assert!(!renders[0].path.contains(LAUNCH_KITS_DIR));
    }

    #[test]
    fn extracts_recording_labels() {
        let l = |s: &str| recording_label(s);
        assert_eq!(l("Envy_2025-12-15 18-49-59_Voice 1 - Kairo").as_deref(), Some("Voice 1 - Kairo"));
        assert_eq!(l("Envy_2025-12-16 22-16-05_Ambiance 2 - Kairo - Part_1").as_deref(), Some("Ambiance 2 - Kairo"));
        assert_eq!(l("Ft Le Q_2025-05-19 21-32-32_Main Voice - Feal_2").as_deref(), Some("Main Voice - Feal"));
        assert_eq!(l("Old_Name_2025-05-01 00-54-19_Ambiances 2 - NV ").as_deref(), Some("Ambiances 2 - NV"));
        assert_eq!(l("X_2025-02-01 17-51-18_REC (consolidated)"), None);
        assert_eq!(l("X_2025-02-01 17-51-18_Insert 9"), None);
        assert_eq!(l("not a recording"), None);
    }

    #[test]
    fn matches_exported_file_names_to_songs() {
        assert_eq!(export_song_key("Envy"), "envy");
        assert_eq!(export_song_key("03 - Envy"), "envy");
        assert_eq!(export_song_key("Envy (2)"), "envy");
        assert_eq!(export_song_key("01 - Ft Le Q (1)"), "ft le q");
        // Not numbering: keep the whole name.
        assert_eq!(export_song_key("Me - You"), "me - you");
        assert_eq!(export_song_key("Titre []"), "titre []");
        assert_eq!(export_song_key("Song (live)"), "song (live)");
    }

    #[test]
    fn strips_backup_suffixes() {
        assert_eq!(backup_base_name("Envy (overwritten at 16h12)"), "Envy");
        assert_eq!(backup_base_name("Envy (overwritten at 16h10)_2"), "Envy");
        assert_eq!(backup_base_name("doggy style (autosaved at 16h43)"), "doggy style");
        assert_eq!(backup_base_name("Plain"), "Plain");
    }

    /// `FLSM_REAL_PROJECTS="D:\...\Projects" cargo test -- --nocapture real_folder`
    #[test]
    fn scans_real_folder_if_available() {
        let Ok(root) = std::env::var("FLSM_REAL_PROJECTS") else { return };
        let projects = scan(&[root], std::env::var("FLSM_EXPORT_FOLDER").ok().as_deref());
        let backups: usize = projects.iter().map(|p| p.backups.len()).sum();
        let rendered = projects.iter().filter(|p| !p.renders.is_empty()).count();
        let templates = projects.iter().filter(|p| p.is_template).count();
        println!("{} songs, {backups} backups grouped, {rendered} with mixdowns, {templates} templates", projects.len());
        let count = |s: SampleStatus| projects.iter().flat_map(|p| &p.samples).filter(|x| x.status == s).count();
        println!(
            "samples: {} ok, {} relocated, {} missing",
            count(SampleStatus::Ok),
            count(SampleStatus::Relocated),
            count(SampleStatus::Missing)
        );
        let mut missing_plugins: Vec<_> = projects
            .iter()
            .flat_map(|p| &p.plugins)
            .filter(|p| p.installed == Some(false))
            .map(|p| p.name.as_str())
            .collect();
        missing_plugins.sort();
        missing_plugins.dedup();
        println!("plugins not installed: {missing_plugins:?}");
        for p in projects.iter().filter(|p| !p.track_names.is_empty()).take(6) {
            println!("  {} tracks: {:?}", p.name, p.track_names);
        }
        for p in projects.iter().take(5) {
            println!("  {} — {} backups, {} renders, {} recordings", p.name, p.backups.len(), p.renders.len(), p.recordings_count);
        }
        assert!(!projects.is_empty());
    }

    #[test]
    fn a_flat_folder_hands_each_file_to_its_longest_song_name() {
        let names: Vec<String> = ["envy", "envy v2", "envy v2 final", "été"].iter().map(|s| s.to_string()).collect();
        let songs = FolderSongs::new(&names);
        let owner = |stem: &str| songs.owner(&fold(stem)).map(|(o, split)| (o.to_vec(), split));
        assert_eq!(owner("Envy"), Some((vec![0], false)));
        assert_eq!(owner("Envy (master)"), Some((vec![0], false)));
        assert_eq!(owner("Envy_Kick"), Some((vec![0], true)));
        assert_eq!(owner("Envy v2_Kick"), Some((vec![1], true)));
        assert_eq!(owner("Envy v2 final - bounce"), Some((vec![2], false)));
        assert_eq!(owner("Envyous"), None);
        assert_eq!(owner("Other"), None);
        // NFD on disk, NFC in the project name.
        assert_eq!(owner("E\u{301}te\u{301} (master)"), Some((vec![3], false)));
        // Two projects with one name (Envy.flp and Envy.als) both own it.
        let twins: Vec<String> = vec!["envy".into(), "envy".into()];
        assert_eq!(FolderSongs::new(&twins).owner("envy").map(|(o, _)| o.to_vec()), Some(vec![0, 1]));
    }

    #[test]
    fn dot_files_are_never_renders_stems_or_takes() {
        let (root, w) = fixture("dotfiles");
        w("Envy/Envy.flp");
        w("Envy/Envy.wav");
        w("Envy/._Envy.wav");
        w("Envy/._Envy (master).mp3");
        w("Envy/.DS_Store");
        w("Envy/Stems/Kick.wav");
        w("Envy/Stems/._Kick.wav");
        w("Envy/Audio/Envy_2025-12-15 18-49-59_Voice.wav");
        w("Envy/Audio/._Envy_2025-12-15 18-49-59_Voice.wav");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(projects.len(), 1);
        let p = &projects[0];
        assert_eq!(file_names(&p.renders), vec!["Envy.wav"]);
        assert_eq!(p.stems.as_ref().map(|s| s.count), Some(1));
        assert_eq!(p.recordings_count, 1);
    }

    #[test]
    fn decomposed_and_composed_names_match() {
        let (root, w) = fixture("nfc");
        // The project named on Windows (NFC), the mixdown and the stems
        // folder made on a Mac (NFD).
        w("Ete/\u{c9}t\u{e9}.flp");
        w("Ete/E\u{301}te\u{301}.wav");
        w("Ete/Other.flp");
        w("Ete/E\u{301}te\u{301} Stems/Kick.wav");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let ete = projects.iter().find(|p| p.name != "Other").expect("listed");
        assert_eq!(ete.renders.len(), 1, "{:?}", ete.renders);
        assert_eq!(ete.stems.as_ref().map(|s| s.count), Some(1));
        assert_eq!(export_song_key("E\u{301}te\u{301}"), export_song_key("\u{c9}t\u{e9}"));
    }

    #[test]
    fn an_icloud_stub_is_listed_in_the_cloud_not_dropped() {
        let (root, w) = fixture("icloud");
        w("Envy/.Envy.flp.icloud");
        w("Envy/Envy.wav");
        w("Solo/Solo.flp");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let envy = projects.iter().find(|p| p.name == "Envy").expect("the stub stands for Envy.flp");
        assert!(envy.path.ends_with("Envy.flp") && !envy.path.contains(".icloud"), "{}", envy.path);
        assert!(envy.in_cloud && envy.read_error.is_none());
        assert_eq!(envy.renders.len(), 1);
        assert!(!projects.iter().find(|p| p.name == "Solo").unwrap().in_cloud);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_folders_are_counted_not_followed() {
        let (root, w) = fixture("links");
        w("Projects/Envy/Envy.flp");
        w("Elsewhere/Night/Night.flp");
        w("Elsewhere/kick.wav");
        std::os::unix::fs::symlink(root.join("Elsewhere"), root.join("Projects/Linked")).unwrap();
        // A linked file next to a project still counts as its render.
        std::os::unix::fs::symlink(root.join("Elsewhere/kick.wav"), root.join("Projects/Envy/Envy.wav")).unwrap();
        let scanned = scan_with(&[root.join("Projects").to_string_lossy().to_string()], None, Resolver::new(None));
        let _ = fs::remove_dir_all(&root);
        assert_eq!(scanned.projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Envy"]);
        assert_eq!(scanned.links.len(), 1);
        assert!(scanned.links[0].ends_with("Linked"));
        assert_eq!(scanned.projects[0].renders.len(), 1);
    }

    #[test]
    fn only_the_newest_scan_replaces_what_the_last_one_listed() {
        // Scans 1 and 2 overlap; 2 finishes first.
        let base = SCAN_SEQ.fetch_add(2, Ordering::SeqCst);
        let (older, newer) = (base + 1, base + 2);
        assert!(remember_if_newest(newer, &[]));
        assert!(!remember_if_newest(older, &[]), "a slower, older scan doesn't overwrite it");
        assert!(!remember_if_newest(newer, &[]));
    }

    #[test]
    fn a_project_caught_mid_save_is_read_again() {
        let (root, _w) = fixture("midsave");
        let song = root.join("Envy");
        fs::create_dir_all(&song).unwrap();
        let flp = song.join("Envy.flp");
        // Half written: the header says more data than there is.
        let mut half = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
        half.extend_from_slice(&64u32.to_le_bytes());
        half.extend_from_slice(b"\xc7\x05FL 2");
        fs::write(&flp, &half).unwrap();
        // FL finishes saving a moment later.
        let done = flp.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let mut full = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
            full.extend_from_slice(&0u32.to_le_bytes());
            fs::write(&done, &full).unwrap();
        });
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        writer.join().unwrap();
        let _ = fs::remove_dir_all(&root);
        assert!(projects[0].read_error.is_none(), "{:?}", projects[0].read_error);
    }

    #[test]
    fn resolved_samples_follow_the_song_folder() {
        let (root, w) = fixture("samples-cache");
        let song = root.join("Envy");
        fs::create_dir_all(&song).unwrap();
        let p = r"C:\Elsewhere\Pack\Kick.wav";
        let mut events = vec![196u8, p.len() as u8];
        events.extend_from_slice(p.as_bytes());
        let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
        flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
        flp.extend_from_slice(&events);
        fs::write(song.join("Envy.flp"), &flp).unwrap();
        let folders = [root.to_string_lossy().to_string()];
        let status = || scan(&folders, None)[0].samples[0].status;
        assert_eq!(status(), SampleStatus::Missing);
        assert_eq!(status(), SampleStatus::Missing, "same answer from the cache");
        // The sample turns up in the song folder: found, though the project didn't change.
        w("Envy/Samples/Kick.wav");
        assert_eq!(status(), SampleStatus::Relocated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn samples_deleted_or_restored_elsewhere_show_on_the_next_scan() {
        let (root, w) = fixture("samples-elsewhere");
        let song = root.join("Projects").join("Envy");
        fs::create_dir_all(&song).unwrap();
        let packs = root.join("Packs");
        w("Packs/Drums/Snare.wav");
        w("Elsewhere/Kick.wav");
        let kick = root.join("Elsewhere").join("Kick.wav");
        let snare = packs.join("Drums").join("Snare.wav");
        let mut events = Vec::new();
        // Kick: an absolute path outside the linked folder. Snare: saved on
        // another computer, found by name in the sample library.
        for p in [kick.to_string_lossy().to_string(), r"C:\gone\Snare.wav".to_string()] {
            assert!(p.len() < 0x80, "temp path too long for a one-byte size: {p}");
            events.push(196u8);
            events.push(p.len() as u8);
            events.extend_from_slice(p.as_bytes());
        }
        let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
        flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
        flp.extend_from_slice(&events);
        fs::write(song.join("Envy.flp"), &flp).unwrap();
        let folders = [root.join("Projects").to_string_lossy().to_string()];
        let statuses = || -> Vec<SampleStatus> {
            let resolver = Resolver::new(None).with_sample_folders(std::slice::from_ref(&packs));
            scan_with(&folders, None, resolver).projects[0].samples.iter().map(|s| s.status).collect()
        };
        assert_eq!(statuses(), vec![SampleStatus::Ok, SampleStatus::Relocated]);
        assert_eq!(statuses(), vec![SampleStatus::Ok, SampleStatus::Relocated], "from the cache");
        fs::remove_file(&kick).unwrap();
        fs::remove_file(&snare).unwrap();
        assert_eq!(statuses(), vec![SampleStatus::Missing, SampleStatus::Missing], "deleted outside the song folder");
        w("Elsewhere/Kick.wav");
        w("Packs/Drums/Snare.wav");
        assert_eq!(statuses(), vec![SampleStatus::Ok, SampleStatus::Relocated], "restored where they were");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probes_are_answered_from_the_listing_or_a_stat() {
        let (root, w) = fixture("probe-check");
        w("Song/kick.wav");
        w("Outside/snare.wav");
        let (listing, ..) = walk(&[root.join("Song").to_string_lossy().to_string()]);
        let mut check = ProbeCheck::new(&listing);
        let probe = |rel: &str, file: bool, hit: bool| Probe { path: root.join(rel), file, hit };
        assert!(check.hold(&[probe("Song/kick.wav", false, true), probe("Outside/snare.wav", true, true), probe("Outside/gone.wav", false, false)]));
        assert!(!check.hold(&[probe("Song/gone.wav", false, true)]));
        // A folder is there but isn't a file: a library hit must be a file.
        assert!(!check.hold(&[probe("Outside", true, true)]));
        assert!(check.hold(&[probe("Outside", false, true)]));
        let _ = fs::remove_dir_all(&root);
    }

    /// `FLSM_BENCH=2000 cargo test bench_flat_folder -- --nocapture`: a flat
    /// folder of N projects, each with a mixdown and two split-mixer stems.
    #[test]
    fn bench_flat_folder() {
        let Some(n) = std::env::var("FLSM_BENCH").ok().and_then(|v| v.parse::<usize>().ok()) else { return };
        let root = std::env::temp_dir().join(format!("flsm-bench-{n}"));
        if !root.join("done").exists() {
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("Beats").join("Audio")).unwrap();
            let flp: &[u8] = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt\0\0\0\0";
            for i in 0..n {
                let d = root.join("Beats");
                fs::write(d.join(format!("Song {i}.flp")), flp).unwrap();
                for f in [format!("Song {i}.wav"), format!("Song {i}_Kick.wav"), format!("Song {i}_Vox.wav")] {
                    fs::write(d.join(f), b"x").unwrap();
                }
                fs::write(d.join("Audio").join(format!("Song {i}_2025-12-15 18-49-59_Voice.wav")), b"x").unwrap();
            }
            fs::write(root.join("done"), b"").unwrap();
        }
        let folders = [root.join("Beats").to_string_lossy().to_string()];
        for run in ["first", "second"] {
            let t = std::time::Instant::now();
            let projects = scan(&folders, None);
            println!("bench {n} projects, {run} scan: {:?} ({} songs)", t.elapsed(), projects.len());
            assert_eq!(projects.len(), n);
            assert!(projects.iter().all(|p| p.renders.len() == 1 && p.stems.as_ref().map(|s| s.count) == Some(2) && p.recordings_count == 1));
        }
    }

    /// `FLSM_BENCH_SONGS=2000 cargo test bench_song_folders -- --nocapture`:
    /// N song folders (project, mixdown, Audio/ take, Backup/ copy, a stems
    /// folder and 20 samples the project points at).
    #[test]
    fn bench_song_folders() {
        let Some(n) = std::env::var("FLSM_BENCH_SONGS").ok().and_then(|v| v.parse::<usize>().ok()) else { return };
        let root = std::env::temp_dir().join(format!("flsm-bench-songs-{n}"));
        if !root.join("done").exists() {
            let _ = fs::remove_dir_all(&root);
            for i in 0..n {
                let d = root.join("Songs").join(format!("Song {i}"));
                for sub in ["Audio", "Backup", "Stems", "Samples"] {
                    fs::create_dir_all(d.join(sub)).unwrap();
                }
                let mut events = Vec::new();
                for s in 0..20 {
                    // Saved on another computer: found by name in Samples/.
                    let p = format!("C:\\Elsewhere\\Pack\\s{s}.wav");
                    events.push(196u8);
                    events.push(p.len() as u8);
                    events.extend_from_slice(p.as_bytes());
                    fs::write(d.join("Samples").join(format!("s{s}.wav")), b"x").unwrap();
                }
                let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
                flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
                flp.extend_from_slice(&events);
                fs::write(d.join(format!("Song {i}.flp")), &flp).unwrap();
                fs::write(d.join(format!("Song {i}.wav")), b"x").unwrap();
                fs::write(d.join("Audio").join(format!("Song {i}_2025-12-15 18-49-59_Voice.wav")), b"x").unwrap();
                fs::write(d.join("Backup").join(format!("Song {i} (overwritten at 16h12).flp")), b"x").unwrap();
                fs::write(d.join("Stems").join("Kick.wav"), b"x").unwrap();
            }
            fs::write(root.join("done"), b"").unwrap();
        }
        let folders = [root.join("Songs").to_string_lossy().to_string()];
        for run in ["first", "second"] {
            let t = std::time::Instant::now();
            let projects = scan(&folders, None);
            println!("bench {n} song folders, {run} scan: {:?}", t.elapsed());
            assert_eq!(projects.len(), n);
            assert!(projects.iter().all(|p| p.renders.len() == 1 && p.backups.len() == 1 && p.recordings_count == 1 && p.stems.is_some()));
            assert!(projects.iter().all(|p| p.samples.len() == 20 && p.samples.iter().all(|s| s.status == SampleStatus::Relocated)));
        }
    }

    /// `FLSM_BENCH_SAMPLES=2000 cargo test bench_found_samples -- --nocapture`:
    /// N song folders whose 20 samples are stored as absolute paths that
    /// exist (each one different), the case a second scan re-checks most.
    #[test]
    fn bench_found_samples() {
        let Some(n) = std::env::var("FLSM_BENCH_SAMPLES").ok().and_then(|v| v.parse::<usize>().ok()) else { return };
        let root = std::env::temp_dir().join(format!("flsm-bench-samples-{n}"));
        if !root.join("done").exists() {
            let _ = fs::remove_dir_all(&root);
            for i in 0..n {
                let d = root.join("Songs").join(format!("Song {i}"));
                fs::create_dir_all(d.join("Samples")).unwrap();
                let mut events = Vec::new();
                for s in 0..20 {
                    let file = d.join("Samples").join(format!("s{s}.wav"));
                    fs::write(&file, b"x").unwrap();
                    let p = file.to_string_lossy().to_string();
                    assert!(p.len() < 0x80, "temp path too long for a one-byte size: {p}");
                    events.push(196u8);
                    events.push(p.len() as u8);
                    events.extend_from_slice(p.as_bytes());
                }
                let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
                flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
                flp.extend_from_slice(&events);
                fs::write(d.join(format!("Song {i}.flp")), &flp).unwrap();
            }
            fs::write(root.join("done"), b"").unwrap();
        }
        let folders = [root.join("Songs").to_string_lossy().to_string()];
        for run in ["first", "second"] {
            let t = std::time::Instant::now();
            let projects = scan(&folders, None);
            println!("bench {n} songs x 20 found samples, {run} scan: {:?}", t.elapsed());
            assert_eq!(projects.len(), n);
            assert!(projects.iter().all(|p| p.samples.len() == 20 && p.samples.iter().all(|s| s.status == SampleStatus::Ok)));
        }
    }

    /// `FLSM_BENCH_LAUNCH=200 cargo test bench_launch -- --nocapture`: N
    /// song folders with a 2 MB project each; the first scan of a launch
    /// with and without the saved read cache. Run it alone (it empties the
    /// in-memory cache).
    #[test]
    fn bench_launch() {
        let Some(n) = std::env::var("FLSM_BENCH_LAUNCH").ok().and_then(|v| v.parse::<usize>().ok()) else { return };
        let root = std::env::temp_dir().join(format!("flsm-bench-launch-{n}"));
        if !root.join("done").exists() {
            let _ = fs::remove_dir_all(&root);
            // Plugin-state-like blobs (an event id the reader skips) padding
            // the project to ~2 MB, plus a few named mixer tracks.
            let mut events = Vec::new();
            for t in 0..1000 {
                let name: Vec<u8> = if t % 50 == 0 { format!("Track {t}").into_bytes() } else { vec![0xAB; 2000] };
                events.push(if t % 50 == 0 { 204u8 } else { 240u8 });
                let mut len = name.len();
                while len >= 0x80 {
                    events.push((len as u8 & 0x7f) | 0x80);
                    len >>= 7;
                }
                events.push(len as u8);
                events.extend_from_slice(&name);
            }
            let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
            flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
            flp.extend_from_slice(&events);
            for i in 0..n {
                let d = root.join("Songs").join(format!("Song {i}"));
                fs::create_dir_all(&d).unwrap();
                fs::write(d.join(format!("Song {i}.flp")), &flp).unwrap();
            }
            fs::write(root.join("done"), b"").unwrap();
        }
        let folders = [root.join("Songs").to_string_lossy().to_string()];
        let file = root.join("read-cache.json");
        daws::clear_read_cache();
        let t = std::time::Instant::now();
        assert_eq!(scan(&folders, None).len(), n);
        println!("bench launch {n} x 2 MB, no saved cache: {:?}", t.elapsed());
        let t = std::time::Instant::now();
        daws::mark_read_cache_dirty();
        daws::save_read_cache(&file).unwrap();
        println!("bench launch save: {:?} ({} KB)", t.elapsed(), fs::metadata(&file).unwrap().len() / 1024);
        daws::clear_read_cache();
        let t = std::time::Instant::now();
        daws::load_read_cache(&file);
        assert_eq!(scan(&folders, None).len(), n);
        println!("bench launch {n} x 2 MB, saved cache loaded: {:?}", t.elapsed());
    }

    #[test]
    fn groups_backups_and_renders() {
        let root = std::env::temp_dir().join(format!("flsm-scan-test-{}", std::process::id()));
        let song = root.join("Envy");
        fs::create_dir_all(song.join("Backup")).unwrap();
        fs::create_dir_all(song.join("Audio")).unwrap();
        fs::write(song.join("Envy.flp"), b"not really an flp").unwrap();
        fs::write(song.join("Envy.wav"), b"x").unwrap();
        fs::write(song.join("Envy (master).mp3"), b"x").unwrap();
        // Another song that happens to start with the same letters.
        fs::write(song.join("Envyous.wav"), b"x").unwrap();
        fs::write(song.join("Other.wav"), b"x").unwrap();
        fs::write(song.join("Backup/Envy (overwritten at 16h12).flp"), b"x").unwrap();
        fs::write(song.join("Backup/Envy (autosaved at 16h43)_2.flp"), b"x").unwrap();
        fs::write(song.join("Audio/Envy_2025-12-15 18-49-59_Voice.wav"), b"abc").unwrap();

        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(projects.len(), 1);
        let p = &projects[0];
        assert_eq!(p.name, "Envy");
        assert_eq!(p.backups.len(), 2);
        assert_eq!(p.renders.len(), 2, "{:?}", p.renders);
        assert!(named_after("Envy_v2", "envy") && named_after("ENVY", "envy") && !named_after("Envyous", "envy"));
        assert_eq!(p.recordings_count, 1);
        assert_eq!(p.recordings_bytes, 3);
        assert!(p.stems.is_none());
    }

    #[test]
    fn scans_projects_from_every_daw() {
        let root = std::env::temp_dir().join(format!("flsm-multidaw-{}", std::process::id()));
        let w = |rel: &str, bytes: &[u8]| {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, bytes).unwrap();
        };
        // Ableton: project folder with a Backup/ copy and recorded takes.
        let mut als = Vec::new();
        {
            use std::io::Write;
            let mut gz = flate2::write::GzEncoder::new(&mut als, flate2::Compression::default());
            gz.write_all(br#"<Ableton Creator="Ableton Live 12.1"><LiveSet><MainTrack><DeviceChain><Mixer><Tempo><Manual Value="128" /></Tempo></Mixer></DeviceChain></MainTrack></LiveSet></Ableton>"#).unwrap();
            gz.finish().unwrap();
        }
        w("Ableton/Wave Project/Wave.als", &als);
        w("Ableton/Wave Project/Backup/Wave [2026-10-12 143005].als", &als);
        w("Ableton/Wave Project/Samples/Recorded/take 1.wav", b"abc");
        w("Ableton/Wave Project/Wave.wav", b"x");
        // REAPER: .rpp + .rpp-bak next to it.
        w("Reaper/Tide/Tide.rpp", b"<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n  TEMPO 90 4 4\n>\n");
        w("Reaper/Tide/Tide.rpp-bak", b"x");
        // Studio One: History/ version and a Mixdown/ export.
        w("Studio One/Glow/Glow.song", b"not a zip");
        w("Studio One/Glow/History/Glow (2).song", b"x");
        w("Studio One/Glow/Mixdown/Glow.wav", b"x");
        // Pro Tools: Session File Backups/, Bounced Files/, Audio Files/.
        w("Pro Tools/Rush/Rush.ptx", b"\x03binary");
        w("Pro Tools/Rush/Session File Backups/Rush.bak.001.ptx", b"x");
        w("Pro Tools/Rush/Bounced Files/Rush mix 2.wav", b"x");
        w("Pro Tools/Rush/Audio Files/Vox_01.wav", b"abcd");
        // Cubase: auto-save .bak and Audio/.
        w("Cubase/Fade/Fade.cpr", b"RIFF....NUND");
        w("Cubase/Fade/Fade-01.bak", b"x");
        w("Cubase/Fade/Audio/Gtr_01.wav", b"ab");
        // Bitwig: bounce/ export and recordings/.
        w("Bitwig/Orbit/Orbit.bwproject", b"BtWg0001");
        w("Bitwig/Orbit/bounce/Orbit.wav", b"x");
        w("Bitwig/Orbit/recordings/rec1.wav", b"x");
        // A REAPER template is flagged as one.
        w("Reaper/ProjectTemplates/Rap session.rpp", b"<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n>\n");

        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let get = |name: &str| projects.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("{name} missing"));

        assert_eq!(projects.len(), 7, "6 DAWs + 1 template, no backups listed as projects: {:?}", projects.iter().map(|p| &p.name).collect::<Vec<_>>());

        let wave = get("Wave");
        assert_eq!((wave.daw, wave.tempo_bpm, wave.daw_version.as_deref()), (Daw::Ableton, Some(128.0), Some("Ableton Live 12.1")));
        assert_eq!((wave.backups.len(), wave.renders.len(), wave.recordings_count), (1, 1, 1));
        assert!(wave.fl_version.is_none());

        let tide = get("Tide");
        assert_eq!((tide.daw, tide.tempo_bpm, tide.backups.len()), (Daw::Reaper, Some(90.0), 1));

        let glow = get("Glow");
        assert_eq!((glow.daw, glow.backups.len(), glow.renders.len()), (Daw::StudioOne, 1, 1));

        let rush = get("Rush");
        assert_eq!((rush.daw, rush.backups.len(), rush.renders.len(), rush.recordings_count), (Daw::ProTools, 1, 1, 1));
        assert!(rush.tempo_bpm.is_none(), "closed format: nothing read from inside");

        let fade = get("Fade");
        assert_eq!((fade.daw, fade.backups.len(), fade.recordings_count), (Daw::Cubase, 1, 1));

        let orbit = get("Orbit");
        assert_eq!((orbit.daw, orbit.renders.len(), orbit.recordings_count), (Daw::Bitwig, 1, 1));

        assert!(get("Rap session").is_template);
    }

    #[test]
    fn split_mixer_exports_are_stems_not_renders() {
        let root = std::env::temp_dir().join(format!("flsm-stems-split-{}", std::process::id()));
        let song = root.join("Envy");
        fs::create_dir_all(&song).unwrap();
        fs::write(song.join("Envy.flp"), b"x").unwrap();
        fs::write(song.join("Envy.wav"), b"x").unwrap();
        fs::write(song.join("Envy_Kick.wav"), b"ab").unwrap();
        fs::write(song.join("Envy_Vox.wav"), b"abc").unwrap();
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let p = &projects[0];
        assert_eq!(p.renders.len(), 1, "only Envy.wav is a mixdown");
        assert!(p.renders[0].path.ends_with("Envy.wav"));
        let stems = p.stems.as_ref().expect("split exports are stems");
        assert_eq!((stems.count, stems.bytes), (2, 5));
    }

    #[test]
    fn a_single_suffixed_file_is_still_a_render() {
        let root = std::env::temp_dir().join(format!("flsm-stems-single-{}", std::process::id()));
        let song = root.join("Envy");
        fs::create_dir_all(&song).unwrap();
        fs::write(song.join("Envy.flp"), b"x").unwrap();
        fs::write(song.join("Envy_master.wav"), b"x").unwrap();
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(projects[0].renders.len(), 1);
        assert!(projects[0].stems.is_none());
    }

    #[test]
    fn a_stems_folder_belongs_to_its_song() {
        let root = std::env::temp_dir().join(format!("flsm-stems-dir-{}", std::process::id()));
        let shared = root.join("Beats");
        fs::create_dir_all(shared.join("Envy Stems")).unwrap();
        fs::write(shared.join("Envy.flp"), b"x").unwrap();
        fs::write(shared.join("Other.flp"), b"x").unwrap();
        fs::write(shared.join("Envy Stems/Drums.wav"), b"abcd").unwrap();
        fs::write(shared.join("Envy Stems/notes.txt"), b"x").unwrap();
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let envy = projects.iter().find(|p| p.name == "Envy").unwrap();
        let other = projects.iter().find(|p| p.name == "Other").unwrap();
        assert_eq!(envy.stems.as_ref().map(|s| (s.count, s.bytes)), Some((1, 4)));
        assert!(other.stems.is_none(), "a stems folder named after another song isn't this one's");
    }

    fn fixture(tag: &str) -> (PathBuf, impl Fn(&str)) {
        let root = std::env::temp_dir().join(format!("flsm-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let r = root.clone();
        (root, move |rel: &str| {
            let p = r.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        })
    }

    fn file_names(entries: &[FileEntry]) -> Vec<String> {
        let mut names: Vec<String> = entries.iter().map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().to_string()).collect();
        names.sort();
        names
    }

    #[test]
    fn versions_in_one_folder_keep_their_own_renders_and_stems() {
        let (root, w) = fixture("versions");
        for f in ["Envy.flp", "Envy v2.flp", "Envy v2 final.flp"] {
            w(&format!("Envy/{f}"));
        }
        for f in ["Envy.wav", "Envy (master).mp3", "Envy v2.wav", "Envy v2 (master).mp3", "Envy v2 final.wav"] {
            w(&format!("Envy/{f}"));
        }
        // Split-mixer exports of v1 and of v2.
        for f in ["Envy_Kick.wav", "Envy_Vox.wav", "Envy v2_Kick.wav", "Envy v2_Vox.wav"] {
            w(&format!("Envy/{f}"));
        }
        // Recorded takes for v2 only.
        w("Envy/Audio/Envy v2_2025-12-15 18-49-59_Voice.wav");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let get = |name: &str| projects.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("{name} missing"));

        assert_eq!(file_names(&get("Envy").renders), vec!["Envy (master).mp3", "Envy.wav"]);
        assert_eq!(file_names(&get("Envy v2").renders), vec!["Envy v2 (master).mp3", "Envy v2.wav"]);
        assert_eq!(file_names(&get("Envy v2 final").renders), vec!["Envy v2 final.wav"]);
        assert_eq!(get("Envy").stems.as_ref().map(|s| s.count), Some(2));
        assert_eq!(get("Envy v2").stems.as_ref().map(|s| s.count), Some(2));
        assert!(get("Envy v2 final").stems.is_none());
        assert_eq!((get("Envy").recordings_count, get("Envy v2").recordings_count), (0, 1));
    }

    #[test]
    fn only_whole_template_folders_hold_templates() {
        let (root, w) = fixture("templates");
        w("Love Template/Love Template.flp");
        w("Beat Templates 2025/Bounce/Bounce.flp");
        w("Templates/Basic.flp");
        w("FL/project templates/Rap.flp");
        w("Reaper/ProjectTemplates/Session.rpp");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let template = |name: &str| projects.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("{name} missing")).is_template;
        assert!(!template("Love Template"));
        assert!(!template("Bounce"));
        assert!(template("Basic") && template("Rap") && template("Session"));
    }

    #[test]
    fn same_name_songs_in_two_folders_dont_share_export_renders() {
        let (root, w) = fixture("same-name");
        w("Projects/Kairo/Envy/Envy.flp");
        w("Projects/Nova/Envy/Envy.flp");
        w("Projects/Nova/Solo/Solo.flp");
        // Each one's own mixdown, next to it.
        w("Projects/Nova/Envy/Envy.wav");
        // The export folder can't say which Envy this came from.
        w("Exports/Envy.wav");
        w("Exports/02 - Solo.wav");
        let exports = root.join("Exports").to_string_lossy().to_string();
        let projects = scan(&[root.join("Projects").to_string_lossy().to_string()], Some(&exports));
        let _ = fs::remove_dir_all(&root);
        let envies: Vec<&ProjectInfo> = projects.iter().filter(|p| p.name == "Envy").collect();
        assert_eq!(envies.len(), 2);
        for envy in &envies {
            assert!(envy.renders.iter().all(|r| !r.path.contains("Exports")), "{:?}", envy.renders);
            assert_eq!(envy.ambiguous_exports, 1);
        }
        let nova = envies.iter().find(|p| p.folder.contains("Nova")).unwrap();
        assert_eq!(nova.renders.len(), 1, "its own render still counts");
        let solo = projects.iter().find(|p| p.name == "Solo").unwrap();
        assert_eq!((solo.renders.len(), solo.ambiguous_exports), (1, 0));
    }

    #[test]
    fn stems_folders_match_whole_words() {
        let (root, w) = fixture("stems-words");
        w("Beats/A.flp");
        w("Beats/Envy.flp");
        w("Beats/Envy Stems/Drums.wav");
        w("Beats/Systems/Loop.wav");
        w("Solo/Solo.flp");
        w("Solo/Ecosystem/Pad.wav");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let get = |name: &str| projects.iter().find(|p| p.name == name).unwrap();
        assert!(get("A").stems.is_none(), "a one-letter name doesn't match inside another folder name");
        assert_eq!(get("Envy").stems.as_ref().map(|s| s.count), Some(1));
        assert!(get("Solo").stems.is_none(), "\"Ecosystem\" isn't a stems folder");
        assert!(is_stems_dir("Stems") && is_stems_dir("envy stems") && is_stems_dir("STEM - Envy"));
        assert!(!is_stems_dir("Systems") && !is_stems_dir("Ecosystem"));
    }

    #[test]
    fn an_unreachable_root_is_reported_not_scanned() {
        let (root, w) = fixture("unreachable");
        w("Here/Envy/Envy.flp");
        let here = root.join("Here").to_string_lossy().to_string();
        let gone = root.join("Unplugged drive").to_string_lossy().to_string();
        let linked = vec![here.clone(), gone.clone()];
        let projects = scan(&linked, None);
        let unreachable = unreachable_roots(&linked);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(projects.len(), 1);
        assert_eq!(unreachable, vec![gone]);
        assert!(unreachable_roots(&[r"\\server\share".to_string()]).len() == 1, "a network path is never touched, so never reachable");
    }

    #[test]
    fn backups_are_counted_once_with_overlapping_roots() {
        let root = std::env::temp_dir().join(format!("flsm-overlap-{}", std::process::id()));
        let tide = root.join("Reaper").join("Tide");
        fs::create_dir_all(tide.join("__MACOSX")).unwrap();
        fs::write(tide.join("Tide.rpp"), b"<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n>\n").unwrap();
        fs::write(tide.join("Tide.rpp-bak"), b"x").unwrap();
        fs::write(tide.join("._Tide.rpp-bak"), b"x").unwrap();
        fs::write(tide.join("__MACOSX").join("Tide.rpp-bak"), b"x").unwrap();
        let outer = root.to_string_lossy().to_string();
        let inner = root.join("Reaper").to_string_lossy().to_string();
        let projects = scan(&[outer, inner], None);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].backups.len(), 1, "{:?}", projects[0].backups);
    }

    #[test]
    fn backups_attach_only_to_their_own_project() {
        let root = std::env::temp_dir().join(format!("flsm-owner-{}", std::process::id()));
        let w = |rel: &str| {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        };
        // P has no project of its own; its parent has one unrelated song.
        w("Beats/Unrelated.flp");
        w("Beats/P/Backup/Old idea (overwritten at 16h12).flp");
        // Renamed since: the only project in the folder holding Backup/ still gets it.
        w("Beats/Envy/Envy v2.flp");
        w("Beats/Envy/Backup/Envy (overwritten at 10h00).flp");
        // Cubase: a stray notes.bak isn't a backup of the project above it.
        w("Cubase/Fade/Fade.cpr");
        w("Cubase/Fade/Fade-01.bak");
        w("Cubase/Fade/Docs/notes.bak");
        w("Cubase/Fade/Auto Saves/Fade-02.bak");
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let get = |name: &str| projects.iter().find(|p| p.name == name).unwrap();
        assert!(get("Unrelated").backups.is_empty());
        assert_eq!(get("Envy v2").backups.len(), 1);
        let fade: Vec<_> = get("Fade").backups.iter().map(|b| Path::new(&b.path).file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(fade.len(), 2, "{fade:?}");
        assert!(!fade.iter().any(|f| f == "notes.bak"));
    }

    #[test]
    fn skips_ableton_library_folders() {
        let root = std::env::temp_dir().join(format!("flsm-library-{}", std::process::id()));
        for rel in ["User Library/Templates/Default.als", "Factory Packs/Drum Booth/Demo.als", "Songs/Wave Project/Wave.als"] {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"not gzip").unwrap();
        }
        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Wave"]);
    }

    #[test]
    fn damaged_or_hostile_projects_are_reported_and_the_scan_completes() {
        let root = std::env::temp_dir().join(format!("flsm-hostile-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A gzipped .als nested far past the depth cap (a few KB on disk).
        let mut als = Vec::new();
        {
            use std::io::Write;
            let mut gz = flate2::write::GzEncoder::new(&mut als, flate2::Compression::best());
            gz.write_all("<a>".repeat(200_000).as_bytes()).unwrap();
            gz.finish().unwrap();
        }
        fs::write(root.join("Deep.als"), &als).unwrap();
        // An .flp whose header claims 4 GB of data.
        let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
        flp.extend_from_slice(&u32::MAX.to_le_bytes());
        fs::write(root.join("Liar.flp"), &flp).unwrap();
        // An .rpp just over the 64 MB text cap (sparse, so it's quick to make).
        let big = fs::File::create(root.join("Huge.rpp")).unwrap();
        big.set_len(64 * 1024 * 1024 + 1).unwrap();
        drop(big);
        // And a normal project next to them.
        fs::write(root.join("Fine.rpp"), b"<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n  TEMPO 92 4 4\n>\n").unwrap();

        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        let get = |name: &str| projects.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("{name} missing"));

        assert_eq!(projects.len(), 4);
        assert_eq!(get("Fine").tempo_bpm, Some(92.0));
        assert!(get("Fine").read_error.is_none());
        for (name, why) in [("Deep", "nested"), ("Liar", "data size"), ("Huge", "MB")] {
            let p = get(name);
            let err = p.read_error.as_deref().unwrap_or_else(|| panic!("{name}: no error"));
            assert!(err.contains(why), "{name}: {err}");
            assert!(p.tempo_bpm.is_none() && p.samples.is_empty());
        }
    }

    #[test]
    fn a_project_full_of_network_paths_scans_without_touching_them() {
        let root = std::env::temp_dir().join(format!("flsm-unc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // .flp: sample path events (id 196) pointing at network shares.
        let mut events = Vec::new();
        for p in [r"\\attacker\share\kick.wav", "//attacker/share/snare.wav", r"\??\UNC\attacker\share\hat.wav"] {
            events.push(196u8);
            events.push(p.len() as u8);
            events.extend_from_slice(p.as_bytes());
        }
        let mut flp = b"FLhd\x06\0\0\0\0\0\x04\0\x60\0FLdt".to_vec();
        flp.extend_from_slice(&(events.len() as u32).to_le_bytes());
        flp.extend_from_slice(&events);
        fs::write(root.join("Bait.flp"), &flp).unwrap();
        // .als: a sample FileRef with a network path.
        let als_xml = r#"<Ableton><LiveSet><Tracks><AudioTrack><SampleRef><FileRef><RelativePath Value="\\attacker\share\loop.wav" /><Path Value="//attacker/share/loop.wav" /></FileRef></SampleRef></AudioTrack></Tracks></LiveSet></Ableton>"#;
        let mut als = Vec::new();
        {
            use std::io::Write;
            let mut gz = flate2::write::GzEncoder::new(&mut als, flate2::Compression::default());
            gz.write_all(als_xml.as_bytes()).unwrap();
            gz.finish().unwrap();
        }
        fs::write(root.join("Bait Set.als"), &als).unwrap();

        let projects = scan(&[root.to_string_lossy().to_string()], None);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(projects.len(), 2);
        for p in &projects {
            assert!(p.read_error.is_none(), "{}: {:?}", p.name, p.read_error);
            assert!(!p.samples.is_empty(), "{}", p.name);
            assert!(p.samples.iter().all(|s| s.status == SampleStatus::Missing), "{}: {:?}", p.name, p.samples);
        }
    }
}
