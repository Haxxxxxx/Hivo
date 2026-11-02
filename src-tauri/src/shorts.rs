//! 9:16 shorts for reels/stories/TikTok, rendered locally with ffmpeg (free,
//! offline): the layout image the app draws (art, title, artist, release
//! line) + an animated waveform + the snippet cut from the real mixdown.

use crate::error::{app_err, path_err};
use crate::audio::safe_name;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Output size: what Reels, TikTok and Shorts expect.
pub const WIDTH: u32 = 1080;
pub const HEIGHT: u32 = 1920;
/// Waveform box. The layout image leaves this area free (src/lib/shorts.ts).
pub const WAVE_W: u32 = 920;
pub const WAVE_H: u32 = 240;
pub const WAVE_Y: u32 = 1250;
const FPS: u32 = 30;
const RENDER_TIMEOUT: Duration = Duration::from_secs(180);

/// ffmpeg locations to try when it isn't on PATH. Apps opened from Finder
/// don't inherit the shell's PATH, so Homebrew's folder must be listed.
fn candidate_paths() -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut out: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(exe)).collect())
        .unwrap_or_default();
    #[cfg(not(windows))]
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"] {
        out.push(Path::new(d).join(exe));
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(Path::new(&local).join("Microsoft").join("WinGet").join("Links").join(exe));
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            out.push(Path::new(&pf).join("ffmpeg").join("bin").join(exe));
        }
        out.push(PathBuf::from("C:\\ffmpeg\\bin").join(exe));
    }
    out
}

/// The ffmpeg to run: only the one saved in Settings (picked by hand, or a
/// found one the user confirmed), and only if it's still a file called
/// ffmpeg / ffmpeg.exe. Nothing found on PATH runs before it's confirmed.
pub fn find_ffmpeg(configured: Option<PathBuf>) -> Option<PathBuf> {
    configured.filter(|p| crate::scope::is_ffmpeg(p))
}

/// An ffmpeg on this machine (FFMPEG_PATH, then PATH and the usual install
/// folders), for Settings to show and the user to confirm. Never run here.
pub fn detect_ffmpeg() -> Option<PathBuf> {
    let env = std::env::var_os("FFMPEG_PATH").map(PathBuf::from);
    env.into_iter().chain(candidate_paths()).find(|p| crate::scope::is_ffmpeg(p))
}

/// Best available H.264 encoder from `ffmpeg -encoders` output.
fn pick_encoder(encoders: &str) -> Option<&'static str> {
    ["libx264", "h264_videotoolbox", "h264_mf", "libopenh264"]
        .into_iter()
        .find(|e| encoders.lines().any(|l| l.split_whitespace().nth(1) == Some(*e)))
}

fn encoder_for(ffmpeg: &Path) -> Result<&'static str, String> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| path_err("ffmpeg.run", ffmpeg, format!("couldn't run ffmpeg at {}: {e}", ffmpeg.display())))?;
    pick_encoder(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| app_err("ffmpeg.noH264", "This ffmpeg has no H.264 encoder. Install a full build (brew install ffmpeg / winget install Gyan.FFmpeg).").into())
}

fn encoder_args(encoder: &str) -> Vec<String> {
    let v: &[&str] = match encoder {
        "libx264" => &["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high"],
        "h264_videotoolbox" => &["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high"],
        other => return vec!["-c:v".into(), other.into(), "-b:v".into(), "8M".into()],
    };
    v.iter().map(|s| s.to_string()).collect()
}

/// Furthest into a mixdown a short may start (a song, not a DJ set).
pub const MAX_START_SEC: f64 = 3.0 * 3600.0;
/// Biggest layout PNG accepted (the app's are ~1-3 MB).
const MAX_LAYOUT_BYTES: usize = 16 * 1024 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// ffmpeg's demuxer for a mixdown, by extension: the format is forced so a
/// file that's really something else (a playlist, a concat list) is never
/// probed as that. None for anything a mixdown can't be.
pub fn audio_format(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "wav" => Some("wav"),
        "mp3" => Some("mp3"),
        "flac" => Some("flac"),
        "ogg" => Some("ogg"),
        _ => None,
    }
}

/// The layout image as sent by the app: a PNG (magic + IHDR), not too big.
pub fn check_layout_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_LAYOUT_BYTES {
        return Err(app_err("shorts.layoutTooLarge", "the layout image is too large").into());
    }
    if bytes.len() < 24 || !bytes.starts_with(PNG_MAGIC) || &bytes[12..16] != b"IHDR" {
        return Err(app_err("shorts.layoutInvalid", "the layout image isn't a PNG").into());
    }
    let dim = |i: usize| u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let (w, h) = (dim(16), dim(20));
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        return Err(app_err("shorts.layoutInvalid", "the layout image has an odd size").into());
    }
    Ok(())
}

/// Whether a clip range can be rendered.
pub fn valid_range(start: f64, length: f64) -> bool {
    start.is_finite() && length.is_finite() && length > 0.0 && length <= 90.0 && (0.0..=MAX_START_SEC).contains(&start)
}

/// The full ffmpeg argument list for one short (pure, so it's testable).
/// `audio_fmt` is `audio_format(master)`.
pub fn build_args(layout: &Path, master: &Path, audio_fmt: &str, start: f64, length: f64, encoder: &str, out: &Path) -> Vec<String> {
    let fade_out = (length - 0.6).max(0.0);
    let filter = format!(
        "[1:a]asplit=2[aw][ao];\
         [aw]showwaves=s={WAVE_W}x{WAVE_H}:mode=cline:draw=full:rate={FPS}:scale=sqrt:colors=0xE8743B,format=rgba[w];\
         [0:v]scale={WIDTH}:{HEIGHT},setsar=1,format=rgba[bg];\
         [bg][w]overlay=x=(W-w)/2:y={WAVE_Y}:shortest=1,format=yuv420p[v];\
         [ao]afade=t=in:st=0:d=0.3,afade=t=out:st={fade_out:.3}:d=0.6[a]"
    );
    let mut args: Vec<String> = [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        // Plain local files only: a mixdown that is really a playlist can't
        // make ffmpeg open other files or URLs.
        // Formats are forced: the layout is read as a PNG image and the
        // mixdown with the demuxer its extension names, nothing probed.
        "-protocol_whitelist", "file", "-f", "image2", "-c:v", "png", "-loop", "1", "-framerate", &FPS.to_string(), "-i", &format!("file:{}", layout.to_string_lossy()),
        "-protocol_whitelist", "file", "-f", audio_fmt, "-ss", &format!("{start:.3}"), "-t", &format!("{length:.3}"), "-i", &format!("file:{}", master.to_string_lossy()),
        "-filter_complex", &filter,
        "-map", "[v]", "-map", "[a]",
        "-t", &format!("{length:.3}"), "-r", &FPS.to_string(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(encoder_args(encoder));
    args.extend(
        ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(out.to_string_lossy().to_string());
    args
}

/// Runs ffmpeg, killing it if it hangs; returns the end of stderr on failure.
fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| app_err("ffmpeg.start", format!("couldn't start ffmpeg: {e}")))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" / ");
                return Err(app_err("ffmpeg.failed", format!("ffmpeg failed: {}", if tail.is_empty() { status.to_string() } else { tail })).into());
            }
            Ok(None) if started.elapsed() > RENDER_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(app_err("ffmpeg.timeout", "ffmpeg took too long and was stopped").into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(app_err("ffmpeg.wait", format!("error waiting for ffmpeg: {e}")).into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortsStatus {
    /// The ffmpeg saved in Settings (the only one ever run).
    pub path: Option<String>,
    /// An ffmpeg found on this machine but not confirmed yet (never run).
    pub found: Option<String>,
    pub encoder: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn shorts_status(app: tauri::AppHandle) -> ShortsStatus {
    let configured = crate::scope::Scope::load(&app).ok().and_then(|s| s.ffmpeg());
    tauri::async_runtime::spawn_blocking(move || match find_ffmpeg(configured) {
        None => ShortsStatus { path: None, found: detect_ffmpeg().map(|p| p.to_string_lossy().into()), encoder: None, error: None },
        Some(p) => match encoder_for(&p) {
            Ok(e) => ShortsStatus { path: Some(p.to_string_lossy().into()), found: None, encoder: Some(e.into()), error: None },
            Err(err) => ShortsStatus { path: Some(p.to_string_lossy().into()), found: None, encoder: None, error: Some(err) },
        },
    })
    .await
    .unwrap_or(ShortsStatus { path: None, found: None, encoder: None, error: Some(app_err("ffmpeg.check", "couldn't check for ffmpeg").into()) })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortClip {
    pub label: String,
    pub start_sec: f64,
    pub length_sec: f64,
    /// The 1080×1920 layout PNG, base64 (drawn by the app).
    pub layout_png: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortResult {
    pub label: String,
    pub path: Option<String>,
    pub error: Option<String>,
}

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    // Small std-only decoder: the layout PNG arrives as standard base64.
    let s = s.split_once(',').map_or(s, |(head, body)| if head.starts_with("data:") { body } else { s });
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let clean: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c).ok_or_else(|| String::from(app_err("shorts.layoutInvalid", "invalid base64 in layout image")))? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// Renders each clip to `<export>/Launch Kits/<song>/shorts/<label>.mp4`
/// (`song` = the workspace key, `previous_folder` = the kit folder the app
/// recorded for it, see `kits::resolve_kit_dir`).
#[tauri::command]
pub async fn render_shorts(
    app: tauri::AppHandle,
    song: String,
    master: String,
    clips: Vec<ShortClip>,
    folder_name: String,
    previous_folder: Option<String>,
) -> Result<Vec<ShortResult>, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let configured = scope.ffmpeg();
    let owner = crate::kits::kit_owner(&scope.known_file(&song)?.to_string_lossy());
    let master = scope.audio(&master)?.to_string_lossy().to_string();
    let output_folder = scope.output()?.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = find_ffmpeg(configured).ok_or_else(|| String::from(app_err("ffmpeg.notSetUp", "ffmpeg isn't set up yet. See Settings → Shorts (ffmpeg).")))?;
        let encoder = encoder_for(&ffmpeg)?;
        let master = PathBuf::from(&master);
        if !master.is_file() {
            return Err(path_err("shorts.noMixdown", &master, format!("The mixdown is missing: {}", master.display())));
        }
        let audio_fmt = audio_format(&master).ok_or_else(|| String::from(app_err("shorts.badFormat", "That mixdown isn't WAV, MP3, FLAC or OGG.")))?;
        let kit = crate::kits::resolve_kit_dir(Path::new(&output_folder), &folder_name, &owner, previous_folder.as_deref())?;
        let out_dir = crate::kits::sub_dir(&kit, "shorts")?;
        let temp = std::env::temp_dir().join(format!("flsm-shorts-{}", std::process::id()));
        fs::create_dir_all(&temp).map_err(|e| path_err("io.create", &temp, format!("could not create a temp folder: {e}")))?;

        let results = clips
            .iter()
            .map(|clip| {
                let render = || -> Result<PathBuf, String> {
                    if !valid_range(clip.start_sec, clip.length_sec) {
                        return Err(app_err("shorts.badRange", "invalid clip range").into());
                    }
                    if clip.layout_png.len() > MAX_LAYOUT_BYTES * 4 / 3 + 64 {
                        return Err(app_err("shorts.layoutTooLarge", "the layout image is too large").into());
                    }
                    let png = decode_base64(&clip.layout_png)?;
                    check_layout_png(&png)?;
                    let layout = temp.join(format!("{}.png", safe_name(&clip.label)));
                    fs::write(&layout, png).map_err(|e| path_err("io.write", &layout, format!("could not write the layout: {e}")))?;
                    let out = out_dir.join(format!("{}.mp4", safe_name(&clip.label)));
                    // ffmpeg -y would write through a planted link.
                    crate::kits::clear_target(&out).map_err(|e| path_err("io.write", &out, format!("could not write {}: {e}", out.display())))?;
                    let result = run_ffmpeg(&ffmpeg, &build_args(&layout, &master, audio_fmt, clip.start_sec, clip.length_sec, encoder, &out));
                    let _ = fs::remove_file(&layout);
                    result.map(|_| out)
                };
                match render() {
                    Ok(p) => ShortResult { label: clip.label.clone(), path: Some(p.to_string_lossy().into()), error: None },
                    Err(e) => ShortResult { label: clip.label.clone(), path: None, error: Some(e) },
                }
            })
            .collect();
        let _ = fs::remove_dir_all(&temp);
        Ok(results)
    })
    .await
    .map_err(|e| app_err("task.failed", format!("rendering failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_best_encoder() {
        let listing = " V....D libx264rgb  libx264 RGB\n V....D h264_videotoolbox VideoToolbox\n V....D libx264 H.264\n";
        assert_eq!(pick_encoder(listing), Some("libx264"));
        assert_eq!(pick_encoder(" V....D h264_videotoolbox VT\n"), Some("h264_videotoolbox"));
        assert_eq!(pick_encoder(" V....D mpeg4 MPEG-4\n"), None);
    }

    #[test]
    fn builds_a_nine_by_sixteen_command() {
        let args = build_args(Path::new("/tmp/l.png"), Path::new("/tmp/m.wav"), "wav", 12.5, 15.0, "libx264", Path::new("/tmp/o.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-protocol_whitelist file -f wav -ss 12.500 -t 15.000 -i file:/tmp/m.wav"), "{joined}");
        assert!(joined.contains("-protocol_whitelist file -f image2 -c:v png -loop 1"), "{joined}");
        assert!(joined.contains("scale=1080:1920"));
        // Default draw=scale makes the strokes ~6% opaque (murky on dark).
        assert!(joined.contains("draw=full"));
        assert!(joined.contains("afade=t=out:st=14.400:d=0.6"));
        assert!(joined.contains("-c:v libx264") && joined.contains("-c:a aac"));
        assert_eq!(args.last().unwrap(), "/tmp/o.mp4");
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("data:image/png;base64,aGk=").unwrap(), b"hi");
        assert!(decode_base64("a$b=").is_err());
    }

    #[test]
    fn forces_formats_and_checks_inputs() {
        assert_eq!(audio_format(Path::new("/m/Mix.WAV")), Some("wav"));
        assert_eq!(audio_format(Path::new("/m/mix.flac")), Some("flac"));
        assert_eq!(audio_format(Path::new("/m/list.m3u8")), None);
        assert_eq!(audio_format(Path::new("/m/mix")), None);

        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(&[0, 0, 0, 13]);
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&1080u32.to_be_bytes());
        png.extend_from_slice(&1920u32.to_be_bytes());
        assert!(check_layout_png(&png).is_ok());
        assert!(check_layout_png(b"GIF89a not a png at all.....").is_err());
        let mut huge = png.clone();
        huge[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(check_layout_png(&huge).is_err());
        assert!(check_layout_png(&vec![0u8; MAX_LAYOUT_BYTES + 1]).is_err());

        assert!(valid_range(12.0, 15.0));
        assert!(!valid_range(MAX_START_SEC + 1.0, 15.0));
        assert!(!valid_range(f64::NAN, 15.0));
        assert!(!valid_range(-1.0, 15.0));
        assert!(!valid_range(0.0, 91.0));
    }

    #[test]
    fn finds_a_configured_ffmpeg_and_runs_nothing_else() {
        let dir = std::env::temp_dir().join(format!("flsm-fake-ffmpeg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("ffmpeg");
        fs::write(&fake, b"").unwrap();
        assert_eq!(find_ffmpeg(Some(fake.clone())), Some(fake.clone()));
        // Anything not called ffmpeg is skipped, even if it's handed in.
        let payload = dir.join("payload.sh");
        fs::write(&payload, b"#!/bin/sh").unwrap();
        assert_ne!(find_ffmpeg(Some(payload.clone())), Some(payload));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Manual check: render a layout PNG drawn by the app.
    /// `FLSM_SHORT_LAYOUT=layout.png FLSM_SHORT_OUT=out.mp4 cargo test given_layout`
    #[test]
    fn renders_a_given_layout() {
        let (Ok(layout), Ok(out)) = (std::env::var("FLSM_SHORT_LAYOUT"), std::env::var("FLSM_SHORT_OUT")) else { return };
        let ffmpeg = detect_ffmpeg().expect("ffmpeg");
        let rate = 44100u32;
        // A pulsing tone so the waveform visibly moves.
        let tone: Vec<f32> = (0..rate * 8)
            .map(|i| {
                let t = i as f64 / rate as f64;
                let env = 0.25 + 0.6 * (t * std::f64::consts::PI * 2.0).sin().abs();
                (env * (t * 220.0 * std::f64::consts::TAU).sin()) as f32
            })
            .collect();
        let master = std::env::temp_dir().join(format!("flsm-given-{}.wav", std::process::id()));
        crate::audio::write_wav(&master, &tone, 1, rate).unwrap();
        let result = run_ffmpeg(&ffmpeg, &build_args(Path::new(&layout), &master, "wav", 0.0, 6.0, encoder_for(&ffmpeg).unwrap(), Path::new(&out)));
        let _ = fs::remove_file(&master);
        result.expect("render");
    }

    /// Real render when ffmpeg is installed (skipped otherwise): a 3 s
    /// short must come out 1080×1920 H.264 + AAC, about 3 s long.
    #[test]
    fn renders_a_real_short_if_ffmpeg_is_installed() {
        let Some(ffmpeg) = detect_ffmpeg() else {
            eprintln!("ffmpeg not found; skipping");
            return;
        };
        let encoder = encoder_for(&ffmpeg).expect("H.264 encoder");
        let dir = std::env::temp_dir().join(format!("flsm-shorts-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let rate = 44100u32;
        let tone: Vec<f32> = (0..rate * 6).map(|i| (0.4 * (i as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin()) as f32).collect();
        let master = dir.join("mix.wav");
        crate::audio::write_wav(&master, &tone, 1, rate).unwrap();
        let layout = dir.join("layout.png");
        let made = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x15110e:s=1080x1920", "-frames:v", "1"])
            .arg(&layout)
            .status()
            .unwrap();
        assert!(made.success());
        let out = dir.join("short.mp4");
        run_ffmpeg(&ffmpeg, &build_args(&layout, &master, "wav", 1.0, 3.0, encoder, &out)).expect("render");
        let probe = Command::new(ffmpeg.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }))
            .args(["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "default=nw=1"])
            .arg(&out)
            .output();
        let _ = fs::remove_dir_all(&dir);
        let Ok(probe) = probe else { return };
        let info = String::from_utf8_lossy(&probe.stdout);
        assert!(info.contains("codec_name=h264"), "{info}");
        assert!(info.contains("codec_name=aac"), "{info}");
        assert!(info.contains("width=1080") && info.contains("height=1920"), "{info}");
        let duration: f64 = info.lines().find_map(|l| l.strip_prefix("duration=")).and_then(|d| d.parse().ok()).unwrap();
        assert!((duration - 3.0).abs() < 0.25, "duration {duration}");
    }
}
