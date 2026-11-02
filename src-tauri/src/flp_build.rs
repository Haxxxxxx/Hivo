//! New FL Studio projects for BandLab sketches: the user's template plus one
//! audio clip per file, each on its own playlist track from bar 1, so
//! "Continue in FL Studio" opens with the BandLab audio already laid out.
//!
//! This is the one place Hivo writes an .flp (user override of "never write
//! to .flp files", 2026-10-27): only a NEW project, built in memory from the
//! template and written next to the sketch with create-new, never an
//! existing project. FL's format isn't documented; the layout below was read
//! from FL's own demo projects and checked by rendering a built project with
//! FL Studio 2026's command line (the audio is in the render):
//! - events: id < 64 one byte, < 128 two, < 192 four, else a varint length;
//! - the header (FLhd) holds the channel count, which must match;
//! - channels come first (each starts with ChannelID.New = 64), then the
//!   first arrangement (99) with its playlist (233) and tracks (238/43/239);
//! - an audio clip is a type-4 channel holding the sample path (196) and a
//!   playlist item pointing at that channel (index < 20480), position and
//!   length in ticks (PPQ from the header), start/end in milliseconds;
//! - project event 9 = 1 is song mode (play the playlist, not pattern 1).
//! Playlist items are 80 bytes since FL 24.2: older templates are refused
//! ("save it once in FL Studio 2024 or newer").

use crate::error::app_err;
use std::path::Path;

/// At most this many clips in one project (a sketch holds 20 files at most).
pub const MAX_CLIPS: usize = 20;
const PATTERN_BASE: u16 = 20480;
const ITEM_BYTES: usize = 80;
const TRACKS: u16 = 500;

const ID_SONG_MODE: u8 = 9;
const ID_TRACK_FLAG: u8 = 43;
const ID_CHANNEL_NEW: u8 = 64;
const ID_ARRANGEMENT_NEW: u8 = 99;
const ID_TEMPO: u8 = 156;
const ID_FL_VERSION: u8 = 199;
const ID_CHANNEL_NAME: u8 = 203;
const ID_SAMPLE_PATH: u8 = 196;
const ID_PLAYLIST: u8 = 233;
const ID_TRACK_DATA: u8 = 238;
const ID_TRACK_NAME: u8 = 239;

/// An audio-clip channel as FL 25.2 saves it (47 events), index 0, name and sample path empty.
const CLIP_CHANNEL: [u8; 809] = include!("flp_clip_channel.in");
/// A playlist item for a plain audio clip (FL 24.2+ layout, 80 bytes): no trim, no fades.
const CLIP_ITEM: [u8; 80] = include!("flp_clip_item.in");

/// One file to lay out.
#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    /// Absolute path, as FL will look for it.
    pub path: String,
    /// The channel's and the track's name.
    pub name: String,
    pub duration_ms: f64,
}

type Event = (u8, Vec<u8>);

struct Flp {
    format: i16,
    channels: u16,
    ppq: u16,
    /// Header bytes after the three fields (kept as they were).
    header_rest: Vec<u8>,
    events: Vec<Event>,
}

fn read_varint(data: &[u8], pos: &mut usize) -> Option<usize> {
    let mut n = 0usize;
    let mut shift = 0;
    loop {
        let b = *data.get(*pos)?;
        *pos += 1;
        n |= ((b & 0x7F) as usize).checked_shl(shift)?;
        if b & 0x80 == 0 {
            return Some(n);
        }
        shift += 7;
        if shift > 28 {
            return None;
        }
    }
}

fn parse_events(data: &[u8]) -> Result<Vec<Event>, String> {
    let bad = || String::from(app_err("template.unreadable", "The template isn't a readable FL Studio project."));
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let id = data[pos];
        pos += 1;
        let len = match id {
            0..=63 => 1,
            64..=127 => 2,
            128..=191 => 4,
            _ => read_varint(data, &mut pos).ok_or_else(bad)?,
        };
        let end = pos.checked_add(len).filter(|&e| e <= data.len()).ok_or_else(bad)?;
        out.push((id, data[pos..end].to_vec()));
        pos = end;
    }
    Ok(out)
}

fn parse(data: &[u8]) -> Result<Flp, String> {
    let bad = || String::from(app_err("template.unreadable", "The template isn't a readable FL Studio project."));
    if data.len() < 22 || &data[0..4] != b"FLhd" {
        return Err(bad());
    }
    let hlen = u32::from_le_bytes(data[4..8].try_into().map_err(|_| bad())?) as usize;
    if hlen < 6 || data.len() < 8 + hlen + 8 {
        return Err(bad());
    }
    let format = i16::from_le_bytes([data[8], data[9]]);
    let channels = u16::from_le_bytes([data[10], data[11]]);
    let ppq = u16::from_le_bytes([data[12], data[13]]);
    let header_rest = data[14..8 + hlen].to_vec();
    let d = 8 + hlen;
    if &data[d..d + 4] != b"FLdt" {
        return Err(bad());
    }
    let dlen = u32::from_le_bytes(data[d + 4..d + 8].try_into().map_err(|_| bad())?) as usize;
    let body = data.get(d + 8..d + 8 + dlen).ok_or_else(bad)?;
    if ppq == 0 {
        return Err(bad());
    }
    Ok(Flp { format, channels, ppq, header_rest, events: parse_events(body)? })
}

fn push_varint(out: &mut Vec<u8>, mut n: usize) {
    loop {
        let b = (n & 0x7F) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn encode(flp: &Flp) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, val) in &flp.events {
        body.push(*id);
        if *id >= 192 {
            push_varint(&mut body, val.len());
        }
        body.extend_from_slice(val);
    }
    let mut out = Vec::with_capacity(body.len() + 32);
    out.extend_from_slice(b"FLhd");
    out.extend_from_slice(&((6 + flp.header_rest.len()) as u32).to_le_bytes());
    out.extend_from_slice(&flp.format.to_le_bytes());
    out.extend_from_slice(&flp.channels.to_le_bytes());
    out.extend_from_slice(&flp.ppq.to_le_bytes());
    out.extend_from_slice(&flp.header_rest);
    out.extend_from_slice(b"FLdt");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

/// UTF-16LE with a NUL, as FL 11.5+ stores its texts.
fn utf16z(s: &str) -> Vec<u8> {
    let mut out: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
    out.extend_from_slice(&[0, 0]);
    out
}

/// "24.2.99.4720" → (24, 2).
fn version_of(events: &[Event]) -> Option<(u32, u32)> {
    let raw = &events.iter().find(|(id, _)| *id == ID_FL_VERSION)?.1;
    let text = String::from_utf8_lossy(raw.split(|b| *b == 0).next().unwrap_or(raw)).to_string();
    let mut parts = text.split('.').map(|p| p.trim().parse::<u32>().ok());
    Some((parts.next()??, parts.next()??))
}

fn u16_of(val: &[u8]) -> Option<u16> {
    Some(u16::from_le_bytes(val.get(0..2)?.try_into().ok()?))
}

/// The template plus `clips`, one per track from bar 1, in song mode.
/// `bpm` replaces the template's tempo when given (40-300).
pub fn build(template: &[u8], clips: &[Clip], bpm: Option<f64>) -> Result<Vec<u8>, String> {
    if clips.is_empty() {
        return Err(app_err("sketch.noPlayable", "No audio to lay out.").into());
    }
    if clips.len() > MAX_CLIPS {
        return Err(app_err("template.tooManyClips", format!("{} files: {MAX_CLIPS} at most in one project.", clips.len())).with("count", clips.len()).with("max", MAX_CLIPS).into());
    }
    let mut flp = parse(template)?;
    match version_of(&flp.events) {
        Some(v) if v >= (24, 2) => {}
        Some((a, b)) => {
            return Err(app_err("template.old", format!("The template was saved by FL Studio {a}.{b}: open it in FL Studio 2024 or newer and save it once.")).with("version", format!("{a}.{b}")).into())
        }
        None => return Err(app_err("template.noVersion", "The template has no FL Studio version: open it in FL Studio and save it once.").into()),
    }
    let ev = &flp.events;
    let channel_ids: Vec<u16> = ev.iter().filter(|(id, _)| *id == ID_CHANNEL_NEW).filter_map(|(_, v)| u16_of(v)).collect();
    let last_channel = ev.iter().rposition(|(id, _)| *id == ID_CHANNEL_NEW);
    let insert_at = ev
        .iter()
        .enumerate()
        .position(|(i, (id, _))| *id == ID_ARRANGEMENT_NEW && last_channel.is_none_or(|l| i > l))
        .ok_or_else(|| String::from(app_err("template.noPlaylist", "The template has no playlist (arrangement): save it once in FL Studio 2024 or newer.")))?;
    let first_new = channel_ids.iter().max().map_or(0, |m| m + 1);
    if first_new as usize + clips.len() >= PATTERN_BASE as usize || clips.len() > TRACKS as usize {
        return Err(app_err("template.tooManyChannels", "The template has too many channels.").into());
    }

    // The tempo the clip lengths are counted at.
    let tempo_event = ev.iter().position(|(id, _)| *id == ID_TEMPO);
    let template_bpm = tempo_event.and_then(|i| ev[i].1.get(0..4)).map(|b| u32::from_le_bytes(b.try_into().unwrap_or([0; 4])) as f64 / 1000.0);
    let bpm = bpm.filter(|b| (40.0..=300.0).contains(b)).or(template_bpm.filter(|b| *b > 0.0)).unwrap_or(140.0);

    // New channels, right after the template's last one.
    let block = parse_events(&CLIP_CHANNEL)?;
    let mut new_events: Vec<Event> = Vec::new();
    let mut items: Vec<u8> = Vec::new();
    for (k, clip) in clips.iter().enumerate() {
        let index = first_new + k as u16;
        for (id, val) in &block {
            let val = match *id {
                ID_CHANNEL_NEW => index.to_le_bytes().to_vec(),
                ID_CHANNEL_NAME => utf16z(&clip.name),
                ID_SAMPLE_PATH => utf16z(&clip.path),
                _ => val.clone(),
            };
            new_events.push((*id, val));
        }
        let ms = clip.duration_ms.max(1.0);
        let ticks = ((ms / 1000.0) * bpm / 60.0 * flp.ppq as f64).round().max(1.0) as u32;
        let mut item = CLIP_ITEM;
        item[0..4].copy_from_slice(&0u32.to_le_bytes());
        item[4..6].copy_from_slice(&PATTERN_BASE.to_le_bytes());
        item[6..8].copy_from_slice(&index.to_le_bytes());
        item[8..12].copy_from_slice(&ticks.to_le_bytes());
        item[12..14].copy_from_slice(&(TRACKS - 1 - k as u16).to_le_bytes());
        item[24..28].copy_from_slice(&0f32.to_le_bytes());
        item[28..32].copy_from_slice(&(ms as f32).to_le_bytes());
        items.extend_from_slice(&item);
    }
    let added = new_events.len();
    flp.events.splice(insert_at..insert_at, new_events);

    // The first arrangement's playlist gets the items; its tracks the names.
    let arrangement = insert_at + added;
    let playlist = (arrangement..flp.events.len())
        .find(|&i| flp.events[i].0 == ID_PLAYLIST)
        .ok_or_else(|| String::from(app_err("template.noPlaylist", "The template has no playlist: save it once in FL Studio 2024 or newer.")))?;
    if flp.events[playlist].1.len() % ITEM_BYTES != 0 {
        return Err(app_err("template.noPlaylist", "The template's playlist isn't in the FL Studio 2024+ layout: save it once in FL Studio 2024 or newer.").into());
    }
    flp.events[playlist].1.extend_from_slice(&items);
    for (k, clip) in clips.iter().enumerate().rev() {
        let number = k as u16 + 1;
        let Some(t) = (playlist..flp.events.len()).find(|&i| flp.events[i].0 == ID_TRACK_DATA && u16_of(&flp.events[i].1) == Some(number)) else { continue };
        let mut at = t + 1;
        if flp.events.get(at).is_some_and(|(id, _)| *id == ID_TRACK_FLAG) {
            at += 1;
        }
        if flp.events.get(at).is_some_and(|(id, _)| *id == ID_TRACK_NAME) {
            flp.events[at].1 = utf16z(&clip.name);
        } else {
            flp.events.insert(at, (ID_TRACK_NAME, utf16z(&clip.name)));
        }
    }

    // Tempo and song mode.
    let tempo = ((bpm * 1000.0).round() as u32).to_le_bytes().to_vec();
    match flp.events.iter().position(|(id, _)| *id == ID_TEMPO) {
        Some(i) => flp.events[i].1 = tempo,
        None => flp.events.insert(1.min(flp.events.len()), (ID_TEMPO, tempo)),
    }
    match flp.events.iter().position(|(id, _)| *id == ID_SONG_MODE) {
        Some(i) => flp.events[i].1 = vec![1],
        None => flp.events.insert(1.min(flp.events.len()), (ID_SONG_MODE, vec![1])),
    }
    flp.channels = flp.channels.saturating_add(clips.len() as u16);
    Ok(encode(&flp))
}

/// FL Studio plays these directly; others (M4A, AAC) are converted to WAV first.
pub fn fl_plays(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["wav", "mp3", "ogg", "flac", "aif", "aiff"].iter().any(|x| e.eq_ignore_ascii_case(x)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal FL 24.2 project: version, tempo, song-mode flag, one
    /// channel, an arrangement with an empty playlist and three tracks.
    fn template(version: &str) -> Vec<u8> {
        let mut ev: Vec<Event> = vec![
            (ID_FL_VERSION, format!("{version}\0").into_bytes()),
            (ID_TEMPO, 140_000u32.to_le_bytes().to_vec()),
            (ID_SONG_MODE, vec![0]),
            (ID_CHANNEL_NEW, 0u16.to_le_bytes().to_vec()),
            (21, vec![0]),
            (ID_CHANNEL_NAME, utf16z("Sampler")),
            (ID_ARRANGEMENT_NEW, 0u16.to_le_bytes().to_vec()),
            (ID_PLAYLIST, vec![]),
        ];
        for n in 1..=3u16 {
            let mut data = n.to_le_bytes().to_vec();
            data.extend_from_slice(&[0; 68]);
            ev.push((ID_TRACK_DATA, data));
            ev.push((ID_TRACK_FLAG, vec![1]));
        }
        ev.push((236, vec![1, 2, 3]));
        encode(&Flp { format: 0, channels: 1, ppq: 96, header_rest: vec![], events: ev })
    }

    fn clip(name: &str, ms: f64) -> Clip {
        Clip { path: format!("/Music/Night Run/BandLab/{name}.wav"), name: name.to_string(), duration_ms: ms }
    }

    #[test]
    fn lays_out_one_clip_per_track_in_song_mode() {
        let out = build(&template("24.2.99.4720"), &[clip("Beat", 8000.0), clip("Vocals", 6000.0)], Some(90.0)).unwrap();
        let flp = parse(&out).unwrap();
        assert_eq!(flp.channels, 3, "header channel count follows");
        let ev = &flp.events;
        let channels: Vec<u16> = ev.iter().filter(|(id, _)| *id == ID_CHANNEL_NEW).filter_map(|(_, v)| u16_of(v)).collect();
        assert_eq!(channels, vec![0, 1, 2]);
        // New channels sit before the arrangement, with their sample paths.
        let arr = ev.iter().position(|(id, _)| *id == ID_ARRANGEMENT_NEW).unwrap();
        let paths: Vec<usize> = ev.iter().enumerate().filter(|(_, (id, _))| *id == ID_SAMPLE_PATH).map(|(i, _)| i).collect();
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().all(|&p| p < arr));
        assert!(ev.iter().any(|(id, v)| *id == ID_SAMPLE_PATH && *v == utf16z("/Music/Night Run/BandLab/Vocals.wav")));
        // Playlist: two 80-byte items, channels 1 and 2, tracks 1 and 2, lengths at 90 BPM.
        let pl = &ev.iter().find(|(id, _)| *id == ID_PLAYLIST).unwrap().1;
        assert_eq!(pl.len(), 160);
        let item = |k: usize, at: usize, n: usize| &pl[k * 80 + at..k * 80 + at + n];
        assert_eq!(u16::from_le_bytes(item(0, 6, 2).try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(item(1, 6, 2).try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(item(0, 4, 2).try_into().unwrap()), PATTERN_BASE);
        // 8 s at 90 BPM = 12 beats = 1152 ticks at PPQ 96.
        assert_eq!(u32::from_le_bytes(item(0, 8, 4).try_into().unwrap()), 1152);
        assert_eq!(u16::from_le_bytes(item(0, 12, 2).try_into().unwrap()), 499);
        assert_eq!(u16::from_le_bytes(item(1, 12, 2).try_into().unwrap()), 498);
        assert_eq!(f32::from_le_bytes(item(1, 28, 4).try_into().unwrap()), 6000.0);
        // Tempo, song mode, track names after each track's flag.
        assert_eq!(ev.iter().find(|(id, _)| *id == ID_TEMPO).unwrap().1, 90_000u32.to_le_bytes().to_vec());
        assert_eq!(ev.iter().find(|(id, _)| *id == ID_SONG_MODE).unwrap().1, vec![1]);
        let names: Vec<&Vec<u8>> = ev.iter().filter(|(id, _)| *id == ID_TRACK_NAME).map(|(_, v)| v).collect();
        assert_eq!(names, vec![&utf16z("Beat"), &utf16z("Vocals")]);
        let t1 = ev.iter().position(|(id, v)| *id == ID_TRACK_DATA && u16_of(v) == Some(1)).unwrap();
        assert_eq!(ev[t1 + 1].0, ID_TRACK_FLAG);
        assert_eq!(ev[t1 + 2], (ID_TRACK_NAME, utf16z("Beat")));
        // What followed the tracks is still there.
        assert_eq!(ev.last().unwrap().0, 236);
    }

    #[test]
    fn keeps_the_template_tempo_without_a_bpm() {
        let out = build(&template("26.1.7.5421"), &[clip("Mix", 60_000.0)], None).unwrap();
        let flp = parse(&out).unwrap();
        let pl = &flp.events.iter().find(|(id, _)| *id == ID_PLAYLIST).unwrap().1;
        // 60 s at 140 BPM = 140 beats = 13440 ticks.
        assert_eq!(u32::from_le_bytes(pl[8..12].try_into().unwrap()), 13_440);
    }

    #[test]
    fn refuses_old_or_odd_templates() {
        assert!(build(&template("21.0.0.3302"), &[clip("a", 1.0)], None).unwrap_err().contains("2024 or newer"));
        assert!(build(b"not a project", &[clip("a", 1.0)], None).unwrap_err().contains("readable"));
        assert!(build(&template("24.2.99.4720"), &[], None).is_err());
        let many: Vec<Clip> = (0..=MAX_CLIPS).map(|i| clip(&i.to_string(), 1.0)).collect();
        assert!(build(&template("24.2.99.4720"), &many, None).unwrap_err().contains("at most"));
        // Truncated file.
        let t = template("24.2.99.4720");
        assert!(build(&t[..t.len() - 5], &[clip("a", 1.0)], None).is_err());
    }

    #[test]
    fn builds_from_fl_studios_own_empty_template_if_installed() {
        let path = Path::new("/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Templates/Empty/Empty.flp");
        let Ok(t) = std::fs::read(path) else { return };
        let out = build(&t, &[clip("Beat", 8000.0), clip("Vocals", 6000.0)], Some(90.0)).unwrap();
        let flp = parse(&out).unwrap();
        assert_eq!(flp.channels, 3);
        // For comparing with a project FL rendered (HIVO_FLP_OUT=<file>).
        if let Ok(p) = std::env::var("HIVO_FLP_OUT") {
            std::fs::write(p, &out).unwrap();
        }
        // Our own metadata reader still reads it.
        let dir = std::env::temp_dir().join(format!("hivo-flp-build-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("Night Run.flp");
        std::fs::write(&f, &out).unwrap();
        let meta = crate::flp_metadata::parse_flp_metadata(&f).unwrap();
        assert_eq!(meta.tempo_bpm, Some(90.0));
        assert!(meta.samples.iter().any(|s| s.ends_with("Vocals.wav")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
