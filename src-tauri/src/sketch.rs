//! BandLab sketches: a song started on the phone in BandLab, exported as
//! audio (mixdown, or stems in a zip) and shared to Hivo on the phone.
//!
//! On disk a sketch is `<project folder>/<song>/BandLab/<audio files>` with no
//! DAW project in `<song>/` (the scanner lists it, keyed by the BandLab
//! folder). It's created from the phone inbox (`phone_inbox::Inbox::
//! file_sketch`). "Continue in FL Studio" makes a NEW `<song>/<song>.flp`
//! next to it from the template, with each BandLab file on its own playlist
//! track (flp_build.rs: the one .flp Hivo writes, and only a new one; user
//! override 2026-10-27). From then on the folder is that FL project's; the
//! audio stays in BandLab/. If the audio can't be laid out, the template is
//! copied alone, as before, and the reason is returned.

use crate::error::{app_err, detail_of, ensure_code, path_err};
use crate::actions::{check_template, copy_file, fl_from_settings, validate_name};
use crate::daws::Daw;
use crate::flp_build::{fl_plays, Clip};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The folder inside a song folder that makes it a sketch (exact name).
pub const SKETCH_DIR: &str = "BandLab";
/// What BandLab exports, plus the usual audio types a phone sends.
pub const SKETCH_AUDIO_EXTS: &[&str] = &["wav", "mp3", "m4a", "aac", "flac", "ogg", "aif", "aiff"];

pub fn is_sketch_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SKETCH_AUDIO_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// What "Continue in FL Studio" made.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Continued {
    /// The new .flp.
    pub flp: String,
    /// Audio clips laid out on its playlist (0: the template alone).
    pub clips: usize,
    /// Why the audio isn't in the project, or what was converted (English).
    pub note: Option<String>,
    /// The same, one coded message each (src-tauri/src/error.rs), for the webview to translate.
    pub notes: Vec<String>,
    /// Audio files left off the playlist past `MAX_CLIPS` (dragged in by hand).
    pub skipped: usize,
    /// The mixdown(s) left off the playlist because the stems are on it
    /// (`BandLab/Stems/`, phone_inbox.rs): file names.
    pub mixdown: Vec<String>,
}

/// The audio files directly in `dir`, sorted, hidden ones left out.
fn audio_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file() && is_sketch_audio(p)).collect())
        .unwrap_or_default();
    files.retain(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')));
    files.sort();
    files
}

fn file_name(p: &Path) -> String {
    p.file_name().unwrap_or_default().to_string_lossy().to_string()
}

/// "Continue in FL Studio": a new `<song>/<song>.flp` next to the sketch's
/// BandLab folder, from the template, with every BandLab file laid out on
/// its own playlist track (flp_build.rs). The app then moves the song's
/// data to it and opens it like any project.
#[tauri::command]
pub async fn continue_sketch(app: AppHandle, sketch_path: String, template_path: String) -> Result<Continued, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let sketch = scope.folder_in_roots(&sketch_path)?;
    check_template(&scope, fl_from_settings(&app), &template_path)?;
    // Decoding and converting can take a few seconds: off the main thread.
    tauri::async_runtime::spawn_blocking(move || continue_in(&sketch, Path::new(&template_path)))
        .await
        .map_err(|e| app_err("task.failed", format!("Continue in FL Studio failed: {e}")))?
}

/// What goes on the playlist: the sketch's audio as FL will play it (M4A/
/// AAC converted to a WAV next to the original, reused when it's already
/// there), sorted by name. When `BandLab/Stems/` holds audio, the stems
/// only: the files beside it are the mixdown, which would play over them.
struct Playable {
    clips: Vec<Clip>,
    notes: Vec<String>,
    /// Clips left out past `MAX_CLIPS`.
    skipped: usize,
    /// Mixdown file names left off.
    mixdown: Vec<String>,
}

fn playable_audio(sketch: &Path) -> Playable {
    let stems = audio_in(&sketch.join(crate::phone_inbox::STEMS_DIR));
    let (files, mixdown) = if stems.is_empty() {
        (audio_in(sketch), Vec::new())
    } else {
        // A WAV converted from the mixdown earlier is still the mixdown.
        let all: Vec<String> = audio_in(sketch).iter().map(|p| file_name(p)).collect();
        let converted = |n: &String| n.to_ascii_lowercase().ends_with(".wav") && all.iter().any(|o| o != n && Path::new(o).file_stem() == Path::new(n).file_stem());
        let mix: Vec<String> = all.iter().filter(|n| !converted(n)).cloned().collect();
        (stems, mix)
    };
    let mut clips: Vec<Clip> = Vec::new();
    let mut notes = Vec::new();
    for f in files {
        let stem = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (path, ms) = if fl_plays(&f) {
            // A WAV made from an M4A earlier is listed once (with its M4A skipped below).
            match crate::audio::duration_ms(&f) {
                Ok(ms) => (f.clone(), ms),
                Err(e) => {
                    notes.push(ensure_code("audio.read", e));
                    continue;
                }
            }
        } else {
            let wav = f.with_extension("wav");
            if wav.is_file() {
                continue; // the WAV is (or will be) in the list itself
            }
            match crate::audio::convert_to_wav(&f, &wav) {
                Ok(ms) => {
                    let name = f.file_name().unwrap_or_default().to_string_lossy().to_string();
                    notes.push(app_err("sketch.converted", format!("{name} converted to WAV for FL Studio")).with("name", name).into());
                    (wav, ms)
                }
                Err(e) => {
                    notes.push(ensure_code("sketch.convertFailed", e));
                    continue;
                }
            }
        };
        if clips.iter().any(|c| Path::new(&c.path) == path) {
            continue;
        }
        clips.push(Clip { path: path.to_string_lossy().to_string(), name: stem, duration_ms: ms });
    }
    let skipped = clips.len().saturating_sub(crate::flp_build::MAX_CLIPS);
    clips.truncate(crate::flp_build::MAX_CLIPS);
    Playable { clips, notes, skipped, mixdown }
}

fn continue_in(sketch: &Path, template: &Path) -> Result<Continued, String> {
    if sketch.file_name().is_none_or(|n| n != SKETCH_DIR) || !sketch.is_dir() {
        return Err(path_err("sketch.notSketch", sketch, format!("not a BandLab sketch: {}", sketch.display())));
    }
    let song = sketch.parent().ok_or_else(|| String::from(app_err("project.badPath", "invalid sketch path")))?;
    let has_project = fs::read_dir(song)
        .map_err(|e| path_err("io.read", song, format!("can't read the song folder: {e}")))?
        .filter_map(|e| e.ok())
        .any(|e| e.path().is_file() && Daw::of_project(&e.path()).is_some());
    if has_project {
        return Err(app_err("sketch.hasProject", "This song already has a project: open it from the Library.").into());
    }
    let name = song.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let name = validate_name(&name)?;
    if !template.is_file() {
        return Err(path_err("template.missing", template, format!("template not found: {}", template.display())));
    }
    let target = song.join(format!("{name}.flp"));
    if target.exists() {
        return Err(app_err("project.nameTaken", format!("\"{name}.flp\" already exists there")).with("name", format!("{name}.flp")).into());
    }
    let Playable { clips, mut notes, skipped, mixdown } = playable_audio(sketch);
    let built = if clips.is_empty() {
        Err(app_err("sketch.noPlayable", "no audio FL Studio can play in the BandLab folder").into())
    } else {
        fs::read(template).map_err(|e| path_err("io.read", template, format!("could not read the template: {e}"))).and_then(|t| crate::flp_build::build(&t, &clips, None))
    };
    let flp = target.to_string_lossy().to_string();
    match built {
        Ok(bytes) => {
            // A new file only: never over anything already there.
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| path_err("io.create", &target, format!("could not create {}: {e}", target.display())))?;
            if let Err(e) = std::io::Write::write_all(&mut f, &bytes) {
                drop(f);
                let _ = fs::remove_file(&target);
                return Err(path_err("io.write", &target, format!("could not write {}: {e}", target.display())));
            }
            let note = (!notes.is_empty()).then(|| notes.iter().map(|n| detail_of(n)).collect::<Vec<_>>().join("; "));
            Ok(Continued { flp, clips: clips.len(), note, notes, skipped, mixdown })
        }
        Err(e) => {
            // The template alone, as before: the audio stays in BandLab/.
            copy_file(template, &target)?;
            let why = format!("The BandLab audio isn't in the project ({}): drag it in from the BandLab folder", detail_of(&e));
            notes.insert(0, app_err("sketch.notInProject", why).with("reason", e).into());
            let note = Some(notes.iter().map(|n| detail_of(n)).collect::<Vec<_>>().join("; "));
            Ok(Continued { flp, clips: 0, note, notes, skipped: 0, mixdown: Vec::new() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn temp(name: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("flsm-sketch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Dir(d)
    }
    fn write(p: &Path, bytes: &[u8]) -> PathBuf {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
        p.to_path_buf()
    }

    #[test]
    fn audio_types() {
        assert!(is_sketch_audio(Path::new("Night Run.MP3")));
        assert!(is_sketch_audio(Path::new("vox.m4a")));
        assert!(!is_sketch_audio(Path::new("stems.zip")));
        assert!(!is_sketch_audio(Path::new("notes.txt")));
    }

    #[test]
    fn continues_a_sketch_in_fl_once() {
        let d = temp("continue");
        let template = write(&d.0.join("Templates").join("Rap.flp"), b"template");
        let sketch = d.0.join("Projects").join("Night Run").join(SKETCH_DIR);
        write(&sketch.join("Night Run.mp3"), b"x");

        // Not real audio and not a real template: the template alone, with the reason.
        let done = continue_in(&sketch, &template).unwrap();
        assert_eq!(PathBuf::from(&done.flp), d.0.join("Projects").join("Night Run").join("Night Run.flp"));
        assert_eq!(done.clips, 0);
        assert!(done.note.as_deref().unwrap().contains("isn't in the project"), "{:?}", done.note);
        assert_eq!(fs::read(&done.flp).unwrap(), b"template");
        assert!(sketch.join("Night Run.mp3").is_file(), "the BandLab audio stays");
        // It has a project now: not a sketch any more.
        assert!(continue_in(&sketch, &template).unwrap_err().contains("already has a project"));
        assert_eq!(fs::read(&done.flp).unwrap(), b"template");
        // Only a BandLab folder is a sketch.
        assert!(continue_in(&d.0.join("Projects").join("Night Run"), &template).is_err());
    }

    fn tone(path: &Path, secs: f32) {
        let samples: Vec<f32> = (0..(44_100.0 * secs) as usize * 2).map(|i| ((i / 2) as f32 * 0.05).sin() * 0.3).collect();
        crate::audio::write_wav(path, &samples, 2, 44_100).unwrap();
    }

    #[test]
    fn stems_go_on_the_playlist_without_the_mixdown_and_extras_are_counted() {
        let d = temp("stems");
        let sketch = d.0.join("Night Run").join(SKETCH_DIR);
        let stems = sketch.join(crate::phone_inbox::STEMS_DIR);
        fs::create_dir_all(&stems).unwrap();
        tone(&sketch.join("Night Run.wav"), 0.1);
        tone(&stems.join("Drums.wav"), 0.1);
        tone(&stems.join("Vox.wav"), 0.1);
        let p = playable_audio(&sketch);
        let names: Vec<&str> = p.clips.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Drums", "Vox"], "the stems only");
        assert_eq!(p.mixdown, vec!["Night Run.wav"]);
        assert_eq!(p.skipped, 0);
        // More than MAX_CLIPS stems: the first ones, and how many were left off.
        for i in 0..21 {
            tone(&stems.join(format!("stem {i:02}.wav")), 0.05);
        }
        let p = playable_audio(&sketch);
        assert_eq!(p.clips.len(), crate::flp_build::MAX_CLIPS);
        assert_eq!(p.skipped, 23 - crate::flp_build::MAX_CLIPS);
        // No Stems folder: everything in BandLab/ is laid out, no mixdown aside.
        let flat = d.0.join("Flat").join(SKETCH_DIR);
        fs::create_dir_all(&flat).unwrap();
        tone(&flat.join("a.wav"), 0.05);
        let p = playable_audio(&flat);
        assert_eq!((p.clips.len(), p.mixdown.len(), p.skipped), (1, 0, 0));
    }

    #[test]
    fn lays_the_bandlab_audio_out_in_a_new_project() {
        let empty = Path::new("/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Templates/Empty/Empty.flp");
        if !empty.is_file() {
            return; // FL Studio isn't installed here
        }
        let d = temp("layout");
        let sketch = d.0.join("Projects").join("Night Run").join(SKETCH_DIR);
        fs::create_dir_all(&sketch).unwrap();
        tone(&sketch.join("1 - Beat.wav"), 2.0);
        tone(&sketch.join("2 - Vocals.wav"), 1.5);
        write(&sketch.join(".hidden.wav"), b"x");
        let done = continue_in(&sketch, empty).unwrap();
        assert_eq!(done.clips, 2, "{:?}", done.note);
        assert_eq!(done.note, None);
        let meta = crate::flp_metadata::parse_flp_metadata(Path::new(&done.flp)).unwrap();
        let samples: Vec<String> = meta.samples.iter().map(|s| s.replace('\\', "/")).collect();
        assert!(samples.iter().any(|s| s.ends_with("BandLab/1 - Beat.wav")), "{samples:?}");
        assert!(samples.iter().any(|s| s.ends_with("BandLab/2 - Vocals.wav")), "{samples:?}");
    }

    /// A real phone export: `HIVO_M4A=<file.m4a> cargo test real_m4a -- --ignored`.
    /// Converts a copy in a temp folder (the file itself is only read).
    #[test]
    #[ignore]
    fn converts_a_real_m4a() {
        let src = PathBuf::from(std::env::var("HIVO_M4A").expect("HIVO_M4A"));
        let d = temp("real-m4a");
        let out = d.0.join("converted.wav");
        let ms = crate::audio::convert_to_wav(&src, &out).unwrap();
        println!("converted {:.1} s, {} bytes", ms / 1000.0, fs::metadata(&out).unwrap().len());
        assert!(ms > 0.0);
    }

    #[test]
    fn converts_what_fl_studio_wouldnt_play() {
        let d = temp("convert");
        let src = d.0.join("take.wav");
        tone(&src, 1.0);
        // As if it were an M4A: decoded, written as a WAV.
        let out = d.0.join("take-converted.wav");
        let ms = crate::audio::convert_to_wav(&src, &out).unwrap();
        assert!((ms - 1000.0).abs() < 1.0, "{ms}");
        assert!((crate::audio::duration_ms(&out).unwrap() - 1000.0).abs() < 1.0);
        // Never over an existing file.
        assert!(crate::audio::convert_to_wav(&src, &out).is_err());
        assert!(crate::audio::convert_to_wav(&d.0.join("missing.m4a"), &d.0.join("x.wav")).is_err());
        assert!(!d.0.join("x.wav").exists(), "nothing half made");
    }

    #[test]
    fn sketch_commands_stay_inside_settings() {
        let f = crate::scope::tests::fixture("sketch");
        let s = |p: &Path| p.to_string_lossy().to_string();
        let outside = f.outside.join("Idea").join(SKETCH_DIR);
        fs::create_dir_all(&outside).unwrap();
        // continue_sketch's sketch and the inbox's parent folder: linked folders only.
        assert!(f.scope.folder_in_roots(&s(&outside)).is_err());
        assert!(f.scope.folder_in_roots(&s(&f.root.join("..").join("Elsewhere"))).is_err());
        assert!(f.scope.folder_in_roots(&s(&f.root)).is_ok());
        // The template check is the New song one.
        assert!(check_template(&f.scope, None, &s(&f.outside.join("Other.flp"))).is_err());
        assert!(check_template(&f.scope, None, &s(&f.root.join("Envy").join("Envy.flp"))).is_ok());
    }
}
