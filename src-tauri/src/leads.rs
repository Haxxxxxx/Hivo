//! Leads for the Digger: a beat found on the web, saved as a small Markdown
//! file (link, title, the dig's facts) in `<first beats folder>/_leads/`.
//! Text only: Hivo never downloads audio (docs/GUARDRAILS.md, Digger
//! exception). Leasing or downloading stays between the user and the
//! producer's page.

use crate::error::{app_err, path_err};
use crate::digger::safe_url;
use crate::scope::Scope;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The folder inside a beats folder where leads go.
pub const LEADS_DIR: &str = "_leads";
/// Same limit as `MAX_LEAD_SLUG` in src/lib/digger.ts.
pub const MAX_LEAD_SLUG: usize = 60;
const MAX_TITLE: usize = 200;
const MAX_PRODUCER: usize = 100;
const MAX_SUMMARY: usize = 600;
const MAX_TRAITS: usize = 12;
const MAX_TRAIT: usize = 40;
const MAX_KEY: usize = 12;
const MAX_YEAR: usize = 10;
const FOOTER: &str = "Saved by Hivo's Digger. Lease or download from the producer's page; Hivo never downloads audio.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LeadSource {
    Youtube,
    Web,
}

/// What the webview sends for one lead: the shown card plus the dig's facts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lead {
    pub url: String,
    pub title: String,
    /// The channel (YouTube) or the site (web link).
    pub producer: String,
    /// "2024", or empty when unknown.
    pub year: String,
    pub source: LeadSource,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub traits: Vec<String>,
    pub summary: Option<String>,
}

/// Control characters blanked, whitespace squeezed, clipped to `max` chars.
fn clip(s: &str, max: usize) -> String {
    let s: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(max).collect::<String>().trim_end().to_string()
}

impl Lead {
    /// Every string capped and cleaned; the url checked (https only).
    fn sanitized(self) -> Result<Lead, String> {
        // Kept as sent (trimmed), not re-serialized: the file name hashes the
        // same string the webview hashes (leadHash in src/lib/digger.ts).
        let raw = self.url.trim().to_string();
        safe_url(&raw).ok_or_else(|| String::from(app_err("lead.badLink", "That link can't be saved (https links only).")))?;
        Ok(Lead {
            url: raw,
            title: clip(&self.title, MAX_TITLE),
            producer: clip(&self.producer, MAX_PRODUCER),
            year: clip(&self.year, MAX_YEAR),
            source: self.source,
            bpm: self.bpm.filter(|b| b.is_finite() && (30.0..=300.0).contains(b)),
            key: self.key.as_deref().map(|k| clip(k, MAX_KEY)).filter(|k| !k.is_empty()),
            traits: self.traits.iter().map(|t| clip(t, MAX_TRAIT)).filter(|t| !t.is_empty()).take(MAX_TRAITS).collect(),
            summary: self.summary.as_deref().map(|s| clip(s, MAX_SUMMARY)).filter(|s| !s.is_empty()),
        })
    }
}

/// FNV-1a (32-bit) of the url's UTF-8 bytes, 8 lowercase hex digits: the
/// same as `leadHash` in src/lib/digger.ts, so the file name is stable per
/// url and the UI can tell a saved lead from the file list.
pub fn lead_hash(url: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in url.trim().bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// `title` as a file-name stem: lowercased, every run of non-alphanumerics
/// one `-`, at most MAX_LEAD_SLUG chars, never empty.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let s: String = out.chars().take(MAX_LEAD_SLUG).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "lead".to_string()
    } else {
        s
    }
}

/// `<slug>-<hash>.md`.
pub fn lead_file_name(lead: &Lead) -> String {
    format!("{}-{}.md", slug(&lead.title), lead_hash(&lead.url))
}

/// The Markdown body: a title line, the facts as a list, the dig summary,
/// and the fixed footer.
pub fn lead_markdown(lead: &Lead, date: &str) -> String {
    let mut lines = vec![format!("# {}", if lead.title.is_empty() { "Lead" } else { &lead.title }), String::new()];
    lines.push(format!("- Link: {}", lead.url));
    lines.push(format!("- Source: {}", match lead.source {
        LeadSource::Youtube => "YouTube",
        LeadSource::Web => "Web",
    }));
    if !lead.producer.is_empty() {
        lines.push(format!("- Producer: {}", lead.producer));
    }
    if !lead.year.is_empty() {
        lines.push(format!("- Year: {}", lead.year));
    }
    if let Some(bpm) = lead.bpm {
        lines.push(format!("- Tempo: {} BPM", bpm.round() as i64));
    }
    if let Some(key) = &lead.key {
        lines.push(format!("- Key: {key}"));
    }
    if !lead.traits.is_empty() {
        lines.push(format!("- Traits: {}", lead.traits.join(", ")));
    }
    lines.push(format!("- Saved: {date}"));
    lines.push(String::new());
    if let Some(summary) = &lead.summary {
        lines.push(summary.clone());
        lines.push(String::new());
    }
    lines.push(FOOTER.to_string());
    lines.push(String::new());
    lines.join("\n")
}

/// Writes the lead into `<folder>/_leads/` (created if needed), overwriting
/// an earlier save of the same url. Returns the file's path.
pub fn write_lead(folder: &Path, lead: &Lead, date: &str) -> Result<PathBuf, String> {
    let dir = folder.join(LEADS_DIR);
    fs::create_dir_all(&dir).map_err(|e| path_err("io.create", &dir, format!("couldn't create {}: {e}", dir.display())))?;
    let path = dir.join(lead_file_name(lead));
    fs::write(&path, lead_markdown(lead, date)).map_err(|e| path_err("io.write", &path, format!("couldn't write {}: {e}", path.display())))?;
    Ok(path)
}

/// A lead file bigger than this isn't one of ours: skipped.
const MAX_LEAD_FILE: u64 = 64 * 1024;

/// The `<hash>` of a `<slug>-<hash>` file stem, when it is one.
fn stem_hash(stem: &str) -> Option<&str> {
    let hash = stem.rsplit('-').next()?;
    (hash.len() == 8 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())).then_some(hash)
}

/// The `.md` files in `dir`, newest first, each read back into its facts.
/// A file named otherwise (a cloud copy: "night-8fd69810 (1).md") that still
/// reads as a lead gets its link's hash. One that doesn't read as a lead
/// (too big, no "# title" line, no link and no hash in its name) is listed
/// `unrecognised`, so the user can show or delete it instead of losing it.
pub fn hashes_in(dir: &Path) -> Vec<SavedLead> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut leads: Vec<SavedLead> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".md")?;
            if stem.starts_with('.') {
                return None;
            }
            let meta = e.metadata().ok()?;
            let modified_at_ms = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            let path = e.path().to_string_lossy().to_string();
            let unrecognised = || SavedLead { path: path.clone(), modified_at_ms, title: clip(stem, MAX_TITLE), unrecognised: true, ..SavedLead::default() };
            if meta.len() > MAX_LEAD_FILE {
                return Some(unrecognised());
            }
            let text = fs::read_to_string(e.path()).unwrap_or_default();
            let Some(mut lead) = parse_lead(&text) else { return Some(unrecognised()) };
            let hash = match stem_hash(stem) {
                Some(h) => h.to_string(),
                None if !lead.url.is_empty() => lead_hash(&lead.url),
                None => return Some(unrecognised()),
            };
            if lead.title.is_empty() {
                lead.title = stem.to_string();
            }
            Some(SavedLead { hash, path, modified_at_ms, ..lead })
        })
        .collect();
    leads.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms).then_with(|| a.title.cmp(&b.title)));
    leads
}

/// The facts of a lead file, read back from the Markdown `lead_markdown`
/// writes. Tolerant: any line can be missing. The link is kept only when it
/// is still an https url (the file is the user's to edit; the UI opens it).
pub fn parse_lead(text: &str) -> Option<SavedLead> {
    let mut lead = SavedLead::default();
    let mut lines = text.lines();
    let first = lines.next()?;
    lead.title = clip(first.strip_prefix("# ")?.trim(), MAX_TITLE);
    if lead.title == "Lead" {
        lead.title.clear();
    }
    let mut in_facts = true;
    let mut body: Vec<&str> = Vec::new();
    for line in lines {
        let line = line.trim_end();
        if in_facts {
            if let Some(fact) = line.strip_prefix("- ") {
                let (name, value) = match fact.split_once(':') {
                    Some((n, v)) => (n.trim(), v.trim()),
                    None => continue,
                };
                match name {
                    "Link" => lead.url = safe_url(value).map(|_| value.to_string()).unwrap_or_default(),
                    "Source" => lead.source = if value.eq_ignore_ascii_case("youtube") { LeadSource::Youtube } else { LeadSource::Web },
                    "Producer" => lead.producer = clip(value, MAX_PRODUCER),
                    "Year" => lead.year = clip(value, MAX_YEAR),
                    "Tempo" => lead.bpm = value.split_whitespace().next().and_then(|n| n.parse::<f64>().ok()).filter(|b| (30.0..=300.0).contains(b)),
                    "Key" => lead.key = Some(clip(value, MAX_KEY)).filter(|k| !k.is_empty()),
                    "Traits" => lead.traits = value.split(',').map(|t| clip(t, MAX_TRAIT)).filter(|t| !t.is_empty()).take(MAX_TRAITS).collect(),
                    "Saved" => lead.saved_on = clip(value, MAX_YEAR),
                    _ => {}
                }
                continue;
            }
            if line.is_empty() && (lead.url.is_empty() && lead.saved_on.is_empty()) {
                // The blank line under the title.
                continue;
            }
            in_facts = false;
        }
        if line != FOOTER {
            body.push(line);
        }
    }
    let summary = clip(&body.join(" "), MAX_SUMMARY);
    lead.summary = Some(summary).filter(|s| !s.is_empty());
    Some(lead)
}

/// A lead on disk: the url hash in its name, where it is (for "reveal"), and
/// its facts read back from the file (empty when the file doesn't parse).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedLead {
    pub hash: String,
    pub path: String,
    pub modified_at_ms: u64,
    /// Empty when the file holds no https link any more.
    pub url: String,
    pub title: String,
    pub producer: String,
    pub year: String,
    pub source: LeadSource,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub traits: Vec<String>,
    pub summary: Option<String>,
    /// "YYYY-MM-DD" as written when saved.
    pub saved_on: String,
    /// A `.md` in `_leads` that doesn't read as a lead: listed with its file
    /// name as title (and no hash) so it can be shown or deleted.
    pub unrecognised: bool,
}

impl Default for LeadSource {
    fn default() -> Self {
        LeadSource::Web
    }
}

/// Today's date (UTC) as YYYY-MM-DD, no dependency needed.
fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Saves a lead as a Markdown file in the first beats folder's `_leads`.
#[tauri::command]
pub fn save_lead(app: AppHandle, lead: Lead) -> Result<String, String> {
    let scope = Scope::load(&app)?;
    let folder = scope.beat_folders().first().ok_or_else(|| String::from(app_err("lead.noBeatFolder", "Add a beats folder in Settings first.")))?;
    let lead = lead.sanitized()?;
    write_lead(folder, &lead, &today()).map(|p| p.to_string_lossy().to_string())
}

/// The leads saved in every beats folder's `_leads`, newest first, read back.
#[tauri::command]
pub fn list_leads(app: AppHandle) -> Result<Vec<SavedLead>, String> {
    let scope = Scope::load(&app)?;
    let mut leads: Vec<SavedLead> = scope.beat_folders().iter().flat_map(|f| hashes_in(&f.join(LEADS_DIR))).collect();
    leads.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms).then_with(|| a.title.cmp(&b.title)));
    Ok(leads)
}

/// Deletes one lead file (only ever a `.md` inside a beats folder's `_leads`).
#[tauri::command]
pub fn delete_lead(app: AppHandle, path: String) -> Result<(), String> {
    let scope = Scope::load(&app)?;
    let real = scope.lead_file(&path)?;
    fs::remove_file(&real).map_err(|e| path_err("io.delete", &real, format!("couldn't delete {}: {e}", real.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lead() -> Lead {
        Lead {
            url: "https://youtu.be/dQw4w9WgXcQ".into(),
            title: "[FREE] Dark Trap Type Beat - \"Night\" (prod. X)".into(),
            producer: "X Beats".into(),
            year: "2024".into(),
            source: LeadSource::Youtube,
            bpm: Some(140.4),
            key: Some("Am".into()),
            traits: vec!["140 BPM".into(), "dark".into(), "808 slides".into()],
            summary: Some("Dark, slow trap with long 808s.".into()),
        }
    }

    #[test]
    fn hash_matches_the_webview_vector() {
        // Same vector as src/lib/digger.test.ts (FNV-1a 32-bit, lowercase hex).
        assert_eq!(lead_hash("https://youtu.be/dQw4w9WgXcQ"), "8fd69810");
        assert_eq!(lead_hash("a"), "e40c292c");
        assert_eq!(lead_hash(""), "811c9dc5");
        assert_eq!(lead_hash("  https://youtu.be/dQw4w9WgXcQ \n"), "8fd69810", "trimmed like the webview");
    }

    #[test]
    fn slug_is_lowercase_dashed_and_capped() {
        assert_eq!(slug("[FREE] Dark Trap Type Beat - \"Night\" (prod. X)"), "free-dark-trap-type-beat-night-prod-x");
        assert_eq!(slug("  ---  "), "lead");
        assert_eq!(slug(""), "lead");
        assert_eq!(slug("Éclair Prod").len(), "éclair-prod".len());
        let long = slug(&"ab ".repeat(100));
        assert!(long.chars().count() <= MAX_LEAD_SLUG && !long.ends_with('-'), "{long}");
        assert_eq!(lead_file_name(&lead()), "free-dark-trap-type-beat-night-prod-x-8fd69810.md");
    }

    #[test]
    fn markdown_holds_the_facts_and_the_footer() {
        let md = lead_markdown(&lead(), "2026-10-24");
        let expected = "# [FREE] Dark Trap Type Beat - \"Night\" (prod. X)\n\n- Link: https://youtu.be/dQw4w9WgXcQ\n- Source: YouTube\n- Producer: X Beats\n- Year: 2024\n- Tempo: 140 BPM\n- Key: Am\n- Traits: 140 BPM, dark, 808 slides\n- Saved: 2026-10-24\n\nDark, slow trap with long 808s.\n\nSaved by Hivo's Digger. Lease or download from the producer's page; Hivo never downloads audio.\n";
        assert_eq!(md, expected);
        let bare = Lead { producer: String::new(), year: String::new(), bpm: None, key: None, traits: vec![], summary: None, source: LeadSource::Web, ..lead() };
        let md = lead_markdown(&bare, "2026-10-24");
        assert!(!md.contains("- Producer") && !md.contains("- Year") && !md.contains("- Tempo") && !md.contains("- Key") && !md.contains("- Traits"));
        assert!(md.contains("- Source: Web") && md.ends_with(&format!("{FOOTER}\n")));
    }

    #[test]
    fn sanitizing_clips_blanks_controls_and_refuses_bad_links() {
        let hostile = Lead {
            title: format!("Night\n# Not a heading\t{}", "x".repeat(400)),
            producer: "p\u{0}q".into(),
            key: Some("A".repeat(50)),
            traits: (0..30).map(|i| format!("t{i}\n{}", "y".repeat(100))).collect(),
            summary: Some("s".repeat(2000)),
            bpm: Some(f64::NAN),
            ..lead()
        };
        let s = hostile.sanitized().unwrap();
        assert!(s.title.starts_with("Night # Not a heading x") && s.title.chars().count() <= MAX_TITLE);
        assert_eq!(s.producer, "p q");
        assert_eq!(s.key.as_deref().map(str::len), Some(MAX_KEY));
        assert_eq!(s.traits.len(), MAX_TRAITS);
        assert!(s.traits.iter().all(|t| t.chars().count() <= MAX_TRAIT && !t.contains('\n')));
        assert_eq!(s.summary.as_deref().map(str::len), Some(MAX_SUMMARY));
        assert_eq!(s.bpm, None, "NaN is not a tempo");
        for bad in ["http://youtu.be/x", "javascript:alert(1)", "https://user:pw@host/x", ""] {
            assert!(Lead { url: bad.into(), ..lead() }.sanitized().is_err(), "{bad}");
        }
        let l: Result<Lead, _> = serde_json::from_str(r#"{"url":"https://a.b/c","title":"t","producer":"","year":"","source":"ftp","traits":[]}"#);
        assert!(l.is_err(), "unknown source");
        let l: Result<Lead, _> = serde_json::from_str(r#"{"url":"https://a.b/c","title":"t","producer":"","year":"","source":"web","traits":[],"path":"/etc"}"#);
        assert!(l.is_err(), "unknown field");
    }

    #[test]
    fn writes_into_leads_and_overwrites_the_same_url() {
        let root = std::env::temp_dir().join(format!("hivo-leads-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let first = write_lead(&root, &lead(), "2026-10-24").unwrap();
        assert_eq!(first, root.join(LEADS_DIR).join("free-dark-trap-type-beat-night-prod-x-8fd69810.md"));
        let again = write_lead(&root, &Lead { summary: Some("Updated.".into()), ..lead() }, "2026-10-25").unwrap();
        assert_eq!(first, again);
        assert!(fs::read_to_string(&again).unwrap().contains("Updated."));
        fs::write(root.join(LEADS_DIR).join("notes.md"), "x").unwrap();
        fs::write(root.join(LEADS_DIR).join("other-DEADBEEF.md"), "x").unwrap();
        fs::write(root.join(LEADS_DIR).join("readme.txt"), "x").unwrap();
        // A cloud copy keeps reading as the lead, keyed by its link.
        fs::copy(&first, root.join(LEADS_DIR).join("free-dark-trap-type-beat-night-prod-x-8fd69810 (1).md")).unwrap();
        let saved = hashes_in(&root.join(LEADS_DIR));
        let _ = fs::remove_dir_all(&root);
        assert_eq!(saved.len(), 4);
        let (odd, saved): (Vec<SavedLead>, Vec<SavedLead>) = saved.into_iter().partition(|s| s.unrecognised);
        let mut odd: Vec<&str> = odd.iter().map(|s| s.title.as_str()).collect();
        odd.sort();
        assert_eq!(odd, ["notes", "other-DEADBEEF"], "listed, not hidden");
        assert_eq!(saved.len(), 2);
        assert!(saved.iter().all(|s| s.hash == "8fd69810"));
        let s = saved.iter().find(|s| s.path == first.to_string_lossy()).unwrap();
        assert_eq!((s.hash.as_str(), s.path.as_str()), ("8fd69810", first.to_string_lossy().as_ref()));
        assert_eq!((s.url.as_str(), s.title.as_str(), s.producer.as_str(), s.year.as_str()), (lead().url.as_str(), lead().title.as_str(), "X Beats", "2024"));
        assert_eq!((s.source, s.bpm, s.key.as_deref(), s.saved_on.as_str()), (LeadSource::Youtube, Some(140.0), Some("Am"), "2026-10-25"));
        assert_eq!(s.traits, lead().traits);
        assert_eq!(s.summary.as_deref(), Some("Updated."));
        assert!(s.modified_at_ms > 0);
        assert!(hashes_in(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn lead_files_read_back_tolerantly() {
        let round = parse_lead(&lead_markdown(&lead(), "2026-10-24")).unwrap();
        assert_eq!(round.title, lead().title);
        assert_eq!(round.summary.as_deref(), Some("Dark, slow trap with long 808s."));
        assert_eq!(round.saved_on, "2026-10-24");
        // A bare lead: no facts, no summary.
        let bare = Lead { producer: String::new(), year: String::new(), bpm: None, key: None, traits: vec![], summary: None, source: LeadSource::Web, ..lead() };
        let round = parse_lead(&lead_markdown(&bare, "2026-10-24")).unwrap();
        assert_eq!((round.producer.as_str(), round.bpm, round.key, round.traits.len(), round.summary, round.source), ("", None, None, 0, None, LeadSource::Web));
        // Edited by hand: the link isn't https any more, the summary spans lines.
        let edited = "# Night\n\n- Link: javascript:alert(1)\n- Tempo: lots\n- Saved: 2026-01-01\n\nLine one.\nLine two.\n\nSaved by Hivo's Digger. Lease or download from the producer's page; Hivo never downloads audio.\n";
        let round = parse_lead(edited).unwrap();
        assert_eq!((round.url.as_str(), round.bpm, round.summary.as_deref()), ("", None, Some("Line one. Line two.")));
        assert!(parse_lead("not a lead").is_none());
        assert!(parse_lead("").is_none());
    }

    #[test]
    fn days_become_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_750), (2026, 10, 24));
        assert_eq!(today().len(), 10);
    }
}
