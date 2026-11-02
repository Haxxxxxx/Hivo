//! Mixdown analysis for the Launch Kit: duration, a loudness curve, the
//! strongest stretches for reels/stories, and cutting those as clips.
//! Decoding is pure Rust (symphonia), so nothing extra to install.

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// One loudness value per this many seconds.
const WINDOW_SEC: f64 = 0.5;
const FADE_SEC: f64 = 0.3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysis {
    pub duration_sec: f64,
    pub window_sec: f64,
    /// RMS loudness per window, normalized so the loudest is 1.
    pub energy: Vec<f32>,
    pub snippets: Vec<Snippet>,
    /// Estimated from the audio; None for silence or too short a file.
    pub key: Option<crate::key::KeyEstimate>,
    /// The file itself, for the distributor checks (WAV, 44.1 kHz, 16/24-bit).
    pub master: MasterSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSpec {
    /// File extension, lowercase ("wav", "mp3"…).
    pub container: String,
    pub sample_rate: u32,
    pub channels: u32,
    /// None for lossy formats (MP3/OGG have no bit depth).
    pub bits_per_sample: Option<u32>,
    /// Highest absolute sample, 0–1 (1 = 0 dBFS).
    pub peak: f32,
    /// Samples at full scale: a sign of clipping.
    pub clipped_samples: u64,
}

/// |sample| at or above this is full scale (16-bit max is 32767/32768).
const FULL_SCALE: f32 = 0.9999;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub label: String,
    pub start_sec: f64,
    pub length_sec: f64,
    /// Why it was picked, in words ("comes back 3 times").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Streams the file's default track as interleaved f32, chunk by chunk.
/// `on_chunk` returns false to stop early. Returns the stored bit depth.
/// Mixdowns come from crewmates, so a decoder panic on a malformed file is
/// caught and becomes an error for that file (release builds unwind).
pub(crate) fn decode(path: &Path, mut on_chunk: impl FnMut(&[f32], usize, u32) -> bool) -> Result<Option<u32>, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_unguarded(path, &mut on_chunk))).unwrap_or_else(|_| {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        Err(format!("{name} couldn't be decoded (damaged or unusual audio file)"))
    })
}

fn decode_unguarded(path: &Path, on_chunk: &mut impl FnMut(&[f32], usize, u32) -> bool) -> Result<Option<u32>, String> {
    let file = File::open(path).map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("unsupported audio file: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("no audio track in file")?;
    let track_id = track.id;
    let bits_per_sample = track.codec_params.bits_per_sample;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("unsupported audio codec: {e}"))?;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("could not read audio: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A corrupt frame: skip it rather than fail the whole file.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("could not decode audio: {e}")),
        };
        let spec = *decoded.spec();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        if !on_chunk(buf.samples(), spec.channels.count().max(1), spec.rate) {
            break;
        }
    }
    Ok(bits_per_sample)
}

pub fn analyze(path: &Path, bpm: Option<f64>) -> Result<AudioAnalysis, String> {
    let mut energy = Vec::new();
    let (mut acc, mut n, mut frames, mut rate) = (0f64, 0usize, 0u64, 0u32);
    let mut chroma = crate::key::Chroma::new();
    let mut timbre = crate::sections::Timbre::new();
    let (mut peak_sample, mut clipped, mut chans) = (0f32, 0u64, 0usize);
    let bits_per_sample = decode(path, |samples, channels, sr| {
        rate = sr;
        chans = channels;
        for &x in samples {
            let a = x.abs();
            peak_sample = peak_sample.max(a);
            if a >= FULL_SCALE {
                clipped += 1;
            }
        }
        let window = ((sr as f64 * WINDOW_SEC) as usize).max(1);
        for frame in samples.chunks(channels) {
            // Mean power across channels (a mono sum would cancel
            // out-of-phase stereo content).
            acc += frame.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / channels as f64;
            let mono = frame.iter().sum::<f32>() / channels as f32;
            chroma.push(mono, sr);
            timbre.push(mono, sr);
            n += 1;
            if n == window {
                energy.push((acc / n as f64).sqrt() as f32);
                acc = 0.0;
                n = 0;
            }
        }
        frames += (samples.len() / channels) as u64;
        true
    })?;
    // A last window of a few samples would read as a fake spike or dip.
    if n > 0 && n * 2 >= (rate as f64 * WINDOW_SEC) as usize {
        energy.push((acc / n as f64).sqrt() as f32);
    }
    if rate == 0 || frames == 0 {
        return Err("the file has no audio".to_string());
    }
    let peak = energy.iter().cloned().fold(0f32, f32::max);
    if peak > 0.0 {
        energy.iter_mut().for_each(|e| *e /= peak);
    }
    let duration_sec = frames as f64 / rate as f64;
    let (feats, fine) = timbre.finish(WINDOW_SEC, energy.len());
    let snippets = pick_snippets_with(&energy, &feats, &fine, duration_sec, bpm);
    let master = MasterSpec {
        container: path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase(),
        sample_rate: rate,
        channels: chans as u32,
        bits_per_sample,
        peak: peak_sample.min(1.0),
        clipped_samples: clipped,
    };
    Ok(AudioAnalysis { duration_sec, window_sec: WINDOW_SEC, energy, snippets, master, key: chroma.estimate() })
}

/// Start (in windows) of the loudest run of `len` windows, skipping any
/// start for which `blocked` is true.
fn loudest_run(energy: &[f32], len: usize, blocked: impl Fn(usize) -> bool) -> Option<usize> {
    if len == 0 || energy.len() < len {
        return None;
    }
    let mut prefix = vec![0f64; energy.len() + 1];
    for (i, e) in energy.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *e as f64;
    }
    (0..=energy.len() - len)
        .filter(|&i| !blocked(i))
        .max_by(|&a, &b| {
            let sa = prefix[a + len] - prefix[a];
            let sb = prefix[b + len] - prefix[b];
            // On a tie keep the earlier start.
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal).then(b.cmp(&a))
        })
}

/// Snap to the nearest bar line (4/4) so the clip starts on the beat.
fn snap(start: f64, length: f64, duration: f64, bpm: Option<f64>) -> f64 {
    let snapped = match bpm.filter(|b| (40.0..=300.0).contains(b)) {
        Some(b) => {
            let bar = 240.0 / b;
            (start / bar).round() * bar
        }
        None => start,
    };
    snapped.clamp(0.0, (duration - length).max(0.0))
}

/// Loudness only (no timbre fingerprint): the loudest 15 s, a 30 s teaser
/// and an alternate cut that doesn't overlap the hook.
#[cfg(test)]
fn pick_snippets(energy: &[f32], duration: f64, bpm: Option<f64>) -> Vec<Snippet> {
    pick_snippets_with(energy, &[], &[], duration, bpm)
}

/// The hook (the 15 s that comes back most, weighed with loudness), a 30 s
/// teaser that builds into it, and an alternate 15 s cut that is neither the
/// hook nor a repeat of it. Without a fingerprint (`feats` empty) it falls
/// back to loudness alone.
fn pick_snippets_with(energy: &[f32], feats: &[crate::sections::Features], fine: &[f32], duration: f64, bpm: Option<f64>) -> Vec<Snippet> {
    use crate::sections::{onset_near, repetition, segment_similarity};
    let windows = |sec: f64| (sec / WINDOW_SEC).round() as usize;
    let bar = bpm.filter(|b| (40.0..=300.0).contains(b)).map(|b| 240.0 / b);
    // Start on a real onset near the spot when there is one (the first beat
    // isn't always at 0:00), else on the bar grid.
    let place = |start_w: usize, len: f64| -> f64 {
        let at = start_w as f64 * WINDOW_SEC;
        let onset = onset_near(fine, at, bar.map_or(1.0, |b| b / 2.0)).map(|t| (t - 0.05).max(0.0));
        match onset {
            Some(t) => t.clamp(0.0, (duration - len).max(0.0)),
            None => snap(at, len, duration, bpm),
        }
    };
    let clip = |label: &str, start_sec: f64, length_sec: f64, reason: Option<String>| Snippet { label: label.to_string(), start_sec, length_sec, reason };
    let mut out = Vec::new();
    // A clip is only offered when the track is really that long.
    if duration < 15.0 {
        return out;
    }
    let len = windows(15.0);
    if energy.len() < len {
        return out;
    }
    let starts = energy.len() - len + 1;
    let mut prefix = vec![0f64; energy.len() + 1];
    for (i, e) in energy.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *e as f64;
    }
    let mean_energy = |i: usize, l: usize| ((prefix[(i + l).min(energy.len())] - prefix[i]) / l as f64) as f32;
    let loud: Vec<f32> = (0..starts).map(|i| mean_energy(i, len)).collect();
    let max_loud = loud.iter().cloned().fold(0f32, f32::max).max(1e-6);
    let rep = if feats.len() == energy.len() { repetition(feats, len) } else { Vec::new() };
    // Repetition only leads when a loud enough stretch really comes back;
    // a song with no clear hook falls back to loudness.
    let use_rep = rep.len() == starts && (0..starts).any(|i| loud[i] / max_loud >= 0.5 && rep[i] >= 0.75);
    let (rmin, rmax) = rep.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &r| (lo.min(r), hi.max(r)));
    let score: Vec<f32> = (0..starts)
        .map(|i| {
            let e = loud[i] / max_loud;
            if !use_rep {
                return e;
            }
            let r = if rmax > rmin { (rep[i] - rmin) / (rmax - rmin) } else { 0.0 };
            // Silence repeats perfectly: quiet stretches can't win on repetition.
            let quiet = (e / 0.5).min(1.0);
            // Intros and outros rarely make the reel.
            let t0 = i as f64 * WINDOW_SEC;
            let edge = if t0 < duration * 0.06 || t0 + 15.0 > duration * 0.94 { 0.7 } else { 1.0 };
            (0.65 * r + 0.35 * e) * quiet * edge
        })
        .collect();
    let best = score.iter().cloned().fold(f32::MIN, f32::max);
    // The first strong occurrence: a hook usually plays 2-3 times, and the
    // first full one is the cleanest to cut.
    let peak = |i: usize| (i.saturating_sub(2)..(i + 3).min(starts)).all(|j| score[j] <= score[i]);
    let hook_w = if use_rep {
        (0..starts).find(|&i| score[i] >= best * 0.95 && peak(i)).unwrap_or(0)
    } else {
        (0..starts).max_by(|&a, &b| score[a].total_cmp(&score[b]).then(b.cmp(&a))).unwrap_or(0)
    };
    let hook = place(hook_w, 15.0);
    let repeats = if use_rep {
        (0..starts)
            .filter(|&i| i + len <= hook_w || i >= hook_w + len)
            .filter(|&i| segment_similarity(feats, hook_w, i, len) > 0.8)
            .fold(Vec::<usize>::new(), |mut acc, i| {
                if acc.last().is_none_or(|&l| i >= l + len) {
                    acc.push(i);
                }
                acc
            })
            .len()
    } else {
        0
    };
    let hook_reason = if repeats > 0 {
        format!("comes back {} times", repeats + 1)
    } else {
        "loudest stretch".to_string()
    };
    out.push(clip("Hook 15s", hook, 15.0, Some(hook_reason)));
    if duration >= 30.0 {
        if use_rep {
            // Build into the hook: start ~8 s before it.
            let w = windows((hook - 8.0).max(0.0));
            out.push(clip("Teaser 30s", place(w, 30.0), 30.0, Some("builds into the hook".to_string())));
        } else if let Some(w) = loudest_run(energy, windows(30.0), |_| false) {
            out.push(clip("Teaser 30s", snap(w as f64 * WINDOW_SEC, 30.0, duration, bpm), 30.0, None));
        }
    }
    // Clear of the hook on both sides (placement moves a start by up to half
    // a bar), not a repeat of it, then check the placed result anyway.
    let pad = bar.map_or(0, |b| ((b / 2.0) / WINDOW_SEC).ceil() as usize);
    let (hook_start, hook_end) = (windows(hook), windows(hook + 15.0));
    let blocked = |i: usize| (i + len + pad > hook_start && i < hook_end + pad) || (use_rep && segment_similarity(feats, hook_w, i, len) > 0.8);
    if let Some(w) = loudest_run(energy, len, blocked) {
        let alt = place(w, 15.0);
        if alt + 15.0 <= hook || alt >= hook + 15.0 {
            out.push(clip("Alt 15s", alt, 15.0, use_rep.then(|| "another loud part, not the hook".to_string())));
        }
    }
    out
}

pub(crate) fn write_wav(path: &Path, samples: &[f32], channels: u16, rate: u32) -> std::io::Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + data_len).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?; // PCM
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&rate.to_le_bytes())?;
    w.write_all(&(rate * channels as u32 * 2).to_le_bytes())?;
    w.write_all(&(channels * 2).to_le_bytes())?;
    w.write_all(&16u16.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        w.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    w.flush()
}

/// A file's length in milliseconds (decodes it: some formats don't say).
pub fn duration_ms(path: &Path) -> Result<f64, String> {
    let (mut frames, mut rate) = (0u64, 0u32);
    decode(path, |samples, channels, sr| {
        rate = sr;
        frames += (samples.len() / channels.max(1)) as u64;
        true
    })?;
    if rate == 0 || frames == 0 {
        return Err(format!("{} has no audio", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    }
    Ok(frames as f64 * 1000.0 / rate as f64)
}

/// Longest audio converted to WAV (30 min: a 16-bit stereo WAV stays under 4 GB).
const MAX_CONVERT_SECS: u64 = 30 * 60;

/// Decodes `src` (an M4A, AAC…) into a 16-bit WAV at `dst`, streamed, never
/// over an existing file. Returns the length in milliseconds.
pub fn convert_to_wav(src: &Path, dst: &Path) -> Result<f64, String> {
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(dst).map_err(|e| format!("could not create {}: {e}", dst.display()))?;
    let mut w = BufWriter::new(file);
    let (mut frames, mut rate, mut chans) = (0u64, 0u32, 0usize);
    let mut io_err: Option<std::io::Error> = None;
    let mut too_long = false;
    // Header now (sizes fixed at the end).
    fn header(w: &mut impl Write, channels: u16, rate: u32, data_len: u32) -> std::io::Result<()> {
        w.write_all(b"RIFF")?;
        w.write_all(&(36u32.saturating_add(data_len)).to_le_bytes())?;
        w.write_all(b"WAVEfmt ")?;
        w.write_all(&16u32.to_le_bytes())?;
        w.write_all(&1u16.to_le_bytes())?;
        w.write_all(&channels.to_le_bytes())?;
        w.write_all(&rate.to_le_bytes())?;
        w.write_all(&(rate * channels as u32 * 2).to_le_bytes())?;
        w.write_all(&(channels * 2).to_le_bytes())?;
        w.write_all(&16u16.to_le_bytes())?;
        w.write_all(b"data")?;
        w.write_all(&data_len.to_le_bytes())
    }
    let result = decode(src, |samples, channels, sr| {
        if chans == 0 {
            chans = channels;
            rate = sr;
            if let Err(e) = header(&mut w, channels as u16, sr, 0) {
                io_err = Some(e);
                return false;
            }
        }
        if channels != chans || sr != rate {
            return true; // a format change mid-file: skip the odd chunk
        }
        for s in samples {
            if let Err(e) = w.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()) {
                io_err = Some(e);
                return false;
            }
        }
        frames += (samples.len() / channels.max(1)) as u64;
        if frames > MAX_CONVERT_SECS * rate as u64 {
            too_long = true;
            return false;
        }
        true
    });
    let finish = (|| -> Result<f64, String> {
        result?;
        if let Some(e) = io_err {
            return Err(crate::phone_inbox::io_error(&e, "could not write the WAV"));
        }
        if too_long {
            return Err(format!("{} is over 30 minutes: not converted", src.display()));
        }
        if chans == 0 || frames == 0 {
            return Err(format!("{} has no audio", src.display()));
        }
        let data_len = (frames * chans as u64 * 2) as u32;
        w.flush().map_err(|e| crate::phone_inbox::io_error(&e, "could not write the WAV"))?;
        let mut file = w.into_inner().map_err(|e| e.to_string())?;
        std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut fix = BufWriter::new(&mut file);
        header(&mut fix, chans as u16, rate, data_len).map_err(|e| e.to_string())?;
        fix.flush().map_err(|e| e.to_string())?;
        Ok(frames as f64 * 1000.0 / rate as f64)
    })();
    if finish.is_err() {
        let _ = std::fs::remove_file(dst);
    }
    finish
}

/// File-system-safe version of a user-facing name.
pub fn safe_name(name: &str) -> String {
    safe_name_opt(name).unwrap_or_else(|| "Untitled".to_string())
}

/// `safe_name`, or None when nothing usable is left (only dots, spaces or
/// nothing at all).
pub fn safe_name_opt(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    // Trailing spaces and dots too: Windows drops them from a name.
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    // Windows reserves these device names, with or without an extension.
    let stem = trimmed.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    Some(if reserved { format!("_{trimmed}") } else { trimmed })
}

/// Cuts each clip out of `src` (one decode pass) into `<out_dir>/<label>.wav`
/// as 16-bit PCM with short fades.
pub fn export_clips(src: &Path, clips: &[Snippet], out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    if crate::kits::is_link(out_dir) {
        return Err(format!("{} is a link: refusing to write through it", out_dir.display()));
    }
    fs::create_dir_all(out_dir).map_err(|e| format!("could not create {}: {e}", out_dir.display()))?;
    let mut buffers: Vec<Vec<f32>> = vec![Vec::new(); clips.len()];
    let (mut frame_index, mut channels, mut rate) = (0u64, 0usize, 0u32);
    let last_end = clips.iter().map(|c| c.start_sec + c.length_sec).fold(0.0, f64::max);
    decode(src, |samples, ch, sr| {
        channels = ch;
        rate = sr;
        for frame in samples.chunks(ch) {
            let t = frame_index as f64 / sr as f64;
            for (clip, buf) in clips.iter().zip(buffers.iter_mut()) {
                if t >= clip.start_sec && t < clip.start_sec + clip.length_sec {
                    buf.extend_from_slice(frame);
                }
            }
            frame_index += 1;
        }
        // Nothing left to cut past the last clip.
        (frame_index as f64 / sr as f64) < last_end
    })?;
    if rate == 0 {
        return Err("the file has no audio".to_string());
    }
    let fade = (FADE_SEC * rate as f64) as usize;
    let mut written = Vec::new();
    for (clip, mut buf) in clips.iter().zip(buffers) {
        let frames = buf.len() / channels;
        for i in 0..fade.min(frames / 2) {
            let gain = i as f32 / fade as f32;
            for c in 0..channels {
                buf[i * channels + c] *= gain;
                buf[(frames - 1 - i) * channels + c] *= gain;
            }
        }
        let path = out_dir.join(format!("{}.wav", safe_name(&clip.label)));
        crate::kits::clear_target(&path).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        write_wav(&path, &buf, channels as u16, rate).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        written.push(path);
    }
    Ok(written)
}

#[tauri::command]
pub async fn analyze_audio(app: tauri::AppHandle, path: String, bpm: Option<f64>) -> Result<AudioAnalysis, String> {
    let path = crate::scope::Scope::load(&app)?.audio(&path)?;
    tauri::async_runtime::spawn_blocking(move || analyze(&path, bpm))
        .await
        .map_err(|e| format!("analysis failed: {e}"))?
}

#[derive(Debug, Deserialize)]
pub struct KitFile {
    pub name: String,
    pub content: String,
}

/// Writes a launch kit folder: the text files, a copy of the master
/// mixdown, and the snippet clips in `snippets/`. Re-exporting overwrites
/// the kit's own files only; anything else in the folder (cover art) stays.
/// `song` is the song's workspace key (its owner id in the kit manifest);
/// `previous_folder` is the folder the app recorded for its last export.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_launch_kit(
    app: tauri::AppHandle,
    song: String,
    folder_name: String,
    files: Vec<KitFile>,
    master: Option<String>,
    master_name: String,
    clips: Vec<Snippet>,
    previous_folder: Option<String>,
) -> Result<String, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let output_folder = scope.output()?.to_string_lossy().to_string();
    let owner = crate::kits::kit_owner(&scope.known_file(&song)?.to_string_lossy());
    let master = master.map(|m| scope.audio(&m).map(|p| p.to_string_lossy().to_string())).transpose()?;
    check_kit_files(&files)?;
    write_launch_kit(output_folder, owner, folder_name, files, master, master_name, clips, previous_folder).await
}

/// The saved cover concept of a kit, as base64, for the shorts' art (the
/// webview can't read a file itself): the file the cover was saved to
/// (it stays put when the title changes), else the one in `folder_name`.
/// Only a plain `cover-concept.jpg` directly in a kit folder is read.
#[tauri::command]
pub async fn read_kit_cover(app: tauri::AppHandle, saved_path: Option<String>, folder_name: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let scope = crate::scope::Scope::load(&app)?;
    let output = scope.output()?.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = find_kit_cover(&output, saved_path.as_deref(), &folder_name) else { return Ok(None) };
        let bytes = fs::read(&path).map_err(|e| format!("could not read the cover concept: {e}"))?;
        Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| format!("reading the cover failed: {e}"))?
}

const MAX_COVER_BYTES: u64 = 20 * 1024 * 1024;

/// A plain `cover-concept.jpg` directly in a kit folder (never through a
/// link), first at `saved_path`, else in `<kits>/<folder_name>`.
fn find_kit_cover(output: &Path, saved_path: Option<&str>, folder_name: &str) -> Option<PathBuf> {
    let kits = output.join(crate::scanner::LAUNCH_KITS_DIR);
    if crate::kits::is_link(&kits) {
        return None;
    }
    let root = kits.canonicalize().ok()?;
    let ok = |p: &Path| -> bool {
        let plain = fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file() && m.len() <= MAX_COVER_BYTES);
        let named = p.file_name().is_some_and(|n| n == crate::cover::COVER_FILE);
        let Some(dir) = p.parent() else { return false };
        plain && named && !crate::kits::is_link(dir) && dir.canonicalize().ok().and_then(|d| d.parent().map(Path::to_path_buf)) == Some(root.clone())
    };
    let saved = saved_path.map(PathBuf::from).filter(|p| p.is_absolute());
    saved.into_iter().chain([kits.join(safe_name(folder_name)).join(crate::cover::COVER_FILE)]).find(|p| ok(p))
}

/// What a kit's text files may be called: the kit's own text formats only.
fn check_kit_files(files: &[KitFile]) -> Result<(), String> {
    for f in files {
        let name = safe_name(&f.name);
        let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "txt" | "json" | "csv" | "md") {
            return Err(format!("a Launch Kit file can't be called {}", f.name));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn write_launch_kit(
    output_folder: String,
    owner: String,
    folder_name: String,
    files: Vec<KitFile>,
    master: Option<String>,
    master_name: String,
    clips: Vec<Snippet>,
    previous_folder: Option<String>,
) -> Result<String, String> {
    use crate::kits;
    tauri::async_runtime::spawn_blocking(move || {
        // <export folder>/Launch Kits/<song>[ (n)]; the song part is
        // sanitized there so a title like ".." can't climb out.
        let output = PathBuf::from(&output_folder);
        let dir = kits::resolve_kit_dir(&output, &folder_name, &owner, previous_folder.as_deref())?;
        let mut written: Vec<String> = Vec::new();
        for f in &files {
            let name = safe_name(&f.name);
            let path = dir.join(&name);
            kits::write_new(&path, f.content.as_bytes()).map_err(|e| format!("could not write {}: {e}", path.display()))?;
            written.push(name);
        }
        if let Some(master) = master {
            let src = Path::new(&master);
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav");
            let name = format!("{}.{ext}", safe_name(&master_name));
            let dest = dir.join(&name);
            // Copying a file onto itself would destroy it: never do that.
            let same = matches!((src.canonicalize(), dest.canonicalize()), (Ok(a), Ok(b)) if a == b);
            if !same {
                kits::copy_new(src, &dest).map_err(|e| format!("could not copy the mixdown: {e}"))?;
            }
            written.push(name);
            if !clips.is_empty() {
                for path in export_clips(src, &clips, &kits::sub_dir(&dir, "snippets")?)? {
                    if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                        written.push(format!("snippets/{n}"));
                    }
                }
            }
        }
        // Leftovers of the last export: in this folder (a new master name,
        // renamed snippets), and this song's old folders after a title change.
        kits::remove_previous(&dir, &written, false);
        kits::clean_old_kits(&kits::kits_root(&output)?, &dir, &owner, &written);
        kits::write_manifest(&dir, &kits::KitManifest { owner: Some(owner.clone()), files: written })?;
        Ok(dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("export failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 60s mono at 8 kHz: quiet tone, loud between 30s and 45s.
    fn fixture(dir: &Path) -> PathBuf {
        let rate = 8000u32;
        let samples: Vec<f32> = (0..rate * 60)
            .map(|i| {
                let t = i as f64 / rate as f64;
                let amp = if (30.0..45.0).contains(&t) { 0.8 } else { 0.05 };
                (amp * (t * 440.0 * std::f64::consts::TAU).sin()) as f32
            })
            .collect();
        let path = dir.join("mix.wav");
        write_wav(&path, &samples, 1, rate).unwrap();
        path
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flsm-audio-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_the_loud_part() {
        let dir = temp("analyze");
        let a = analyze(&fixture(&dir), None).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!((a.duration_sec - 60.0).abs() < 0.01);
        assert_eq!(a.energy.len(), 120);
        let hook = &a.snippets[0];
        assert_eq!(hook.label, "Hook 15s");
        assert!((hook.start_sec - 30.0).abs() <= 0.5, "hook at {}", hook.start_sec);
        let teaser = &a.snippets[1];
        assert!(teaser.start_sec <= 30.0 && teaser.start_sec + 30.0 >= 45.0);
        let alt = &a.snippets[2];
        assert!(alt.start_sec + 15.0 <= hook.start_sec || alt.start_sec >= hook.start_sec + 15.0);
    }

    /// A rap-shaped song at 8 kHz: intro, verse, hook, verse, the same hook,
    /// then an outro louder than everything. Loudness alone picks the outro.
    #[test]
    fn finds_the_hook_that_comes_back_not_the_loud_outro() {
        let rate = 8000u32;
        let mut seed = 11u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (seed >> 16) % 1000
        };
        // Each half second plays two tones; verses draw new ones, the hook
        // replays the same 30 pairs.
        let mut pair = || (150.0 + next() as f64 * 2.5, 300.0 + next() as f64 * 3.0);
        let hook_pairs: Vec<(f64, f64)> = (0..30).map(|_| pair()).collect();
        let mut plan: Vec<((f64, f64), f64)> = Vec::new();
        plan.extend((0..20).map(|_| ((220.0, 0.0), 0.15))); // intro 0-10 s
        plan.extend((0..60).map(|_| (pair(), 0.5))); // verse 10-40 s
        plan.extend(hook_pairs.iter().map(|&p| (p, 0.55))); // hook 40-55 s
        plan.extend((0..60).map(|_| (pair(), 0.5))); // verse 55-85 s
        plan.extend(hook_pairs.iter().map(|&p| (p, 0.55))); // hook 85-100 s
        plan.extend((0..40).map(|_| (pair(), 0.95))); // loud outro 100-120 s
        let mut samples = Vec::new();
        for ((f1, f2), amp) in plan {
            for i in 0..rate / 2 {
                let t = i as f64 / rate as f64;
                let v = (t * f1 * std::f64::consts::TAU).sin() + if f2 > 0.0 { (t * f2 * std::f64::consts::TAU).sin() } else { 0.0 };
                samples.push((amp * 0.5 * v) as f32);
            }
        }
        let dir = temp("hook");
        let path = dir.join("song.wav");
        write_wav(&path, &samples, 1, rate).unwrap();
        let a = analyze(&path, None).unwrap();
        let _ = fs::remove_dir_all(&dir);
        let hook = &a.snippets[0];
        assert!((38.0..=42.5).contains(&hook.start_sec), "hook at {} (expected ~40 s, the first hook)", hook.start_sec);
        assert_eq!(hook.reason.as_deref(), Some("comes back 2 times"));
        let teaser = &a.snippets[1];
        assert!(teaser.start_sec < hook.start_sec && teaser.start_sec + 30.0 > hook.start_sec + 15.0, "teaser {} builds into the hook", teaser.start_sec);
        if let Some(alt) = a.snippets.iter().find(|s| s.label == "Alt 15s") {
            assert!(!(83.0..=87.0).contains(&alt.start_sec), "alt isn't the second hook");
        }
    }

    #[test]
    fn snaps_to_bars() {
        // 120 BPM: a bar is 2s.
        let s = pick_snippets(&[1.0; 120], 60.0, Some(120.0));
        assert!(s.iter().all(|c| (c.start_sec / 2.0).fract() == 0.0));
        assert!(pick_snippets(&[1.0; 20], 10.0, None).is_empty(), "too short for a 15s clip");
        assert!(pick_snippets(&[1.0; 30], 14.9, None).is_empty(), "14.9 s isn't a 15 s clip");
        let short = pick_snippets(&[1.0; 50], 25.0, None);
        assert!(short.iter().all(|s| s.length_sec == 15.0), "no 30 s teaser from 25 s");
    }

    #[test]
    fn alt_never_overlaps_hook_after_snapping() {
        // Two loud blocks close together; at 40 BPM a bar is 6 s, so naive
        // snapping could pull the alt into the hook.
        for offset in 0..12 {
            let energy: Vec<f32> = (0..240)
                .map(|i| if (60..90).contains(&i) || (92 + offset..122 + offset).contains(&i) { 1.0 } else { 0.1 })
                .collect();
            let s = pick_snippets(&energy, 120.0, Some(40.0));
            let hook = &s[0];
            if let Some(alt) = s.iter().find(|c| c.label == "Alt 15s") {
                assert!(
                    alt.start_sec + 15.0 <= hook.start_sec || alt.start_sec >= hook.start_sec + 15.0,
                    "offset {offset}: alt {} overlaps hook {}",
                    alt.start_sec,
                    hook.start_sec
                );
            }
        }
    }

    #[test]
    fn exports_clips_with_exact_length() {
        let dir = temp("export");
        let src = fixture(&dir);
        let clips = vec![Snippet { label: "Hook 15s".into(), start_sec: 30.0, length_sec: 15.0, reason: None }];
        let written = export_clips(&src, &clips, &dir.join("snippets")).unwrap();
        let bytes = fs::read(&written[0]).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(written[0].ends_with("snippets/Hook 15s.wav"));
        assert_eq!(bytes.len(), 44 + 15 * 8000 * 2);
    }

    /// One export of `song` into `out` (README.md + the master + one clip).
    fn export_kit(out: &Path, src: &Path, song: &str, folder: &str, master_name: &str, label: &str, prev: Option<&str>) -> PathBuf {
        PathBuf::from(
            tauri::async_runtime::block_on(write_launch_kit(
                out.to_string_lossy().to_string(),
                crate::kits::kit_owner(song),
                folder.to_string(),
                vec![KitFile { name: "README.md".to_string(), content: "x".to_string() }],
                Some(src.to_string_lossy().to_string()),
                master_name.to_string(),
                vec![Snippet { label: label.into(), start_sec: 30.0, length_sec: 7.0, reason: None }],
                prev.map(str::to_string),
            ))
            .unwrap(),
        )
    }

    #[test]
    fn re_export_replaces_only_the_files_it_wrote() {
        let dir = temp("reexport");
        let out = dir.join("out");
        let src = fixture(&dir);
        let export = |folder: &str, master_name: &str, label: &str, prev: Option<&str>| export_kit(&out, &src, "/p/a.flp", folder, master_name, label, prev);

        let first = export("Night Run", "Ana - Night Run", "Hook 7s", None);
        // Things the user put in the kit folder.
        fs::write(first.join("cover-concept.jpg"), b"jpg").unwrap();
        fs::write(first.join("notes.md"), b"mine").unwrap();
        // A file next to the kit folders, never touched.
        fs::write(dir.join("out").join("keep.md"), b"outside").unwrap();

        // Same title, new artist and snippet name: the old master and clip go.
        let again = export("Night Run", "Ana feat. Ben - Night Run", "Hook 15s", Some("Night Run"));
        assert_eq!(again, first);
        assert!(!first.join("Ana - Night Run.wav").exists());
        assert!(first.join("Ana feat. Ben - Night Run.wav").exists());
        assert!(!first.join("snippets").join("Hook 7s.wav").exists());
        assert!(first.join("snippets").join("Hook 15s.wav").exists());
        assert!(first.join("cover-concept.jpg").exists() && first.join("notes.md").exists());

        // New title: a new folder; the old one keeps only what the user put there.
        let renamed = export("Night Drive", "Ana - Night Drive", "Hook 15s", Some("Night Run"));
        assert!(renamed.join("Ana - Night Drive.wav").exists());
        assert!(!first.join("Ana feat. Ben - Night Run.wav").exists());
        assert!(!first.join("README.md").exists());
        assert!(!first.join("snippets").exists());
        assert!(!first.join(crate::kits::KIT_MANIFEST).exists());
        assert!(first.join("cover-concept.jpg").exists() && first.join("notes.md").exists());
        assert!(dir.join("out").join("keep.md").exists());
        // The cover saved in the old folder is still found for the shorts.
        let saved = first.join(crate::cover::COVER_FILE);
        assert_eq!(find_kit_cover(&out, Some(&saved.to_string_lossy()), "Night Drive"), Some(saved));

        // Only a renamed folder whose files were all ours disappears.
        let _ = export("Solo", "Ana - Solo", "Hook 15s", None);
        let _ = export("Solo 2", "Ana - Solo 2", "Hook 15s", Some("Solo"));
        let kits = out.join(crate::scanner::LAUNCH_KITS_DIR);
        assert!(!kits.join("Solo").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_case_only_title_change_keeps_the_kit() {
        let dir = temp("case");
        let out = dir.join("out");
        let src = fixture(&dir);
        let first = export_kit(&out, &src, "/p/a.flp", "night run", "Ana - night run", "Hook 7s", None);
        let second = export_kit(&out, &src, "/p/a.flp", "Night Run", "Ana - Night Run", "Hook 7s", Some("night run"));
        // Whatever the file system, the new kit is complete: nothing just
        // written was cleaned up as "the old folder".
        assert!(second.ends_with("Night Run"));
        assert!(second.join("README.md").exists(), "README.md was deleted");
        assert!(second.join("Ana - Night Run.wav").exists());
        assert!(second.join("snippets").join("Hook 7s.wav").exists());
        assert_eq!(crate::kits::read_manifest(&second).unwrap().owner, Some(crate::kits::kit_owner("/p/a.flp")));
        // On a case-insensitive file system it's the same folder, renamed.
        if crate::kits::same_path(&first, &second) == Some(true) {
            let names: Vec<String> = fs::read_dir(out.join(crate::scanner::LAUNCH_KITS_DIR)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
            assert_eq!(names, vec!["Night Run".to_string()]);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_songs_with_one_title_keep_their_own_kits() {
        let dir = temp("twins");
        let out = dir.join("out");
        let src = fixture(&dir);
        let a = export_kit(&out, &src, "/p/a.flp", "Night Run", "Ana - Night Run", "Hook 7s", None);
        let b = export_kit(&out, &src, "/p/b.flp", "Night Run", "Ben - Night Run", "Hook 7s", None);
        assert_ne!(a, b);
        assert!(b.ends_with("Night Run (2)"));
        // Song A is renamed: its old folder goes, song B's kit stays whole.
        let a2 = export_kit(&out, &src, "/p/a.flp", "Night Walk", "Ana - Night Walk", "Hook 7s", Some("Night Run"));
        assert!(a2.join("README.md").exists());
        assert!(!a.join("Ana - Night Run.wav").exists());
        assert!(b.join("README.md").exists() && b.join("Ben - Night Run.wav").exists() && b.join("snippets").join("Hook 7s.wav").exists());
        // Song B re-exports: still its own folder.
        assert_eq!(export_kit(&out, &src, "/p/b.flp", "Night Run", "Ben - Night Run", "Hook 7s", Some("Night Run (2)")), b);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_cover_is_never_read() {
        use std::os::unix::fs::symlink;
        let dir = temp("coverlink");
        let out = dir.join("out");
        let kit = crate::kits::resolve_kit_dir(&out, "Night", &crate::kits::kit_owner("/p/a.flp"), None).unwrap();
        fs::write(dir.join("secret.jpg"), b"secret").unwrap();
        symlink(dir.join("secret.jpg"), kit.join(crate::cover::COVER_FILE)).unwrap();
        assert_eq!(find_kit_cover(&out, None, "Night"), None);
        // A saved path outside the kits is refused too.
        let outside = dir.join(crate::cover::COVER_FILE);
        fs::write(&outside, b"jpg").unwrap();
        assert_eq!(find_kit_cover(&out, Some(&outside.to_string_lossy()), "Night"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_entries_stay_in_the_kit_folder() {
        use crate::kits::kit_entry;
        for ok in ["README.md", "Ana - Night.wav", "snippets/Hook 15s.wav"] {
            assert!(kit_entry(ok), "{ok}");
        }
        for bad in ["../x.md", "snippets/../../x.wav", "a/b.md", "/etc/x.md", "cover-concept.jpg", "run.sh", "snippets", "..", "x\\..\\y.md"] {
            assert!(!kit_entry(bad), "{bad}");
        }
    }

    #[test]
    fn reads_the_master_spec_and_counts_clipping() {
        let dir = temp("master");
        let path = dir.join("master.wav");
        // 2 s of stereo at 48 kHz, quiet, with 5 full-scale samples.
        let mut samples = vec![0.25f32; 48_000 * 2 * 2];
        for s in samples.iter_mut().take(5) {
            *s = 1.0;
        }
        write_wav(&path, &samples, 2, 48_000).unwrap();
        let a = analyze(&path, None).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(
            (a.master.container.as_str(), a.master.sample_rate, a.master.channels, a.master.bits_per_sample),
            ("wav", 48_000, 2, Some(16))
        );
        assert_eq!(a.master.clipped_samples, 5);
        assert!(a.master.peak > 0.999);
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("a/b:c"), "a_b_c");
        assert_eq!(safe_name(" .. "), "Untitled");
        for reserved in ["CON", "con", "NUL.txt", "Com1", "LPT9.wav", "aux "] {
            assert!(safe_name(reserved).starts_with('_'), "{reserved}");
        }
        assert_eq!(safe_name("Console"), "Console");
        assert_eq!(safe_name("COM10"), "COM10");
    }

    #[test]
    fn a_mixdown_the_decoder_rejects_is_an_error_not_a_crash() {
        let dir = std::env::temp_dir().join(format!("flsm-badaudio-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("Broken mix.wav");
        let mut bytes = b"RIFF\xff\xff\xff\x7fWAVEfmt ".to_vec();
        bytes.extend(std::iter::repeat_n(0xAB, 4096));
        fs::write(&bad, &bytes).unwrap();
        let fake = dir.join("Not audio.mp3");
        fs::write(&fake, b"this is not an mp3 at all").unwrap();

        assert!(analyze(&bad, None).is_err());
        assert!(analyze(&fake, None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_while_decoding_is_contained() {
        let dir = std::env::temp_dir().join(format!("flsm-panicaudio-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        write_wav(&wav, &vec![0.1f32; 48_000], 1, 48_000).unwrap();
        let err = decode(&wav, |_, _, _| panic!("decoder bug")).unwrap_err();
        assert!(err.contains("couldn't be decoded"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn launch_kit_text_files_keep_their_formats() {
        let file = |name: &str| KitFile { name: name.to_string(), content: "x".to_string() };
        assert!(check_kit_files(&[file("metadata.json"), file("captions.txt"), file("sheet.csv"), file("brief.md")]).is_ok());
        for bad in ["p.plist", "run.bat", "x.command", "evil.sh", "noext", "a.txt.exe"] {
            assert!(check_kit_files(&[file(bad)]).is_err(), "{bad}");
        }
    }
}
