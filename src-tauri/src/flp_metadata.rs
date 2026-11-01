use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

// Event IDs verified against PyFLP (demberto/PyFLP) source: pyflp/project.py
// (ProjectID enum) and pyflp/arrangement.py (ArrangementsID enum).
const ID_TIME_SIG_NUM: u8 = 17; // ArrangementsID.TimeSigNum (byte range)
const ID_TIME_SIG_BEAT: u8 = 18; // ArrangementsID.TimeSigBeat (byte range)
const ID_TEMPO_COARSE: u8 = 66; // ProjectID._TempoCoarse (word range, legacy)
const ID_TEMPO_FINE: u8 = 93; // ProjectID._TempoFine (word range, legacy)
const ID_TEMPO: u8 = 156; // ProjectID.Tempo (dword range) = BPM * 1000
const ID_TITLE: u8 = 194; // ProjectID.Title
const ID_COMMENTS: u8 = 195; // ProjectID.Comments
const ID_URL: u8 = 197; // ProjectID.Url
const ID_RTF_COMMENTS: u8 = 198; // ProjectID._RTFComments (legacy)
const ID_FL_VERSION: u8 = 199; // ProjectID.FLVersion (always ASCII)
const ID_GENRE: u8 = 206; // ProjectID.Genre
const ID_ARTISTS: u8 = 207; // ProjectID.Artists
const ID_SAMPLE_PATH: u8 = 196; // ChannelID.SamplePath (may start with %FLStudioUserData% etc.)
const ID_PLUGIN_INTERNAL_NAME: u8 = 201; // PluginID.InternalName ("Fruity Limiter", "Fruity Wrapper"…)
const ID_PLUGIN_DATA: u8 = 213; // PluginID.Data — for "Fruity Wrapper", the hosted VST's info
const ID_INSERT_NAME: u8 = 204; // InsertID.Name — mixer track names ("Main Voice Nova")

// Records inside a Fruity Wrapper data blob: [u32 id][u64 size][payload].
// IDs confirmed on FL 24/25 projects (54/55/56 hold UTF-8 strings).
const VST_REC_NAME: u32 = 54;
const VST_REC_PATH: u32 = 55;
const VST_REC_VENDOR: u32 = 56;

const WRAPPER: &str = "Fruity Wrapper";

/// A plugin instance found in a project. Native FL plugins only have a
/// name; third-party plugins (hosted by Fruity Wrapper) carry vendor + path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct RawPlugin {
    pub name: String,
    pub vendor: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlpMetadata {
    pub title: Option<String>,
    pub genre: Option<String>,
    pub artist: Option<String>,
    pub comment: Option<String>,
    pub url: Option<String>,
    pub fl_version: Option<String>,
    pub tempo_bpm: Option<f64>,
    pub time_sig_num: Option<u8>,
    pub time_sig_denom: Option<u8>,
    pub ppq: Option<u16>,
    /// Sample paths as stored (unresolved, deduplicated, in file order).
    pub samples: Vec<String>,
    /// Deduplicated plugin list, in file order.
    pub plugins: Vec<RawPlugin>,
    /// Named mixer tracks (unnamed ones have no event), deduplicated.
    pub mixer_names: Vec<String>,
}

/// Most a project may list before it's refused as damaged or hostile (real
/// projects use a few hundred at most). A refused file is reported, not read.
pub const MAX_SAMPLES: usize = 5_000;
pub const MAX_PLUGINS: usize = 2_000;
pub const MAX_TRACK_NAMES: usize = 2_000;

/// Deduplicating, capped lists shared by every project reader: a hash set
/// keeps each add constant-time, the caps bound memory and the work done
/// later per sample (one disk lookup each).
#[derive(Default)]
pub struct Lists {
    samples: HashSet<String>,
    plugins: HashSet<String>,
    tracks: HashSet<String>,
}

fn add(seen: &mut HashSet<String>, list: &mut Vec<String>, item: String, max: usize, what: &str) -> Result<(), String> {
    if item.is_empty() || seen.contains(&item) {
        return Ok(());
    }
    if list.len() >= max {
        return Err(too_many(max, what));
    }
    seen.insert(item.clone());
    list.push(item);
    Ok(())
}

fn too_many(max: usize, what: &str) -> String {
    format!("it lists more than {max} {what}, so it wasn't read (damaged or not a real project)")
}

impl Lists {
    pub fn sample(&mut self, meta: &mut FlpMetadata, path: String) -> Result<(), String> {
        add(&mut self.samples, &mut meta.samples, path, MAX_SAMPLES, "samples")
    }

    pub fn track(&mut self, meta: &mut FlpMetadata, name: String) -> Result<(), String> {
        add(&mut self.tracks, &mut meta.mixer_names, name, MAX_TRACK_NAMES, "track names")
    }

    pub fn plugin(&mut self, meta: &mut FlpMetadata, plugin: RawPlugin) -> Result<(), String> {
        if plugin.name.is_empty() || self.plugins.contains(&plugin.name) {
            return Ok(());
        }
        if meta.plugins.len() >= MAX_PLUGINS {
            return Err(too_many(MAX_PLUGINS, "plugins"));
        }
        self.plugins.insert(plugin.name.clone());
        meta.plugins.push(plugin);
        Ok(())
    }
}

/// Best-effort metadata reader for FL Studio's undocumented `.flp` binary
/// format. Layout reverse-engineered by the PyFLP project; see comments
/// above for the exact event IDs this pulls from.
pub fn parse_flp_metadata(path: &Path) -> Result<FlpMetadata, String> {
    let file = File::open(path).map_err(|e| format!("could not open file: {e}"))?;
    parse_flp_file(file)
}

/// The same, from a file already opened (the scan's read cache opens it
/// first, so a file that can't be opened isn't cached as damaged).
pub(crate) fn parse_flp_file(file: File) -> Result<FlpMetadata, String> {
    let len = file.metadata().map(|m| m.len()).ok();
    let mut reader = BufReader::new(file);
    parse_from_reader(&mut reader, len)
}

/// `file_len`, when known, bounds the data chunk: a size past the end of the
/// file is a damaged (or crafted) header.
fn parse_from_reader<R: Read>(reader: &mut R, file_len: Option<u64>) -> Result<FlpMetadata, String> {
    let mut header = [0u8; 14];
    reader
        .read_exact(&mut header)
        .map_err(|e| format!("could not read header: {e}"))?;
    if &header[0..4] != b"FLhd" {
        return Err("not a valid FLP file (missing FLhd header)".to_string());
    }
    let ppq = u16::from_le_bytes([header[12], header[13]]);

    let mut data_header = [0u8; 8];
    reader
        .read_exact(&mut data_header)
        .map_err(|e| format!("could not read data chunk header: {e}"))?;
    if &data_header[0..4] != b"FLdt" {
        return Err("not a valid FLP file (missing FLdt chunk)".to_string());
    }
    let data_size = u32::from_le_bytes([
        data_header[4],
        data_header[5],
        data_header[6],
        data_header[7],
    ]) as u64;
    // 14-byte FLhd chunk + 8-byte FLdt header come first.
    if file_len.is_some_and(|len| data_size > len.saturating_sub(22)) {
        return Err("its data size doesn't match the file (truncated or damaged)".to_string());
    }

    let mut lists = Lists::default();
    let mut meta = FlpMetadata {
        ppq: Some(ppq),
        ..Default::default()
    };
    let mut tempo_coarse: Option<u16> = None;
    let mut tempo_fine: Option<u16> = None;
    // FL < 11.5 stored strings as ASCII/Latin-1; FL >= 11.5 stores UTF-16LE.
    // The FLVersion event (always ASCII) tells us which, and per PyFLP it
    // precedes other text events in a well-formed file.
    let mut is_unicode = false;
    let mut consumed: u64 = 0;
    // The internal name of the plugin whose events we're inside; its Data
    // event follows it.
    let mut current_plugin: Option<String> = None;

    // Reads the whole event stream: plugin and sample events are spread
    // throughout. Real projects are a few hundred KB, so this stays fast.
    'events: while consumed < data_size {
        let mut id_buf = [0u8; 1];
        if reader.read_exact(&mut id_buf).is_err() {
            break;
        }
        consumed += 1;
        let id = id_buf[0];

        if id < 64 {
            let mut buf = [0u8; 1];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            consumed += 1;
            // First occurrence wins: later arrangements repeat these.
            match id {
                ID_TIME_SIG_NUM => _ = meta.time_sig_num.get_or_insert(buf[0]),
                ID_TIME_SIG_BEAT => _ = meta.time_sig_denom.get_or_insert(buf[0]),
                _ => {}
            }
        } else if id < 128 {
            let mut buf = [0u8; 2];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            consumed += 2;
            let value = u16::from_le_bytes(buf);
            match id {
                ID_TEMPO_COARSE => tempo_coarse = Some(value),
                ID_TEMPO_FINE => tempo_fine = Some(value),
                _ => {}
            }
        } else if id < 192 {
            let mut buf = [0u8; 4];
            if reader.read_exact(&mut buf).is_err() {
                break;
            }
            consumed += 4;
            if id == ID_TEMPO && meta.tempo_bpm.is_none() {
                let value = u32::from_le_bytes(buf);
                meta.tempo_bpm = Some(value as f64 / 1000.0);
            }
        } else {
            // IDs >= 192: VarInt (LEB128-style, least-significant group
            // first, high bit = continuation) length prefix, then payload.
            let mut len: u64 = 0;
            let mut shift = 0u32;
            loop {
                let mut b = [0u8; 1];
                if reader.read_exact(&mut b).is_err() || shift > 56 {
                    break 'events;
                }
                consumed += 1;
                len |= ((b[0] & 0x7f) as u64) << shift;
                if b[0] & 0x80 == 0 {
                    break;
                }
                shift += 7;
            }

            let is_needed = matches!(
                id,
                ID_TITLE
                    | ID_COMMENTS
                    | ID_URL
                    | ID_RTF_COMMENTS
                    | ID_FL_VERSION
                    | ID_GENRE
                    | ID_ARTISTS
                    | ID_SAMPLE_PATH
                    | ID_PLUGIN_INTERNAL_NAME
                    | ID_INSERT_NAME
            ) || (id == ID_PLUGIN_DATA && current_plugin.as_deref() == Some(WRAPPER));

            if is_needed && len > 0 && len < 10_000_000 {
                let mut payload = vec![0u8; len as usize];
                if reader.read_exact(&mut payload).is_err() {
                    break 'events;
                }
                consumed += len;

                if id == ID_FL_VERSION {
                    // Always ASCII regardless of file version.
                    let text = decode_flp_text(&payload, false);
                    if let Some((major, minor)) = parse_major_minor(&text) {
                        is_unicode = (major, minor) >= (11, 5);
                    }
                    meta.fl_version = Some(text);
                } else if id == ID_PLUGIN_DATA {
                    if let Some(plugin) = parse_wrapper_data(&payload) {
                        lists.plugin(&mut meta, plugin)?;
                    }
                } else {
                    let text = decode_flp_text(&payload, is_unicode);
                    match id {
                        ID_TITLE => meta.title = Some(text),
                        ID_COMMENTS | ID_RTF_COMMENTS => {
                            if meta.comment.is_none() {
                                meta.comment = Some(text);
                            }
                        }
                        ID_URL => meta.url = Some(text),
                        ID_GENRE => meta.genre = Some(text),
                        ID_ARTISTS => meta.artist = Some(text),
                        ID_SAMPLE_PATH => lists.sample(&mut meta, text)?,
                        ID_INSERT_NAME => lists.track(&mut meta, text)?,
                        ID_PLUGIN_INTERNAL_NAME => {
                            // Empty = a plain sampler channel; the wrapper's
                            // real name arrives in its Data event.
                            if !text.is_empty() && text != WRAPPER {
                                lists.plugin(&mut meta, RawPlugin { name: text.clone(), ..Default::default() })?;
                            }
                            current_plugin = Some(text);
                        }
                        _ => {}
                    }
                }
            } else {
                if skip_bytes(reader, len).is_err() {
                    break 'events;
                }
                consumed += len;
            }
        }
    }

    if meta.tempo_bpm.is_none() && tempo_coarse.is_some() {
        let coarse = tempo_coarse.unwrap_or(0) as f64;
        let fine = tempo_fine.unwrap_or(0) as f64 / 1000.0;
        meta.tempo_bpm = Some(coarse + fine);
    }

    // Some real projects carry garbage here (seen: 522055.422 BPM
    // from an FL 24 project). FL's tempo range is 10–522 BPM; anything
    // outside it means the fields can't be trusted, so drop them.
    if meta.tempo_bpm.is_some_and(|t| !(10.0..=522.0).contains(&t)) {
        meta.tempo_bpm = None;
        meta.time_sig_num = None;
        meta.time_sig_denom = None;
    }
    if meta.time_sig_denom.is_some_and(|d| ![2, 4, 8, 16].contains(&d)) {
        meta.time_sig_num = None;
        meta.time_sig_denom = None;
    }

    Ok(meta)
}

/// Fruity Wrapper data: a u32 kind, then `[u32 id][u64 size][payload]`
/// records. Pulls out the hosted plugin's name, file path and vendor.
fn parse_wrapper_data(data: &[u8]) -> Option<RawPlugin> {
    let mut plugin = RawPlugin::default();
    let mut pos = 4;
    while pos + 12 <= data.len() {
        let id = u32::from_le_bytes(data[pos..pos + 4].try_into().ok()?);
        let size = u64::from_le_bytes(data[pos + 4..pos + 12].try_into().ok()?) as usize;
        pos += 12;
        let payload = data.get(pos..pos.checked_add(size)?)?;
        pos += size;
        let text = || {
            let s = String::from_utf8_lossy(payload).trim_end_matches('\0').trim().to_string();
            (!s.is_empty()).then_some(s)
        };
        match id {
            VST_REC_NAME => plugin.name = text().unwrap_or_default(),
            VST_REC_PATH => plugin.path = text(),
            VST_REC_VENDOR => plugin.vendor = text(),
            _ => {}
        }
    }
    (!plugin.name.is_empty()).then_some(plugin)
}

fn skip_bytes<R: Read>(reader: &mut R, mut remaining: u64) -> std::io::Result<()> {
    let mut buf = [0u8; 4096];
    while remaining > 0 {
        let chunk = remaining.min(buf.len() as u64) as usize;
        reader.read_exact(&mut buf[..chunk])?;
        remaining -= chunk as u64;
    }
    Ok(())
}

fn decode_flp_text(bytes: &[u8], unicode: bool) -> String {
    if unicode {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_end_matches('\u{0}')
            .to_string()
    } else {
        // FL Studio's own encoder writes Latin-1/ASCII for pre-11.5 files;
        // mapping each byte straight to a char covers ASCII and degrades
        // gracefully rather than panicking on stray high-bit bytes.
        bytes
            .iter()
            .map(|&b| b as char)
            .collect::<String>()
            .trim_end_matches('\u{0}')
            .to_string()
    }
}

fn parse_major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.trim_end_matches('\u{0}').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn push_varint(buf: &mut Vec<u8>, mut value: usize) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            buf.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn push_text_event(buf: &mut Vec<u8>, id: u8, payload: &[u8]) {
        buf.push(id);
        push_varint(buf, payload.len());
        buf.extend_from_slice(payload);
    }

    fn utf16le_with_nul(s: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in format!("{s}\0").encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    fn ascii_with_nul(s: &str) -> Vec<u8> {
        let mut out = s.as_bytes().to_vec();
        out.push(0);
        out
    }

    /// Builds a minimal, spec-shaped .flp byte buffer (FLhd header + FLdt
    /// event stream) to verify the parser against a known-correct layout,
    /// independent of needing a real FL Studio install to test with.
    fn build_synthetic_flp() -> Vec<u8> {
        let mut events = Vec::new();

        // FLVersion (id 199) precedes other text events, as in real files.
        // 20.9 >= 11.5, so every other text event below is UTF-16LE.
        push_text_event(&mut events, 199, &ascii_with_nul("20.9.1.1234"));
        push_text_event(&mut events, 194, &utf16le_with_nul("Midnight Drift"));
        push_text_event(&mut events, 206, &utf16le_with_nul("Trap"));
        push_text_event(&mut events, 207, &utf16le_with_nul("DJ Sample"));

        // Tempo (id 156, dword range) = BPM * 1000 -> 140.5 BPM.
        events.push(156);
        events.extend_from_slice(&140_500u32.to_le_bytes());

        // Time signature: 3/4 (byte range).
        events.push(17);
        events.push(3);
        events.push(18);
        events.push(4);

        let mut file = Vec::new();
        file.extend_from_slice(b"FLhd");
        file.extend_from_slice(&6u32.to_le_bytes());
        file.extend_from_slice(&0i16.to_le_bytes()); // format = Project
        file.extend_from_slice(&4u16.to_le_bytes()); // num_channels
        file.extend_from_slice(&96u16.to_le_bytes()); // ppq

        file.extend_from_slice(b"FLdt");
        file.extend_from_slice(&(events.len() as u32).to_le_bytes());
        file.extend_from_slice(&events);
        file
    }

    #[test]
    fn parses_synthetic_flp_metadata() {
        let bytes = build_synthetic_flp();
        let mut cursor = Cursor::new(bytes);
        let meta = parse_from_reader(&mut cursor, None).expect("parse should succeed");

        assert_eq!(meta.ppq, Some(96));
        assert_eq!(meta.fl_version.as_deref(), Some("20.9.1.1234"));
        assert_eq!(meta.title.as_deref(), Some("Midnight Drift"));
        assert_eq!(meta.genre.as_deref(), Some("Trap"));
        assert_eq!(meta.artist.as_deref(), Some("DJ Sample"));
        assert_eq!(meta.tempo_bpm, Some(140.5));
        assert_eq!(meta.time_sig_num, Some(3));
        assert_eq!(meta.time_sig_denom, Some(4));
    }

    #[test]
    fn legacy_ascii_and_tempo_fallback() {
        let mut events = Vec::new();
        // 8.0 < 11.5 -> ASCII text events.
        push_text_event(&mut events, 199, &ascii_with_nul("8.0.0.0"));
        push_text_event(&mut events, 194, &ascii_with_nul("Old School Loop"));

        // Legacy tempo: coarse (word, id 66) + fine (word, id 93).
        events.push(66);
        events.extend_from_slice(&128u16.to_le_bytes());
        events.push(93);
        events.extend_from_slice(&250u16.to_le_bytes());

        events.push(17);
        events.push(4);
        events.push(18);
        events.push(4);

        let mut file = Vec::new();
        file.extend_from_slice(b"FLhd");
        file.extend_from_slice(&6u32.to_le_bytes());
        file.extend_from_slice(&0i16.to_le_bytes());
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&96u16.to_le_bytes());
        file.extend_from_slice(b"FLdt");
        file.extend_from_slice(&(events.len() as u32).to_le_bytes());
        file.extend_from_slice(&events);

        let mut cursor = Cursor::new(file);
        let meta = parse_from_reader(&mut cursor, None).expect("parse should succeed");

        assert_eq!(meta.title.as_deref(), Some("Old School Loop"));
        assert_eq!(meta.tempo_bpm, Some(128.25));
        assert_eq!(meta.genre, None);
    }

    fn push_wrapper_record(buf: &mut Vec<u8>, id: u32, s: &str) {
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&(s.len() as u64).to_le_bytes());
        buf.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn extracts_plugins_and_samples() {
        let mut events = Vec::new();
        push_text_event(&mut events, 199, &ascii_with_nul("25.1.6.4997"));
        push_text_event(&mut events, 196, &utf16le_with_nul("%FLStudioUserData%\\Projects\\Envy\\Samples\\Kick.wav"));
        push_text_event(&mut events, 196, &utf16le_with_nul("%FLStudioUserData%\\Projects\\Envy\\Samples\\Kick.wav"));
        push_text_event(&mut events, 201, &utf16le_with_nul("Fruity Limiter"));
        push_text_event(&mut events, 201, &utf16le_with_nul("Fruity Wrapper"));
        let mut blob = 12u32.to_le_bytes().to_vec();
        push_wrapper_record(&mut blob, 54, "FabFilter Pro-Q 3");
        push_wrapper_record(&mut blob, 55, "C:\\VST3\\FabFilter Pro-Q 3.vst3");
        push_wrapper_record(&mut blob, 56, "FabFilter");
        push_wrapper_record(&mut blob, 99, "ignored");
        push_text_event(&mut events, 213, &blob);
        // Data after a *native* plugin must not be read as wrapper records.
        push_text_event(&mut events, 201, &utf16le_with_nul("Fruity Limiter"));
        push_text_event(&mut events, 213, &[1, 2, 3, 4, 5]);

        let mut file = Vec::new();
        file.extend_from_slice(b"FLhd");
        file.extend_from_slice(&6u32.to_le_bytes());
        file.extend_from_slice(&0i16.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&96u16.to_le_bytes());
        file.extend_from_slice(b"FLdt");
        file.extend_from_slice(&(events.len() as u32).to_le_bytes());
        file.extend_from_slice(&events);

        let meta = parse_from_reader(&mut Cursor::new(file), None).unwrap();
        assert_eq!(meta.samples, vec!["%FLStudioUserData%\\Projects\\Envy\\Samples\\Kick.wav"]);
        let names: Vec<_> = meta.plugins.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Fruity Limiter", "FabFilter Pro-Q 3"]);
        assert_eq!(meta.plugins[1].vendor.as_deref(), Some("FabFilter"));
        assert_eq!(meta.plugins[1].path.as_deref(), Some("C:\\VST3\\FabFilter Pro-Q 3.vst3"));
    }

    /// Runs the parser over the user's real projects when FLSM_REAL_PROJECTS
    /// points at a folder: `FLSM_REAL_PROJECTS="D:\...\Projects" cargo test -- --nocapture real`
    #[test]
    fn parses_real_projects_if_available() {
        let Ok(root) = std::env::var("FLSM_REAL_PROJECTS") else { return };
        let mut parsed = 0;
        for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            let is_flp = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("flp"));
            if !is_flp || p.to_string_lossy().to_lowercase().contains("backup") {
                continue;
            }
            let meta = parse_flp_metadata(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            assert!(meta.fl_version.is_some(), "{}: no version", p.display());
            println!("{:?} {:?} {:?}/{:?}", p.file_name().unwrap(), meta.tempo_bpm, meta.time_sig_num, meta.time_sig_denom);
            parsed += 1;
        }
        assert!(parsed > 0);
    }

    #[test]
    fn rejects_non_flp_bytes() {
        let mut cursor = Cursor::new(b"not an flp file".to_vec());
        assert!(parse_from_reader(&mut cursor, None).is_err());
    }

    /// An .flp around `events`, declaring `declared` bytes of data.
    fn flp_file(events: &[u8], declared: u32) -> Vec<u8> {
        let mut file = Vec::new();
        file.extend_from_slice(b"FLhd");
        file.extend_from_slice(&6u32.to_le_bytes());
        file.extend_from_slice(&0i16.to_le_bytes());
        file.extend_from_slice(&4u16.to_le_bytes());
        file.extend_from_slice(&96u16.to_le_bytes());
        file.extend_from_slice(b"FLdt");
        file.extend_from_slice(&declared.to_le_bytes());
        file.extend_from_slice(events);
        file
    }

    #[test]
    fn refuses_a_data_size_past_the_end_of_the_file() {
        let mut events = Vec::new();
        push_text_event(&mut events, ID_TITLE, &ascii_with_nul("Lies"));
        let file = flp_file(&events, u32::MAX);
        let len = file.len() as u64;
        let err = parse_from_reader(&mut Cursor::new(file), Some(len)).unwrap_err();
        assert!(err.contains("data size"), "{err}");
        // The honest size still reads.
        let ok = flp_file(&events, events.len() as u32);
        let len = ok.len() as u64;
        assert_eq!(parse_from_reader(&mut Cursor::new(ok), Some(len)).unwrap().title.as_deref(), Some("Lies"));
    }

    #[test]
    fn refuses_a_project_with_too_many_samples_and_dedupes_repeats() {
        let mut events = Vec::new();
        for i in 0..=MAX_SAMPLES {
            push_text_event(&mut events, ID_SAMPLE_PATH, &ascii_with_nul(&format!("/s/{i}.wav")));
        }
        let err = parse_from_reader(&mut Cursor::new(flp_file(&events, events.len() as u32)), None).unwrap_err();
        assert!(err.contains("samples"), "{err}");

        // A million repeats of one sample are one sample (and stay fast).
        let mut events = Vec::new();
        for _ in 0..200_000 {
            push_text_event(&mut events, ID_SAMPLE_PATH, &ascii_with_nul("/s/kick.wav"));
        }
        let meta = parse_from_reader(&mut Cursor::new(flp_file(&events, events.len() as u32)), None).unwrap();
        assert_eq!(meta.samples, vec!["/s/kick.wav".to_string()]);
    }
}
