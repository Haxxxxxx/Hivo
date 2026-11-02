//! Cover-art concepts: FLUX.1 [schnell] on Cloudflare Workers AI (free
//! allocation: 10,000 neurons a day). Same security model as ai.rs: the
//! account ID and API token live in their own owner-only file in the app
//! config dir (or come from the environment) and never reach the webview.
//! The prompt is built in the frontend (src/lib/cover.ts).
//!
//! API (developers.cloudflare.com/workers-ai/models/flux-1-schnell/):
//! `POST {API_BASE}/accounts/{account_id}/ai/run/@cf/black-forest-labs/flux-1-schnell`
//! with `Authorization: Bearer <token>` and `{ "prompt", "steps" (max 8,
//! default 4) }`; the answer is the usual Cloudflare envelope
//! `{ "result": { "image": "<base64 JPEG>" }, "success", "errors", "messages" }`.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const API_BASE: &str = "https://api.cloudflare.com/client/v4";
pub const MODEL: &str = "@cf/black-forest-labs/flux-1-schnell";
const ACCOUNT_ENV: &str = "CLOUDFLARE_ACCOUNT_ID";
const TOKEN_ENV: &str = "CLOUDFLARE_API_TOKEN";
/// Diffusion steps: the model's default. Each step costs ~9.6 neurons, so
/// 4 steps keep a 1024 px image near 58 neurons (~170 a day for free).
const STEPS: u32 = 4;
/// The model's documented prompt limit.
const MAX_PROMPT_CHARS: usize = 2048;
/// File name of the picked concept inside the kit folder.
pub const COVER_FILE: &str = "cover-concept.jpg";
/// Cloudflare's "you have used up your daily free allocation" error.
const QUOTA_CODE: i64 = 3036;

#[derive(Default, Serialize, Deserialize)]
struct CoverSecrets {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    api_token: Option<String>,
}

struct Credentials {
    account_id: String,
    token: String,
}

fn secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("could not resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("cover.json"))
}

fn read_secrets(path: &Path) -> CoverSecrets {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Both environment variables win (dev machines), else what Settings saved.
/// A half-set environment is ignored rather than mixed with the file.
fn resolve(env_account: Option<String>, env_token: Option<String>, saved: CoverSecrets) -> Option<(Credentials, &'static str)> {
    if let (Some(account_id), Some(token)) = (non_empty(env_account), non_empty(env_token)) {
        return Some((Credentials { account_id, token }, "env"));
    }
    match (non_empty(saved.account_id), non_empty(saved.api_token)) {
        (Some(account_id), Some(token)) => Some((Credentials { account_id, token }, "settings")),
        _ => None,
    }
}

fn credentials(app: &AppHandle) -> Option<(Credentials, &'static str)> {
    let saved = secrets_path(app).map(|p| read_secrets(&p)).unwrap_or_default();
    resolve(std::env::var(ACCOUNT_ENV).ok(), std::env::var(TOKEN_ENV).ok(), saved)
}

/// Cloudflare account IDs are 32 hex characters. Checked before the ID goes
/// into the URL path.
fn valid_account_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Tokens go into a header: printable ASCII, no spaces.
fn valid_token(token: &str) -> bool {
    (20..=200).contains(&token.len()) && token.chars().all(|c| c.is_ascii_graphic())
}

/// Writes `bytes` readable by the owner only, from the moment the file
/// exists (no world-readable window). On Windows the per-user %APPDATA% ACL
/// is what protects it.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        // An older file may have been created with wider permissions.
        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    let mut file = options.open(path)?;
    std::io::Write::write_all(&mut file, bytes)
}

/// Saves both values, or removes the file when both are None/empty.
fn store_credentials(path: &Path, account_id: Option<String>, token: Option<String>) -> Result<(), String> {
    let (account_id, token) = (non_empty(account_id), non_empty(token));
    let (account_id, token) = match (account_id, token) {
        (None, None) => {
            return match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("could not remove the Cloudflare credentials: {e}")),
            };
        }
        (Some(a), Some(t)) => (a.to_ascii_lowercase(), t),
        _ => return Err("Enter both the account ID and the API token.".to_string()),
    };
    if !valid_account_id(&account_id) {
        return Err("That doesn't look like a Cloudflare account ID (32 letters a–f and digits). Copy it from the Workers AI page of the dashboard.".to_string());
    }
    if !valid_token(&token) {
        return Err("That doesn't look like a Cloudflare API token. Copy it again, without spaces.".to_string());
    }
    let raw = serde_json::to_string_pretty(&CoverSecrets { account_id: Some(account_id), api_token: Some(token) }).map_err(|e| e.to_string())?;
    write_private(path, raw.as_bytes()).map_err(|e| format!("could not save the Cloudflare credentials: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverStatus {
    pub configured: bool,
    /// "env" or "settings".
    pub source: Option<String>,
    pub model: String,
}

#[tauri::command]
pub fn cover_status(app: AppHandle) -> CoverStatus {
    let creds = credentials(&app);
    CoverStatus {
        configured: creds.is_some(),
        source: creds.map(|(_, s)| s.to_string()),
        model: MODEL.to_string(),
    }
}

/// Saves (or, with both None/empty, removes) the account ID and token.
/// Never returned to the UI.
#[tauri::command]
pub fn set_cover_credentials(app: AppHandle, account_id: Option<String>, token: Option<String>) -> Result<(), String> {
    store_credentials(&secrets_path(&app)?, account_id, token)
}

// ---- Transport ----

const MAX_RETRIES: u32 = 4;
/// Longest server-suggested wait we sit through.
const MAX_WAIT: Duration = Duration::from_secs(20);
/// Milliseconds before the first retry (tiny in tests so they stay fast).
const BACKOFF_BASE_MS: u64 = if cfg!(test) { 10 } else { 1000 };

/// Exponential backoff with jitter: ~1 s, 2 s, 4 s, 8 s, plus 0–400 ms so
/// parallel requests don't retry in lockstep.
fn backoff(attempt: u32) -> Duration {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis() as u64 % (BACKOFF_BASE_MS * 2 / 5))
        .unwrap_or(0);
    Duration::from_millis(BACKOFF_BASE_MS * 2u64.pow(attempt.min(5)) + jitter)
}

fn error_codes(v: &Value) -> Vec<i64> {
    v.get("errors").and_then(Value::as_array).map(|a| a.iter().filter_map(|e| e.get("code")?.as_i64()).collect()).unwrap_or_default()
}

fn error_message(v: &Value) -> String {
    v.get("errors")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|e| e.get("message")?.as_str()).collect::<Vec<_>>().join("; "))
        .unwrap_or_default()
}

/// The daily free allocation is spent: waiting won't help until 00:00 UTC.
fn quota_used_up(v: &Value) -> bool {
    error_codes(v).contains(&QUOTA_CODE) || error_message(v).to_lowercase().contains("daily free allocation")
}

/// Transient: timeouts, capacity (429 other than the daily quota), server errors.
fn retryable(status: u16, v: &Value) -> bool {
    match status {
        408 | 500..=599 => true,
        429 => !quota_used_up(v),
        _ => false,
    }
}

#[derive(Debug)]
enum Failure {
    Http(u16, Value),
    Other(String),
}

/// Errors in words the crew can act on. Never includes the token.
fn explain_error(status: u16, v: &Value) -> String {
    let msg = error_message(v);
    let codes = error_codes(v);
    match status {
        429 if quota_used_up(v) => {
            "Today's free Workers AI allowance (10,000 neurons, about 170 concepts) is used up. It resets at 00:00 UTC.".to_string()
        }
        429 => "Cloudflare is out of capacity for FLUX right now, even after several retries. Try again in a minute.".to_string(),
        401 => "Cloudflare rejected the API token. Check it in Settings → Cover art.".to_string(),
        403 if codes.contains(&10000) || msg.to_lowercase().contains("authentication") => {
            "Cloudflare rejected the API token. Check it in Settings → Cover art (it needs the Workers AI permission).".to_string()
        }
        403 => "This token isn't allowed to run Workers AI on that account. Create one with the \"Workers AI\" template (Settings → Cover art).".to_string(),
        404 => "Cloudflare didn't find that account ID, or the FLUX model moved. Check the account ID in Settings → Cover art.".to_string(),
        400 if codes.contains(&7003) || codes.contains(&7000) => {
            "Cloudflare didn't find that account ID. Check it in Settings → Cover art.".to_string()
        }
        400 if !msg.is_empty() => format!("Cloudflare refused the request: {msg}"),
        408 => "FLUX took too long to answer. Try again.".to_string(),
        500..=599 => format!("Cloudflare Workers AI is having trouble ({status}), even after several retries. Try again in a few minutes."),
        _ if !msg.is_empty() => format!("Cloudflare error: {msg}"),
        _ => format!("Cloudflare error (HTTP {status})."),
    }
}

/// Seconds from a `Retry-After` header, if sane.
fn retry_after(res: &reqwest::Response) -> Option<Duration> {
    let s = res.headers().get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    s.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// One model call, retrying transient failures with backoff. `base` is
/// injectable so tests can point it at a local server.
async fn run_model(client: &reqwest::Client, base: &str, creds: &Credentials, body: &Value, retries: u32) -> Result<Value, Failure> {
    if !valid_account_id(&creds.account_id) {
        return Err(Failure::Other("The Cloudflare account ID isn't valid (32 letters a–f and digits). Fix it in Settings → Cover art.".to_string()));
    }
    let url = format!("{base}/accounts/{}/ai/run/{MODEL}", creds.account_id);
    let mut attempt = 0;
    loop {
        let sent = client.post(&url).bearer_auth(&creds.token).json(body).send().await;
        let (status, hint, v) = match sent {
            Ok(res) => {
                let status = res.status().as_u16();
                let hint = retry_after(&res);
                let is_image = res
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|c| c.to_str().ok())
                    .is_some_and(|c| c.starts_with("image/"));
                let v = if is_image && (200..300).contains(&status) {
                    // Raw bytes instead of the JSON envelope: wrap them the same way.
                    match res.bytes().await {
                        Ok(b) => json!({ "success": true, "result": { "image": base64::engine::general_purpose::STANDARD.encode(&b) } }),
                        Err(_) => Value::Null,
                    }
                } else {
                    res.json().await.unwrap_or(Value::Null)
                };
                (status, hint, v)
            }
            Err(e) if e.is_timeout() => return Err(Failure::Other("FLUX took too long to answer. Try again.".to_string())),
            Err(e) if e.is_connect() && attempt < retries => {
                tokio::time::sleep(backoff(attempt)).await;
                attempt += 1;
                continue;
            }
            // without_url: keep the account ID out of error text.
            Err(e) => return Err(Failure::Other(format!("Couldn't reach Cloudflare. Are you online? ({})", e.without_url()))),
        };
        if (200..300).contains(&status) {
            return Ok(v);
        }
        if retryable(status, &v) && attempt < retries {
            let wait = hint.unwrap_or_else(|| backoff(attempt));
            if wait <= MAX_WAIT {
                tokio::time::sleep(wait).await;
                attempt += 1;
                continue;
            }
        }
        return Err(Failure::Http(status, v));
    }
}

/// The base64 JPEG out of a 200 answer, checked to really be an image.
fn parse_image(v: &Value) -> Result<(String, Vec<u8>), String> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = error_message(v);
        return Err(if msg.is_empty() { "Cloudflare reported a failure without details.".to_string() } else { format!("Cloudflare error: {msg}") });
    }
    let b64 = v
        .pointer("/result/image")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("FLUX answered without an image. Try again.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "FLUX's image wasn't valid base64. Try again.".to_string())?;
    if !is_jpeg(&bytes) {
        return Err("FLUX's answer wasn't a JPEG image. Try again.".to_string());
    }
    Ok((b64.to_string(), bytes))
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() > 4 && bytes[..3] == [0xFF, 0xD8, 0xFF]
}

/// Width and height from the first SOF marker of a JPEG.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        // Fill bytes / standalone markers.
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if matches!(marker, 0x01 | 0xD0..=0xD9) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            if i + 9 > bytes.len() {
                return None;
            }
            let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// A seed when the UI didn't send one.
fn fresh_seed() -> u32 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    // Mix the bits a little; keep it positive in a signed 32-bit int.
    ((nanos ^ (nanos >> 29)).wrapping_mul(0x9E37_79B9) as u32) & 0x7FFF_FFFF
}

/// The documented input schema lists only `prompt` and `steps` (with
/// additionalProperties: false) while the docs' own examples send `seed`.
/// If the API ever refuses the seed, ask again without it.
fn rejects_seed(status: u16, v: &Value) -> bool {
    let msg = error_message(v).to_lowercase();
    status == 400 && (msg.contains("seed") || msg.contains("additional propert"))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoverImage {
    /// Base64 JPEG, straight from FLUX.
    pub image_b64: String,
    pub seed: u32,
    /// False if Cloudflare refused the seed and the image is unseeded.
    pub seed_applied: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

async fn generate(client: &reqwest::Client, base: &str, creds: &Credentials, prompt: &str, seed: u32) -> Result<CoverImage, String> {
    let body = json!({ "prompt": prompt, "steps": STEPS, "seed": seed });
    let mut seed_applied = true;
    let v = match run_model(client, base, creds, &body, MAX_RETRIES).await {
        Err(Failure::Http(status, v)) if rejects_seed(status, &v) => {
            seed_applied = false;
            run_model(client, base, creds, &json!({ "prompt": prompt, "steps": STEPS }), MAX_RETRIES).await
        }
        other => other,
    };
    let v = v.map_err(|f| match f {
        Failure::Http(status, v) => explain_error(status, &v),
        Failure::Other(message) => message,
    })?;
    let (image_b64, bytes) = parse_image(&v)?;
    let size = jpeg_size(&bytes);
    Ok(CoverImage { image_b64, seed, seed_applied, width: size.map(|s| s.0), height: size.map(|s| s.1) })
}

/// One cover concept from FLUX.1 [schnell]: base64 JPEG + the seed used.
#[tauri::command]
pub async fn generate_cover(app: AppHandle, prompt: String, seed: Option<u32>) -> Result<CoverImage, String> {
    let (creds, _) = credentials(&app).ok_or("Cover concepts are off. Add a free Cloudflare account ID and token in Settings → Cover art.")?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("The cover prompt is empty. Write a cover art brief first.".to_string());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("The cover prompt is longer than FLUX accepts ({MAX_PROMPT_CHARS} characters)."));
    }
    let seed = seed.map(|s| s & 0x7FFF_FFFF).unwrap_or_else(fresh_seed);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("could not start the HTTP client: {e}"))?;
    generate(&client, API_BASE, &creds, prompt, seed).await
}

/// Biggest image we accept to save (FLUX answers are ~100–300 KB).
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

fn write_cover(output_folder: &str, owner: &str, folder_name: &str, previous: Option<&str>, image_b64: &str) -> Result<PathBuf, String> {
    if output_folder.trim().is_empty() || !Path::new(output_folder).is_dir() {
        return Err("Set an export folder in Settings first.".to_string());
    }
    if image_b64.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("That image is too large to save.".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(image_b64.trim()).map_err(|_| "The image data is corrupted.".to_string())?;
    if !is_jpeg(&bytes) {
        return Err("Only JPEG concepts can be saved.".to_string());
    }
    // This song's kit folder (kits.rs: sanitized, owned, never a symlink).
    let dir = crate::kits::resolve_kit_dir(Path::new(output_folder), folder_name, owner, previous)?;
    let path = dir.join(COVER_FILE);
    crate::kits::write_new(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path)
}

/// Saves the picked concept as `<export folder>/Launch Kits/<song>/cover-concept.jpg`
/// (`song` = the workspace key, `previous_folder` = the kit folder the app
/// recorded for it, see `kits::resolve_kit_dir`).
#[tauri::command]
pub async fn save_cover(app: AppHandle, song: String, folder_name: String, previous_folder: Option<String>, image_b64: String) -> Result<String, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let output_folder = scope.output()?.to_string_lossy().to_string();
    let owner = crate::kits::kit_owner(&scope.known_file(&song)?.to_string_lossy());
    tauri::async_runtime::spawn_blocking(move || {
        write_cover(&output_folder, &owner, &folder_name, previous_folder.as_deref(), &image_b64).map(|p| p.to_string_lossy().to_string())
    })
        .await
        .map_err(|e| format!("saving failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";
    const TOKEN: &str = "test-token-not-a-real-one-0000";

    fn creds() -> Credentials {
        Credentials { account_id: ACCOUNT.to_string(), token: TOKEN.to_string() }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flsm-cover-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A minimal JPEG header: SOI, an APP0 segment, then SOF0 with 1024×768.
    fn tiny_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        b.extend_from_slice(b"JFIF\0");
        b.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        b.extend_from_slice(&[0xFF, 0xD9]);
        b
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn ok_answer() -> Value {
        json!({ "result": { "image": b64(&tiny_jpeg(1024, 1024)) }, "success": true, "errors": [], "messages": [] })
    }

    fn cf_error(code: i64, message: &str) -> Value {
        json!({ "result": null, "success": false, "errors": [{ "code": code, "message": message }], "messages": [] })
    }

    #[test]
    fn validates_account_ids() {
        assert!(valid_account_id(ACCOUNT));
        assert!(valid_account_id(&ACCOUNT.to_uppercase()));
        assert!(!valid_account_id("0123456789abcdef"));
        assert!(!valid_account_id("0123456789abcdef0123456789abcdeg"));
        assert!(!valid_account_id("../../../../../../../../../../.."));
        assert!(!valid_account_id("0123456789abcdef0123456789abcd/f"));
        assert!(!valid_account_id(""));
    }

    #[test]
    fn validates_tokens() {
        assert!(valid_token(TOKEN));
        assert!(!valid_token("short"));
        assert!(!valid_token("has a space in the middle of it"));
        assert!(!valid_token("line\nbreak-token-0000000000000"));
    }

    #[test]
    fn env_wins_only_when_complete() {
        let saved = || CoverSecrets { account_id: Some(ACCOUNT.into()), api_token: Some("saved-token".into()) };
        let (c, src) = resolve(Some("f".repeat(32)), Some("env-token".into()), saved()).unwrap();
        assert_eq!((c.account_id.as_str(), c.token.as_str(), src), ("f".repeat(32).as_str(), "env-token", "env"));
        let (c, src) = resolve(Some("f".repeat(32)), None, saved()).unwrap();
        assert_eq!((c.token.as_str(), src), ("saved-token", "settings"));
        let (_, src) = resolve(Some("  ".into()), Some("".into()), saved()).unwrap();
        assert_eq!(src, "settings");
        assert!(resolve(None, None, CoverSecrets { account_id: Some(ACCOUNT.into()), api_token: None }).is_none());
    }

    #[test]
    fn stores_credentials_owner_only_and_removes_them() {
        let dir = temp_dir("creds");
        let path = dir.join("cover.json");
        store_credentials(&path, Some(format!(" {} ", ACCOUNT.to_uppercase())), Some(TOKEN.into())).unwrap();
        let saved = read_secrets(&path);
        assert_eq!(saved.account_id.as_deref(), Some(ACCOUNT), "trimmed and lowercased");
        assert_eq!(saved.api_token.as_deref(), Some(TOKEN));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            // A file left world-readable by something else gets tightened on save.
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            store_credentials(&path, Some(ACCOUNT.into()), Some(TOKEN.into())).unwrap();
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Half a pair or a bad ID is refused and leaves the file alone.
        assert!(store_credentials(&path, Some(ACCOUNT.into()), None).is_err());
        assert!(store_credentials(&path, Some("not-hex".into()), Some(TOKEN.into())).unwrap_err().contains("account ID"));
        assert_eq!(read_secrets(&path).api_token.as_deref(), Some(TOKEN));
        store_credentials(&path, None, Some("  ".into())).unwrap();
        assert!(!path.exists());
        store_credentials(&path, None, None).unwrap(); // removing twice is fine
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_the_cloudflare_envelope() {
        let (image, bytes) = parse_image(&ok_answer()).unwrap();
        assert!(!image.is_empty());
        assert_eq!(jpeg_size(&bytes), Some((1024, 1024)));
        assert!(parse_image(&json!({ "result": {}, "success": true })).unwrap_err().contains("without an image"));
        assert!(parse_image(&json!({ "result": { "image": "%%%" }, "success": true })).unwrap_err().contains("base64"));
        assert!(parse_image(&json!({ "result": { "image": b64(b"\x89PNG\r\n\x1a\n....") }, "success": true })).unwrap_err().contains("JPEG"));
        assert!(parse_image(&cf_error(5004, "bad input")).unwrap_err().contains("bad input"));
    }

    #[test]
    fn reads_jpeg_dimensions() {
        assert_eq!(jpeg_size(&tiny_jpeg(1024, 768)), Some((1024, 768)));
        assert_eq!(jpeg_size(b"\xFF\xD8\xFF"), None);
        assert_eq!(jpeg_size(&[0xFF, 0xD8, 0x00, 0x00, 0x00, 0x00]), None);
    }

    #[test]
    fn explains_errors_in_plain_words() {
        let quota = cf_error(QUOTA_CODE, "AiError: you have used up your daily free allocation of 10,000 neurons");
        assert!(explain_error(429, &quota).contains("resets at 00:00 UTC"));
        assert!(explain_error(429, &cf_error(3040, "Capacity temporarily exceeded")).contains("capacity"));
        assert!(explain_error(401, &Value::Null).contains("token"));
        assert!(explain_error(403, &cf_error(10000, "Authentication error")).contains("rejected the API token"));
        assert!(explain_error(403, &cf_error(3023, "Account blocked")).contains("isn't allowed"));
        assert!(explain_error(404, &Value::Null).contains("account ID"));
        assert!(explain_error(400, &cf_error(7003, "Could not route")).contains("account ID"));
        assert!(explain_error(400, &cf_error(5006, "prompt flagged")).contains("prompt flagged"));
        assert!(explain_error(503, &Value::Null).contains("503"));
        for s in [400, 401, 403, 404, 429, 500] {
            assert!(!explain_error(s, &cf_error(1, "x")).contains(TOKEN));
        }
    }

    #[test]
    fn retries_only_transient_errors() {
        for s in [408, 500, 502, 503, 504] {
            assert!(retryable(s, &Value::Null), "{s} should be retried");
        }
        assert!(retryable(429, &cf_error(3040, "Capacity temporarily exceeded")));
        assert!(!retryable(429, &cf_error(QUOTA_CODE, "daily free allocation")), "the daily quota won't come back by waiting");
        for s in [400, 401, 403, 404] {
            assert!(!retryable(s, &Value::Null), "{s} should not be retried");
        }
    }

    #[test]
    fn backoff_grows_exponentially() {
        let base = BACKOFF_BASE_MS as u128;
        for a in 0..4 {
            let m = backoff(a).as_millis();
            let floor = base * 2u128.pow(a);
            assert!((floor..floor + base * 2 / 5).contains(&m), "attempt {a}: {m} ms");
        }
    }

    #[test]
    fn fresh_seeds_fit_a_signed_int() {
        for _ in 0..100 {
            assert!(fresh_seed() <= i32::MAX as u32);
        }
    }

    /// A local HTTP server: answers each request with the next canned
    /// response and records the raw request (line, headers, body).
    fn mock_cloudflare(responses: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
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
                let (head_end, length) = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + length {
                    let n = stream.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&buf).to_string());
                let body = body.to_string();
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        (base, seen)
    }

    fn run(base: &str, prompt: &str, seed: u32) -> Result<CoverImage, String> {
        let client = reqwest::Client::new();
        tauri::async_runtime::block_on(generate(&client, base, &creds(), prompt, seed))
    }

    #[test]
    fn sends_the_documented_request() {
        let (base, seen) = mock_cloudflare(vec![(200, ok_answer())]);
        let image = run(&base, "a neon koi, album cover", 42).unwrap();
        assert_eq!((image.seed, image.seed_applied, image.width, image.height), (42, true, Some(1024), Some(1024)));
        let seen = seen.lock().unwrap();
        let req = &seen[0];
        assert!(req.starts_with(&format!("POST /accounts/{ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell HTTP/1.1")), "{req}");
        assert!(req.to_lowercase().contains(&format!("authorization: bearer {TOKEN}")));
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({ "prompt": "a neon koi, album cover", "steps": STEPS, "seed": 42 }));
    }

    #[test]
    fn retries_capacity_errors_until_it_works() {
        let busy = cf_error(3040, "Capacity temporarily exceeded, please try again.");
        let (base, seen) = mock_cloudflare(vec![(429, busy), (503, Value::Null), (200, ok_answer())]);
        assert!(run(&base, "p", 1).is_ok(), "should succeed on the third try");
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[test]
    fn gives_up_after_max_retries() {
        let (base, seen) = mock_cloudflare(vec![(503, Value::Null); 1 + MAX_RETRIES as usize]);
        assert!(run(&base, "p", 1).unwrap_err().contains("503"));
        assert_eq!(seen.lock().unwrap().len(), 1 + MAX_RETRIES as usize);
    }

    #[test]
    fn does_not_retry_the_daily_quota_or_a_bad_token() {
        let quota = cf_error(QUOTA_CODE, "you have used up your daily free allocation of 10,000 neurons");
        let (base, seen) = mock_cloudflare(vec![(429, quota)]);
        assert!(run(&base, "p", 1).unwrap_err().contains("allowance"));
        assert_eq!(seen.lock().unwrap().len(), 1);

        let (base, seen) = mock_cloudflare(vec![(401, cf_error(10000, "Authentication error"))]);
        let err = run(&base, "p", 1).unwrap_err();
        assert!(err.contains("token") && !err.contains(TOKEN));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn asks_again_without_a_seed_if_it_is_refused() {
        let refused = cf_error(5006, "Error: required properties at '/' are 'prompt'; additional properties not allowed: seed");
        let (base, seen) = mock_cloudflare(vec![(400, refused), (200, ok_answer())]);
        let image = run(&base, "p", 7).unwrap();
        assert!(!image.seed_applied);
        let seen = seen.lock().unwrap();
        let body: Value = serde_json::from_str(seen[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({ "prompt": "p", "steps": STEPS }));
    }

    #[test]
    fn refuses_a_bad_account_id_before_any_request() {
        let client = reqwest::Client::new();
        let bad = Credentials { account_id: "../evil".into(), token: TOKEN.into() };
        let r = tauri::async_runtime::block_on(run_model(&client, "http://127.0.0.1:9", &bad, &json!({}), 0));
        assert!(matches!(r, Err(Failure::Other(m)) if m.contains("account ID")));
    }

    #[test]
    fn reports_network_errors_without_the_url() {
        // Nothing listens on a port we just freed.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = run(&format!("http://127.0.0.1:{port}"), "p", 1).unwrap_err();
        assert!(err.contains("Couldn't reach Cloudflare"), "{err}");
        assert!(!err.contains(ACCOUNT));
    }

    #[test]
    fn saves_the_concept_into_the_kit_folder() {
        let out = temp_dir("save");
        let jpeg = tiny_jpeg(1024, 1024);
        let path = write_cover(out.to_str().unwrap(), "o", "../Envy: v2", None, &b64(&jpeg)).unwrap();
        assert_eq!(path, out.join(crate::scanner::LAUNCH_KITS_DIR).join("_Envy_ v2").join(COVER_FILE));
        assert_eq!(fs::read(&path).unwrap(), jpeg);
        assert!(write_cover(out.to_str().unwrap(), "o", "x", None, &b64(b"not a jpeg")).unwrap_err().contains("JPEG"));
        assert!(write_cover(out.join("missing").to_str().unwrap(), "o", "x", None, &b64(&jpeg)).unwrap_err().contains("export folder"));
        let _ = fs::remove_dir_all(out);
    }
}
