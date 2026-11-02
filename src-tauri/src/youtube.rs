//! YouTube search for the Digger: the YouTube Data API v3 (free quota:
//! 10,000 units a day, a search costs 100, so about 100 searches a day).
//! Same security model as ai.rs and cover.rs: the key lives in its own
//! owner-only file in the app config dir (or comes from the environment) and
//! never reaches the webview. It travels in the `X-Goog-Api-Key` header, never
//! in a URL, so it can't leak through error text.
//!
//! API (developers.google.com/youtube/v3/docs/search/list):
//! `GET {API_BASE}/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&q=…` (embeddable only: the Digger plays results in an embed)
//! answers `{ "items": [{ "id": { "videoId" }, "snippet": { "title",
//! "channelTitle", "publishedAt" } }] }`. Links and thumbnails are rebuilt
//! here from a checked video ID: nothing from the answer is used as a URL.
//!
//! Search only: no downloading, ever (YouTube terms, docs/GUARDRAILS.md).

use crate::error::app_err;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const API_BASE: &str = "https://www.googleapis.com/youtube/v3";
const KEY_ENV: &str = "YOUTUBE_API_KEY";
/// YouTube's "Music" category.
const MUSIC_CATEGORY: &str = "10";
pub const MAX_RESULTS: usize = 12;
pub const MAX_QUERY_CHARS: usize = 120;
const MAX_TITLE_CHARS: usize = 200;
const MAX_CHANNEL_CHARS: usize = 100;
/// Same query again within this window: answered from memory, no quota spent.
const CACHE_FOR: Duration = Duration::from_secs(6 * 60 * 60);
const CACHE_MAX: usize = 64;

#[derive(Default, Serialize, Deserialize)]
struct YoutubeSecrets {
    #[serde(default)]
    api_key: Option<String>,
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| app_err("config.dir", format!("could not resolve app config dir: {e}")))?;
    fs::create_dir_all(&dir).map_err(|e| app_err("config.dir", format!("could not create config dir: {e}")))?;
    Ok(dir.join("youtube.json"))
}

fn read_secrets(path: &Path) -> YoutubeSecrets {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The environment wins (dev machines), else the key saved from Settings.
fn api_key(app: &AppHandle) -> Option<(String, &'static str)> {
    if let Some(k) = non_empty(std::env::var(KEY_ENV).ok()) {
        return Some((k, "env"));
    }
    let saved = secrets_path(app).map(|p| read_secrets(&p)).unwrap_or_default();
    non_empty(saved.api_key).map(|k| (k, "settings"))
}

/// Google API keys are ~39 characters of letters, digits, `-` and `_`.
/// Checked before the key goes into a header.
fn valid_key(key: &str) -> bool {
    (30..=100).contains(&key.len()) && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Saves the key, or removes the file when it is None/empty.
fn store_key(path: &Path, key: Option<String>) -> Result<(), String> {
    let Some(key) = non_empty(key) else {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(app_err("secret.remove", format!("could not remove the YouTube key: {e}")).into()),
        };
    };
    if !valid_key(&key) {
        return Err(app_err("youtube.badKey", "That doesn't look like a Google API key. Copy it again, without spaces.").into());
    }
    let raw = serde_json::to_string_pretty(&YoutubeSecrets { api_key: Some(key) }).map_err(|e| e.to_string())?;
    crate::cover::write_private(path, raw.as_bytes()).map_err(|e| app_err("secret.save", format!("could not save the YouTube key: {e}")).into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeStatus {
    pub configured: bool,
    /// "env" or "settings".
    pub source: Option<String>,
}

#[tauri::command]
pub fn youtube_status(app: AppHandle) -> YoutubeStatus {
    let key = api_key(&app);
    YoutubeStatus { configured: key.is_some(), source: key.map(|(_, s)| s.to_string()) }
}

/// Saves (or, with None/empty, removes) the key. Never returned to the UI.
#[tauri::command]
pub fn set_youtube_key(app: AppHandle, key: Option<String>) -> Result<(), String> {
    store_key(&secrets_path(&app)?, key)
}

// ---- Search ----

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeVideo {
    pub id: String,
    pub title: String,
    pub channel: String,
    /// RFC 3339 date from YouTube, or empty.
    pub published_at: String,
    /// `https://www.youtube.com/watch?v=<id>`, built here.
    pub url: String,
    /// `https://i.ytimg.com/vi/<id>/mqdefault.jpg`, built here.
    pub thumbnail: String,
}

/// The query as sent: trimmed, whitespace collapsed, no control characters.
pub fn clean_query(q: &str) -> Result<String, String> {
    let q = q.split_whitespace().collect::<Vec<_>>().join(" ");
    if q.is_empty() {
        return Err(app_err("youtube.emptyQuery", "Type something to search for.").into());
    }
    if q.chars().count() > MAX_QUERY_CHARS {
        return Err(app_err("youtube.longQuery", format!("That search is too long ({MAX_QUERY_CHARS} characters max).")).with("max", MAX_QUERY_CHARS).into());
    }
    if q.chars().any(char::is_control) {
        return Err(app_err("youtube.badQuery", "That search has characters YouTube won't take.").into());
    }
    Ok(q)
}

/// Video IDs are 11 characters of letters, digits, `-` and `_`.
fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Titles come HTML-escaped (`&amp;`, `&#39;`…). Decodes the common ones.
fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn clip(s: &str, max: usize) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end())
    }
}

/// The videos out of a search answer. Items without a valid video ID are
/// dropped; duplicates too.
fn parse_videos(v: &Value) -> Vec<YoutubeVideo> {
    let mut out: Vec<YoutubeVideo> = Vec::new();
    for item in v.get("items").and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = item.pointer("/id/videoId").and_then(Value::as_str).filter(|id| valid_video_id(id)) else { continue };
        if out.iter().any(|o| o.id == id) {
            continue;
        }
        let text = |p: &str| item.pointer(p).and_then(Value::as_str).unwrap_or_default();
        let published = text("/snippet/publishedAt");
        out.push(YoutubeVideo {
            id: id.to_string(),
            title: clip(&unescape(text("/snippet/title")), MAX_TITLE_CHARS),
            channel: clip(&unescape(text("/snippet/channelTitle")), MAX_CHANNEL_CHARS),
            published_at: if published.len() <= 40 && published.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.' | '+')) {
                published.to_string()
            } else {
                String::new()
            },
            url: format!("https://www.youtube.com/watch?v={id}"),
            thumbnail: format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"),
        });
        if out.len() >= MAX_RESULTS {
            break;
        }
    }
    out
}

fn error_reason(v: &Value) -> String {
    v.pointer("/error/errors/0/reason")
        .and_then(Value::as_str)
        .or_else(|| v.pointer("/error/status").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// Errors in words the crew can act on. Never includes the key.
fn explain_error(status: u16, v: &Value) -> String {
    let reason = error_reason(v);
    let message = v.pointer("/error/message").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    let e = match (status, reason.as_str()) {
        (_, "quotaExceeded" | "dailyLimitExceeded" | "rateLimitExceeded") => app_err(
            "youtube.quota",
            "Today's free YouTube quota (about 100 searches) is used up. It resets at midnight Pacific time. The YouTube search links still work.",
        ),
        (_, "keyInvalid") => app_err("youtube.keyRejected", "YouTube rejected the API key. Check it in Settings → YouTube search."),
        (400, _) if message.contains("api key not valid") => app_err("youtube.keyRejected", "YouTube rejected the API key. Check it in Settings → YouTube search."),
        (_, "accessNotConfigured" | "SERVICE_DISABLED") => app_err(
            "youtube.apiOff",
            "This key's Google Cloud project doesn't have the YouTube Data API v3 turned on. Enable it in the Google Cloud console, then try again.",
        ),
        (403, "ipRefererBlocked" | "forbidden" | "PERMISSION_DENIED") => app_err(
            "youtube.keyNotAllowed",
            "This key isn't allowed to call the YouTube Data API. Check its API restrictions in the Google Cloud console.",
        ),
        (500..=599, _) => app_err("youtube.trouble", format!("YouTube is having trouble ({status}). Try again in a minute.")),
        _ => app_err("youtube.http", format!("YouTube search failed (HTTP {status}).")),
    };
    e.with("status", status).into()
}

type Cache = Mutex<HashMap<String, (Instant, Vec<YoutubeVideo>)>>;

fn cache() -> &'static Cache {
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(query: &str) -> Option<Vec<YoutubeVideo>> {
    let map = cache().lock().ok()?;
    map.get(&query.to_lowercase()).filter(|(at, _)| at.elapsed() < CACHE_FOR).map(|(_, v)| v.clone())
}

fn remember(query: &str, videos: &[YoutubeVideo]) {
    let Ok(mut map) = cache().lock() else { return };
    map.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
    if map.len() >= CACHE_MAX {
        if let Some(oldest) = map.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
            map.remove(&oldest);
        }
    }
    map.insert(query.to_lowercase(), (Instant::now(), videos.to_vec()));
}

/// One search call. `base` is injectable so tests can point it at a local server.
async fn search_at(client: &reqwest::Client, base: &str, key: &str, query: &str) -> Result<Vec<YoutubeVideo>, String> {
    if !valid_key(key) {
        return Err(app_err("youtube.badKey", "The YouTube API key isn't valid. Fix it in Settings → YouTube search.").into());
    }
    let max = MAX_RESULTS.to_string();
    let url = reqwest::Url::parse_with_params(
        &format!("{base}/search"),
        [("part", "snippet"), ("type", "video"), ("videoEmbeddable", "true"), ("videoCategoryId", MUSIC_CATEGORY), ("maxResults", max.as_str()), ("q", query)],
    )
    .map_err(|e| app_err("youtube.badQuery", format!("Couldn't build the YouTube search: {e}")))?;
    let res = client
        .get(url)
        .header("X-Goog-Api-Key", key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                String::from(app_err("youtube.timeout", "YouTube took too long to answer. Try again."))
            } else {
                app_err("youtube.offline", format!("Couldn't reach YouTube. Are you online? ({})", e.without_url())).into()
            }
        })?;
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(explain_error(status, &v));
    }
    Ok(parse_videos(&v))
}

/// Searches YouTube music videos. Answers from memory for a query seen in
/// the last few hours, so the daily quota lasts.
pub async fn search(app: &AppHandle, query: &str) -> Result<Vec<YoutubeVideo>, String> {
    let query = clean_query(query)?;
    if let Some(hit) = cached(&query) {
        return Ok(hit);
    }
    let (key, _) = api_key(app).ok_or_else(|| String::from(app_err("youtube.noKey", "No YouTube API key yet. Add one in Settings → YouTube search.")))?;
    let videos = search_at(&reqwest::Client::new(), API_BASE, &key, &query).await?;
    remember(&query, &videos);
    Ok(videos)
}

#[tauri::command]
pub async fn youtube_search(app: AppHandle, query: String) -> Result<Vec<YoutubeVideo>, String> {
    search(&app, &query).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    const KEY: &str = "AIzaTestKeyNotARealOne_0000000000000000";

    fn item(id: &str, title: &str) -> Value {
        json!({ "id": { "kind": "youtube#video", "videoId": id }, "snippet": { "title": title, "channelTitle": "Some Producer", "publishedAt": "2026-05-01T12:00:00Z" } })
    }

    /// A local HTTP server answering each request with the next canned
    /// response and recording the request head.
    fn mock_youtube(responses: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&buf).to_string());
                let body = body.to_string();
                let reply = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        (base, seen)
    }

    fn run(base: &str, key: &str, q: &str) -> Result<Vec<YoutubeVideo>, String> {
        tauri::async_runtime::block_on(search_at(&reqwest::Client::new(), base, key, q))
    }

    #[test]
    fn cleans_queries() {
        assert_eq!(clean_query("  dark   trap\tbeat ").unwrap(), "dark trap beat");
        assert!(clean_query("   ").is_err());
        assert!(clean_query(&"a".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert!(clean_query("a\u{0}b").is_err());
    }

    #[test]
    fn validates_keys_and_ids() {
        assert!(valid_key(KEY));
        assert!(!valid_key("short"));
        assert!(!valid_key("AIza key with spaces 0000000000000000000"));
        assert!(valid_video_id("dQw4w9WgXcQ"));
        assert!(!valid_video_id("dQw4w9WgXc"));
        assert!(!valid_video_id("../../evil/"));
    }

    #[test]
    fn parses_results_and_rebuilds_every_link() {
        let answer = json!({ "items": [
            item("abcdefghijk", "Dark Trap Beat &quot;Night&quot; &amp; Rain"),
            item("abcdefghijk", "duplicate"),
            item("javascript:", "bad id"),
            { "id": { "kind": "youtube#channel", "channelId": "UC123" }, "snippet": { "title": "a channel" } },
            item("ABCDEFGHIJ_", "Chill Lofi Type Beat"),
        ] });
        let videos = parse_videos(&answer);
        assert_eq!(videos.len(), 2);
        assert_eq!(videos[0].title, "Dark Trap Beat \"Night\" & Rain");
        assert_eq!(videos[0].url, "https://www.youtube.com/watch?v=abcdefghijk");
        assert_eq!(videos[1].thumbnail, "https://i.ytimg.com/vi/ABCDEFGHIJ_/mqdefault.jpg");
        assert_eq!(videos[1].published_at, "2026-05-01T12:00:00Z");
    }

    #[test]
    fn clips_long_titles() {
        let long = "x".repeat(500);
        let v = parse_videos(&json!({ "items": [item("abcdefghijk", &long)] }));
        assert_eq!(v[0].title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn sends_the_key_in_a_header_not_the_url() {
        let (base, seen) = mock_youtube(vec![(200, json!({ "items": [item("abcdefghijk", "t")] }))]);
        assert_eq!(run(&base, KEY, "dark trap").unwrap().len(), 1);
        let req = seen.lock().unwrap()[0].clone();
        let line = req.lines().next().unwrap();
        assert!(line.starts_with("GET /search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=12&q=dark+trap "), "{line}");
        assert!(!line.contains(KEY));
        assert!(req.to_lowercase().contains(&format!("x-goog-api-key: {}", KEY.to_lowercase())));
    }

    #[test]
    fn explains_quota_and_key_errors_without_the_key() {
        let quota = json!({ "error": { "code": 403, "message": "quota", "errors": [{ "reason": "quotaExceeded" }] } });
        let (base, _) = mock_youtube(vec![(403, quota)]);
        let err = run(&base, KEY, "q").unwrap_err();
        assert!(err.contains("quota") && !err.contains(KEY), "{err}");

        let bad = json!({ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.", "errors": [{ "reason": "badRequest" }] } });
        let (base, _) = mock_youtube(vec![(400, bad)]);
        assert!(run(&base, KEY, "q").unwrap_err().contains("rejected the API key"));

        let off = json!({ "error": { "code": 403, "errors": [{ "reason": "accessNotConfigured" }] } });
        let (base, _) = mock_youtube(vec![(403, off)]);
        assert!(run(&base, KEY, "q").unwrap_err().contains("YouTube Data API v3"));
    }

    #[test]
    fn refuses_a_bad_key_before_any_request() {
        assert!(run("http://127.0.0.1:9", "not a key", "q").unwrap_err().contains("isn't valid"));
    }

    #[test]
    fn reports_network_errors_without_the_key() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = run(&format!("http://127.0.0.1:{port}"), KEY, "q").unwrap_err();
        assert!(err.contains("Couldn't reach YouTube") && !err.contains(KEY), "{err}");
    }

    #[test]
    fn remembers_recent_searches() {
        let v = parse_videos(&json!({ "items": [item("abcdefghijk", "t")] }));
        remember("Unit Test Query", &v);
        assert_eq!(cached("unit test query"), Some(v));
        assert_eq!(cached("another query"), None);
    }

    #[test]
    fn stores_the_key_owner_only_and_removes_it() {
        let dir = std::env::temp_dir().join(format!("hivo-yt-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("youtube.json");
        assert!(store_key(&path, Some("nope".into())).is_err());
        store_key(&path, Some(format!("  {KEY} "))).unwrap();
        assert_eq!(read_secrets(&path).api_key.as_deref(), Some(KEY));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        store_key(&path, None).unwrap();
        assert!(!path.exists());
        store_key(&path, Some(" ".into())).unwrap();
        let _ = fs::remove_dir_all(dir);
    }
}
