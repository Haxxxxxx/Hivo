//! Artist profile lookup for People: which streaming and social profiles a
//! person has, with the IDs distributors ask for (Spotify artist ID, Apple
//! Music ID…). MusicBrainz is the backbone (artist search, then the artist's
//! "url-rels"), Deezer and iTunes fill those two gaps by exact name, and
//! Spotify's own API adds followers, genres, popularity and a picture when
//! the user has set app credentials (optional; the Spotify ID and link come
//! from MusicBrainz without any key).
//!
//! Everything runs here, never in the webview: the CSP pins no lookup host,
//! and what goes back is rebuilt from checked IDs (a known platform's link is
//! never the string a server sent). Spotify credentials live in their own
//! owner-only file like the other keys (youtube.rs, cover.rs).
//!
//! MusicBrainz asks for a descriptive User-Agent and at most one request a
//! second: both are enforced here.

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MB_BASE: &str = "https://musicbrainz.org/ws/2";
const DEEZER_BASE: &str = "https://api.deezer.com";
const ITUNES_BASE: &str = "https://itunes.apple.com";
const SPOTIFY_TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const SPOTIFY_BASE: &str = "https://api.spotify.com/v1";
const USER_AGENT: &str = concat!("Hivo/", env!("CARGO_PKG_VERSION"), " (https://github.com/Haxxxxxx/fl-studio-manager)");
/// Same as `MAX_LOOKUP_QUERY_CHARS` in src/lib/people.ts.
pub const MAX_QUERY_CHARS: usize = 120;
const MAX_CANDIDATES: usize = 8;
const MAX_LINKS: usize = 40;
const MAX_URL_CHARS: usize = 300;
const MAX_TEXT_CHARS: usize = 120;
const MAX_GENRES: usize = 8;
const MAX_BODY: usize = 2 * 1024 * 1024;
const MB_GAP: Duration = Duration::from_millis(1100);
const TIMEOUT: Duration = Duration::from_secs(20);
const ID_ENV: &str = "SPOTIFY_CLIENT_ID";
const SECRET_ENV: &str = "SPOTIFY_CLIENT_SECRET";

fn clip(s: &str, max: usize) -> String {
    let s: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(max).collect::<String>().trim_end().to_string()
}

// ---- What goes back to the webview ----

/// Where a candidate (and then a profile) comes from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateSource {
    Musicbrainz,
    Spotify,
}

/// One artist the user can pick: a MusicBrainz artist (`id` = MBID) or,
/// with credentials, a Spotify artist (`id` = Spotify artist id).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source: CandidateSource,
    pub id: String,
    pub name: String,
    /// MusicBrainz's disambiguation, or Spotify's first genres.
    pub disambiguation: String,
    pub country: String,
    /// "Person", "Group"… as MusicBrainz says; empty for Spotify.
    pub kind: String,
    /// MusicBrainz's match score, or Spotify's popularity (0-100).
    pub score: u32,
    pub followers: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Streaming,
    Social,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Musicbrainz,
    Deezer,
    Itunes,
    /// Added by hand (People → Profiles → Add a link).
    Manual,
}

/// What a by-name match says about the artist it found, so the user can
/// tell two artists with the same name apart before confirming it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchInfo {
    pub fans: Option<u64>,
    pub albums: Option<u64>,
    pub genre: Option<String>,
    pub top_track: Option<String>,
}

/// A profile on one platform: the link (rebuilt from the id for known
/// platforms) and the id distributors ask for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLink {
    pub platform: String,
    pub label: String,
    pub category: Category,
    pub url: String,
    pub id: Option<String>,
    pub source: Source,
    /// False for Deezer / Apple Music found by name only (a homonym is
    /// possible): the user confirms it before its id counts.
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_info: Option<MatchInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyDetails {
    pub id: String,
    /// None when Spotify doesn't return them (apps in development mode
    /// created after 2025 get artist objects without followers, popularity
    /// or genres).
    pub followers: Option<u64>,
    pub popularity: Option<u32>,
    pub genres: Vec<String>,
    /// Only an `https://i.scdn.co/…` picture, else None.
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub source: CandidateSource,
    /// Set when the profile came through MusicBrainz.
    pub mbid: Option<String>,
    pub name: String,
    pub links: Vec<PlatformLink>,
    pub spotify: Option<SpotifyDetails>,
    /// Why Spotify details are missing when a Spotify link exists
    /// ("no credentials", or the API's error), for the UI.
    pub spotify_note: Option<String>,
}

// ---- Checks ----

/// A MusicBrainz id: 8-4-4-4-12 lowercase hex.
pub fn valid_mbid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        })
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit())
}

/// A handle or slug as platforms use them: letters, digits, `.`, `_`, `-`.
fn handle(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn spotify_id(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Lowercased letters and digits only: how two sources' names are compared.
pub fn normalize(name: &str) -> String {
    name.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

// ---- Classifying MusicBrainz urls ----

fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn link(platform: &str, label: &str, category: Category, url: String, id: Option<String>) -> PlatformLink {
    PlatformLink { platform: platform.into(), label: label.into(), category, url, id, source: Source::Musicbrainz, verified: true, match_info: None }
}

/// Reference databases MusicBrainz links to that aren't profiles.
const SKIP_HOSTS: &[&str] = &["wikidata.org", "viaf.org", "isni.org", "d-nb.info", "loc.gov", "bnf.fr", "worldcat.org", "musicbrainz.org", "imdb.com"];

/// The profile a MusicBrainz url is, or None for anything that isn't one
/// (reference databases, odd paths, non-http). `rel_type` is MusicBrainz's
/// relation type ("official homepage", "streaming", "social network"…).
pub fn classify(raw: &str, rel_type: &str) -> Option<PlatformLink> {
    let u = Url::parse(raw.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let host = host.strip_prefix("m.").unwrap_or(&host).to_string();
    if SKIP_HOSTS.iter().any(|d| host_is(&host, d)) {
        return None;
    }
    let segs: Vec<String> = u.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(|p| p.to_string()).collect()).unwrap_or_default();
    let seg = |i: usize| segs.get(i).map(String::as_str);
    let after = |key: &str| segs.iter().position(|s| s == key).and_then(|i| segs.get(i + 1)).map(String::as_str);
    use Category::*;

    if host_is(&host, "spotify.com") {
        let id = after("artist").filter(|id| spotify_id(id))?;
        return Some(link("spotify", "Spotify", Streaming, format!("https://open.spotify.com/artist/{id}"), Some(id.into())));
    }
    if host_is(&host, "music.apple.com") || host_is(&host, "itunes.apple.com") {
        let id = segs.iter().rev().find(|s| digits(s))?;
        if !segs.iter().any(|s| s == "artist") {
            return None;
        }
        return Some(link("apple-music", "Apple Music", Streaming, format!("https://music.apple.com/artist/{id}"), Some(id.into())));
    }
    if host_is(&host, "deezer.com") {
        let id = after("artist").filter(|id| digits(id))?;
        return Some(link("deezer", "Deezer", Streaming, format!("https://www.deezer.com/artist/{id}"), Some(id.into())));
    }
    if host_is(&host, "youtube.com") {
        let (platform, label) = if host.starts_with("music.") { ("youtube-music", "YouTube Music") } else { ("youtube", "YouTube") };
        let base = if platform == "youtube" { "https://www.youtube.com" } else { "https://music.youtube.com" };
        if let Some(id) = after("channel").filter(|id| handle(id)) {
            return Some(link(platform, label, Streaming, format!("{base}/channel/{id}"), Some(id.into())));
        }
        if let Some(h) = seg(0).and_then(|s| s.strip_prefix('@')).filter(|h| handle(h)) {
            return Some(link(platform, label, Streaming, format!("{base}/@{h}"), Some(h.into())));
        }
        if let (Some(kind @ ("user" | "c")), Some(name)) = (seg(0), seg(1).filter(|n| handle(n))) {
            return Some(link(platform, label, Streaming, format!("{base}/{kind}/{name}"), Some(name.into())));
        }
        return None;
    }
    if host_is(&host, "soundcloud.com") {
        let h = seg(0).filter(|h| handle(h) && !matches!(*h, "search" | "discover" | "stream" | "upload"))?;
        return Some(link("soundcloud", "SoundCloud", Streaming, format!("https://soundcloud.com/{h}"), Some(h.into())));
    }
    if host.ends_with(".bandcamp.com") {
        let sub = host.trim_end_matches(".bandcamp.com");
        if !handle(sub) || sub.contains('.') {
            return None;
        }
        return Some(link("bandcamp", "Bandcamp", Streaming, format!("https://{sub}.bandcamp.com"), Some(sub.into())));
    }
    if host_is(&host, "audiomack.com") {
        let h = seg(0).filter(|h| handle(h))?;
        return Some(link("audiomack", "Audiomack", Streaming, format!("https://audiomack.com/{h}"), Some(h.into())));
    }
    if host_is(&host, "tidal.com") {
        let id = after("artist").filter(|id| digits(id))?;
        return Some(link("tidal", "Tidal", Streaming, format!("https://tidal.com/artist/{id}"), Some(id.into())));
    }
    if host.starts_with("music.amazon.") {
        let id = after("artists").filter(|id| handle(id))?;
        return Some(link("amazon-music", "Amazon Music", Streaming, format!("https://music.amazon.com/artists/{id}"), Some(id.into())));
    }
    if host_is(&host, "instagram.com") {
        let h = seg(0).filter(|h| handle(h) && !matches!(*h, "p" | "reel" | "explore" | "accounts"))?;
        return Some(link("instagram", "Instagram", Social, format!("https://www.instagram.com/{h}/"), Some(h.into())));
    }
    if host_is(&host, "tiktok.com") {
        let h = seg(0).and_then(|s| s.strip_prefix('@')).filter(|h| handle(h))?;
        return Some(link("tiktok", "TikTok", Social, format!("https://www.tiktok.com/@{h}"), Some(h.into())));
    }
    if host_is(&host, "x.com") || host_is(&host, "twitter.com") {
        let h = seg(0).filter(|h| handle(h) && !matches!(*h, "i" | "home" | "search" | "intent" | "hashtag"))?;
        return Some(link("x", "X", Social, format!("https://x.com/{h}"), Some(h.into())));
    }
    if host_is(&host, "facebook.com") {
        let h = seg(0).filter(|h| handle(h) && !matches!(*h, "profile.php" | "pages" | "groups" | "people"))?;
        return Some(link("facebook", "Facebook", Social, format!("https://www.facebook.com/{h}"), Some(h.into())));
    }
    if host_is(&host, "threads.net") || host_is(&host, "threads.com") {
        let h = seg(0).and_then(|s| s.strip_prefix('@')).filter(|h| handle(h))?;
        return Some(link("threads", "Threads", Social, format!("https://www.threads.net/@{h}"), Some(h.into())));
    }
    if host_is(&host, "snapchat.com") {
        let h = after("add").filter(|h| handle(h))?;
        return Some(link("snapchat", "Snapchat", Social, format!("https://www.snapchat.com/add/{h}"), Some(h.into())));
    }
    if host_is(&host, "twitch.tv") {
        let h = seg(0).filter(|h| handle(h))?;
        return Some(link("twitch", "Twitch", Social, format!("https://www.twitch.tv/{h}"), Some(h.into())));
    }
    if host_is(&host, "linktr.ee") {
        let h = seg(0).filter(|h| handle(h))?;
        return Some(link("linktree", "Linktree", Social, format!("https://linktr.ee/{h}"), Some(h.into())));
    }
    if host_is(&host, "genius.com") {
        let s = after("artists").filter(|s| handle(s))?;
        return Some(link("genius", "Genius", Other, format!("https://genius.com/artists/{s}"), Some(s.into())));
    }
    if host_is(&host, "discogs.com") {
        let raw_id = after("artist")?;
        let id = raw_id.split('-').next().filter(|id| digits(id))?;
        return Some(link("discogs", "Discogs", Other, format!("https://www.discogs.com/artist/{id}"), Some(id.into())));
    }
    if host_is(&host, "last.fm") {
        let n = after("music").filter(|n| handle(n) || n.contains('+'))?;
        let n: String = n.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+')).take(64).collect();
        return Some(link("lastfm", "Last.fm", Other, format!("https://www.last.fm/music/{n}"), Some(n)));
    }
    if host.ends_with(".wikipedia.org") {
        let lang = host.trim_end_matches(".wikipedia.org");
        let title = after("wiki")?;
        if lang.len() > 3 || !lang.bytes().all(|b| b.is_ascii_lowercase()) || title.is_empty() || title.len() > 200 || title.contains(['/', '?', '#']) {
            return None;
        }
        return Some(link("wikipedia", "Wikipedia", Other, format!("https://{lang}.wikipedia.org/wiki/{title}"), Some(title.into())));
    }
    if host_is(&host, "songkick.com") {
        let raw_id = after("artists")?;
        let id = raw_id.split('-').next().filter(|id| digits(id))?;
        return Some(link("songkick", "Songkick", Other, format!("https://www.songkick.com/artists/{id}"), Some(id.into())));
    }
    if host_is(&host, "bandsintown.com") {
        let id = after("a").filter(|id| digits(id))?;
        return Some(link("bandsintown", "Bandsintown", Other, format!("https://www.bandsintown.com/a/{id}"), Some(id.into())));
    }
    // Anything else: the page itself, https only, as the person's website or
    // a plain web link.
    if u.scheme() != "https" || raw.len() > MAX_URL_CHARS || u.username() != "" || u.password().is_some() {
        return None;
    }
    let url = u.to_string();
    if rel_type.eq_ignore_ascii_case("official homepage") {
        return Some(link("website", "Website", Other, url, None));
    }
    Some(link("web", &clip(&host, MAX_TEXT_CHARS), Other, url, None))
}

/// Links without duplicates (same platform and id, or same url), at most
/// MAX_LINKS, streaming first.
pub fn dedupe(links: Vec<PlatformLink>) -> Vec<PlatformLink> {
    let mut out: Vec<PlatformLink> = Vec::new();
    for l in links {
        let dup = out.iter().any(|o| o.url.eq_ignore_ascii_case(&l.url) || (o.platform == l.platform && o.id.is_some() && o.id == l.id));
        if !dup {
            out.push(l);
        }
        if out.len() >= MAX_LINKS {
            break;
        }
    }
    let rank = |c: Category| match c {
        Category::Streaming => 0,
        Category::Social => 1,
        Category::Other => 2,
    };
    out.sort_by_key(|l| rank(l.category));
    out
}

// ---- Parsing answers (pure, tested) ----

fn str_of(v: &Value, key: &str) -> String {
    clip(v.get(key).and_then(Value::as_str).unwrap_or(""), MAX_TEXT_CHARS)
}

pub fn parse_candidates(v: &Value) -> Vec<Candidate> {
    v.get("artists")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let id = x.get("id").and_then(Value::as_str)?.to_string();
                    if !valid_mbid(&id) {
                        return None;
                    }
                    Some(Candidate {
                        source: CandidateSource::Musicbrainz,
                        id,
                        name: str_of(x, "name"),
                        disambiguation: str_of(x, "disambiguation"),
                        country: str_of(x, "country"),
                        kind: str_of(x, "type"),
                        score: x.get("score").and_then(Value::as_u64).unwrap_or(0).min(100) as u32,
                        followers: None,
                    })
                })
                .filter(|c| !c.name.is_empty())
                .take(MAX_CANDIDATES)
                .collect()
        })
        .unwrap_or_default()
}

/// Spotify's artist search answer (`artists.items`).
pub fn parse_spotify_candidates(v: &Value) -> Vec<Candidate> {
    v.get("artists")
        .and_then(|a| a.get("items"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|x| {
                    let id = x.get("id").and_then(Value::as_str)?.to_string();
                    if !spotify_id(&id) {
                        return None;
                    }
                    let genres: Vec<String> = x
                        .get("genres")
                        .and_then(Value::as_array)
                        .map(|g| g.iter().filter_map(Value::as_str).map(|s| clip(s, 40)).filter(|s| !s.is_empty()).take(2).collect())
                        .unwrap_or_default();
                    Some(Candidate {
                        source: CandidateSource::Spotify,
                        id,
                        name: str_of(x, "name"),
                        disambiguation: genres.join(", "),
                        country: String::new(),
                        kind: String::new(),
                        score: x.get("popularity").and_then(Value::as_u64).unwrap_or(0).min(100) as u32,
                        followers: x.get("followers").and_then(|f| f.get("total")).and_then(Value::as_u64),
                    })
                })
                .filter(|c| !c.name.is_empty())
                .take(MAX_CANDIDATES)
                .collect()
        })
        .unwrap_or_default()
}

/// The profiles among an artist's url relations (ended ones skipped).
pub fn parse_relations(v: &Value) -> Vec<PlatformLink> {
    let rels = v.get("relations").and_then(Value::as_array).cloned().unwrap_or_default();
    let links = rels
        .iter()
        .filter(|r| !r.get("ended").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|r| {
            let url = r.get("url")?.get("resource")?.as_str()?;
            let kind = r.get("type").and_then(Value::as_str).unwrap_or("");
            classify(url, kind)
        })
        .collect();
    dedupe(links)
}

/// Deezer's search answer: the artist whose name is exactly `name`,
/// unverified (a name match only), with its fan and album counts.
pub fn parse_deezer(v: &Value, name: &str) -> Option<PlatformLink> {
    let want = normalize(name);
    v.get("data")?.as_array()?.iter().find_map(|a| {
        let id = a.get("id").and_then(Value::as_u64)?;
        (normalize(a.get("name")?.as_str()?) == want).then(|| PlatformLink {
            platform: "deezer".into(),
            label: "Deezer".into(),
            category: Category::Streaming,
            url: format!("https://www.deezer.com/artist/{id}"),
            id: Some(id.to_string()),
            source: Source::Deezer,
            verified: false,
            match_info: Some(MatchInfo { fans: a.get("nb_fan").and_then(Value::as_u64), albums: a.get("nb_album").and_then(Value::as_u64), ..MatchInfo::default() }),
        })
    })
}

/// iTunes' search answer: the artist whose name is exactly `name`,
/// unverified (a name match only), with its main genre.
pub fn parse_itunes(v: &Value, name: &str) -> Option<PlatformLink> {
    let want = normalize(name);
    v.get("results")?.as_array()?.iter().find_map(|a| {
        let id = a.get("artistId").and_then(Value::as_u64)?;
        (normalize(a.get("artistName")?.as_str()?) == want).then(|| PlatformLink {
            platform: "apple-music".into(),
            label: "Apple Music".into(),
            category: Category::Streaming,
            url: format!("https://music.apple.com/artist/{id}"),
            id: Some(id.to_string()),
            source: Source::Itunes,
            verified: false,
            match_info: Some(MatchInfo { genre: Some(str_of(a, "primaryGenreName")).filter(|g| !g.is_empty()), ..MatchInfo::default() }),
        })
    })
}

/// The first title in Deezer's `/artist/{id}/top` answer.
pub fn parse_deezer_top(v: &Value) -> Option<String> {
    Some(str_of(v.get("data")?.as_array()?.first()?, "title")).filter(|t| !t.is_empty())
}

/// The first song in iTunes' `/lookup?id=…&entity=song` answer (the artist comes first).
pub fn parse_itunes_top(v: &Value) -> Option<String> {
    v.get("results")?.as_array()?.iter().find(|r| r.get("wrapperType").and_then(Value::as_str) == Some("track")).map(|r| str_of(r, "trackName")).filter(|t| !t.is_empty())
}

/// Spotify's artist object.
pub fn parse_spotify_artist(v: &Value, id: &str) -> SpotifyDetails {
    let image_url = v
        .get("images")
        .and_then(Value::as_array)
        .and_then(|imgs| imgs.first())
        .and_then(|i| i.get("url"))
        .and_then(Value::as_str)
        .filter(|u| Url::parse(u).ok().is_some_and(|p| p.scheme() == "https" && p.host_str() == Some("i.scdn.co")))
        .map(|u| u.to_string());
    SpotifyDetails {
        id: id.to_string(),
        followers: v.get("followers").and_then(|f| f.get("total")).and_then(Value::as_u64),
        popularity: v.get("popularity").and_then(Value::as_u64).map(|p| p.min(100) as u32),
        genres: v
            .get("genres")
            .and_then(Value::as_array)
            .map(|g| g.iter().filter_map(Value::as_str).map(|s| clip(s, 40)).filter(|s| !s.is_empty()).take(MAX_GENRES).collect())
            .unwrap_or_default(),
        image_url,
    }
}

// ---- HTTP ----

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent(USER_AGENT).timeout(TIMEOUT).build().unwrap_or_else(|_| reqwest::Client::new())
}

fn explain(what: &str, e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{what} didn't answer in time. Try again.")
    } else if e.is_connect() {
        format!("Couldn't reach {what}. Check the connection.")
    } else {
        format!("{what}: {e}")
    }
}

async fn get_json(client: &reqwest::Client, what: &str, url: &str, bearer: Option<&str>) -> Result<Value, String> {
    get_json_status(client, what, url, bearer).await.map_err(|(_, e)| e)
}

/// `get_json`, keeping the HTTP status of a refusal (0 when nothing answered).
async fn get_json_status(client: &reqwest::Client, what: &str, url: &str, bearer: Option<&str>) -> Result<Value, (u16, String)> {
    let mut req = client.get(url).header("Accept", "application/json");
    if let Some(token) = bearer {
        req = req.bearer_auth(token);
    }
    let res = req.send().await.map_err(|e| (0, explain(what, e)))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|e| (0, explain(what, e)))?;
    if bytes.len() > MAX_BODY {
        return Err((0, format!("{what} sent too much data.")));
    }
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    match status {
        200 => Ok(body),
        429 | 503 => Err((status, format!("{what} is busy (rate limit). Wait a few seconds and try again."))),
        404 => Err((status, format!("{what}: not found."))),
        401 | 403 => Err((status, format!("{what} refused the request ({status}). Check the credentials in Settings."))),
        _ => Err((status, format!("{what} answered {status}."))),
    }
}

fn mb_clock() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// One MusicBrainz request a second: waits for the gap since the last one.
async fn mb_wait() {
    let wait = {
        let mut last = mb_clock().lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let wait = last.map(|t| MB_GAP.saturating_sub(now.duration_since(t))).unwrap_or(Duration::ZERO);
        *last = Some(now + wait);
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

async fn mb_search(client: &reqwest::Client, base: &str, query: &str) -> Result<Vec<Candidate>, String> {
    let q: String = query.chars().filter(|c| !matches!(c, '"' | '\\')).collect();
    let url = Url::parse_with_params(&format!("{base}/artist"), &[("query", format!("artist:\"{q}\"")), ("fmt", "json".into()), ("limit", MAX_CANDIDATES.to_string())])
        .map_err(|e| e.to_string())?;
    mb_wait().await;
    Ok(parse_candidates(&get_json(client, "MusicBrainz", url.as_str(), None).await?))
}

async fn mb_relations(client: &reqwest::Client, base: &str, mbid: &str) -> Result<(String, Vec<PlatformLink>), String> {
    let url = format!("{base}/artist/{mbid}?inc=url-rels&fmt=json");
    mb_wait().await;
    let v = get_json(client, "MusicBrainz", &url, None).await?;
    Ok((str_of(&v, "name"), parse_relations(&v)))
}

async fn deezer_search(client: &reqwest::Client, base: &str, name: &str) -> Option<PlatformLink> {
    let url = Url::parse_with_params(&format!("{base}/search/artist"), &[("q", name), ("limit", "5")]).ok()?;
    let v = get_json(client, "Deezer", url.as_str(), None).await.ok()?;
    let mut link = parse_deezer(&v, name)?;
    // The top track helps tell two artists with the same name apart.
    if let (Some(id), Some(info)) = (link.id.clone(), link.match_info.as_mut()) {
        if let Ok(top) = get_json(client, "Deezer", &format!("{base}/artist/{id}/top?limit=1"), None).await {
            info.top_track = parse_deezer_top(&top);
        }
    }
    Some(link)
}

async fn itunes_search(client: &reqwest::Client, base: &str, name: &str) -> Option<PlatformLink> {
    let url = Url::parse_with_params(&format!("{base}/search"), &[("term", name), ("entity", "musicArtist"), ("limit", "5")]).ok()?;
    let v = get_json(client, "iTunes", url.as_str(), None).await.ok()?;
    let mut link = parse_itunes(&v, name)?;
    if let (Some(id), Some(info)) = (link.id.clone(), link.match_info.as_mut()) {
        if let Ok(top) = get_json(client, "iTunes", &format!("{base}/lookup?id={id}&entity=song&limit=1"), None).await {
            info.top_track = parse_itunes_top(&top);
        }
    }
    Some(link)
}

// ---- Spotify credentials (optional) ----

#[derive(Default, Serialize, Deserialize)]
struct SpotifySecrets {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("could not resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("spotify.json"))
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Spotify client ids and secrets are 32 hex characters.
fn valid_credential(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The environment wins, else the pair saved from Settings.
fn credentials(app: &AppHandle) -> Option<((String, String), &'static str)> {
    if let (Some(id), Some(secret)) = (non_empty(std::env::var(ID_ENV).ok()), non_empty(std::env::var(SECRET_ENV).ok())) {
        return Some(((id, secret), "env"));
    }
    let saved = secrets_path(app).map(|p| read_secrets(&p)).unwrap_or_default();
    match (non_empty(saved.client_id), non_empty(saved.client_secret)) {
        (Some(id), Some(secret)) => Some(((id, secret), "settings")),
        _ => None,
    }
}

fn read_secrets(path: &Path) -> SpotifySecrets {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn store_credentials(path: &Path, client_id: Option<String>, client_secret: Option<String>) -> Result<(), String> {
    let (Some(id), Some(secret)) = (non_empty(client_id), non_empty(client_secret)) else {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not remove the Spotify credentials: {e}")),
        };
    };
    if !valid_credential(&id) || !valid_credential(&secret) {
        return Err("That doesn't look like a Spotify client id and secret (32 characters each, from the Spotify developer dashboard).".to_string());
    }
    let raw = serde_json::to_string_pretty(&SpotifySecrets { client_id: Some(id), client_secret: Some(secret) }).map_err(|e| e.to_string())?;
    crate::cover::write_private(path, raw.as_bytes()).map_err(|e| format!("could not save the Spotify credentials: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    pub configured: bool,
    /// "env" or "settings".
    pub source: Option<String>,
}

#[tauri::command]
pub fn spotify_status(app: AppHandle) -> SpotifyStatus {
    let c = credentials(&app);
    SpotifyStatus { configured: c.is_some(), source: c.map(|(_, s)| s.to_string()) }
}

/// Saves (or, with empty values, removes) the credentials. Never returned.
#[tauri::command]
pub fn set_spotify_credentials(app: AppHandle, client_id: Option<String>, client_secret: Option<String>) -> Result<(), String> {
    // A token from the old app must not outlive its credentials.
    clear_spotify_token();
    store_credentials(&secrets_path(&app)?, client_id, client_secret)
}

fn token_cache() -> &'static Mutex<Option<(String, Instant)>> {
    static TOKEN: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
    TOKEN.get_or_init(|| Mutex::new(None))
}

/// Forgets the cached app token (new credentials, or Spotify said 401).
fn clear_spotify_token() {
    *token_cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Where to get a token and with what (tests point `token_url` at a local server).
struct SpotifyApp {
    token_url: String,
    id: String,
    secret: String,
}

/// A Spotify API GET with the app token; a 401 (the token was revoked or
/// belongs to older credentials) drops the cached token and retries once.
async fn spotify_get(client: &reqwest::Client, app: &SpotifyApp, url: &str) -> Result<Value, String> {
    let token = spotify_token(client, &app.token_url, &app.id, &app.secret).await?;
    match get_json_status(client, "Spotify", url, Some(&token)).await {
        Err((401, _)) => {
            clear_spotify_token();
            let token = spotify_token(client, &app.token_url, &app.id, &app.secret).await?;
            get_json(client, "Spotify", url, Some(&token)).await
        }
        other => other.map_err(|(_, e)| e),
    }
}

/// An app token (client credentials), cached until shortly before it expires.
async fn spotify_token(client: &reqwest::Client, token_url: &str, id: &str, secret: &str) -> Result<String, String> {
    if let Some((t, until)) = token_cache().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if Instant::now() < until {
            return Ok(t);
        }
    }
    let res = client
        .post(token_url)
        .basic_auth(id, Some(secret))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|e| explain("Spotify", e))?;
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if status != 200 {
        return Err(format!("Spotify refused the credentials ({status}). Check the client id and secret in Settings."));
    }
    let token = v.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()).ok_or("Spotify sent no token.")?.to_string();
    let expires = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600).saturating_sub(60);
    *token_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some((token.clone(), Instant::now() + Duration::from_secs(expires)));
    Ok(token)
}

/// The artist object, and its name.
async fn spotify_artist(client: &reqwest::Client, base: &str, app: &SpotifyApp, id: &str) -> Result<(String, SpotifyDetails), String> {
    let v = spotify_get(client, app, &format!("{base}/artists/{id}")).await?;
    Ok((str_of(&v, "name"), parse_spotify_artist(&v, id)))
}

async fn spotify_search(client: &reqwest::Client, base: &str, app: &SpotifyApp, query: &str) -> Result<Vec<Candidate>, String> {
    let url = Url::parse_with_params(&format!("{base}/search"), &[("q", query), ("type", "artist"), ("limit", &MAX_CANDIDATES.to_string())]).map_err(|e| e.to_string())?;
    Ok(parse_spotify_candidates(&spotify_get(client, app, url.as_str()).await?))
}

/// The Spotify app when credentials are set.
fn spotify_app(app: &AppHandle) -> Option<SpotifyApp> {
    credentials(app).map(|((id, secret), _)| SpotifyApp { token_url: SPOTIFY_TOKEN_URL.to_string(), id, secret })
}

// ---- Commands ----

/// Artists matching a name, for the user to pick from: Spotify's (when
/// credentials are set) first, then MusicBrainz's. One source failing is
/// fine while the other answers.
#[tauri::command]
pub async fn lookup_artists(app: AppHandle, query: String) -> Result<Vec<Candidate>, String> {
    let q = clip(&query, MAX_QUERY_CHARS);
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let client = client();
    let spotify = match spotify_app(&app) {
        Some(sp) => spotify_search(&client, SPOTIFY_BASE, &sp, &q).await,
        None => Ok(Vec::new()),
    };
    let mb = mb_search(&client, MB_BASE, &q).await;
    match (spotify, mb) {
        (Ok(mut s), Ok(m)) => {
            s.extend(m);
            Ok(s)
        }
        (Ok(s), Err(_)) if !s.is_empty() => Ok(s),
        (Err(_), Ok(m)) if !m.is_empty() => Ok(m),
        (_, Err(e)) | (Err(e), _) => Err(e),
    }
}

/// The spotify link for a checked artist id.
fn spotify_link(id: &str) -> PlatformLink {
    link("spotify", "Spotify", Category::Streaming, format!("https://open.spotify.com/artist/{id}"), Some(id.to_string()))
}

/// The profiles of one picked artist. MusicBrainz: its url relations, then
/// Deezer and Apple Music by exact name when MusicBrainz has none, then
/// Spotify's details when credentials are set. Spotify: the artist object
/// (credentials needed) and its link, plus Deezer and Apple Music by name.
#[tauri::command]
pub async fn lookup_profile(app: AppHandle, source: CandidateSource, id: String) -> Result<Profile, String> {
    let client = client();
    match source {
        CandidateSource::Spotify => {
            if !spotify_id(&id) {
                return Err("That isn't a Spotify artist id.".to_string());
            }
            let sp = spotify_app(&app).ok_or("Set Spotify credentials in Settings first.")?;
            let (name, details) = spotify_artist(&client, SPOTIFY_BASE, &sp, &id).await?;
            let mut links = vec![spotify_link(&id)];
            if !name.is_empty() {
                links.extend(deezer_search(&client, DEEZER_BASE, &name).await);
                links.extend(itunes_search(&client, ITUNES_BASE, &name).await);
            }
            Ok(Profile { source, mbid: None, name, links: dedupe(links), spotify: Some(details), spotify_note: None })
        }
        CandidateSource::Musicbrainz => {
            if !valid_mbid(&id) {
                return Err("That isn't a MusicBrainz id.".to_string());
            }
            let (name, mut links) = mb_relations(&client, MB_BASE, &id).await?;
            if !name.is_empty() {
                if !links.iter().any(|l| l.platform == "deezer") {
                    links.extend(deezer_search(&client, DEEZER_BASE, &name).await);
                }
                if !links.iter().any(|l| l.platform == "apple-music") {
                    links.extend(itunes_search(&client, ITUNES_BASE, &name).await);
                }
                links = dedupe(links);
            }
            let sid = links.iter().find(|l| l.platform == "spotify").and_then(|l| l.id.clone());
            let (spotify, spotify_note) = match sid {
                None => (None, None),
                Some(sid) => match spotify_app(&app) {
                    Some(sp) => match spotify_artist(&client, SPOTIFY_BASE, &sp, &sid).await {
                        Ok((_, d)) => (Some(d), None),
                        Err(e) => (None, Some(e)),
                    },
                    None => (None, Some("no credentials".to_string())),
                },
            };
            Ok(Profile { source, mbid: Some(id), name, links, spotify, spotify_note })
        }
    }
}

/// A profile link typed by the user (People → Profiles → Add a link): the
/// same classification as MusicBrainz's urls (a known platform's link is
/// rebuilt from its id), marked as added by hand.
#[tauri::command]
pub fn classify_profile_link(url: String) -> Result<PlatformLink, String> {
    if url.len() > MAX_URL_CHARS {
        return Err("That link is too long.".to_string());
    }
    manual_link(&url).ok_or_else(|| "That isn't a profile link (http or https).".to_string())
}

pub fn manual_link(url: &str) -> Option<PlatformLink> {
    classify(url, "").map(|l| PlatformLink { source: Source::Manual, verified: true, ..l })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn l(url: &str) -> Option<PlatformLink> {
        classify(url, "streaming")
    }
    fn id(url: &str) -> Option<String> {
        l(url).and_then(|x| x.id)
    }

    #[test]
    fn classifies_known_platforms_and_rebuilds_their_links() {
        let s = l("https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb?si=x").unwrap();
        assert_eq!((s.platform.as_str(), s.id.as_deref(), s.url.as_str()), ("spotify", Some("4Z8W4fKeB5YxbusRsdQVPb"), "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb"));
        assert_eq!(l("https://music.apple.com/fr/artist/the-name/123456").unwrap().url, "https://music.apple.com/artist/123456");
        assert_eq!(id("https://www.deezer.com/fr/artist/27"), Some("27".into()));
        assert_eq!(id("https://www.youtube.com/channel/UCabc_123"), Some("UCabc_123".into()));
        assert_eq!(l("https://youtube.com/@handle").unwrap().url, "https://www.youtube.com/@handle");
        assert_eq!(l("https://music.youtube.com/channel/UCabc").unwrap().platform, "youtube-music");
        assert_eq!(id("https://soundcloud.com/some-one"), Some("some-one".into()));
        assert_eq!(l("https://someone.bandcamp.com/album/x").unwrap().url, "https://someone.bandcamp.com");
        assert_eq!(id("https://tidal.com/browse/artist/12345"), Some("12345".into()));
        assert_eq!(id("https://music.amazon.fr/artists/B000QJ"), Some("B000QJ".into()));
        assert_eq!(l("https://www.instagram.com/some.one/").unwrap().category, Category::Social);
        assert_eq!(id("https://www.tiktok.com/@some.one"), Some("some.one".into()));
        assert_eq!(l("https://twitter.com/someone").unwrap().url, "https://x.com/someone");
        assert_eq!(id("https://www.facebook.com/someone"), Some("someone".into()));
        assert_eq!(id("https://genius.com/artists/Someone"), Some("Someone".into()));
        assert_eq!(id("https://www.discogs.com/artist/12345-Someone"), Some("12345".into()));
        assert_eq!(l("https://fr.wikipedia.org/wiki/Someone").unwrap().url, "https://fr.wikipedia.org/wiki/Someone");
        assert_eq!(id("https://www.songkick.com/artists/99-someone"), Some("99".into()));
        assert_eq!(id("https://www.bandsintown.com/a/42"), Some("42".into()));
        let home = classify("https://someone.example/", "official homepage").unwrap();
        assert_eq!((home.platform.as_str(), home.id), ("website", None));
        assert_eq!(classify("https://blog.example/post", "blog").unwrap().platform, "web");
    }

    #[test]
    fn refuses_what_is_not_a_profile() {
        for bad in [
            "https://www.wikidata.org/wiki/Q42",
            "https://viaf.org/viaf/1",
            "https://open.spotify.com/track/4Z8W4fKeB5YxbusRsdQVPb",
            "https://open.spotify.com/artist/short",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.instagram.com/p/abc/",
            "https://twitter.com/i/status/1",
            "https://www.facebook.com/profile.php?id=1",
            "javascript:alert(1)",
            "http://insecure.example/page",
            "https://user:pw@example.com/",
            "https://www.deezer.com/fr/artist/notanumber",
            "https://x.y.bandcamp.com/",
        ] {
            assert!(l(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn relations_are_deduped_and_ordered() {
        let v = json!({ "name": "Someone", "relations": [
            { "type": "social network", "url": { "resource": "https://www.instagram.com/someone/" } },
            { "type": "streaming", "url": { "resource": "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb" } },
            { "type": "streaming", "url": { "resource": "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb?si=dup" } },
            { "type": "streaming", "ended": true, "url": { "resource": "https://www.deezer.com/artist/1" } },
            { "type": "wikidata", "url": { "resource": "https://www.wikidata.org/wiki/Q1" } }
        ]});
        let links = parse_relations(&v);
        assert_eq!(links.iter().map(|l| l.platform.as_str()).collect::<Vec<_>>(), vec!["spotify", "instagram"]);
    }

    #[test]
    fn candidates_and_fallbacks_parse() {
        let v = json!({ "artists": [
            { "id": "5b11f4ce-a62d-471e-81fc-a69a8278c7da", "name": "Someone", "score": 100, "country": "FR", "type": "Person", "disambiguation": "rapper" },
            { "id": "not-an-mbid", "name": "Ghost" },
            { "id": "5b11f4ce-a62d-471e-81fc-a69a8278c7db", "name": "" }
        ]});
        let c = parse_candidates(&v);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].source, c[0].name.as_str(), c[0].country.as_str(), c[0].kind.as_str(), c[0].score), (CandidateSource::Musicbrainz, "Someone", "FR", "Person", 100));
        let s = json!({ "artists": { "items": [
            { "id": "4Z8W4fKeB5YxbusRsdQVPb", "name": "Someone", "popularity": 41, "followers": { "total": 980 }, "genres": ["rap", "drill", "x"] },
            { "id": "bad", "name": "Ghost" }
        ]}});
        let s = parse_spotify_candidates(&s);
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].source, s[0].id.as_str(), s[0].disambiguation.as_str(), s[0].score, s[0].followers), (CandidateSource::Spotify, "4Z8W4fKeB5YxbusRsdQVPb", "rap, drill", 41, Some(980)));
        assert!(valid_mbid("5b11f4ce-a62d-471e-81fc-a69a8278c7da") && !valid_mbid("5B11F4CE-A62D-471E-81FC-A69A8278C7DA") && !valid_mbid("x"));

        let d = json!({ "data": [ { "id": 7, "name": "Some One" }, { "id": 9, "name": "SOMEONE" } ] });
        // Spaces and case don't count: "Some One" is the first exact match.
        assert_eq!(parse_deezer(&d, "Someone").unwrap().url, "https://www.deezer.com/artist/7");
        assert!(parse_deezer(&d, "Nobody").is_none());
        let i = json!({ "results": [ { "artistId": 5, "artistName": "Someone", "artistLinkUrl": "https://evil.example/" } ] });
        assert_eq!(parse_itunes(&i, "someone").unwrap().url, "https://music.apple.com/artist/5");
        // Found by name only: unverified, with what tells homonyms apart.
        let d = json!({ "data": [ { "id": 7, "name": "Someone", "nb_fan": 1200, "nb_album": 3 } ] });
        let dz = parse_deezer(&d, "Someone").unwrap();
        assert!(!dz.verified);
        assert_eq!(dz.match_info, Some(MatchInfo { fans: Some(1200), albums: Some(3), ..MatchInfo::default() }));
        let i = json!({ "results": [ { "artistId": 5, "artistName": "Someone", "primaryGenreName": "Hip-Hop/Rap" } ] });
        let it = parse_itunes(&i, "Someone").unwrap();
        assert!(!it.verified && it.match_info.unwrap().genre.as_deref() == Some("Hip-Hop/Rap"));
        assert_eq!(parse_deezer_top(&json!({ "data": [ { "title": "Night Drive" } ] })).as_deref(), Some("Night Drive"));
        assert_eq!(parse_deezer_top(&json!({ "data": [] })), None);
        let top = json!({ "results": [ { "wrapperType": "artist", "artistName": "Someone" }, { "wrapperType": "track", "trackName": "Cold Room" } ] });
        assert_eq!(parse_itunes_top(&top).as_deref(), Some("Cold Room"));
        // MusicBrainz links and hand-added ones count as checked.
        assert!(l("https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb").unwrap().verified);
        let m = manual_link("https://www.instagram.com/someone/").unwrap();
        assert_eq!((m.source, m.verified), (Source::Manual, true));
        assert!(manual_link("javascript:alert(1)").is_none());
        assert_eq!(normalize("Mé-Dé !!"), "médé");
    }

    #[test]
    fn spotify_artist_parses_and_keeps_only_its_cdn_picture() {
        let v = json!({ "followers": { "total": 1234 }, "popularity": 57, "genres": ["french hip hop", "rap", "", "x"], "images": [ { "url": "https://i.scdn.co/image/abc" } ] });
        let d = parse_spotify_artist(&v, "4Z8W4fKeB5YxbusRsdQVPb");
        assert_eq!((d.followers, d.popularity, d.genres.len(), d.image_url.as_deref()), (Some(1234), Some(57), 3, Some("https://i.scdn.co/image/abc")));
        // What a development-mode app gets: no followers, popularity or genres.
        let v = json!({ "id": "x", "name": "Someone", "images": [ { "url": "https://evil.example/x.jpg" } ] });
        let d = parse_spotify_artist(&v, "id");
        assert_eq!((d.followers, d.popularity, d.genres.len(), d.image_url), (None, None, 0, None));
    }

    /// A local Spotify: `/token` hands out "t1", then "t2"…; `/artists/<id>`
    /// refuses "t1" with a 401 (a revoked token) and answers the others.
    fn mock_spotify() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr().to_ip().unwrap());
        let issued = std::sync::Arc::new(AtomicUsize::new(0));
        let count = issued.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let (status, body) = if req.url() == "/token" {
                    let n = count.fetch_add(1, Ordering::SeqCst) + 1;
                    (200, json!({ "access_token": format!("t{n}"), "expires_in": 3600 }))
                } else {
                    let auth = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.to_string()).unwrap_or_default();
                    if auth == "Bearer t1" { (401, json!({ "error": "bad token" })) } else { (200, json!({ "name": "Someone", "followers": { "total": 5 } })) }
                };
                let _ = req.respond(tiny_http::Response::from_string(body.to_string()).with_status_code(status));
            }
        });
        (base, issued)
    }

    #[test]
    fn spotify_token_resets_and_a_401_retries_once() {
        use std::sync::atomic::Ordering;
        let (base, issued) = mock_spotify();
        let app = SpotifyApp { token_url: format!("{base}/token"), id: "a".repeat(32), secret: "b".repeat(32) };
        let client = reqwest::Client::new();
        tauri::async_runtime::block_on(async {
            clear_spotify_token();
            // "t1" is refused: the cache is dropped, "t2" is fetched, the call retried.
            let (name, d) = spotify_artist(&client, &base, &app, "4Z8W4fKeB5YxbusRsdQVPb").await.unwrap();
            assert_eq!((name.as_str(), d.followers), ("Someone", Some(5)));
            assert_eq!(issued.load(Ordering::SeqCst), 2);
            // "t2" is cached now: no new token.
            spotify_artist(&client, &base, &app, "4Z8W4fKeB5YxbusRsdQVPb").await.unwrap();
            assert_eq!(issued.load(Ordering::SeqCst), 2);
            // New credentials clear the cache: the next call asks again.
            clear_spotify_token();
            assert!(token_cache().lock().unwrap().is_none());
            spotify_artist(&client, &base, &app, "4Z8W4fKeB5YxbusRsdQVPb").await.unwrap();
            assert_eq!(issued.load(Ordering::SeqCst), 3);
        });
    }

    #[test]
    fn credentials_are_checked_and_removable() {
        let root = std::env::temp_dir().join(format!("hivo-spotify-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let p = root.join("spotify.json");
        assert!(store_credentials(&p, Some("short".into()), Some("x".repeat(32))).is_err());
        assert!(store_credentials(&p, Some("a".repeat(32)), Some("b".repeat(32))).is_ok());
        let saved = read_secrets(&p);
        assert_eq!(saved.client_id.as_deref(), Some("a".repeat(32).as_str()));
        assert!(store_credentials(&p, None, None).is_ok() && !p.exists());
        assert!(store_credentials(&p, None, None).is_ok(), "removing twice is fine");
        let _ = fs::remove_dir_all(&root);
    }
}
