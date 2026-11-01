use crate::models::{RenderEvent, RenderStatus};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const RENDER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(300);

pub(crate) fn unique_output_path(output_folder: &Path, base_name: &str, ext: &str) -> PathBuf {
    let candidate = output_folder.join(format!("{base_name}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    let mut n = 1;
    loop {
        let candidate = output_folder.join(format!("{base_name} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// FL Studio's command-line switch prefix: `/R /Emp3 /F<folder>` on Windows,
/// `-R -Emp3 -F<folder>` on macOS (Image-Line's manual, "Command line export
/// options"). With `/` on a Mac, FL took `/F/var/folders/…` for a file to
/// open and said it "could not be found".
#[cfg(target_os = "macos")]
const SWITCH: char = '-';
#[cfg(not(target_os = "macos"))]
const SWITCH: char = '/';

/// Render every project in `folder` (the staging folder, which holds one).
/// The folder ends with a separator, as in the manual's examples.
fn render_args(switch: char, format: &str, folder: &Path) -> Vec<String> {
    let mut dir = folder.display().to_string();
    if !dir.ends_with(std::path::MAIN_SEPARATOR) {
        dir.push(std::path::MAIN_SEPARATOR);
    }
    vec![format!("{switch}R"), format!("{switch}E{format}"), format!("{switch}F{dir}")]
}

fn emit(app: &AppHandle, event: RenderEvent) {
    let _ = app.emit("render-progress", event);
}

fn render_one(
    fl_studio_path: &str,
    project_path: &str,
    output_folder: &Path,
    format: &str,
    output_name: Option<&str>,
) -> Result<(PathBuf, Option<String>), String> {
    let src = Path::new(project_path);
    let file_name = src
        .file_name()
        .ok_or_else(|| "invalid project path".to_string())?;
    let base_name = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    // Unique per render: a reused folder could hand a stale file from an
    // earlier failed render to find_rendered_file.
    static RENDER_SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!(
        "flsm-render-{}-{nanos}-{}",
        std::process::id(),
        RENDER_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("could not create staging folder: {e}"))?;

    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    // The samples the project stores relative to its folder go along, or
    // FL would render without them. The original .flp is never touched.
    let raw_samples = crate::daws::read_project(crate::daws::Daw::FlStudio, src).map(|m| m.samples).unwrap_or_default();
    let project_dir = src.parent().unwrap_or(Path::new("."));
    let staged = stage_samples(project_dir, &temp_dir, &raw_samples);
    let staged_flp = staged.dir.join(file_name);
    if let Err(e) = fs::create_dir_all(&staged.dir).and_then(|_| fs::copy(src, &staged_flp)) {
        cleanup(&temp_dir);
        return Err(format!("could not stage project file: {e}"));
    }

    let mut child = match Command::new(fl_studio_path)
        .args(render_args(SWITCH, format, &staged.dir))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            cleanup(&temp_dir);
            return Err(format!("could not launch FL Studio renderer: {e}"));
        }
    };

    let started = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if started.elapsed() > RENDER_TIMEOUT {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => {
                cleanup(&temp_dir);
                return Err(format!("error waiting for renderer: {e}"));
            }
        }
    }

    // Give the renderer a brief grace period to flush the file to disk after exit.
    std::thread::sleep(Duration::from_millis(250));

    let rendered_file = match find_rendered_file(&staged.dir, &base_name, format) {
        Some(f) => f,
        None => {
            cleanup(&temp_dir);
            let reason = if timed_out {
                "render timed out and no output was produced"
            } else {
                "FL Studio exited but no mixdown was written. If FL Studio is already open, close it and render again (it can't render from the command line while it runs); otherwise check the FL Studio path and format in Settings"
            };
            return Err(reason.to_string());
        }
    };

    if let Err(e) = fs::create_dir_all(output_folder) {
        cleanup(&temp_dir);
        return Err(format!("could not create output folder: {e}"));
    }
    let dest = unique_output_path(output_folder, output_name.unwrap_or(&base_name), format);
    let copy_result = fs::copy(&rendered_file, &dest);
    cleanup(&temp_dir);
    copy_result.map_err(|e| format!("could not move rendered file: {e}"))?;

    let warning = (!staged.missing.is_empty()).then(|| {
        let shown: Vec<&str> = staged.missing.iter().take(3).map(String::as_str).collect();
        let more = staged.missing.len().saturating_sub(3);
        format!(
            "Rendered, but {} sample(s) stored next to the project weren't found, so they're silent in this mixdown: {}{}",
            staged.missing.len(),
            shown.join(", "),
            if more > 0 { format!(" (+{more})") } else { String::new() }
        )
    });
    Ok((dest, warning))
}

/// How many folders up a project-relative sample may point (`..\..\Kick.wav`).
const MAX_UP: usize = 4;

/// Where the project is staged, and which project-relative samples
/// couldn't be put next to it.
struct Staged {
    /// The folder the .flp goes in (FL renders every project in it).
    dir: PathBuf,
    /// Stored paths that weren't found next to the project (or climb too far).
    missing: Vec<String>,
}

/// Rebuilds, inside `temp_root`, the part of the project's folder its
/// relative samples live in (`Audio/take.wav`, `../Kick.wav`), so FL finds
/// them when it renders the staged copy. The staged .flp sits `MAX_UP`
/// folders deep at most, so `..` stays inside `temp_root`. Files are
/// hard-linked when the volume allows it, else copied; nothing outside
/// `temp_root` is written. Absolute and `%FLStudio…%` paths need nothing.
fn stage_samples(project_dir: &Path, temp_root: &Path, raw: &[String]) -> Staged {
    let mut missing = Vec::new();
    // (stored path, how many folders up, the rest)
    let mut relative: Vec<(&str, usize, Vec<String>)> = Vec::new();
    for r in raw {
        let native = crate::resolve::native(r);
        if !crate::resolve::is_project_relative(&native) {
            continue;
        }
        let parts: Vec<&str> = r.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
        let up = parts.iter().take_while(|p| **p == "..").count();
        let rest: Vec<String> = parts[up..].iter().map(|p| p.to_string()).collect();
        if up > MAX_UP || rest.is_empty() || rest.iter().any(|p| p == "..") {
            missing.push(r.clone());
            continue;
        }
        relative.push((r.as_str(), up, rest));
    }
    let depth = relative.iter().map(|(_, up, _)| *up).max().unwrap_or(0);
    let mut dir = temp_root.to_path_buf();
    for i in 0..depth {
        dir.push(format!("p{i}"));
    }
    for (stored, up, rest) in relative {
        let mut from = project_dir.to_path_buf();
        let mut to = dir.clone();
        for _ in 0..up {
            from.pop();
            to.pop();
        }
        for part in &rest {
            from.push(part);
            to.push(part);
        }
        let ok = from.is_file()
            && to.parent().is_some_and(|p| fs::create_dir_all(p).is_ok())
            && (to.exists() || fs::hard_link(&from, &to).is_ok() || fs::copy(&from, &to).is_ok());
        if !ok {
            missing.push(stored.to_string());
        }
    }
    Staged { dir, missing }
}

fn find_rendered_file(dir: &Path, base_name: &str, format: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext_matches = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case(format))
            .unwrap_or(false);
        let stem_matches = path
            .file_stem()
            .map(|s| s.to_string_lossy() == base_name)
            .unwrap_or(false);
        if ext_matches && stem_matches {
            return Some(path);
        }
    }
    None
}

/// Renders sequentially on a worker thread (a batch can take many minutes;
/// a sync command would block the UI thread the whole time).
/// `output_names`, when given, lines up with `project_paths` and names each
/// file (e.g. "01 - Envy" for an album export) instead of the project name.
/// FL Studio, the format and the export folder come from Settings; every
/// project must be an FL Studio project in a linked folder.
#[tauri::command]
pub async fn render_projects(
    app: AppHandle,
    project_paths: Vec<String>,
    subfolder: Option<String>,
    output_names: Option<Vec<String>>,
) -> Result<(), String> {
    let scope = crate::scope::Scope::load(&app)?;
    let fl_studio_path = scope.fl_studio()?.to_string_lossy().to_string();
    let format = scope.render_format.clone();
    if !matches!(format.as_str(), "wav" | "mp3" | "ogg" | "flac") {
        return Err(format!("unsupported render format: {format}"));
    }
    let mut output_folder = scope.output()?.to_path_buf();
    if let Some(sub) = subfolder.as_deref().and_then(crate::scope::safe_subfolder) {
        output_folder.push(sub);
    }
    for p in &project_paths {
        scope.fl_project(p)?;
    }
    let output_names = output_names.map(|names| names.iter().map(|n| crate::audio::safe_name(n)).collect());
    tauri::async_runtime::spawn_blocking(move || {
        render_all(&app, project_paths, output_folder, &fl_studio_path, &format, output_names)
    })
    .await
    .map_err(|e| format!("render worker failed: {e}"))
}

fn render_all(
    app: &AppHandle,
    project_paths: Vec<String>,
    output_folder: PathBuf,
    fl_studio_path: &str,
    format: &str,
    output_names: Option<Vec<String>>,
) {
    for (i, project_path) in project_paths.into_iter().enumerate() {
        let output_name = output_names.as_ref().and_then(|n| n.get(i)).map(String::as_str);
        let project_name = Path::new(&project_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| project_path.clone());

        emit(
            app,
            RenderEvent {
                project_path: project_path.clone(),
                project_name: project_name.clone(),
                status: RenderStatus::Rendering,
                message: None,
                output_path: None,
            },
        );

        match render_one(fl_studio_path, &project_path, &output_folder, format, output_name) {
            Ok((dest, warning)) => emit(
                app,
                RenderEvent {
                    project_path: project_path.clone(),
                    project_name: project_name.clone(),
                    status: RenderStatus::Done,
                    message: warning,
                    output_path: Some(dest.to_string_lossy().to_string()),
                },
            ),
            Err(message) => emit(
                app,
                RenderEvent {
                    project_path: project_path.clone(),
                    project_name: project_name.clone(),
                    status: RenderStatus::Error,
                    message: Some(message),
                    output_path: None,
                },
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_args_use_the_platform_switch() {
        let dir = std::env::temp_dir().join("flsm-render-1-2-3");
        let sep = std::path::MAIN_SEPARATOR;
        let mac = render_args('-', "mp3", &dir);
        assert_eq!(mac, vec!["-R".to_string(), "-Emp3".to_string(), format!("-F{}{sep}", dir.display())]);
        let win = render_args('/', "wav", &dir);
        assert_eq!(win[..2], ["/R".to_string(), "/Ewav".to_string()]);
        assert!(win[2].starts_with("/F") && win[2].ends_with(sep));
        // Already ends with a separator: not doubled.
        let with_sep = PathBuf::from(format!("{}{sep}", dir.display()));
        assert_eq!(render_args('-', "wav", &with_sep)[2], format!("-F{}{sep}", dir.display()));
    }

    #[test]
    fn relative_samples_are_staged_next_to_the_copy() {
        let root = std::env::temp_dir().join(format!("flsm-stage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let project = root.join("Projects").join("Envy");
        fs::create_dir_all(project.join("Audio")).unwrap();
        fs::write(project.join("Envy.flp"), b"flp").unwrap();
        fs::write(project.join("Audio").join("take.wav"), b"take").unwrap();
        fs::write(root.join("Projects").join("Kick.wav"), b"kick").unwrap();
        let temp = root.join("stage");
        fs::create_dir_all(&temp).unwrap();
        let raw = vec![
            r"Audio\take.wav".to_string(),
            "../Kick.wav".to_string(),
            "Audio/gone.wav".to_string(),
            "../../../../../../too far.wav".to_string(),
            "/abs/elsewhere.wav".to_string(),
            "%FLStudioUserData%/Audio/x.wav".to_string(),
        ];
        let staged = stage_samples(&project, &temp, &raw);
        // One level up is needed, so the copy sits one folder deep.
        assert_eq!(staged.dir, temp.join("p0"));
        assert_eq!(fs::read(staged.dir.join("Audio").join("take.wav")).unwrap(), b"take");
        assert_eq!(fs::read(temp.join("Kick.wav")).unwrap(), b"kick");
        assert_eq!(staged.missing, vec!["../../../../../../too far.wav".to_string(), "Audio/gone.wav".to_string()]);
        // The originals are untouched.
        assert_eq!(fs::read(project.join("Audio").join("take.wav")).unwrap(), b"take");
        assert_eq!(fs::read(project.join("Envy.flp")).unwrap(), b"flp");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uses_dashes() {
        assert_eq!(SWITCH, '-');
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_slashes() {
        assert_eq!(SWITCH, '/');
    }
}
