//! Beats for the Digger: raw beats (mp3/wav/m4a…, often downloaded from
//! YouTube) in the beats folders from Settings. They're listed and played,
//! never treated as projects, never shared with the crew.
//!
//! `analyze_beats` measures tempo, key, loudness and length offline (the
//! same analysis the dig uses, `digger::analyze_beat`), without any AI key.
//! Results are cached per (path, modified time, size) in `beat-facts.json`
//! in the config dir, so a beat is decoded once.

use crate::digger::{analyze_beat, BeatFacts};
use crate::scope::{is_beat_file, is_unsupported_audio, Scope};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

/// One beat file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatFile {
    pub path: String,
    /// File name without the extension ("Night Drive - Dark Trap Beat (prod. X)").
    pub name: String,
    pub folder: String,
    pub size_bytes: u64,
    pub modified_at_ms: i64,
}

/// The beats, and what the list must say about the ones it doesn't show.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatScan {
    pub beats: Vec<BeatFile>,
    /// Beats found, including the ones past MAX_BEATS.
    pub total: usize,
    /// The scan stopped early (MAX_BEATS or MAX_VISITED): `total` is a floor.
    pub capped: bool,
    /// Audio files in a format the Digger can't read (opus, aac…).
    pub ignored: usize,
}

/// How deep to look inside a beats folder.
const MAX_DEPTH: usize = 4;
/// Enough for any crew's beats; protects against a whole drive picked by mistake.
const MAX_BEATS: usize = 5_000;
/// Entries looked at, beats or not: a huge folder can't stall the scan.
const MAX_VISITED: usize = 100_000;

pub fn list_beats(folders: &[PathBuf]) -> BeatScan {
    let mut scan = BeatScan::default();
    let mut visited = 0usize;
    'roots: for root in folders {
        // Phone memos linked to beats (`_memos`) aren't beats.
        let walker = WalkDir::new(root)
            .max_depth(MAX_DEPTH)
            .into_iter()
            .filter_entry(|e| !(e.depth() == 1 && e.file_type().is_dir() && e.file_name() == crate::phone_inbox::BEAT_MEMOS_DIR));
        for e in walker.filter_map(|e| e.ok()) {
            visited += 1;
            if visited > MAX_VISITED {
                scan.capped = true;
                break 'roots;
            }
            let p = e.path();
            if !e.file_type().is_file() || is_hidden(p) {
                continue;
            }
            if is_unsupported_audio(p) {
                scan.ignored += 1;
                continue;
            }
            if !is_beat_file(p) {
                continue;
            }
            scan.total += 1;
            if scan.beats.len() >= MAX_BEATS {
                scan.capped = true;
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            scan.beats.push(BeatFile {
                path: p.to_string_lossy().to_string(),
                name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                folder: p.parent().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
                size_bytes: meta.len(),
                modified_at_ms: mtime_ms(&meta),
            });
        }
    }
    scan.beats.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms).then_with(|| a.name.cmp(&b.name)));
    scan
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn is_hidden(p: &Path) -> bool {
    p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// The beats in the beats folders, newest first. Lets the webview play them
/// (asset protocol) inside those folders only.
#[tauri::command]
pub async fn scan_beats(app: AppHandle) -> Result<BeatScan, String> {
    let scope = Scope::load(&app)?;
    let folders = scope.beat_folders().to_vec();
    let assets = tauri::Manager::asset_protocol_scope(&app);
    for f in &folders {
        let _ = assets.allow_directory(f, true);
    }
    tauri::async_runtime::spawn_blocking(move || list_beats(&folders))
        .await
        .map_err(|e| format!("beat scan failed: {e}"))
}

// ---------------------------------------------------------------- analysis

/// Beats analysed per call: the webview asks in small batches.
pub const MAX_ANALYZE: usize = 20;
/// Entries kept in the cache file (the scan's own cap).
const MAX_CACHED: usize = MAX_BEATS;
const CACHE_FILE: &str = "beat-facts.json";

/// One cached analysis: valid while the file keeps this mtime and size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFacts {
    pub modified_at_ms: i64,
    pub size_bytes: u64,
    /// None: the file couldn't be decoded (remembered too, not retried).
    pub facts: Option<BeatFacts>,
    #[serde(default)]
    pub error: Option<String>,
}

pub type FactsCache = HashMap<String, CachedFacts>;

/// What one beat's analysis came to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatAnalysis {
    pub path: String,
    pub facts: Option<BeatFacts>,
    pub error: Option<String>,
}

/// The cached facts for `path` if its mtime and size still match, else a
/// fresh `analyse(path)` stored in the cache. Returns whether it was fresh.
pub fn facts_for(cache: &mut FactsCache, path: &str, modified_at_ms: i64, size_bytes: u64, analyse: impl FnOnce() -> Result<BeatFacts, String>) -> (CachedFacts, bool) {
    if let Some(hit) = cache.get(path).filter(|c| c.modified_at_ms == modified_at_ms && c.size_bytes == size_bytes) {
        return (hit.clone(), false);
    }
    let entry = match analyse() {
        Ok(f) => CachedFacts { modified_at_ms, size_bytes, facts: Some(f), error: None },
        Err(e) => CachedFacts { modified_at_ms, size_bytes, facts: None, error: Some(e.chars().take(300).collect()) },
    };
    if cache.len() >= MAX_CACHED && !cache.contains_key(path) {
        // Drop entries for files that are gone; the cache stays bounded either way.
        cache.retain(|p, _| Path::new(p).exists());
        if cache.len() >= MAX_CACHED {
            return (entry, true);
        }
    }
    cache.insert(path.to_string(), entry.clone());
    (entry, true)
}

fn cache() -> &'static Mutex<Option<FactsCache>> {
    static CACHE: OnceLock<Mutex<Option<FactsCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("could not resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join(CACHE_FILE))
}

fn read_cache(path: &Path) -> FactsCache {
    std::fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
}

/// Tempo, key, loudness and length of beats, offline (no AI key needed),
/// at most MAX_ANALYZE per call. A path outside the beats folders, or a
/// file that can't be decoded, gets an error of its own.
#[tauri::command]
pub async fn analyze_beats(app: AppHandle, paths: Vec<String>) -> Result<Vec<BeatAnalysis>, String> {
    if paths.len() > MAX_ANALYZE {
        return Err(format!("{MAX_ANALYZE} beats per call max."));
    }
    let scope = Scope::load(&app)?;
    let file = cache_path(&app)?;
    let checked: Vec<(String, Result<PathBuf, String>)> = paths.into_iter().map(|p| {
        let real = scope.beat(&p);
        (p, real)
    }).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
        let cache = guard.get_or_insert_with(|| read_cache(&file));
        let mut changed = false;
        let out = checked
            .into_iter()
            .map(|(path, real)| {
                let real = match real {
                    Ok(r) => r,
                    Err(e) => return BeatAnalysis { path, facts: None, error: Some(e) },
                };
                let Ok(meta) = std::fs::metadata(&real) else {
                    return BeatAnalysis { path, facts: None, error: Some("The file is gone.".to_string()) };
                };
                let (entry, fresh) = facts_for(cache, &path, mtime_ms(&meta), meta.len(), || analyze_beat(&real, false).map(|(f, _)| f));
                changed |= fresh;
                BeatAnalysis { path, facts: entry.facts, error: entry.error }
            })
            .collect::<Vec<_>>();
        if changed {
            if let Ok(raw) = serde_json::to_vec(&*cache) {
                let tmp = file.with_extension("json.tmp");
                if std::fs::write(&tmp, raw).is_ok() {
                    let _ = std::fs::rename(&tmp, &file);
                }
            }
        }
        out
    })
    .await
    .map_err(|e| format!("beat analysis stopped: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_only_beats_newest_first() {
        let root = std::env::temp_dir().join(format!("flsm-beats-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("YouTube").join("dark")).unwrap();
        fs::write(root.join("Night Drive (prod. X).mp3"), b"x").unwrap();
        fs::write(root.join("YouTube").join("dark").join("Cold Room.wav"), b"x").unwrap();
        fs::write(root.join("cover.jpg"), b"x").unwrap();
        fs::write(root.join("Session.flp"), b"x").unwrap();
        fs::write(root.join(".hidden.mp3"), b"x").unwrap();
        fs::write(root.join("song.m4a"), b"x").unwrap();
        fs::write(root.join("voice.opus"), b"x").unwrap();
        fs::write(root.join("old.aac"), b"x").unwrap();
        let scan = list_beats(&[root.clone()]);
        let _ = fs::remove_dir_all(&root);
        let mut names: Vec<String> = scan.beats.into_iter().map(|b| b.name).collect();
        names.sort();
        assert_eq!(names, vec!["Cold Room", "Night Drive (prod. X)", "song"]);
        assert_eq!((scan.total, scan.capped, scan.ignored), (3, false, 2));
    }

    #[test]
    fn a_beat_must_live_in_a_beats_folder() {
        let root = std::env::temp_dir().join(format!("flsm-beat-scope-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("beats")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("beats").join("a.mp3"), b"x").unwrap();
        fs::write(root.join("other").join("b.mp3"), b"x").unwrap();
        fs::write(root.join("beats").join("c.txt"), b"x").unwrap();
        let s = crate::models::Settings { beat_folders: vec![root.join("beats").to_string_lossy().to_string()], ..Default::default() };
        let scope = Scope::from_settings(&s);
        let ok = scope.beat(&root.join("beats").join("a.mp3").to_string_lossy());
        let outside = scope.beat(&root.join("other").join("b.mp3").to_string_lossy());
        let climb = scope.beat(&root.join("beats").join("..").join("other").join("b.mp3").to_string_lossy());
        let not_audio = scope.beat(&root.join("beats").join("c.txt").to_string_lossy());
        let _ = fs::remove_dir_all(&root);
        assert!(ok.is_ok());
        assert!(outside.is_err() && climb.is_err() && not_audio.is_err());
    }

    fn facts(bpm: f64) -> BeatFacts {
        BeatFacts { name: "b".into(), duration_sec: 60.0, duration_capped: false, bpm: Some(bpm), bpm_source: Some("audio".into()), key: Some("Am".into()), loudness_db: None, hits_per_sec: None }
    }

    #[test]
    fn analysis_is_cached_per_path_mtime_and_size() {
        let mut cache = FactsCache::new();
        let calls = std::cell::Cell::new(0);
        let run = |bpm: f64| {
            calls.set(calls.get() + 1);
            Ok(facts(bpm))
        };
        let (a, fresh) = facts_for(&mut cache, "/b/x.mp3", 10, 100, || run(120.0));
        assert!(fresh && a.facts.as_ref().unwrap().bpm == Some(120.0));
        // Same file, same mtime and size: no decode.
        let (b, fresh) = facts_for(&mut cache, "/b/x.mp3", 10, 100, || run(99.0));
        assert!(!fresh && b == a && calls.get() == 1);
        // Saved again (new mtime) or replaced (new size): analysed again.
        assert_eq!(facts_for(&mut cache, "/b/x.mp3", 11, 100, || run(140.0)).0.facts.unwrap().bpm, Some(140.0));
        assert_eq!(facts_for(&mut cache, "/b/x.mp3", 11, 101, || run(90.0)).0.facts.unwrap().bpm, Some(90.0));
        assert_eq!(calls.get(), 3);
        // A failure is remembered as such.
        let (e, _) = facts_for(&mut cache, "/b/bad.mp3", 1, 1, || Err("no audio".into()));
        assert_eq!((e.facts, e.error.as_deref()), (None, Some("no audio")));
        let (e, fresh) = facts_for(&mut cache, "/b/bad.mp3", 1, 1, || Ok(facts(1.0)));
        assert!(!fresh && e.facts.is_none());
        // The cache file round-trips.
        let back: FactsCache = serde_json::from_slice(&serde_json::to_vec(&cache).unwrap()).unwrap();
        assert_eq!(back, cache);
    }
}
