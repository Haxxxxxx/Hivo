use crate::daws::{self, Daw};
use crate::models::{FileEntry, ProjectInfo, ScanResult, StemsInfo};
use crate::resolve::Resolver;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
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
    s.to_lowercase()
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
/// "Envy (master)", "Envy_v2", "Envy - final"). `name` is lowercased already;
/// "Envyous" is another song.
fn named_after(stem: &str, name: &str) -> bool {
    let stem = stem.to_lowercase();
    match stem.strip_prefix(name) {
        Some(rest) => rest.is_empty() || rest.starts_with(|c: char| !c.is_alphanumeric()),
        None => false,
    }
}

/// Whether `stem` belongs to the song `name` among the songs of one folder
/// (`names`, all lowercased): it's named after `name`, and not after a
/// longer name there too. "Envy v2.wav" is "Envy v2"'s, not "Envy"'s, when
/// both projects sit in the same folder.
fn owned_by(stem: &str, name: &str, names: &[String]) -> bool {
    named_after(stem, name) && !names.iter().any(|n| n.len() > name.len() && named_after(stem, n))
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

#[cfg(test)]
fn scan(folders: &[String], output_folder: Option<&str>) -> Vec<ProjectInfo> {
    scan_with(folders, output_folder, Resolver::new(crate::settings::detect_fl_studio()))
}

fn scan_with(folders: &[String], output_folder: Option<&str>, mut resolver: Resolver) -> Vec<ProjectInfo> {
    let exports = index_exports(output_folder);
    let mut seen = HashSet::new();
    let mut projects: Vec<ProjectInfo> = Vec::new();
    // (file, DAW, backup-only file type)
    let mut backups: Vec<(PathBuf, Daw, bool)> = Vec::new();
    // (`<song>/BandLab` folder, its linked root)
    let mut sketch_dirs: Vec<(PathBuf, String)> = Vec::new();

    for root in folders {
        let root_path = Path::new(root);
        // Unreachable right now: reported by `unreachable_roots`.
        if !reachable(root_path) {
            continue;
        }
        // Ableton's library folders hold presets and demo sets, not songs.
        let walker = WalkDir::new(root_path).into_iter().filter_entry(|e| {
            !(e.depth() > 0 && e.file_type().is_dir() && daws::LIBRARY_DIRS.contains(&e.file_name().to_string_lossy().to_lowercase().as_str()))
        });
        for entry in walker.filter_map(|e| e.ok()) {
            let path = entry.path();
            // `<song>/BandLab/` below the root: maybe a sketch (checked
            // once every project is known, see `sketch_of`).
            if entry.file_type().is_dir() && entry.depth() >= 2 && entry.file_name() == crate::sketch::SKETCH_DIR {
                sketch_dirs.push((path.to_path_buf(), root.clone()));
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            // Backup-only files: .rpp-bak, Cubase .bak, Studio One .autosave.
            let (daw, backup_only) = match (Daw::of_project(path), Daw::of_backup_file(path)) {
                (Some(d), _) => (d, false),
                (None, Some(d)) => (d, true),
                _ => continue,
            };
            // macOS metadata twins (`._Envy.flp`, `__MACOSX/`) from unzipped
            // packages or exFAT drives aren't projects.
            if entry.file_name().to_string_lossy().starts_with("._")
                || path.components().any(|c| c.as_os_str() == "__MACOSX")
            {
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

            // A corrupt, oversized or hostile project never fails the whole
            // scan: it's listed with no metadata and the reason. A reader bug
            // (panic) is contained the same way (release builds unwind, see
            // Cargo.toml). Reads are cached by size and mtime (daws.rs).
            let read = std::panic::catch_unwind(|| daws::read_project(daw, path));
            let (flp, read_error) = match read {
                Ok(Ok(flp)) => (flp, None),
                Ok(Err(e)) => (Default::default(), Some(e)),
                Err(_) => (Default::default(), Some("the reader crashed on this file (damaged or unusual project)".to_string())),
            };

            projects.push(ProjectInfo {
                path: path.to_string_lossy().to_string(),
                name: stem_of(path),
                folder: path
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size_bytes: meta.len(),
                modified_at_ms: modified_ms(&meta),
                root: root.clone(),
                genre: non_empty(flp.genre),
                artist: non_empty(flp.artist),
                tempo_bpm: flp.tempo_bpm,
                time_sig_num: flp.time_sig_num,
                time_sig_denom: flp.time_sig_denom,
                fl_version: if daw == Daw::FlStudio { flp.fl_version.clone() } else { None },
                daw,
                daw_version: flp.fl_version.clone(),
                is_template: under_template_dir(path, root_path),
                backups: Vec::new(),
                renders: Vec::new(),
                recordings_count: 0,
                recordings_bytes: 0,
                flp_title: non_empty(flp.title.clone()),
                comment: non_empty(flp.comment.clone()),
                stems: None,
                plugins: resolver.plugins(&flp.plugins),
                samples: resolver.samples(&flp.samples, path),
                track_names: {
                    let mut names = Vec::new();
                    for n in &flp.mixer_names {
                        push_track_name(&mut names, n);
                    }
                    names
                },
                read_error,
                ambiguous_exports: 0,
            });
        }
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
        *name_counts.entry(p.name.to_lowercase()).or_default() += 1;
    }

    // Renders sit next to the .flp; recordings in the sibling Audio/ folder.
    for indices in by_folder.values() {
        let dir = PathBuf::from(&projects[indices[0]].folder);
        let siblings: Vec<PathBuf> = read_files(&dir);
        let recordings: Vec<PathBuf> = read_files(&dir.join("Audio"));
        let stem_dirs: Vec<PathBuf> = read_dirs(&dir)
            .into_iter()
            .filter(|d| d.file_name().is_some_and(|n| is_stems_dir(&n.to_string_lossy())))
            .collect();
        // Every song name in this folder: a file goes to the longest one it's
        // named after (versions: "Envy", "Envy v2", "Envy v2 final").
        let names: Vec<String> = indices.iter().map(|&j| projects[j].name.to_lowercase()).collect();

        for &i in indices {
            let name = projects[i].name.to_lowercase();
            let owns = |p: &Path| owned_by(&stem_of(p), &name, &names);
            // FL's split-mixer export: `<name>_<track>.wav`, one per track.
            // Two or more of them are stems, not mixdowns.
            let split_prefix = format!("{name}_");
            let split: Vec<&PathBuf> = siblings
                .iter()
                .filter(|p| has_ext(p, AUDIO_EXTS) && stem_of(p).to_lowercase().starts_with(&split_prefix) && owns(p))
                .collect();
            let split_are_stems = split.len() >= 2;
            let mut renders: Vec<FileEntry> = siblings
                .iter()
                .filter(|p| has_ext(p, AUDIO_EXTS) && owns(p))
                .filter(|p| !(split_are_stems && stem_of(p).to_lowercase().starts_with(&split_prefix)))
                .filter_map(|p| file_entry(p))
                .collect();
            // Each DAW's own export folder (Pro Tools "Bounced Files", Studio
            // One "Mixdown"…): files named after the song, or any audio there
            // if it's the only project of that DAW in the folder.
            let daw = projects[i].daw;
            let alone = indices.iter().filter(|&&j| projects[j].daw == daw).count() == 1;
            for sub in daw.render_dirs() {
                renders.extend(
                    read_files(&dir.join(sub))
                        .iter()
                        .filter(|p| has_ext(p, AUDIO_EXTS) && (alone || owns(p)))
                        .filter_map(|p| file_entry(p)),
                );
            }
            // A stems folder belongs to this song if it's the only song in the
            // folder, or the stems folder is named after it (whole words, and
            // the longest song name that fits: "Envy v2 Stems" is "Envy v2"'s).
            let dir_named_after = |d: &Path, n: &str| d.file_name().is_some_and(|f| has_words(&f.to_string_lossy().to_lowercase(), n));
            let own_dir = stem_dirs
                .iter()
                .find(|d| dir_named_after(d, &name) && !names.iter().any(|n| n.len() > name.len() && dir_named_after(d, n)))
                .or_else(|| (indices.len() == 1).then(|| stem_dirs.first()).flatten());
            projects[i].stems = if let Some(sd) = own_dir {
                stems_info(sd, &read_files(sd))
            } else if split_are_stems {
                stems_info(&dir, &split.iter().map(|p| (*p).clone()).collect::<Vec<_>>())
            } else {
                None
            };
            if let Some(exported) = exports.get(&name) {
                if name_counts.get(&name).copied().unwrap_or(0) > 1 {
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
                        for rec in read_files(&dir.join(sub)).iter().filter(|p| has_ext(p, AUDIO_EXTS)) {
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
            let prefix = format!("{name}_");
            for rec in recordings.iter().filter(|p| {
                has_ext(p, AUDIO_EXTS) && stem_of(p).to_lowercase().starts_with(&prefix) && owns(p)
            }) {
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
        if let Some(sketch) = sketch_of(&dir, &root) {
            projects.push(sketch);
        }
    }

    merge_plugin_aliases(&mut projects);
    projects.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    projects
}

/// A BandLab sketch: `X/BandLab/` holding at least one audio file, with no
/// DAW project directly in X (once there's one, X is that project's folder
/// and BandLab/ just holds its source audio). Keyed by the BandLab folder's
/// path; named after X. Nothing is read from inside the audio here.
fn sketch_of(bandlab: &Path, root: &str) -> Option<ProjectInfo> {
    let song = bandlab.parent()?;
    if bandlab.components().any(|c| c.as_os_str() == "__MACOSX") {
        return None;
    }
    let hidden = |p: &Path| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
    if read_files(song).iter().any(|p| !hidden(p) && Daw::of_project(p).is_some()) {
        return None;
    }
    let mut audio: Vec<FileEntry> = read_files(bandlab)
        .iter()
        .filter(|p| !hidden(p) && crate::sketch::is_sketch_audio(p))
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
    })
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

fn read_dirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
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

fn read_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default()
}

/// Scans the linked folders and the export folder from Settings (never
/// folders named by the webview: the backup cleanup trusts this listing).
#[tauri::command]
pub async fn scan_projects(app: AppHandle) -> Result<ScanResult, String> {
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
    let (projects, unreachable) = tauri::async_runtime::spawn_blocking(move || {
        let resolver = Resolver::new(fl).with_user_data(user_data).with_sample_folders(&sample_folders);
        (scan_with(&folders, output_folder.as_deref(), resolver), unreachable_roots(&linked))
    })
        .await
        .map_err(|e| format!("scan failed: {e}"))?;
    remember_scan(&projects);
    Ok(ScanResult { projects, unreachable })
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
