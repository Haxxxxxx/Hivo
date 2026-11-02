//! Projects from every DAW the crew uses, not just FL Studio.
//!
//! Each DAW is recognized by its project file extension. What can be read
//! from inside the file differs a lot:
//! - FL Studio (.flp): flp_metadata.rs (binary events).
//! - REAPER (.rpp): plain text, everything readable (tempo, plugins, samples, tracks).
//! - Ableton Live (.als): gzipped XML, everything readable.
//! - Studio One (.song): a zip of XML files; tempo, title and version from
//!   metainfo.xml, samples from the media pool, plugins and tracks best-effort.
//! - Pro Tools (.ptx/.ptf), Cubase (.cpr/.npr), Bitwig (.bwproject): closed
//!   binary formats. They're still tracked (stages, files, backups, mixdowns,
//!   crew sharing); nothing is read from inside them.
//!
//! Every reader returns the same `FlpMetadata` shape the FL reader does, so
//! the rest of the app (plugin/sample resolution, Launch Kit) is DAW-agnostic.

use crate::flp_metadata::{FlpMetadata, Lists, RawPlugin};
use crate::paths::is_remote_or_device;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

/// Upper bound on bytes read from one .rpp, one unpacked .als or one zip
/// entry. Real projects are a few MB; past this the file is refused and
/// reported, so a malformed or hostile file can't exhaust memory.
const MAX_TEXT: u64 = 64 * 1024 * 1024;
/// Deepest XML nesting read from an .als (real sets stay under ~40).
const MAX_ALS_DEPTH: usize = 256;
/// Studio One keeps one XML per device; read at most this many, this big.
const MAX_DEVICE_FILES: usize = 64;
const MAX_DEVICE_BYTES: u64 = 16 * 1024 * 1024;

/// Folders that belong to a DAW's install or library, never to songs.
pub const LIBRARY_DIRS: &[&str] = &["factory packs", "user library", "core library"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Daw {
    FlStudio,
    Ableton,
    Reaper,
    StudioOne,
    ProTools,
    Cubase,
    Bitwig,
    /// A BandLab export (mp3/wav) in `<song>/BandLab/` with no project yet: a
    /// sketch. Found by folder in the scanner (`sketch_of`), never by file
    /// extension, so `of_project` never returns it.
    Bandlab,
}

impl Daw {
    /// The DAW whose project file this is, by extension.
    pub fn of_project(path: &Path) -> Option<Daw> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        Some(match ext.as_str() {
            "flp" => Daw::FlStudio,
            "als" => Daw::Ableton,
            "rpp" => Daw::Reaper,
            "song" => Daw::StudioOne,
            "ptx" | "ptf" => Daw::ProTools,
            "cpr" | "npr" => Daw::Cubase,
            "bwproject" => Daw::Bitwig,
            _ => return None,
        })
    }

    /// Backup-only file types (never projects themselves). These extensions
    /// are generic (`.bak`), so the scanner only attaches them to a project
    /// whose name matches.
    pub fn of_backup_file(path: &Path) -> Option<Daw> {
        let name = path.file_name()?.to_str()?.to_ascii_lowercase();
        if name.ends_with(".rpp-bak") {
            Some(Daw::Reaper)
        } else if name.ends_with(".bak") && !name.ends_with(".song.bak") {
            // Cubase's previous-save / auto-save files: `<Project>.bak`, `<Project>-01.bak`.
            Some(Daw::Cubase)
        } else if name.ends_with(".song.bak") || name.ends_with(".autosave") {
            Some(Daw::StudioOne)
        } else {
            None
        }
    }

    /// Folders that hold this DAW's backups or saved versions.
    fn backup_dirs(self) -> &'static [&'static str] {
        match self {
            Daw::FlStudio | Daw::Ableton => &["backup"],
            Daw::StudioOne => &["history"],
            Daw::ProTools => &["session file backups"],
            Daw::Cubase => &["auto saves"],
            Daw::Bitwig => &["backups", "auto-backups", "autobackups"],
            Daw::Reaper => &["backups"],
            Daw::Bandlab => &[],
        }
    }

    /// Where finished mixdowns usually land, besides next to the project.
    pub fn render_dirs(self) -> &'static [&'static str] {
        match self {
            Daw::StudioOne => &["Mixdown", "Bounces"],
            Daw::ProTools => &["Bounced Files"],
            Daw::Cubase => &["Mixdown"],
            Daw::Bitwig => &["bounce"],
            _ => &[],
        }
    }

    /// Recorded takes (FL is handled separately: `Audio/<project>_<date>_<track>`).
    pub fn recording_dirs(self) -> &'static [&'static str] {
        match self {
            Daw::Ableton => &["Samples/Recorded"],
            Daw::Reaper => &["Audio", "Media"],
            Daw::StudioOne => &["Media"],
            Daw::ProTools => &["Audio Files"],
            Daw::Cubase => &["Audio"],
            Daw::Bitwig => &["recordings"],
            Daw::FlStudio | Daw::Bandlab => &[],
        }
    }
}

/// Lowercased components of `path` below `root` (directories only).
fn dirs_below(path: &Path, root: &Path) -> Vec<String> {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut comps: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    comps.pop(); // the file itself
    comps
}

/// A project-extension file that's really a backup or an older saved version.
pub fn is_backup_project(path: &Path, root: &Path, daw: Daw) -> bool {
    let dirs = dirs_below(path, root);
    dirs.iter().any(|d| daw.is_backup_dir(d)) || has_backup_stem(path, daw)
}

/// Whether the scanner could list this file as a project's backup, without
/// knowing the linked root: a backup-only file type, or a project file with
/// a backup name or a backup folder in the two folders above it (as far up
/// as backups get attached).
pub fn is_backup_file(path: &Path) -> bool {
    if Daw::of_backup_file(path).is_some() {
        return true;
    }
    let Some(daw) = Daw::of_project(path) else { return false };
    let in_backup_dir = path
        .ancestors()
        .skip(1)
        .take(2)
        .filter_map(|d| d.file_name())
        .any(|n| daw.is_backup_dir(&n.to_string_lossy().to_lowercase()));
    in_backup_dir || has_backup_stem(path, daw)
}

/// The folder whose project a backup most likely belongs to: the one
/// holding its backup folder (`Song/Backup/x.als` → `Song`), else the
/// backup's own folder (`.rpp-bak` next to the project).
pub fn backup_home_dir(path: &Path, daw: Daw) -> Option<&Path> {
    let parent = path.parent()?;
    parent
        .ancestors()
        .take(2)
        .find(|d| d.file_name().is_some_and(|n| daw.is_backup_dir(&n.to_string_lossy().to_lowercase())))
        .and_then(Path::parent)
        .or(Some(parent))
}

impl Daw {
    fn is_backup_dir(self, lower_name: &str) -> bool {
        self.backup_dirs().contains(&lower_name)
    }
}

fn has_backup_stem(path: &Path, daw: Daw) -> bool {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    match daw {
        // `<Session>.bak.001.ptx`
        Daw::ProTools => is_pro_tools_backup_stem(&stem),
        _ => false,
    }
}

fn is_pro_tools_backup_stem(stem: &str) -> bool {
    match stem.rsplit_once(".bak.") {
        Some((_, n)) => !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// The project a backup file belongs to, by name (`base` matched
/// case-insensitively against project names).
pub fn backup_base_name(daw: Daw, file_name: &str) -> String {
    // ASCII lowercasing keeps byte offsets valid for `file_name`.
    let lower = file_name.to_ascii_lowercase();
    // Drop the extension(s).
    let mut base = file_name.to_string();
    for ext in [".rpp-bak", ".song.bak", ".autosave", ".bak", ".flp", ".als", ".song", ".ptx", ".ptf", ".cpr", ".npr", ".bwproject"] {
        if lower.ends_with(ext) {
            base.truncate(base.len() - ext.len());
            break;
        }
    }
    let base = base.trim().to_string();
    match daw {
        Daw::FlStudio => crate::scanner::backup_base_name(&base).to_string(),
        // `Night Run [2026-10-12 143005]`
        Daw::Ableton => match base.rfind(" [") {
            Some(i) if base.ends_with(']') => base[..i].to_string(),
            _ => base,
        },
        // `Night Run-2026-10-12_143005` (timestamped backups)
        Daw::Reaper => strip_timestamp_suffix(&base),
        // `Night Run.bak.001`
        Daw::ProTools => match base.to_ascii_lowercase().rfind(".bak.") {
            Some(i) => base[..i].to_string(),
            None => base,
        },
        // `Night Run-01` (auto-save)
        Daw::Cubase => match base.rsplit_once('-') {
            Some((b, n)) if n.len() >= 2 && n.chars().all(|c| c.is_ascii_digit()) => b.to_string(),
            _ => base,
        },
        // `Night Run (2)` (History/ versions, numbered backups)
        Daw::StudioOne | Daw::Bitwig => strip_copy_number(&base),
        Daw::Bandlab => base,
    }
}

fn strip_copy_number(base: &str) -> String {
    if let Some((name, n)) = base.strip_suffix(')').and_then(|h| h.rsplit_once(" (")) {
        if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) && !name.trim().is_empty() {
            return name.trim_end().to_string();
        }
    }
    base.to_string()
}

fn strip_timestamp_suffix(base: &str) -> String {
    // `<name>[-_ ]YYYY-MM-DD[_ -]HHMM(SS)`. Offsets go through `get` so a
    // non-ASCII name can't land a slice inside a character.
    let is_date = |d: &[u8]| d.len() == 10 && d.iter().enumerate().all(|(k, &c)| if k == 4 || k == 7 { c == b'-' } else { c.is_ascii_digit() });
    for sep in ['-', '_', ' '] {
        let Some(i) = base.rfind(sep) else { continue };
        let Some(tail) = base.get(i + 1..) else { continue };
        if tail.len() < 4 || !tail.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Some(date_start) = i.checked_sub(10).filter(|&d| d >= 1) else { continue };
        let Some(date) = base.as_bytes().get(date_start..i) else { continue };
        if is_date(date) {
            if let Some(name) = base.get(..date_start - 1) {
                return name.trim_end().to_string();
            }
        }
    }
    base.to_string()
}

/// (size, mtime in nanoseconds since 1970) a cached read was made at.
pub type Stamp = (u64, Option<u64>);

/// The stamp of a file's metadata, as it's compared and saved.
pub fn stamp_of(meta: &fs::Metadata) -> Stamp {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    (meta.len(), mtime)
}

type ReadCache = HashMap<PathBuf, (Stamp, Result<FlpMetadata, String>)>;

/// Rescans run on every window focus; an unchanged file is read (or
/// refused) once. Saved to the config dir after a scan (`save_read_cache`)
/// and loaded before the first one, so a launch doesn't re-read every project.
static READ_CACHE: Mutex<Option<ReadCache>> = Mutex::new(None);
/// Whether the cache changed since it was loaded or saved.
static READ_CACHE_DIRTY: AtomicBool = AtomicBool::new(false);

/// Why a project couldn't be read.
enum ReadError {
    /// The file couldn't be opened or read (cloud placeholder, locked file):
    /// not cached, so the next scan tries again.
    Io(String),
    /// What's inside is refused (too big, too deep, too many entries):
    /// cached until the file changes.
    Refused(String),
}

fn io(e: impl std::fmt::Display) -> ReadError {
    ReadError::Io(e.to_string())
}

/// Whether the DAW's files can be read at all (closed formats can't).
fn readable(daw: Daw) -> bool {
    matches!(daw, Daw::FlStudio | Daw::Reaper | Daw::Ableton | Daw::StudioOne)
}

/// A file whose contents are in the cloud, not on this disk (iCloud Drive
/// "optimise storage", OneDrive / Dropbox files on demand): opening it would
/// download it, so the scan doesn't. macOS: the `SF_DATALESS` flag. Windows:
/// `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, `_RECALL_ON_OPEN` or `_OFFLINE`.
pub fn is_cloud_placeholder(meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        meta.st_flags() & SF_DATALESS != 0
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const OFFLINE: u32 = 0x1000;
        const RECALL_ON_OPEN: u32 = 0x4_0000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
        meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = meta;
        false
    }
}

/// What reading a project gave (returned, never stored, so the size gap
/// between the variants doesn't matter).
#[allow(clippy::large_enum_variant)]
pub enum ProjectRead {
    Read(Result<FlpMetadata, String>),
    /// A cloud placeholder that wasn't read before: not opened.
    InCloud,
}

/// What can be read from inside a project (FL Studio included). Closed
/// formats yield empty metadata; a file that can't be read is an error the
/// scan reports. A cloud placeholder is only read from the cache.
pub fn read_project(daw: Daw, path: &Path) -> Result<FlpMetadata, String> {
    let meta = fs::metadata(path).ok();
    let placeholder = meta.as_ref().is_some_and(is_cloud_placeholder);
    match read_project_at(daw, path, meta.as_ref().map(stamp_of), placeholder) {
        ProjectRead::Read(read) => read,
        ProjectRead::InCloud => Err("the project is in the cloud, not downloaded to this computer".to_string()),
    }
}

/// `read_project` with the file's stamp and placeholder state already known
/// (the scan has them from its walk).
pub fn read_project_at(daw: Daw, path: &Path, stamp: Option<Stamp>, placeholder: bool) -> ProjectRead {
    if !readable(daw) {
        return ProjectRead::Read(Ok(FlpMetadata::default()));
    }
    if let Some(stamp) = stamp {
        let cache = READ_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((s, read)) = cache.as_ref().and_then(|c| c.get(path)) {
            if *s == stamp {
                return ProjectRead::Read(read.clone());
            }
        }
    }
    if placeholder {
        return ProjectRead::InCloud;
    }
    let read = match read_uncached(daw, path) {
        Ok(meta) => Ok(meta),
        Err(ReadError::Refused(e)) => Err(e),
        Err(ReadError::Io(e)) => return ProjectRead::Read(Err(e)),
    };
    if let Some(stamp) = stamp {
        let mut cache = READ_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.get_or_insert_with(HashMap::new).insert(path.to_path_buf(), (stamp, read.clone()));
        READ_CACHE_DIRTY.store(true, Ordering::Relaxed);
    }
    ProjectRead::Read(read)
}

/// Drop cached reads for projects the last scan didn't see (deleted or moved).
pub fn prune_read_cache(keep: &std::collections::HashSet<PathBuf>) {
    let mut cache = READ_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = cache.as_mut() {
        let before = c.len();
        c.retain(|p, _| keep.contains(p));
        if c.len() != before {
            READ_CACHE_DIRTY.store(true, Ordering::Relaxed);
        }
    }
}

/// The saved cache's format: bump it when `FlpMetadata` or a reader changes
/// what it returns, so an old file is ignored instead of misread.
const READ_CACHE_VERSION: u32 = 1;
/// A saved cache bigger than this is ignored (thousands of projects with
/// hundreds of samples each stay well under it).
const READ_CACHE_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct SavedRead {
    path: PathBuf,
    size: u64,
    mtime: Option<u64>,
    read: Result<FlpMetadata, String>,
}

#[derive(Serialize, Deserialize)]
struct SavedCache {
    version: u32,
    reads: Vec<SavedRead>,
}

/// Loads the saved cache (the scan does it once, before the first scan of a
/// launch); reads already in memory win. A missing, damaged or outdated file
/// just means reading the projects again.
pub fn load_read_cache(file: &Path) {
    let small = fs::metadata(file).is_ok_and(|m| m.len() <= READ_CACHE_MAX_BYTES);
    let saved = small.then(|| fs::read(file).ok()).flatten().and_then(|b| serde_json::from_slice::<SavedCache>(&b).ok());
    let mut cache = READ_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = cache.get_or_insert_with(ReadCache::new);
    for r in saved.filter(|s| s.version == READ_CACHE_VERSION).map(|s| s.reads).unwrap_or_default() {
        // An edited file can't hand the scan more than a reader would.
        let within = r.read.as_ref().map_or(true, |m| {
            m.samples.len() <= crate::flp_metadata::MAX_SAMPLES
                && m.plugins.len() <= crate::flp_metadata::MAX_PLUGINS
                && m.mixer_names.len() <= crate::flp_metadata::MAX_TRACK_NAMES
        });
        if within {
            map.entry(r.path).or_insert(((r.size, r.mtime), r.read));
        }
    }
}

/// Saves the cache when it changed since it was loaded or last saved
/// (owner-only and atomic, see `cover::write_private`).
pub fn save_read_cache(file: &Path) -> Result<(), String> {
    if !READ_CACHE_DIRTY.swap(false, Ordering::Relaxed) {
        return Ok(());
    }
    let bytes = {
        let cache = READ_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let reads: Vec<SavedRead> = cache
            .iter()
            .flatten()
            .map(|(path, ((size, mtime), read))| SavedRead { path: path.clone(), size: *size, mtime: *mtime, read: read.clone() })
            .collect();
        serde_json::to_vec(&SavedCache { version: READ_CACHE_VERSION, reads }).map_err(|e| e.to_string())?
    };
    // Too big to be loaded again: not worth writing (or keeping).
    if bytes.len() as u64 > READ_CACHE_MAX_BYTES {
        let _ = fs::remove_file(file);
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    crate::cover::write_private(file, &bytes).map_err(|e| {
        READ_CACHE_DIRTY.store(true, Ordering::Relaxed);
        format!("could not save the project read cache: {e}")
    })
}

/// Empties the in-memory cache (a launch, for the gated launch benchmark).
#[cfg(test)]
pub(crate) fn clear_read_cache() {
    *READ_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
pub(crate) fn mark_read_cache_dirty() {
    READ_CACHE_DIRTY.store(true, Ordering::Relaxed);
}

/// Forgets one cached read (tests that load a saved cache).
#[cfg(test)]
pub(crate) fn forget_read(path: &Path) {
    if let Some(c) = READ_CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        c.remove(path);
    }
}

fn read_uncached(daw: Daw, path: &Path) -> Result<FlpMetadata, ReadError> {
    match daw {
        Daw::Reaper => {
            let text = read_capped(File::open(path).map_err(io)?, MAX_TEXT)?;
            parse_rpp(&text, project_dir(path)).map_err(ReadError::Refused)
        }
        Daw::Ableton => {
            let mut xml = flate2::read::GzDecoder::new(File::open(path).map_err(io)?).take(MAX_TEXT + 1);
            let meta = parse_als_reader(BufReader::new(&mut xml), project_dir(path)).map_err(ReadError::Refused)?;
            if xml.limit() == 0 {
                return Err(too_big());
            }
            Ok(meta)
        }
        Daw::StudioOne => read_song(path),
        Daw::FlStudio => crate::flp_metadata::parse_flp_file(File::open(path).map_err(io)?).map_err(ReadError::Refused),
        _ => Ok(FlpMetadata::default()),
    }
}

fn too_big() -> ReadError {
    ReadError::Refused(format!("it's over {} MB of text, so it wasn't read (damaged or not a real project)", MAX_TEXT / (1024 * 1024)))
}

/// At most `max` bytes as text; more is refused. Valid UTF-8 isn't copied.
fn read_capped(r: impl Read, max: u64) -> Result<String, ReadError> {
    let mut bytes = Vec::new();
    r.take(max + 1).read_to_end(&mut bytes).map_err(io)?;
    if bytes.len() as u64 > max {
        return Err(too_big());
    }
    Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

fn project_dir(path: &Path) -> &Path {
    path.parent().unwrap_or(path)
}

/// Relative sample paths are relative to the project folder.
fn absolutize(raw: &str, dir: &Path) -> String {
    let p = Path::new(raw);
    let looks_absolute = p.is_absolute() || raw.starts_with('/') || raw.starts_with('\\') || raw.get(1..3) == Some(":\\") || raw.get(1..3) == Some(":/");
    if looks_absolute {
        raw.to_string()
    } else {
        dir.join(raw).to_string_lossy().to_string()
    }
}

// ------------------------------------------------------------------ REAPER

/// Tokens on an .rpp line: quoted with " ' or `, else split on whitespace.
fn rpp_tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.trim().chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '"' || c == '\'' || c == '`' {
            chars.next();
            let tok: String = chars.by_ref().take_while(|&x| x != c).collect();
            out.push(tok);
        } else {
            let tok: String = std::iter::from_fn(|| chars.next_if(|x| !x.is_whitespace())).collect();
            out.push(tok);
        }
    }
    out
}

/// "VST3i: Serum (Xfer Records)" → name "Serum", vendor "Xfer Records".
fn rpp_plugin(desc: &str) -> Option<RawPlugin> {
    let rest = match desc.split_once(':') {
        Some((fmt, rest)) if fmt.len() <= 6 && fmt.chars().all(|c| c.is_ascii_alphanumeric()) => rest.trim(),
        _ => desc.trim(),
    };
    if rest.is_empty() {
        return None;
    }
    let (name, vendor) = match (rest.rfind(" ("), rest.ends_with(')')) {
        (Some(i), true) => (rest[..i].trim().to_string(), Some(rest[i + 2..rest.len() - 1].trim().to_string())),
        _ => (rest.to_string(), None),
    };
    Some(RawPlugin { name, vendor, path: None })
}

pub fn parse_rpp(text: &str, dir: &Path) -> Result<FlpMetadata, String> {
    let mut meta = FlpMetadata::default();
    let mut lists = Lists::default();
    let mut stack: Vec<String> = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line == ">" {
            stack.pop();
            continue;
        }
        if let Some(rest) = line.strip_prefix('<') {
            let toks = rpp_tokens(rest);
            let tag = toks.first().cloned().unwrap_or_default();
            if i == 0 && tag == "REAPER_PROJECT" {
                if let Some(v) = toks.get(2) {
                    meta.fl_version = Some(format!("REAPER {}", v.split('/').next().unwrap_or(v)));
                }
            }
            if matches!(tag.as_str(), "VST" | "AU" | "CLAP" | "DX" | "LV2") {
                if let Some(p) = toks.get(1).and_then(|d| rpp_plugin(d)) {
                    lists.plugin(&mut meta, p)?;
                }
            }
            stack.push(tag);
            continue;
        }
        let toks = rpp_tokens(line);
        let Some(key) = toks.first() else { continue };
        let in_chunk = stack.last().map(String::as_str);
        match key.as_str() {
            "TEMPO" if meta.tempo_bpm.is_none() && stack.len() == 1 => {
                meta.tempo_bpm = toks.get(1).and_then(|v| v.parse().ok());
                meta.time_sig_num = toks.get(2).and_then(|v| v.parse().ok());
                meta.time_sig_denom = toks.get(3).and_then(|v| v.parse().ok());
            }
            "NAME" if in_chunk == Some("TRACK") => {
                if let Some(n) = toks.get(1) {
                    lists.track(&mut meta, n.clone())?;
                }
            }
            "FILE" if in_chunk == Some("SOURCE") => {
                if let Some(f) = toks.get(1) {
                    lists.sample(&mut meta, absolutize(f, dir))?;
                }
            }
            _ => {}
        }
    }
    Ok(meta)
}

// ------------------------------------------------------------------ Ableton

fn attr_value(e: &quick_xml::events::BytesStart, key: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| a.normalized_value(quick_xml::XmlVersion::default()).ok().map(|v| v.to_string()))
}

/// State while walking an .als: the FileRef / AU plugin being read.
#[derive(Default)]
struct AlsState {
    file_abs: String,
    file_rel: String,
    rel_dirs: Vec<String>,
    file_name: String,
    au_name: Option<String>,
    au_vendor: Option<String>,
    /// The current FileRef is audio (inside a SampleRef), not a device
    /// preset or Max device.
    file_is_sample: bool,
}

fn als_element(
    name: &str,
    e: &quick_xml::events::BytesStart,
    stack: &[String],
    in_master: bool,
    meta: &mut FlpMetadata,
    lists: &mut Lists,
    st: &mut AlsState,
) -> Result<(), String> {
    let parent = stack.last().map(String::as_str).unwrap_or("");
    let grand = stack.len().checked_sub(2).and_then(|i| stack.get(i)).map(String::as_str).unwrap_or("");
    let value = || attr_value(e, "Value").unwrap_or_default();
    match (name, parent) {
        ("Ableton", _) => meta.fl_version = attr_value(e, "Creator"),
        ("Manual", "Tempo") if in_master && meta.tempo_bpm.is_none() => meta.tempo_bpm = value().parse().ok(),
        ("Manual", "TimeSignature") if in_master && meta.time_sig_num.is_none() => {
            // (numerator - 1) + 99 * log2(denominator)
            if let Ok(v) = value().parse::<u32>() {
                meta.time_sig_num = Some((v % 99 + 1) as u8);
                meta.time_sig_denom = Some(1u8 << (v / 99).min(7));
            }
        }
        ("EffectiveName", "Name") if matches!(grand, "MidiTrack" | "AudioTrack" | "GroupTrack" | "ReturnTrack") => {
            lists.track(meta, value())?;
        }
        ("PlugName", "VstPluginInfo") | ("Name", "Vst3PluginInfo") => {
            lists.plugin(meta, RawPlugin { name: value(), vendor: None, path: None })?;
        }
        ("Name", "AuPluginInfo") => st.au_name = Some(value()),
        ("Manufacturer", "AuPluginInfo") => st.au_vendor = Some(value()),
        ("Path", "FileRef") => st.file_abs = value(),
        ("RelativePath", "FileRef") => st.file_rel = value(),
        ("RelativePathElement", "RelativePath") => {
            if let Some(d) = attr_value(e, "Dir") {
                st.rel_dirs.push(d);
            }
        }
        ("Name", "FileRef") => st.file_name = value(),
        ("FileRef", _) => st.file_is_sample = parent == "SampleRef",
        _ => {}
    }
    Ok(())
}

fn is_master(name: &str) -> bool {
    name == "MasterTrack" || name == "MainTrack"
}

#[cfg(test)]
pub fn parse_als(xml: &str, dir: &Path) -> Result<FlpMetadata, String> {
    parse_als_reader(xml.as_bytes(), dir)
}

/// Streams the set's XML, so a big .als never sits in memory as one string.
pub fn parse_als_reader<R: BufRead>(input: R, dir: &Path) -> Result<FlpMetadata, String> {
    use quick_xml::events::Event;
    let mut meta = FlpMetadata::default();
    let mut lists = Lists::default();
    let mut reader = quick_xml::Reader::from_reader(input);
    let mut stack: Vec<String> = Vec::new();
    // Open MasterTrack/MainTrack elements (a counter, not a stack scan per element).
    let mut masters = 0usize;
    let mut st = AlsState::default();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                if stack.len() >= MAX_ALS_DEPTH {
                    return Err(format!("its XML is nested more than {MAX_ALS_DEPTH} levels deep, so it wasn't read (damaged or not a real set)"));
                }
                let name = e.name().as_ref().to_string();
                als_element(&name, &e, &stack, masters > 0, &mut meta, &mut lists, &mut st)?;
                masters += usize::from(is_master(&name));
                stack.push(name);
            }
            Ok(Event::Empty(e)) => {
                let name = e.name().as_ref().to_string();
                als_element(&name, &e, &stack, masters > 0, &mut meta, &mut lists, &mut st)?;
            }
            Ok(Event::End(e)) => {
                let name = e.name().as_ref().to_string();
                if stack.pop().is_some_and(|n| is_master(&n)) {
                    masters -= 1;
                }
                if name == "FileRef" {
                    // Live 11+: RelativePath/@Value; Live 9-10: RelativePathElement dirs + Name.
                    let rel = if !st.file_rel.is_empty() {
                        st.file_rel.clone()
                    } else if !st.rel_dirs.is_empty() && !st.file_name.is_empty() {
                        format!("{}/{}", st.rel_dirs.join("/"), st.file_name)
                    } else {
                        String::new()
                    };
                    let rel_abs = (!rel.is_empty()).then(|| absolutize(&rel, dir));
                    let pick = match rel_abs {
                        // Never looked up when it names a network share (paths.rs).
                        Some(r) if (!is_remote_or_device(&r) && Path::new(&r).exists()) || st.file_abs.is_empty() => r,
                        _ => st.file_abs.clone(),
                    };
                    if st.file_is_sample && Path::new(&pick).extension().is_some() {
                        lists.sample(&mut meta, pick)?;
                    }
                    st.file_is_sample = false;
                    st.file_abs.clear();
                    st.file_rel.clear();
                    st.rel_dirs.clear();
                    st.file_name.clear();
                } else if name == "AuPluginInfo" {
                    if let Some(n) = st.au_name.take().filter(|n| !n.is_empty()) {
                        lists.plugin(&mut meta, RawPlugin { name: n, vendor: st.au_vendor.take().filter(|v| !v.is_empty()), path: None })?;
                    }
                    st.au_vendor = None;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(meta)
}

// ------------------------------------------------------------------ Studio One

/// One entry as text: None if it's missing or unreadable, refused past `max`.
fn zip_text(archive: &mut zip::ZipArchive<File>, name: &str, max: u64) -> Result<Option<String>, ReadError> {
    let Ok(f) = archive.by_name(name) else { return Ok(None) };
    match read_capped(f, max) {
        Ok(text) => Ok(Some(text)),
        Err(ReadError::Io(_)) => Ok(None),
        Err(refused) => Err(refused),
    }
}

/// `file:///Users/x/My%20Song/a.wav` → `/Users/x/My Song/a.wav`.
fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let rest = rest.strip_prefix('/').map(|r| if r.get(1..2) == Some(":") { r.to_string() } else { format!("/{r}") }).unwrap_or_else(|| rest.to_string());
    let mut out = Vec::new();
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // On bytes: `%` may be followed by a multi-byte character.
            let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).to_string())
}

fn read_song(path: &Path) -> Result<FlpMetadata, ReadError> {
    use quick_xml::events::Event;
    let file = File::open(path).map_err(io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| ReadError::Refused(format!("it isn't a readable Studio One song ({e})")))?;
    let mut meta = FlpMetadata::default();
    let mut lists = Lists::default();
    let refused = ReadError::Refused;
    let dir: PathBuf = project_dir(path).to_path_buf();

    // metainfo.xml: <Attribute id="Media:Tempo" value="140"/> pairs.
    if let Some(xml) = zip_text(&mut archive, "metainfo.xml", MAX_TEXT)? {
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.name().as_ref() == "Attribute" => {
                    let (Some(id), Some(v)) = (attr_value(&e, "id"), attr_value(&e, "value")) else { continue };
                    match id.as_str() {
                        "Document:Title" => meta.title = Some(v),
                        "Document:Generator" => meta.fl_version = Some(v.replace('/', " ")),
                        "Document:Artist" | "Media:Artist" => meta.artist = Some(v),
                        "Media:Tempo" => meta.tempo_bpm = v.parse().ok(),
                        "Media:TimeSignatureNumerator" => meta.time_sig_num = v.parse().ok(),
                        "Media:TimeSignatureDenominator" => meta.time_sig_denom = v.parse().ok(),
                        _ => {}
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }

    // Media pool: any url="file:///..." is a referenced audio file.
    if let Some(xml) = zip_text(&mut archive, "Song/mediapool.xml", MAX_TEXT)? {
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                    if let Some(p) = attr_value(&e, "url").and_then(|u| file_url_to_path(&u)) {
                        lists.sample(&mut meta, absolutize(&p, &dir)).map_err(refused)?;
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }

    // Tracks (best-effort): elements named *Track with a name attribute.
    if let Some(xml) = zip_text(&mut archive, "Song/song.xml", MAX_TEXT)? {
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                    if e.name().as_ref().ends_with("Track") {
                        if let Some(n) = attr_value(&e, "name") {
                            lists.track(&mut meta, n).map_err(refused)?;
                        }
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }

    // Plugins (best-effort): <Attributes x:id="deviceData" name="Serum"/> in Devices/*.xml.
    let device_files: Vec<String> = archive
        .file_names()
        // A name that doesn't decode is skipped, like any unreadable device.
        .filter_map(Result::ok)
        .filter(|n| n.starts_with("Devices/") && n.ends_with(".xml"))
        .take(MAX_DEVICE_FILES)
        .map(|n| n.into_owned())
        .collect();
    for name in device_files {
        // Best-effort: an oversized device file is skipped, not fatal.
        let Ok(Some(xml)) = zip_text(&mut archive, &name, MAX_DEVICE_BYTES) else { continue };
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                    if attr_value(&e, "x:id").as_deref() == Some("deviceData") {
                        if let Some(n) = attr_value(&e, "name") {
                            lists.plugin(&mut meta, RawPlugin { name: n, vendor: None, path: None }).map_err(refused)?;
                        }
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn recognizes_every_daw_by_extension() {
        let cases = [
            ("a.flp", Daw::FlStudio),
            ("a.als", Daw::Ableton),
            ("a.RPP", Daw::Reaper),
            ("a.song", Daw::StudioOne),
            ("a.ptx", Daw::ProTools),
            ("a.ptf", Daw::ProTools),
            ("a.cpr", Daw::Cubase),
            ("a.npr", Daw::Cubase),
            ("a.bwproject", Daw::Bitwig),
        ];
        for (f, d) in cases {
            assert_eq!(Daw::of_project(Path::new(f)), Some(d), "{f}");
        }
        assert_eq!(Daw::of_project(Path::new("a.wav")), None);
        assert_eq!(Daw::of_backup_file(Path::new("Night Run.rpp-bak")), Some(Daw::Reaper));
        assert_eq!(Daw::of_backup_file(Path::new("Night Run-01.bak")), Some(Daw::Cubase));
    }

    #[test]
    fn backup_rules_per_daw() {
        let root = Path::new("/m");
        assert!(is_backup_project(Path::new("/m/Night Run Project/Backup/Night Run [2026-10-12 143005].als"), root, Daw::Ableton));
        assert!(is_backup_project(Path::new("/m/Night Run/History/Night Run (2).song"), root, Daw::StudioOne));
        assert!(is_backup_project(Path::new("/m/Night Run/Session File Backups/Night Run.bak.003.ptx"), root, Daw::ProTools));
        assert!(is_backup_project(Path::new("/m/Night Run/Night Run.bak.003.ptx"), root, Daw::ProTools));
        assert!(!is_backup_project(Path::new("/m/Night Run/Night Run.ptx"), root, Daw::ProTools));
        assert!(!is_backup_project(Path::new("/m/Night Run Project/Night Run.als"), root, Daw::Ableton));

        assert_eq!(backup_base_name(Daw::Ableton, "Night Run [2026-10-12 143005].als"), "Night Run");
        assert_eq!(backup_base_name(Daw::Reaper, "Night Run.rpp-bak"), "Night Run");
        assert_eq!(backup_base_name(Daw::Reaper, "Night Run-2026-10-12_143005.rpp-bak"), "Night Run");
        assert_eq!(backup_base_name(Daw::ProTools, "Night Run.bak.003.ptx"), "Night Run");
        assert_eq!(backup_base_name(Daw::Cubase, "Night Run-01.bak"), "Night Run");
        assert_eq!(backup_base_name(Daw::Cubase, "Night Run.bak"), "Night Run");
    }

    #[test]
    fn reads_a_reaper_project() {
        let rpp = r#"<REAPER_PROJECT 0.1 "7.22/macOS-arm64" 1791800000
  TEMPO 142 4 4
  SAMPLERATE 44100 0 0
  <TRACK {AAAA}
    NAME "Lead Vox - Ana"
    <FXCHAIN
      <VST "VST3i: Serum (Xfer Records)" Serum.vst3 0 "" 123
      >
      <VST "VST: ReaComp (Cockos)" reacomp.dll 0 "" 456
      >
      <JS utility/volume ""
      >
    >
    <ITEM
      <SOURCE WAVE
        FILE "Audio/vox take 1.wav"
      >
    >
  >
  <TRACK {BBBB}
    NAME 808
  >
>"#;
        let m = parse_rpp(rpp, Path::new("/music/Night Run")).unwrap();
        assert_eq!(m.fl_version.as_deref(), Some("REAPER 7.22"));
        assert_eq!((m.tempo_bpm, m.time_sig_num, m.time_sig_denom), (Some(142.0), Some(4), Some(4)));
        assert_eq!(m.mixer_names, vec!["Lead Vox - Ana", "808"]);
        let names: Vec<_> = m.plugins.iter().map(|p| (p.name.as_str(), p.vendor.as_deref())).collect();
        assert_eq!(names, vec![("Serum", Some("Xfer Records")), ("ReaComp", Some("Cockos"))]);
        assert_eq!(m.samples, vec!["/music/Night Run/Audio/vox take 1.wav"]);
    }

    #[test]
    fn reads_an_ableton_set() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="11.0_11300" Creator="Ableton Live 11.3.4">
  <LiveSet>
    <Tracks>
      <MidiTrack Id="1">
        <Name><EffectiveName Value="Keys" /><UserName Value="" /></Name>
        <DeviceChain><DeviceChain><Devices>
          <PluginDevice Id="2"><PluginDesc>
            <Vst3PluginInfo Id="0"><Name Value="Serum" /></Vst3PluginInfo>
          </PluginDesc></PluginDevice>
          <PluginDevice Id="3"><PluginDesc>
            <AuPluginInfo><Name Value="Pro-Q 3" /><Manufacturer Value="FabFilter" /></AuPluginInfo>
          </PluginDesc></PluginDevice>
        </Devices></DeviceChain></DeviceChain>
      </MidiTrack>
      <AudioTrack Id="4">
        <Name><EffectiveName Value="Vox" /></Name>
        <SampleRef><FileRef>
          <RelativePathType Value="3" />
          <RelativePath Value="Samples/Recorded/vox 1.wav" />
          <Path Value="/Users/someone/Night Run Project/Samples/Recorded/vox 1.wav" />
        </FileRef></SampleRef>
      </AudioTrack>
    </Tracks>
    <MasterTrack>
      <DeviceChain><Mixer>
        <Tempo><Manual Value="128" /></Tempo>
        <TimeSignature><Manual Value="201" /></TimeSignature>
      </Mixer></DeviceChain>
    </MasterTrack>
  </LiveSet>
</Ableton>"#;
        let m = parse_als(xml, Path::new("/elsewhere/Night Run Project")).unwrap();
        assert_eq!(m.fl_version.as_deref(), Some("Ableton Live 11.3.4"));
        assert_eq!(m.tempo_bpm, Some(128.0));
        assert_eq!((m.time_sig_num, m.time_sig_denom), (Some(4), Some(4)));
        assert_eq!(m.mixer_names, vec!["Keys", "Vox"]);
        let names: Vec<_> = m.plugins.iter().map(|p| (p.name.as_str(), p.vendor.as_deref())).collect();
        assert_eq!(names, vec![("Serum", None), ("Pro-Q 3", Some("FabFilter"))]);
        // Relative path doesn't exist here, so the stored absolute path is used.
        assert_eq!(m.samples, vec!["/Users/someone/Night Run Project/Samples/Recorded/vox 1.wav"]);
    }

    #[test]
    fn reads_live_12_main_track_and_old_relative_paths() {
        let xml = r#"<Ableton Creator="Ableton Live 12.1"><LiveSet>
  <Tracks><AudioTrack><SampleRef><FileRef>
    <RelativePath><RelativePathElement Dir="Samples" /><RelativePathElement Dir="Imported" /></RelativePath>
    <Name Value="kick.wav" />
  </FileRef></SampleRef></AudioTrack></Tracks>
  <MainTrack><DeviceChain><Mixer><Tempo><Manual Value="92.5" /></Tempo></Mixer></DeviceChain></MainTrack>
</LiveSet></Ableton>"#;
        let m = parse_als(xml, Path::new("/p")).unwrap();
        assert_eq!(m.tempo_bpm, Some(92.5));
        assert_eq!(m.samples, vec!["/p/Samples/Imported/kick.wav"]);
    }

    #[test]
    fn reads_an_ableton_file_from_disk_gzipped() {
        let dir = std::env::temp_dir().join(format!("flsm-als-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Set.als");
        let mut gz = flate2::write::GzEncoder::new(File::create(&path).unwrap(), flate2::Compression::default());
        gz.write_all(br#"<Ableton Creator="Ableton Live 11.0"><LiveSet><MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="140" /></Tempo></Mixer></DeviceChain></MasterTrack></LiveSet></Ableton>"#).unwrap();
        gz.finish().unwrap();
        let m = read_project(Daw::Ableton, &path).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(m.tempo_bpm, Some(140.0));
    }

    #[test]
    fn reads_a_studio_one_song() {
        let dir = std::env::temp_dir().join(format!("flsm-song-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Night Run.song");
        let mut zw = zip::ZipWriter::new(File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file("metainfo.xml", opts).unwrap();
        zw.write_all(br#"<?xml version="1.0"?><MetaInformation>
  <Attribute id="Document:Title" value="Night Run"/>
  <Attribute id="Document:Generator" value="Studio One/6.5.2"/>
  <Attribute id="Media:Tempo" value="140"/>
  <Attribute id="Media:TimeSignatureNumerator" value="3"/>
  <Attribute id="Media:TimeSignatureDenominator" value="4"/>
</MetaInformation>"#).unwrap();
        zw.start_file("Song/mediapool.xml", opts).unwrap();
        zw.write_all(br#"<MediaPool><AudioClip url="file:///Users/someone/Songs/Night%20Run/Media/vox.wav"/></MediaPool>"#).unwrap();
        zw.start_file("Song/song.xml", opts).unwrap();
        zw.write_all(br#"<Song><Tracks><MediaTrack name="Lead Vox"/><MediaTrack name="808"/></Tracks></Song>"#).unwrap();
        zw.start_file("Devices/audiosynthfolder.xml", opts).unwrap();
        zw.write_all(br#"<SynthFolder xmlns:x="x"><Attributes x:id="deviceData" name="Serum"/></SynthFolder>"#).unwrap();
        zw.finish().unwrap();
        let m = read_project(Daw::StudioOne, &path).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(m.title.as_deref(), Some("Night Run"));
        assert_eq!(m.fl_version.as_deref(), Some("Studio One 6.5.2"));
        assert_eq!((m.tempo_bpm, m.time_sig_num, m.time_sig_denom), (Some(140.0), Some(3), Some(4)));
        assert_eq!(m.samples, vec!["/Users/someone/Songs/Night Run/Media/vox.wav"]);
        assert_eq!(m.mixer_names, vec!["Lead Vox", "808"]);
        assert_eq!(m.plugins.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Serum"]);
    }

    #[test]
    fn closed_formats_yield_empty_metadata() {
        let dir = std::env::temp_dir().join(format!("flsm-closed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("Session.ptx");
        fs::write(&p, b"\x03\x00binary").unwrap();
        let m = read_project(Daw::ProTools, &p).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(m.tempo_bpm.is_none() && m.plugins.is_empty());
    }

    #[test]
    fn non_ascii_backup_names_never_panic() {
        assert_eq!(backup_base_name(Daw::Reaper, "Ma très belle chanson_2024.rpp-bak"), "Ma très belle chanson_2024");
        assert_eq!(backup_base_name(Daw::Reaper, "Été-2026-10-12_143005.rpp-bak"), "Été");
        assert_eq!(backup_base_name(Daw::Reaper, "ééééééééééé_1234.rpp-bak"), "ééééééééééé_1234");
        assert_eq!(backup_base_name(Daw::Reaper, "é-2026-10-12_1430.rpp-bak"), "é");
        assert_eq!(backup_base_name(Daw::ProTools, "İstanbul.bak.002.ptx"), "İstanbul");
        assert_eq!(backup_base_name(Daw::Cubase, "Nuit étoilée-01.bak"), "Nuit étoilée");
        for name in ["日本語-2026", "—_1234", "x-é1234", "-2026-10-12_1430", "ÀÀÀÀÀÀÀÀÀÀ_0000"] {
            let _ = strip_timestamp_suffix(name);
        }
    }

    #[test]
    fn file_urls_with_non_ascii_after_percent() {
        assert_eq!(file_url_to_path("file:///Users/x/Caf%C3%A9/a.wav").as_deref(), Some("/Users/x/Café/a.wav"));
        assert_eq!(file_url_to_path("file:///Users/x/%é%/a.wav").as_deref(), Some("/Users/x/%é%/a.wav"));
        assert_eq!(file_url_to_path("file:///x/100%").as_deref(), Some("/x/100%"));
        assert_eq!(file_url_to_path("file:///C:/Songs/a%20b.wav").as_deref(), Some("C:/Songs/a b.wav"));
    }

    #[test]
    fn studio_one_and_bitwig_backups_drop_copy_numbers() {
        assert_eq!(backup_base_name(Daw::StudioOne, "Night Run (2).song"), "Night Run");
        assert_eq!(backup_base_name(Daw::StudioOne, "Night Run.autosave"), "Night Run");
        assert_eq!(backup_base_name(Daw::Bitwig, "Night Run (14).bwproject"), "Night Run");
        // Not a copy number: part of the name.
        assert_eq!(backup_base_name(Daw::StudioOne, "Night Run (live).song"), "Night Run (live)");
        assert_eq!(backup_base_name(Daw::Bitwig, "(2).bwproject"), "(2)");
    }

    #[test]
    fn ableton_device_presets_are_not_samples() {
        let xml = r#"<Ableton Creator="Ableton Live 12.1"><LiveSet><Tracks><AudioTrack>
  <DeviceChain><Devices>
    <InstrumentGroupDevice><LastPresetRef><Value><FilePresetRef><FileRef>
      <RelativePath Value="Presets/Keys.adg" /><Path Value="/lib/Presets/Keys.adg" />
    </FileRef></FilePresetRef></Value></LastPresetRef></InstrumentGroupDevice>
    <MxDeviceAudioEffect><FileRef><Path Value="/lib/Max/Delay.amxd" /></FileRef></MxDeviceAudioEffect>
  </Devices></DeviceChain>
  <SampleRef><FileRef><Path Value="/lib/Samples/kick.wav" /></FileRef></SampleRef>
</AudioTrack></Tracks></LiveSet></Ableton>"#;
        let m = parse_als(xml, Path::new("/p")).unwrap();
        assert_eq!(m.samples, vec!["/lib/Samples/kick.wav"]);
    }

    #[test]
    fn backup_files_without_a_root() {
        assert!(is_backup_file(Path::new("/m/Wave Project/Backup/Wave [2026-10-12 143005].als")));
        assert!(is_backup_file(Path::new("/m/Tide/Tide.rpp-bak")));
        assert!(is_backup_file(Path::new("/m/Fade/Fade-01.bak")));
        assert!(is_backup_file(Path::new("/m/Rush/Rush.bak.001.ptx")));
        assert!(is_backup_file(Path::new("/m/Glow/History/Glow (2).song")));
        assert!(is_backup_file(Path::new("/m/Envy/Backup/Envy (overwritten at 16h12).flp")));
        assert!(!is_backup_file(Path::new("/m/Envy/Envy.flp")));
        assert!(!is_backup_file(Path::new("/m/Wave Project/Wave.als")));
        assert!(!is_backup_file(Path::new("/m/Tide/Tide.rpp")));
        // A backup folder name of another DAW doesn't count.
        assert!(!is_backup_file(Path::new("/m/Glow/Backup/Glow.song")));
        assert!(!is_backup_file(Path::new("/m/Envy/Backup/notes.txt")));
    }

    #[test]
    fn rereads_a_project_only_when_it_changes() {
        let dir = std::env::temp_dir().join(format!("flsm-cache-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Tide.rpp");
        fs::write(&path, "<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n  TEMPO 90 4 4\n>\n").unwrap();
        assert_eq!(read_project(Daw::Reaper, &path).unwrap().tempo_bpm, Some(90.0));
        assert_eq!(read_project(Daw::Reaper, &path).unwrap().tempo_bpm, Some(90.0));
        fs::write(&path, "<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n  TEMPO 142.5 4 4\n>\n").unwrap();
        let m = read_project(Daw::Reaper, &path).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(m.tempo_bpm, Some(142.5));
    }

    #[test]
    fn a_saved_read_cache_spares_the_next_launch_a_read() {
        let dir = std::env::temp_dir().join(format!("flsm-saved-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Tide.rpp");
        fs::write(&path, "<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n  TEMPO 97 4 4\n>\n").unwrap();
        let (size, mtime) = stamp_of(&fs::metadata(&path).unwrap());
        let stamp = Some((size, mtime));
        assert!(matches!(read_project_at(Daw::Reaper, &path, stamp, false), ProjectRead::Read(Ok(_))));
        let file = dir.join("read-cache.json");
        save_read_cache(&file).unwrap();
        assert!(file.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A new launch: nothing in memory, the saved file is loaded.
        forget_read(&path);
        assert!(matches!(read_project_at(Daw::Reaper, &path, stamp, true), ProjectRead::InCloud), "not in memory any more");
        load_read_cache(&file);
        // Served from the saved cache: even a cloud placeholder isn't opened.
        match read_project_at(Daw::Reaper, &path, stamp, true) {
            ProjectRead::Read(Ok(m)) => assert_eq!(m.tempo_bpm, Some(97.0)),
            _ => panic!("expected the saved read"),
        }
        // A changed file isn't served from it.
        let changed = Some((size + 1, mtime));
        assert!(matches!(read_project_at(Daw::Reaper, &path, changed, true), ProjectRead::InCloud));
        // A damaged file is ignored, not an error.
        fs::write(&file, b"{ not json").unwrap();
        forget_read(&path);
        load_read_cache(&file);
        assert!(matches!(read_project_at(Daw::Reaper, &path, stamp, true), ProjectRead::InCloud));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cloud_placeholder_is_never_opened() {
        // Not a real placeholder (tests can't make one): what the scan does
        // when the flag says so. The path doesn't even exist.
        let path = Path::new("/nonexistent/flsm/Envy.flp");
        assert!(matches!(read_project_at(Daw::FlStudio, path, Some((10, Some(1))), true), ProjectRead::InCloud));
        // Closed formats have nothing to read either way.
        assert!(matches!(read_project_at(Daw::ProTools, path, None, true), ProjectRead::Read(Ok(_))));
        assert!(read_project(Daw::FlStudio, path).is_err());
    }

    #[test]
    fn refuses_an_als_nested_too_deep() {
        let depth = MAX_ALS_DEPTH + 10;
        let xml = format!("{}{}", "<a>".repeat(depth), "</a>".repeat(depth));
        let err = parse_als(&xml, Path::new("/p")).unwrap_err();
        assert!(err.contains("nested"), "{err}");
        // A million levels is refused just as fast (no per-element stack scan).
        let deep = "<a>".repeat(1_000_000);
        assert!(parse_als(&deep, Path::new("/p")).is_err());
    }

    #[test]
    fn refuses_text_over_the_cap() {
        assert!(matches!(read_capped(&b"0123456789"[..], 9), Err(ReadError::Refused(_))));
        assert_eq!(read_capped(&b"0123456789"[..], 10).ok().as_deref(), Some("0123456789"));
        // Invalid UTF-8 still reads (lossy), never fails.
        assert_eq!(read_capped(&[b'a', 0xff, b'b'][..], 10).ok().as_deref(), Some("a\u{fffd}b"));
    }

    #[test]
    fn refuses_a_project_listing_too_many_tracks() {
        let mut rpp = String::from("<REAPER_PROJECT 0.1 \"7.22/win64\" 1\n");
        for i in 0..=crate::flp_metadata::MAX_TRACK_NAMES {
            rpp.push_str(&format!("  <TRACK\n    NAME \"t{i}\"\n  >\n"));
        }
        rpp.push_str(">\n");
        assert!(parse_rpp(&rpp, Path::new("/p")).unwrap_err().contains("track names"));
    }
}
