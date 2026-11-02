//! Phone sync (phase B step 2): the desktop half of docs/PHONE-SYNC.md.
//!
//! Opt-in (Settings → Phone sync, off by default). While it's on, a small
//! HTTP listener (tiny_http, its own thread) answers paired phones on the
//! local network. Plain HTTP, but every request and response body is an
//! envelope sealed with the device's pairing key (XChaCha20-Poly1305,
//! AAD = `hivo-sync-v1|<deviceId>|<path>`, `|resp` for answers), with a
//! timestamp window and a nonce set against replays. Anything that can't be
//! authenticated gets a bare 401; once the envelope opened, every error is
//! answered sealed (`bad request`, `clock` for a timestamp outside the
//! window), so the phone can tell "forgotten" from "something's off".
//!
//! Paired devices and their keys live in `phone-sync.json` in the app config
//! dir (owner-only, like ai.json / spotify.json), never in workspace.json and
//! never sent to the webview after the pairing QR. `/v1/hello` is answered
//! here; `/v1/snapshot` and `/v1/notes` are forwarded to the webview (the
//! single writer of workspace.json) with the `phone-sync-request` event and
//! answered through `phone_sync_reply`, or "busy" after 10 s.
//!
//! Protocol 1.2 (2026-11): replies are bound to the request they answer
//! (AAD `hivo-sync-v1|<device>|<path>|resp|<request nonce>`), pairing is a
//! one-time X25519 exchange (the QR holds a 5-minute token and this
//! computer's public key, never the device key: `/v1/pair`), and the replay
//! set survives a restart (`<store>.replay`, an append-only log). Phones
//! paired before 1.2 keep their key and get unbound replies only while they
//! don't say 1.2 (`StoredDevice::derived` = false: "Re-pair to upgrade").

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, Generate, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

// ---- Limits (docs/PHONE-SYNC.md) ----

/// Request bodies above this get a bare 413.
pub const MAX_BODY_BYTES: usize = 1_000_000;
/// Same as `MAX_NOTE_CHARS` in src/lib/notes.ts.
pub const MAX_NOTE_CHARS: usize = 20_000;
/// Same as `MAX_CHANGES` in src/lib/phoneSync.ts.
pub const MAX_CHANGES: usize = 500;
/// `|now - ts|` above this is rejected.
pub const TS_WINDOW_MS: i64 = 120_000;
/// Nonces are remembered this long.
pub const NONCE_TTL_MS: i64 = 600_000;
/// Bound on the remembered nonces; when full, new requests are refused.
const MAX_SEEN_NONCES: usize = 50_000;
/// Requests per device per second.
const RATE_PER_SEC: usize = 10;
/// Requests handled at once (each on its own thread); more get a 503.
const MAX_IN_FLIGHT: usize = 16;
const MAX_PHONE_NAME: usize = 60;
const MAX_DEVICES: usize = 20;
const MAX_ID_CHARS: usize = 4_096;
const MAX_ERROR_CHARS: usize = 120;
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// The webview's last-seen time is written at most this often per device.
const SEEN_WRITE_EVERY_MS: i64 = 60_000;
const AAD_PREFIX: &str = "hivo-sync-v1|";
/// What `/v1/hello` reports and what a phone says it speaks (`v` in the request).
pub const PROTOCOL: &str = "1.2";
/// v1.2 pairing: the phone's first request, sealed with the derived key.
pub const PAIR_PATH: &str = "/v1/pair";
/// A pairing QR works once, for this long.
pub const PAIR_TTL_MS: i64 = 300_000;
/// HKDF info prefix for the device key (then `<device>|<desktop pub>|<phone pub>`).
const PAIR_INFO_PREFIX: &str = "hivo-sync-v1.2|pair|";
/// The replay log is rewritten (live entries only) after this many appends.
const REPLAY_COMPACT_EVERY: usize = 10_000;
pub const REQUEST_EVENT: &str = "phone-sync-request";
const FORWARDED: [&str; 2] = ["/v1/snapshot", "/v1/notes"];
/// v1.1 (step 4): answered here from the phone inbox (crate::phone_inbox).
const INBOX_PATHS: [&str; 5] = ["/v1/ideas", "/v1/upload/start", "/v1/upload/chunk", "/v1/upload/finish", "/v1/inbox"];
pub const INBOX_EVENT: &str = "phone-inbox-changed";
/// Progress events (upload start/chunk/finish) at most this often, per item,
/// with a trailing one so the last progress always shows.
const INBOX_EVENT_EVERY: Duration = Duration::from_millis(1000);
/// A request body must arrive within this; a slower client loses its slot.
const BODY_DEADLINE: Duration = Duration::from_secs(20);
/// Connections one address can hold at once (bodies still being read
/// included), so a slow client on the LAN can't take every slot.
const MAX_PER_IP: usize = 4;
/// A paired phone that never said hello within this is forgotten (an
/// abandoned QR whose key shouldn't stay valid).
const UNSEEN_TTL_MS: i64 = 24 * 3600 * 1000;
/// A phone said hello with a newer Hivo than this computer's: the webview
/// checks for an update.
pub const PHONE_NEWER_EVENT: &str = "phone-sync-phone-newer";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

// ---- Envelope ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    /// 24-byte nonce, base64url without padding.
    pub n: String,
    /// Ciphertext + 16-byte tag, base64url without padding.
    pub c: String,
}

/// `hivo-sync-v1|<deviceId>|<path>`; answers use `<path>|resp`.
pub fn aad(device_id: &str, path: &str) -> String {
    format!("{AAD_PREFIX}{device_id}|{path}")
}

fn resp_path(path: &str) -> String {
    format!("{path}|resp")
}

/// The answer's AAD. v1.2: bound to the request's nonce
/// (`…|<path>|resp|<nonce>`), so an old sealed answer can't be replayed as
/// the answer to a new request. None: the 1.1 form (`…|<path>|resp`), only
/// for phones paired before 1.2 that don't say 1.2.
pub fn resp_aad(device_id: &str, path: &str, request_nonce: Option<&str>) -> String {
    match request_nonce {
        Some(n) => format!("{AAD_PREFIX}{device_id}|{path}|resp|{n}"),
        None => aad(device_id, &resp_path(path)),
    }
}

/// True when a phone's `v` is 1.2 or later (it checks the answer's binding).
pub fn speaks_bound(v: Option<&str>) -> bool {
    v.and_then(major_minor).is_some_and(|mm| mm >= (1, 2))
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    <[u8; N]>::try_generate().map_err(|e| format!("no system randomness: {e}"))
}

pub fn seal(key: &[u8; 32], aad: &str, plaintext: &[u8]) -> Result<Envelope, String> {
    let cipher = XChaCha20Poly1305::new(&(*key).into());
    let nonce_bytes = random_bytes::<24>()?;
    let nonce = XNonce::from(nonce_bytes);
    let c = cipher.encrypt(&nonce, Payload { msg: plaintext, aad: aad.as_bytes() }).map_err(|_| "encryption failed".to_string())?;
    Ok(Envelope { n: B64.encode(nonce_bytes), c: B64.encode(c) })
}

/// The plaintext, or None for anything that doesn't decode or authenticate.
pub fn open(key: &[u8; 32], aad: &str, env: &Envelope) -> Option<Vec<u8>> {
    let n = B64.decode(env.n.as_bytes()).ok()?;
    let n: [u8; 24] = n.try_into().ok()?;
    let c = B64.decode(env.c.as_bytes()).ok()?;
    let cipher = XChaCha20Poly1305::new(&(*key).into());
    cipher.decrypt(&XNonce::from(n), Payload { msg: &c, aad: aad.as_bytes() }).ok()
}

/// What's inside a request envelope.
#[derive(Debug, Serialize, Deserialize)]
pub struct SealedRequest {
    pub ts: i64,
    pub nonce: String,
    #[serde(default)]
    pub body: Value,
    /// The protocol the phone speaks ("1.2"); absent from 1.1 phones.
    #[serde(default)]
    pub v: Option<String>,
}

// ---- v1.2 pairing: X25519 + HKDF-SHA256 ----

/// The device key both sides derive at pairing:
/// `HKDF-SHA256(salt = token, ikm = X25519(shared), info = "hivo-sync-v1.2|pair|" + deviceId + "|" + b64(desktop pub) + "|" + b64(phone pub))`.
/// The token (a pre-shared secret from the QR) is mixed in as the salt, like
/// a PSK in Noise / WireGuard: knowing the token alone gives nothing, and the
/// DH alone (an attacker on the LAN without the QR) gives nothing either.
pub fn derive_device_key(shared: &[u8; 32], token: &[u8; 32], device_id: &str, desktop_pub: &[u8; 32], phone_pub: &[u8; 32]) -> [u8; 32] {
    let info = format!("{PAIR_INFO_PREFIX}{device_id}|{}|{}", B64.encode(desktop_pub), B64.encode(phone_pub));
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(token), shared);
    let mut out = [0u8; 32];
    hk.expand(info.as_bytes(), &mut out).expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

/// The desktop's side: the device key for a phone's public key, or None for
/// a low-order point (an all-zero shared secret).
pub fn desktop_derive(secret: &x25519_dalek::StaticSecret, token: &[u8; 32], device_id: &str, phone_pub: &[u8; 32]) -> Option<[u8; 32]> {
    let desktop_pub = x25519_dalek::PublicKey::from(secret).to_bytes();
    let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(*phone_pub));
    if !shared.was_contributory() {
        return None;
    }
    Some(derive_device_key(shared.as_bytes(), token, device_id, &desktop_pub, phone_pub))
}

/// A QR shown and not used yet (memory only: a restart voids it).
pub struct PendingPair {
    pub token: [u8; 32],
    pub secret: x25519_dalek::StaticSecret,
    pub created_ms: i64,
    /// Re-pair of a phone already in the store (replaced in place on success).
    pub repair: bool,
    pub port: u16,
}

impl PendingPair {
    pub fn new(repair: bool, port: u16, now: i64) -> Result<PendingPair, String> {
        Ok(PendingPair { token: random_bytes::<32>()?, secret: x25519_dalek::StaticSecret::from(random_bytes::<32>()?), created_ms: now, repair, port })
    }
    pub fn expired(&self, now: i64) -> bool {
        now - self.created_ms > PAIR_TTL_MS
    }
    pub fn desktop_pub(&self) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&self.secret).to_bytes()
    }
}

/// The body of a `/v1/pair` request: an envelope plus the phone's public key.
#[derive(Debug, Deserialize)]
struct PairEnvelope {
    n: String,
    c: String,
    x: String,
}

// ---- Replay protection ----

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    Stale,
    Replayed,
    Full,
    BadNonce,
}

#[derive(Default)]
pub struct ReplayGuard {
    seen: HashMap<String, i64>,
    order: VecDeque<(i64, String)>,
    /// Append-only log of accepted nonces (`<seen ms>\t<device>|<nonce>`), so
    /// a request replayed right after a restart is still refused. None in
    /// tests that don't need it.
    log: Option<PathBuf>,
    appended: usize,
}

impl ReplayGuard {
    /// The guard, with what the log at `log` remembers from the last
    /// `NONCE_TTL_MS` (the log is then rewritten with those only).
    pub fn load(log: PathBuf, now: i64) -> ReplayGuard {
        let mut g = ReplayGuard { log: Some(log.clone()), ..ReplayGuard::default() };
        if let Ok(raw) = fs::read_to_string(&log) {
            let mut rows: Vec<(i64, String)> = raw
                .lines()
                .filter_map(|l| {
                    let (at, key) = l.split_once('\t')?;
                    Some((at.parse::<i64>().ok()?, key.to_string()))
                })
                .filter(|(at, key)| *at >= now - NONCE_TTL_MS && *at <= now + TS_WINDOW_MS && !key.is_empty())
                .collect();
            rows.sort_by_key(|(at, _)| *at);
            let skip = rows.len().saturating_sub(MAX_SEEN_NONCES);
            for (at, key) in rows.into_iter().skip(skip) {
                if g.seen.insert(key.clone(), at).is_none() {
                    g.order.push_back((at, key));
                }
            }
        }
        if let Err(e) = g.compact() {
            eprintln!("phone sync: could not rewrite the replay log: {e}");
        }
        g
    }

    fn compact(&mut self) -> std::io::Result<()> {
        let Some(log) = &self.log else { return Ok(()) };
        let body: String = self.order.iter().map(|(at, key)| format!("{at}\t{key}\n")).collect();
        crate::cover::write_private(log, body.as_bytes())?;
        self.appended = 0;
        Ok(())
    }

    fn append(&mut self, at: i64, key: &str) -> std::io::Result<()> {
        let Some(log) = &self.log else { return Ok(()) };
        let mut options = fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(log)?;
        std::io::Write::write_all(&mut f, format!("{at}\t{key}\n").as_bytes())?;
        self.appended += 1;
        if self.appended >= REPLAY_COMPACT_EVERY {
            self.compact()?;
        }
        Ok(())
    }

    /// Accepts a (device, nonce, ts) once inside the window.
    pub fn check(&mut self, device_id: &str, nonce: &str, ts: i64, now: i64) -> Result<(), Reject> {
        // Printable ASCII only: it goes in the log, one per line.
        if nonce.is_empty() || nonce.len() > 64 || !nonce.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(Reject::BadNonce);
        }
        if (now - ts).abs() > TS_WINDOW_MS {
            return Err(Reject::Stale);
        }
        while let Some((at, _)) = self.order.front() {
            if *at >= now - NONCE_TTL_MS {
                break;
            }
            let (_, k) = self.order.pop_front().expect("front exists");
            self.seen.remove(&k);
        }
        let key = format!("{device_id}|{nonce}");
        if self.seen.contains_key(&key) {
            return Err(Reject::Replayed);
        }
        if self.seen.len() >= MAX_SEEN_NONCES {
            return Err(Reject::Full);
        }
        // Written down before it's answered: a nonce that can't be logged
        // would be accepted again after a restart (refused as "busy").
        if let Err(e) = self.append(now, &key) {
            eprintln!("phone sync: could not write the replay log: {e}");
            return Err(Reject::Full);
        }
        self.seen.insert(key.clone(), now);
        self.order.push_back((now, key));
        Ok(())
    }
}

// ---- Paired devices (phone-sync.json) ----

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub id: String,
    /// 32 bytes, base64url without padding. Never leaves Rust except once, in the QR.
    pub key: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    pub paired_at_ms: i64,
    #[serde(default)]
    pub last_seen_ms: Option<i64>,
    /// The port its QR carried. When the listener had to take another one,
    /// this phone needs a new QR (Settings → Phone sync → Re-pair).
    #[serde(default)]
    pub paired_port: Option<u16>,
    /// Paired with v1.2 (key derived with X25519, never in a QR): its answers
    /// are always bound to the request. False for phones paired before.
    #[serde(default)]
    pub derived: bool,
}

impl StoredDevice {
    fn key_bytes(&self) -> Option<[u8; 32]> {
        B64.decode(self.key.as_bytes()).ok()?.try_into().ok()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub devices: Vec<StoredDevice>,
}

/// Something wrong with `phone-sync.json` at launch, shown in Settings →
/// Phone sync until a save works.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreProblem {
    pub message: String,
    /// The file couldn't be read (it may be fine) or moved aside: nothing is
    /// saved over it while this app runs.
    pub blocks_saving: bool,
}

/// The paired phones, or defaults when there's no file. A file that can't
/// be read is left alone and blocks saving (it may be fine: a permission,
/// a locked disk); one that doesn't parse is kept as
/// `phone-sync.json.bad-<ms>` (never over an older one) and phones pair again.
pub fn load_store(path: &Path) -> (SyncFile, Option<StoreProblem>) {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (SyncFile::default(), None),
        Err(e) => {
            let message = format!("The paired phones (phone-sync.json) can't be read right now ({e}). Nothing is saved over them: fix that and restart Hivo.");
            return (SyncFile::default(), Some(StoreProblem { message, blocks_saving: true }));
        }
    };
    let parse = match serde_json::from_slice(&raw) {
        Ok(file) => return (file, None),
        Err(e) => e,
    };
    let bad = crate::workspace::bad_path(path);
    let problem = match fs::rename(path, &bad) {
        Ok(()) => {
            let kept = bad.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            StoreProblem {
                message: format!("The paired phones couldn't be read ({parse}), so every phone needs pairing again. The old file is kept as {kept} in Hivo's settings folder."),
                blocks_saving: false,
            }
        }
        Err(e) => StoreProblem {
            message: format!("The paired phones couldn't be read ({parse}) or moved aside ({e}). Nothing is saved over them: fix that and restart Hivo."),
            blocks_saving: true,
        },
    };
    (SyncFile::default(), Some(problem))
}

#[cfg(test)]
pub fn read_store(path: &Path) -> SyncFile {
    load_store(path).0
}

pub fn write_store(path: &Path, file: &SyncFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    crate::cover::write_private(path, raw.as_bytes()).map_err(|e| format!("could not save phone sync settings: {e}"))
}

/// A device paired the 1.1 way (16-byte id, 32-byte key that was in the QR),
/// as phones paired before 1.2 are in `phone-sync.json`. Devices that were
/// paired but never said hello (an abandoned QR) are dropped first.
#[cfg(test)]
pub fn add_device(file: &mut SyncFile, now: i64) -> Result<StoredDevice, String> {
    file.devices.retain(|d| d.last_seen_ms.is_some());
    if file.devices.len() >= MAX_DEVICES {
        return Err(format!("{MAX_DEVICES} phones are paired already. Forget one first."));
    }
    let device = StoredDevice {
        id: B64.encode(random_bytes::<16>()?),
        key: B64.encode(random_bytes::<32>()?),
        name: None,
        app_version: None,
        paired_at_ms: now,
        last_seen_ms: None,
        paired_port: None,
        derived: false,
    };
    file.devices.push(device.clone());
    Ok(device)
}

/// A v1.2 pairing went through: the device with its derived key. A re-pair
/// replaces the key in place (its name and what it sent stay; the old key
/// stops working only now, so an abandoned re-pair QR breaks nothing).
pub fn complete_pairing(file: &mut SyncFile, id: &str, key: &[u8; 32], repair: bool, port: u16, now: i64) -> Result<(), String> {
    let key = B64.encode(key);
    if let Some(d) = file.devices.iter_mut().find(|d| d.id == id) {
        d.key = key;
        d.derived = true;
        d.paired_at_ms = now;
        d.last_seen_ms = Some(now);
        d.paired_port = Some(port);
        return Ok(());
    }
    if repair {
        return Err("That phone isn't paired any more.".to_string());
    }
    if file.devices.len() >= MAX_DEVICES {
        return Err(format!("{MAX_DEVICES} phones are paired already. Forget one first."));
    }
    file.devices.push(StoredDevice {
        id: id.to_string(),
        key,
        name: None,
        app_version: None,
        paired_at_ms: now,
        last_seen_ms: Some(now),
        paired_port: Some(port),
        derived: true,
    });
    Ok(())
}

/// The listener took `port` while another one was saved (the one phones
/// know): every phone paired before keeps the old one as its paired port,
/// so the settings can say it needs a new QR. True when the port changed.
pub fn note_port(file: &mut SyncFile, port: u16) -> bool {
    let old = file.port;
    file.port = Some(port);
    let Some(old) = old.filter(|p| *p != port) else {
        return false;
    };
    for d in file.devices.iter_mut().filter(|d| d.paired_port.is_none()) {
        d.paired_port = Some(old);
    }
    true
}

pub fn forget_device(file: &mut SyncFile, id: &str) -> bool {
    let before = file.devices.len();
    file.devices.retain(|d| d.id != id);
    file.devices.len() != before
}

// ---- Pairing URL and addresses ----

/// RFC 3986 unreserved characters stay, everything else is %XX (UTF-8).
fn uri_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// v1.2 (QR format 2): `hivo://pair?v=2&d=<id>&t=<token>&x=<desktop X25519 pub>&h=<ip1>,<ip2>&p=<port>&n=<name>`.
/// No key: the token works once, for `PAIR_TTL_MS`. Only private IPv4
/// addresses go in `h`. (1.1 QRs were `v=1&…&k=<device key>`.)
pub fn pairing_url(device_id: &str, token: &[u8; 32], desktop_pub: &[u8; 32], hosts: &[Ipv4Addr], port: u16, desktop_name: &str) -> String {
    let h = hosts.iter().filter(|ip| ip.is_private()).map(|ip| ip.to_string()).collect::<Vec<_>>().join(",");
    format!("hivo://pair?v=2&d={device_id}&t={}&x={}&h={h}&p={port}&n={}", B64.encode(token), B64.encode(desktop_pub), uri_encode(desktop_name))
}

/// Interfaces that are usually virtual (VPN, VM, container bridges) go last.
fn virtual_iface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["utun", "tun", "tap", "bridge", "vmnet", "vbox", "docker", "veth", "virbr", "vethernet", "llw", "awdl", "zt", "tailscale", "wg"]
        .iter()
        .any(|p| n.starts_with(p))
}

/// Private IPv4 addresses, best first: the one the default route uses, then
/// physical interfaces, 192.168 before 10 before 172.16 (often VM bridges).
pub fn rank_addresses(list: &[(String, Ipv4Addr)], primary: Option<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut out: Vec<(u8, Ipv4Addr)> = Vec::new();
    for (name, ip) in list {
        if !ip.is_private() || out.iter().any(|(_, o)| o == ip) {
            continue;
        }
        let family = match ip.octets() {
            [192, 168, ..] => 0,
            [10, ..] => 1,
            _ => 2,
        };
        let rank = if Some(*ip) == primary { 0 } else { 1 + family + if virtual_iface(name) { 3 } else { 0 } };
        out.push((rank, *ip));
    }
    out.sort_by_key(|(r, _)| *r);
    out.into_iter().map(|(_, ip)| ip).take(4).collect()
}

/// The address the default route would use. UDP connect sends nothing.
fn primary_ipv4() -> Option<Ipv4Addr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

pub fn lan_addresses() -> Vec<Ipv4Addr> {
    let list: Vec<(String, Ipv4Addr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if !i.is_loopback() => Some((i.name, ip)),
            _ => None,
        })
        .collect();
    rank_addresses(&list, primary_ipv4())
}

/// The computer's name, shown on the phone. Falls back to "Hivo".
fn desktop_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        let raw = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string());
        #[cfg(windows)]
        let raw = std::env::var("COMPUTERNAME").ok();
        #[cfg(not(any(target_os = "macos", windows)))]
        let raw = fs::read_to_string("/etc/hostname").ok();
        let name = clip(&raw.unwrap_or_default(), MAX_PHONE_NAME);
        if name.is_empty() {
            "Hivo".to_string()
        } else {
            name
        }
    })
    .clone()
}

// ---- Shared state ----

type Reply = Result<Value, String>;

/// What the listener needs from the app (a fake one in tests).
pub trait Host: Send + Sync {
    /// Sends the request to the webview; false when no window can answer.
    fn forward(&self, request: &ForwardedRequest) -> bool;
    fn hivo_version(&self) -> String;
    fn desktop_name(&self) -> String;
    /// Something new is in the phone inbox (the desktop's Inbox refreshes).
    fn inbox_changed(&self) {}
    /// The same, `after` from now (the trailing progress event). Tests run it at once.
    fn inbox_changed_after(&self, _after: Duration) {
        self.inbox_changed();
    }
    /// A phone with a newer Hivo (major.minor) said hello.
    fn phone_newer(&self) {}
}

/// One item's progress throttle (`next` = when an event may go, `scheduled`
/// = when the trailing one fires): Some(0) = send now, Some(d) = schedule
/// one in `d`, None = an event already covers this move. At most one a
/// second, and the last move always gets one.
fn progress_step(entry: &mut (Instant, Option<Instant>), now: Instant) -> Option<Duration> {
    let (next, scheduled) = entry;
    if scheduled.is_some_and(|s| now >= s) {
        *scheduled = None;
    }
    if now >= *next {
        *next = now + INBOX_EVENT_EVERY;
        return Some(Duration::ZERO);
    }
    if scheduled.is_some() {
        return None;
    }
    let wait = *next - now;
    *scheduled = Some(*next);
    *next += INBOX_EVENT_EVERY;
    Some(wait)
}

/// `major.minor` of a version ("0.6.3" → (0, 6)); None when it isn't one.
pub fn major_minor(v: &str) -> Option<(u64, u64)> {
    let mut parts = v.trim().trim_start_matches('v').split(['.', '-', '+']);
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// How the phone's version compares with the desktop's, by major.minor
/// (patch releases always talk to each other). None when either is unknown.
pub fn compare_versions(phone: &str, desktop: &str) -> Option<std::cmp::Ordering> {
    Some(major_minor(phone)?.cmp(&major_minor(desktop)?))
}

/// Drops paired phones that never said hello within `UNSEEN_TTL_MS` (their
/// QR was never scanned, or scanned and abandoned). True when one went.
pub fn expire_unseen(file: &mut SyncFile, now: i64) -> bool {
    let before = file.devices.len();
    file.devices.retain(|d| d.last_seen_ms.is_some() || now - d.paired_at_ms <= UNSEEN_TTL_MS);
    file.devices.len() != before
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedRequest {
    pub id: String,
    pub path: String,
    pub body: Value,
    pub phone_name: String,
}

struct Listener {
    server: Arc<tiny_http::Server>,
    port: u16,
    thread: Option<JoinHandle<()>>,
}

pub struct Inner {
    path: PathBuf,
    store: Mutex<SyncFile>,
    listener: Mutex<Option<Listener>>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Reply>>>,
    replay: Mutex<ReplayGuard>,
    rate: Mutex<HashMap<String, VecDeque<Instant>>>,
    in_flight: AtomicUsize,
    next_id: AtomicU64,
    error: Mutex<Option<String>>,
    /// What went wrong reading phone-sync.json at launch (`load_store`).
    store_problem: Mutex<Option<StoreProblem>>,
    pub inbox: Arc<crate::phone_inbox::Inbox>,
    /// The webview says so when it shows sample data: uploads are refused.
    demo: AtomicBool,
    /// Per uploading item: when its next progress event may go, and when the
    /// trailing one is scheduled, if one is (`inbox_progress`).
    last_progress: Mutex<HashMap<String, (Instant, Option<Instant>)>>,
    /// Connections open per remote address (`MAX_PER_IP`).
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    /// `BODY_DEADLINE` (shorter in tests).
    pub body_deadline_ms: AtomicU64,
    /// QRs shown and not used yet, by device id (v1.2 pairing, memory only).
    pairs: Mutex<HashMap<String, PendingPair>>,
}

/// `<store>.replay` next to `phone-sync.json`: the replay log.
fn replay_log(path: &Path) -> PathBuf {
    path.with_extension("replay")
}

/// `<config dir>/phone-inbox` next to `phone-sync.json` (tests: `<file>.inbox`).
fn inbox_root(path: &Path) -> PathBuf {
    if path.file_name().is_some_and(|n| n == "phone-sync.json") {
        path.with_file_name("phone-inbox")
    } else {
        path.with_extension("inbox")
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    pub fn new(path: PathBuf) -> Arc<Inner> {
        let (store, problem) = load_store(&path);
        if let Some(p) = &problem {
            eprintln!("phone sync: {}", p.message);
        }
        let inbox = Arc::new(crate::phone_inbox::Inbox::open(inbox_root(&path)));
        let replay = ReplayGuard::load(replay_log(&path), now_ms());
        Arc::new(Inner {
            store_problem: Mutex::new(problem),
            inbox,
            demo: AtomicBool::new(false),
            path,
            store: Mutex::new(store),
            listener: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            replay: Mutex::new(replay),
            pairs: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
            next_id: AtomicU64::new(1),
            error: Mutex::new(None),
            last_progress: Mutex::new(HashMap::new()),
            per_ip: Arc::new(Mutex::new(HashMap::new())),
            body_deadline_ms: AtomicU64::new(BODY_DEADLINE.as_millis() as u64),
        })
    }

    /// An upload moved: the desktop's "Still arriving" line refreshes, at
    /// most once a second per item, and once more at the end of that second
    /// when moves were skipped meanwhile (else the last progress never shows).
    fn inbox_progress(&self, host: &dyn Host, item: &str) {
        let now = Instant::now();
        let action = {
            let mut last = lock(&self.last_progress);
            // Items quiet for a while are forgotten (the map stays small).
            last.retain(|_, (next, _)| now < *next + INBOX_EVENT_EVERY * 10);
            progress_step(last.entry(item.to_string()).or_insert((now, None)), now)
        };
        match action {
            Some(wait) if wait.is_zero() => host.inbox_changed(),
            Some(wait) => host.inbox_changed_after(wait),
            None => {}
        }
    }

    fn save(&self, file: &SyncFile) -> Result<(), String> {
        let mut problem = lock(&self.store_problem);
        if let Some(p) = problem.as_ref().filter(|p| p.blocks_saving) {
            return Err(p.message.clone());
        }
        write_store(&self.path, file)?;
        // Paired again since the reset: the note has done its job.
        *problem = None;
        Ok(())
    }

    /// A paired device, unless it never said hello within `UNSEEN_TTL_MS`
    /// (dropped from the store then).
    fn device(&self, id: &str) -> Option<StoredDevice> {
        self.expire_unseen();
        lock(&self.store).devices.iter().find(|d| d.id == id).cloned()
    }

    fn expire_unseen(&self) {
        let mut store = lock(&self.store);
        if expire_unseen(&mut store, now_ms()) {
            let snapshot = store.clone();
            drop(store);
            if let Err(e) = self.save(&snapshot) {
                eprintln!("phone sync: {e}");
            }
        }
    }

    /// Marks the device seen (and named, on hello). Written at most once a minute unless the name changed.
    fn touch(&self, id: &str, name: Option<String>, app_version: Option<String>) {
        let mut store = lock(&self.store);
        let now = now_ms();
        let Some(d) = store.devices.iter_mut().find(|d| d.id == id) else { return };
        let renamed = name.is_some() && name != d.name;
        let stale = d.last_seen_ms.is_none_or(|t| now - t > SEEN_WRITE_EVERY_MS);
        d.last_seen_ms = Some(now);
        if let Some(n) = name {
            d.name = Some(n);
        }
        if app_version.is_some() {
            d.app_version = app_version;
        }
        if renamed || stale {
            let snapshot = store.clone();
            drop(store);
            if let Err(e) = self.save(&snapshot) {
                eprintln!("phone sync: {e}");
            }
        }
    }

    fn allow_rate(&self, id: &str) -> bool {
        let mut rate = lock(&self.rate);
        let q = rate.entry(id.to_string()).or_default();
        let now = Instant::now();
        while q.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(1)) {
            q.pop_front();
        }
        if q.len() >= RATE_PER_SEC {
            return false;
        }
        q.push_back(now);
        true
    }

    /// The webview's answer to a forwarded request. Unknown ids are ignored.
    pub fn reply(&self, id: &str, reply: Reply) {
        if let Some(tx) = lock(&self.pending).remove(id) {
            let _ = tx.try_send(reply);
        }
    }

    fn forward(&self, host: &dyn Host, path: &str, body: Value, phone_name: String) -> Reply {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::sync_channel(1);
        lock(&self.pending).insert(id.clone(), tx);
        let request = ForwardedRequest { id: id.clone(), path: path.to_string(), body, phone_name };
        let answer = if host.forward(&request) { rx.recv_timeout(REPLY_TIMEOUT).ok() } else { None };
        lock(&self.pending).remove(&id);
        answer.unwrap_or_else(|| Err("busy".to_string()))
    }

    pub fn port(&self) -> Option<u16> {
        lock(&self.listener).as_ref().map(|l| l.port)
    }

    /// A v1.2 pairing QR: a new device (`repair` None; a QR shown before and
    /// not used is dropped) or a new key for a paired one (`repair` = its id).
    /// Returns the device id, the token and this computer's public key.
    pub fn begin_pair(&self, repair: Option<&str>, port: u16, now: i64) -> Result<(String, [u8; 32], [u8; 32]), String> {
        let id = match repair {
            Some(id) => {
                if !lock(&self.store).devices.iter().any(|d| d.id == id) {
                    return Err("That phone isn't paired any more.".to_string());
                }
                id.to_string()
            }
            None => {
                if lock(&self.store).devices.len() >= MAX_DEVICES {
                    return Err(format!("{MAX_DEVICES} phones are paired already. Forget one first."));
                }
                B64.encode(random_bytes::<16>()?)
            }
        };
        let pending = PendingPair::new(repair.is_some(), port, now)?;
        let out = (id.clone(), pending.token, pending.desktop_pub());
        let mut pairs = lock(&self.pairs);
        pairs.retain(|_, p| !p.expired(now) && (repair.is_some() || p.repair));
        pairs.insert(id, pending);
        Ok(out)
    }

    /// A QR for this device id is up and still valid (expired ones go).
    fn pair_pending(&self, id: &str, now: i64) -> bool {
        let mut pairs = lock(&self.pairs);
        pairs.retain(|_, p| !p.expired(now));
        pairs.contains_key(id)
    }

    /// The device key a phone's `/v1/pair` would be sealed with, from the
    /// pending QR for `id` (None: no QR, or a low-order public key).
    /// Also returns the QR's token, which `finish_pair` checks.
    fn pair_key(&self, id: &str, phone_pub: &[u8; 32], now: i64) -> Option<([u8; 32], [u8; 32])> {
        let pairs = lock(&self.pairs);
        let p = pairs.get(id).filter(|p| !p.expired(now))?;
        Some((desktop_derive(&p.secret, &p.token, id, phone_pub)?, p.token))
    }

    /// Burns the QR and stores the device with its key. Err when that QR was
    /// used meanwhile (a second phone racing with the same code), replaced
    /// by a new one, or expired.
    fn finish_pair(&self, id: &str, token: &[u8; 32], key: &[u8; 32], now: i64) -> Result<(), String> {
        let p = {
            let mut pairs = lock(&self.pairs);
            if !pairs.get(id).is_some_and(|p| &p.token == token && !p.expired(now)) {
                return Err("used".to_string());
            }
            pairs.remove(id).expect("checked above")
        };
        let mut store = lock(&self.store);
        complete_pairing(&mut store, id, key, p.repair, p.port, now)?;
        let snapshot = store.clone();
        drop(store);
        self.save(&snapshot)
    }
}

// ---- Listener ----

/// Binds (the saved port when free, else one the OS picks) and starts the
/// accept thread. Returns the port.
pub fn start(inner: &Arc<Inner>, host: Arc<dyn Host>, ip: IpAddr) -> Result<u16, String> {
    let mut slot = lock(&inner.listener);
    if let Some(l) = slot.as_ref() {
        return Ok(l.port);
    }
    let saved = lock(&inner.store).port;
    let server = saved
        .and_then(|p| tiny_http::Server::http(SocketAddr::new(ip, p)).ok())
        .map(Ok)
        .unwrap_or_else(|| tiny_http::Server::http(SocketAddr::new(ip, 0)))
        .map_err(|e| format!("could not open a port for phone sync: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("phone sync: no port")?;
    let server = Arc::new(server);
    let thread = {
        let server = server.clone();
        let inner = inner.clone();
        std::thread::Builder::new()
            .name("phone-sync".into())
            .spawn(move || {
                for request in server.incoming_requests() {
                    // One address can't take every slot (a slow client on the LAN).
                    let Some(slot) = IpSlot::take(&inner.per_ip, request.remote_addr().map(SocketAddr::ip)) else {
                        let _ = request.respond(tiny_http::Response::empty(503));
                        continue;
                    };
                    if inner.in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
                        inner.in_flight.fetch_sub(1, Ordering::SeqCst);
                        let _ = request.respond(tiny_http::Response::empty(503));
                        continue;
                    }
                    let worker = inner.clone();
                    let host = host.clone();
                    let spawned = std::thread::Builder::new().name("phone-sync-req".into()).spawn(move || {
                        handle(&worker, host.as_ref(), request, slot);
                        worker.in_flight.fetch_sub(1, Ordering::SeqCst);
                    });
                    if spawned.is_err() {
                        inner.in_flight.fetch_sub(1, Ordering::SeqCst);
                    }
                }
            })
            .map_err(|e| format!("could not start phone sync: {e}"))?
    };
    *slot = Some(Listener { server, port, thread: Some(thread) });
    drop(slot);
    let mut store = lock(&inner.store);
    if store.port != Some(port) {
        note_port(&mut store, port);
        let snapshot = store.clone();
        drop(store);
        inner.save(&snapshot)?;
    }
    Ok(port)
}

/// Closes the port. Requests already being answered finish on their own.
pub fn stop(inner: &Arc<Inner>) {
    let Some(mut l) = lock(&inner.listener).take() else { return };
    l.server.unblock();
    if let Some(t) = l.thread.take() {
        let _ = t.join();
    }
    let port = l.port;
    drop(l);
    // tiny_http unblocks its accept thread by connecting to the bound address;
    // 0.0.0.0 isn't connectable on Windows, so knock on loopback too.
    let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(200));
    for (_, tx) in lock(&inner.pending).drain() {
        let _ = tx.try_send(Err("busy".to_string()));
    }
}

fn header<'a>(req: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

fn json_response(status: u16, body: &impl Serialize) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let mut r = tiny_http::Response::from_data(bytes).with_status_code(status);
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        r.add_header(h);
    }
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]) {
        r.add_header(h);
    }
    r
}

/// The result of an encrypted call: an envelope (200) or a bare status.
#[derive(Debug)]
pub enum Outcome {
    Sealed(Envelope),
    Status(u16),
}

/// One connection counted against its address (`MAX_PER_IP`), released when
/// dropped: when the answer went, or when a body that never came is given up.
pub struct IpSlot {
    map: Arc<Mutex<HashMap<IpAddr, usize>>>,
    ip: Option<IpAddr>,
}

impl IpSlot {
    /// None when that address already holds `MAX_PER_IP` connections.
    pub fn take(map: &Arc<Mutex<HashMap<IpAddr, usize>>>, ip: Option<IpAddr>) -> Option<IpSlot> {
        if let Some(ip) = ip {
            let mut m = lock(map);
            let n = m.entry(ip).or_insert(0);
            if *n >= MAX_PER_IP {
                return None;
            }
            *n += 1;
        }
        Some(IpSlot { map: map.clone(), ip })
    }
}

impl Drop for IpSlot {
    fn drop(&mut self) {
        let Some(ip) = self.ip else { return };
        let mut m = lock(&self.map);
        if let Some(n) = m.get_mut(&ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(&ip);
            }
        }
    }
}

/// Reads the body on its own thread, at most `deadline`: a client that
/// sends its body slower loses its slot (the reader thread keeps the
/// connection, and its address's `IpSlot`, until the client goes away).
fn read_body(req: tiny_http::Request, slot: IpSlot, deadline: Duration) -> Option<(tiny_http::Request, IpSlot, std::io::Result<Vec<u8>>)> {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("phone-sync-body".into()).spawn(move || {
        let mut req = req;
        let mut body = Vec::new();
        let read = req.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut body).map(|_| body);
        // Given up on: the request (and the slot) drop here.
        let _ = tx.send((req, slot, read));
    });
    spawned.ok()?;
    rx.recv_timeout(deadline).ok()
}

fn handle(inner: &Arc<Inner>, host: &dyn Host, req: tiny_http::Request, slot: IpSlot) {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let method = req.method().clone();
    let mut req = req;
    let outcome = match (&method, path.as_str()) {
        (tiny_http::Method::Get, "/v1/ping") => {
            let _ = req.respond(json_response(200, &json!({ "app": "hivo", "v": 1 })));
            return;
        }
        (tiny_http::Method::Post, p) if p == "/v1/hello" || p == PAIR_PATH || FORWARDED.contains(&p) || INBOX_PATHS.contains(&p) => {
            let device = header(&req, "X-Hivo-Device").map(str::to_string);
            let too_big = req.body_length().is_some_and(|n| n > MAX_BODY_BYTES);
            // An unknown device is refused before its body is read (for
            // `/v1/pair`: one whose QR is up counts as known).
            let known = device.as_deref().is_some_and(|d| {
                !d.is_empty() && d.len() <= 64 && (inner.device(d).is_some() || (path == PAIR_PATH && inner.pair_pending(d, now_ms())))
            });
            if !known || too_big {
                // Answered without reading the body: tiny_http drains what's
                // left when the request drops, so that happens off this slot
                // (still counted against the address until the client is done).
                let status = if known { 413 } else { 401 };
                let _ = std::thread::Builder::new().name("phone-sync-drain".into()).spawn(move || {
                    let _slot = slot;
                    let _ = req.respond(tiny_http::Response::empty(status));
                });
                return;
            } else {
                match read_body(req, slot, Duration::from_millis(inner.body_deadline_ms.load(Ordering::Relaxed))) {
                    // Too slow: the slot goes to someone else, no answer.
                    None => return,
                    Some((r, slot, read)) => {
                        req = r;
                        let outcome = match read {
                            Err(_) => Outcome::Status(400),
                            Ok(body) if body.len() > MAX_BODY_BYTES => Outcome::Status(413),
                            Ok(body) => handle_sealed(inner, host, &path, device.as_deref(), &body),
                        };
                        let _ = match outcome {
                            Outcome::Sealed(env) => req.respond(json_response(200, &env)),
                            Outcome::Status(s) => req.respond(tiny_http::Response::empty(s)),
                        };
                        drop(slot);
                        return;
                    }
                }
            }
        }
        _ => Outcome::Status(404),
    };
    let _ = match outcome {
        Outcome::Sealed(env) => req.respond(json_response(200, &env)),
        Outcome::Status(s) => req.respond(tiny_http::Response::empty(s)),
    };
}

/// Opens, checks and answers one encrypted request. Pure apart from `inner`/`host`.
pub fn handle_sealed(inner: &Arc<Inner>, host: &dyn Host, path: &str, device_id: Option<&str>, body: &[u8]) -> Outcome {
    if body.len() > MAX_BODY_BYTES {
        return Outcome::Status(413);
    }
    let Some(device_id) = device_id.filter(|d| !d.is_empty() && d.len() <= 64) else {
        return Outcome::Status(401);
    };
    let now = now_ms();
    let Some(Opened { key, plain, device, pair_token }) = open_request(inner, path, device_id, body, now) else {
        return Outcome::Status(401);
    };
    // Authenticated from here on: errors are answered sealed, never as a
    // bare 401 (which the phone reads as "this computer forgot me").
    let Ok(sealed) = serde_json::from_slice::<SealedRequest>(&plain) else {
        // No nonce to bind to: a 1.2 phone refuses this answer, which is
        // right (it never sends such a request).
        let bind = (path == PAIR_PATH || device.as_ref().is_some_and(|d| d.derived)).then_some("");
        return sealed_answer(&key, device_id, path, bind, Err("bad request".to_string()));
    };
    // v1.2: the answer is bound to this request's nonce. Unbound only for a
    // phone paired before 1.2 that doesn't say 1.2 (it can't check it).
    let bound = path == PAIR_PATH || device.as_ref().is_some_and(|d| d.derived) || speaks_bound(sealed.v.as_deref());
    let bind = bound.then_some(sealed.nonce.as_str());
    let checked = lock(&inner.replay).check(device_id, &sealed.nonce, sealed.ts, now);
    match checked {
        Ok(()) => {}
        // Replays stay refused without a word.
        Err(Reject::Replayed) => return Outcome::Status(401),
        // The phone's clock is more than TS_WINDOW_MS off this computer's
        // (a pairing isn't finished then: the same QR works once it's fixed).
        Err(Reject::Stale) => return sealed_answer(&key, device_id, path, bind, Err("clock".to_string())),
        Err(Reject::BadNonce) => return sealed_answer(&key, device_id, path, bind, Err("bad request".to_string())),
        Err(Reject::Full) => return sealed_answer(&key, device_id, path, bind, Err("busy".to_string())),
    }
    if !inner.allow_rate(device_id) {
        return Outcome::Status(429);
    }
    // A first `/v1/pair`: the QR is burnt and the device stored with its key.
    if let Some(token) = pair_token {
        match inner.finish_pair(device_id, &token, &key, now) {
            Ok(()) => {}
            // Used by someone else a moment ago, or replaced: as if unknown.
            Err(e) if e == "used" => return Outcome::Status(401),
            Err(e) => return sealed_answer(&key, device_id, path, bind, Err(e)),
        }
    }

    let answer: Reply = match path {
        "/v1/hello" | PAIR_PATH => {
            let name = sealed.body.get("phoneName").and_then(Value::as_str).map(|s| clip(s, MAX_PHONE_NAME)).filter(|s| !s.is_empty());
            let version = sealed.body.get("appVersion").and_then(Value::as_str).map(|s| clip(s, 20)).filter(|s| !s.is_empty());
            let desktop_version = host.hivo_version();
            // A newer phone: this computer may have an update waiting.
            if version.as_deref().and_then(|v| compare_versions(v, &desktop_version)) == Some(std::cmp::Ordering::Greater) {
                host.phone_newer();
            }
            inner.touch(device_id, Some(name.unwrap_or_else(|| "Phone".to_string())), version);
            Ok(json!({ "desktopName": host.desktop_name(), "hivoVersion": desktop_version, "protocol": PROTOCOL }))
        }
        p if INBOX_PATHS.contains(&p) => {
            inner.touch(device_id, None, None);
            let phone = device.as_ref().and_then(|d| d.name.clone()).unwrap_or_else(|| "Phone".to_string());
            answer_inbox(inner, host, p, device_id, &phone, &sealed.body)
        }
        p if FORWARDED.contains(&p) => {
            inner.touch(device_id, None, None);
            match check_payload(p, &sealed.body) {
                Err(e) => Err(e),
                Ok(()) => {
                    let phone = device.as_ref().and_then(|d| d.name.clone()).unwrap_or_else(|| "Phone".to_string());
                    inner.forward(host, p, sealed.body, phone)
                }
            }
        }
        _ => return Outcome::Status(404),
    };
    sealed_answer(&key, device_id, path, bind, answer)
}

/// A request that authenticated: the key that opened it, its plaintext, the
/// stored device (None for a first pairing), and the QR's token when it is a
/// first `/v1/pair`.
struct Opened {
    key: [u8; 32],
    plain: Vec<u8>,
    device: Option<StoredDevice>,
    pair_token: Option<[u8; 32]>,
}

/// Which key opens the request. `/v1/pair`: the one derived from the QR the
/// phone scanned (its public key comes with the envelope), else, for a
/// phone already paired with v1.2 retrying a pairing whose answer was lost,
/// its stored key. Every other path: the device's key.
fn open_request(inner: &Inner, path: &str, device_id: &str, body: &[u8], now: i64) -> Option<Opened> {
    let device = inner.device(device_id);
    if path == PAIR_PATH {
        let env = serde_json::from_slice::<PairEnvelope>(body).ok()?;
        let phone_pub: [u8; 32] = B64.decode(env.x.as_bytes()).ok()?.try_into().ok()?;
        let env = Envelope { n: env.n, c: env.c };
        let a = aad(device_id, PAIR_PATH);
        if let Some((key, token)) = inner.pair_key(device_id, &phone_pub, now) {
            if let Some(plain) = open(&key, &a, &env) {
                return Some(Opened { key, plain, device, pair_token: Some(token) });
            }
        }
        let d = device.filter(|d| d.derived)?;
        let key = d.key_bytes()?;
        let plain = open(&key, &a, &env)?;
        return Some(Opened { key, plain, device: Some(d), pair_token: None });
    }
    let d = device?;
    let key = d.key_bytes()?;
    let env = serde_json::from_slice::<Envelope>(body).ok()?;
    let plain = open(&key, &aad(device_id, path), &env)?;
    Some(Opened { key, plain, device: Some(d), pair_token: None })
}

/// `{"ok": true, "body"}` or `{"ok": false, "error"}`, sealed for the device
/// (bound to `bind`, the request's nonce, see `resp_aad`).
fn sealed_answer(key: &[u8; 32], device_id: &str, path: &str, bind: Option<&str>, answer: Reply) -> Outcome {
    let plaintext = match answer {
        Ok(body) => json!({ "ok": true, "body": body }),
        Err(e) => json!({ "ok": false, "error": clip(&e, MAX_ERROR_CHARS) }),
    };
    let bytes = serde_json::to_vec(&plaintext).unwrap_or_default();
    match seal(key, &resp_aad(device_id, path, bind), &bytes) {
        Ok(env) => Outcome::Sealed(env),
        Err(_) => Outcome::Status(500),
    }
}

/// The v1.1 endpoints. Sample data never receives anything ("demo").
fn answer_inbox(inner: &Inner, host: &dyn Host, path: &str, device_id: &str, phone: &str, body: &Value) -> Reply {
    if !body.is_object() {
        return Err("bad request".to_string());
    }
    if path == "/v1/inbox" {
        return Ok(inner.inbox.status_for(device_id));
    }
    if inner.demo.load(Ordering::Relaxed) {
        return Err("demo".to_string());
    }
    let now = now_ms();
    // The throttle is per item: two phones sending at once both show progress.
    let item = format!("{device_id}.{}", body.get("itemId").and_then(Value::as_str).unwrap_or(""));
    match path {
        "/v1/ideas" => {
            let r = inner.inbox.push_ideas(device_id, phone, body, now);
            if r.is_ok() {
                host.inbox_changed();
            }
            r
        }
        "/v1/upload/start" => inner.inbox.upload_start(device_id, phone, body, now).inspect(|_| inner.inbox_progress(host, &item)),
        "/v1/upload/chunk" => inner.inbox.upload_chunk(device_id, body).inspect(|_| inner.inbox_progress(host, &item)),
        "/v1/upload/finish" => inner.inbox.upload_finish(device_id, body, now).map(|(v, ready)| {
            if ready {
                lock(&inner.last_progress).remove(&item);
                host.inbox_changed();
            } else {
                inner.inbox_progress(host, &item);
            }
            v
        }),
        _ => Err("bad request".to_string()),
    }
}

/// Shape and limits of a forwarded payload, checked before the webview sees it.
pub fn check_payload(path: &str, body: &Value) -> Result<(), String> {
    if !body.is_object() {
        return Err("bad request".to_string());
    }
    if path != "/v1/notes" {
        return Ok(());
    }
    let changes = body.get("changes").and_then(Value::as_array).ok_or("bad request")?;
    if changes.len() > MAX_CHANGES {
        return Err(format!("too many changes ({MAX_CHANGES} max)"));
    }
    for c in changes {
        let kind = c.get("kind").and_then(Value::as_str).unwrap_or("");
        let id = c.get("id").and_then(Value::as_str).unwrap_or("");
        let text = c.get("text").and_then(Value::as_str).ok_or("bad request")?;
        let base = c.get("baseHash").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "prod" | "beat" | "song") || id.is_empty() || id.len() > MAX_ID_CHARS || base.len() > 16 {
            return Err("bad request".to_string());
        }
        if text.chars().count() > MAX_NOTE_CHARS {
            return Err(format!("note too long ({MAX_NOTE_CHARS} characters max)"));
        }
    }
    Ok(())
}

// ---- Tauri glue ----

pub struct PhoneSync(pub Arc<Inner>);

struct TauriHost {
    app: AppHandle,
}

impl Host for TauriHost {
    fn forward(&self, request: &ForwardedRequest) -> bool {
        self.app.get_webview_window("main").is_some() && self.app.emit(REQUEST_EVENT, request).is_ok()
    }
    fn hivo_version(&self) -> String {
        self.app.package_info().version.to_string()
    }
    fn desktop_name(&self) -> String {
        desktop_name()
    }
    fn inbox_changed(&self) {
        let _ = self.app.emit(INBOX_EVENT, ());
    }
    fn inbox_changed_after(&self, after: Duration) {
        let app = self.app.clone();
        let _ = std::thread::Builder::new().name("phone-inbox-progress".into()).spawn(move || {
            std::thread::sleep(after);
            let _ = app.emit(INBOX_EVENT, ());
        });
    }
    fn phone_newer(&self) {
        let _ = self.app.emit(PHONE_NEWER_EVENT, ());
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("could not resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("phone-sync.json"))
}

fn start_for_app(app: &AppHandle, inner: &Arc<Inner>) -> Result<u16, String> {
    let r = start(inner, Arc::new(TauriHost { app: app.clone() }), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    *lock(&inner.error) = r.as_ref().err().cloned();
    r
}

/// Registers the state and, when it was left on, opens the port.
pub fn init(app: &AppHandle) {
    let path = match store_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("phone sync: {e}");
            return;
        }
    };
    let inner = Inner::new(path);
    if lock(&inner.store).enabled {
        let _ = start_for_app(app, &inner);
    }
    // Unfinished uploads are dropped while the app runs, not only at start.
    let handle = app.clone();
    crate::phone_inbox::sweep_every(&inner.inbox, crate::phone_inbox::SWEEP_EVERY, move || {
        let _ = handle.emit(INBOX_EVENT, ());
    });
    app.manage(PhoneSync(inner));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: Option<String>,
    pub app_version: Option<String>,
    pub paired_at_ms: i64,
    pub last_seen_ms: Option<i64>,
    /// Paired on another port than the one open now: it needs a new QR.
    pub needs_new_qr: bool,
    /// Its Hivo is older (major.minor) than this computer's: "Update Hivo on this phone".
    pub phone_outdated: bool,
    /// Paired before 1.2 (its key was in the QR): "Re-pair to upgrade security".
    pub legacy_pairing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSyncStatus {
    pub on: bool,
    pub port: Option<u16>,
    pub addresses: Vec<String>,
    pub devices: Vec<DeviceInfo>,
    pub error: Option<String>,
}

fn status_of(inner: &Inner, desktop_version: &str) -> PhoneSyncStatus {
    inner.expire_unseen();
    let store = lock(&inner.store).clone();
    let port = inner.port();
    PhoneSyncStatus {
        on: store.enabled && port.is_some(),
        port,
        addresses: if port.is_some() { lan_addresses().iter().map(Ipv4Addr::to_string).collect() } else { Vec::new() },
        devices: store
            .devices
            .into_iter()
            .map(|d| DeviceInfo {
                needs_new_qr: port.is_some() && d.paired_port.is_some_and(|p| Some(p) != port),
                phone_outdated: d.app_version.as_deref().and_then(|v| compare_versions(v, desktop_version)) == Some(std::cmp::Ordering::Less),
                legacy_pairing: !d.derived,
                id: d.id,
                name: d.name,
                app_version: d.app_version,
                paired_at_ms: d.paired_at_ms,
                last_seen_ms: d.last_seen_ms,
            })
            .collect(),
        // A file problem first: it outlasts a listener error.
        error: lock(&inner.store_problem).as_ref().map(|p| p.message.clone()).or_else(|| lock(&inner.error).clone()),
    }
}

/// Windows: opens "Allow an app through Windows Firewall" (the phone can't
/// reach Hivo when it's blocked there). A fixed system command, no input.
#[tauri::command]
pub fn phone_sync_open_firewall() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("control.exe")
            .args(["/name", "Microsoft.WindowsFirewall", "/page", "pageConfigureApps"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open the firewall settings: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err("Only on Windows.".to_string())
    }
}

/// What `phone_sync_pair` answers when the user said no in the dialog.
pub const CANCELLED: &str = "cancelled";

#[derive(Clone, Copy)]
enum Confirm {
    Enable,
    Pair,
}

/// The native confirmation (Rust-side text, the app's language from the
/// webview: only "fr" switches it). True when the user said yes.
async fn confirm(app: &AppHandle, what: Confirm, lang: Option<&str>) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let fr = lang == Some("fr");
    let (title, message, ok) = match (what, fr) {
        (Confirm::Enable, false) => (
            "Turn on phone sync?",
            "Hivo will listen on this computer's local network so paired phones can read your songs, beats and prods and edit their notes. Only phones you pair can do anything. Your firewall may ask to allow it.",
            "Turn on",
        ),
        (Confirm::Enable, true) => (
            "Activer la sync téléphone ?",
            "Hivo va écouter sur le réseau local de cet ordi pour que les téléphones associés lisent tes sons, prods et beats et modifient leurs notes. Seuls les téléphones que tu associes peuvent faire quoi que ce soit. Ton pare-feu peut demander de l'autoriser.",
            "Activer",
        ),
        (Confirm::Pair, false) => (
            "Pair a new phone?",
            "The QR code that comes next lets the phone that scans it read and edit your notes and send files to this computer. Show it only to your own phone.",
            "Show the QR code",
        ),
        (Confirm::Pair, true) => (
            "Associer un nouveau téléphone ?",
            "Le QR code qui suit permet au téléphone qui le scanne de lire et modifier tes notes et d'envoyer des fichiers à cet ordi. Ne le montre qu'à ton propre téléphone.",
            "Afficher le QR code",
        ),
    };
    let cancel = if fr { "Annuler" } else { "Cancel" };
    let builder = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.to_string(), cancel.to_string()));
    tauri::async_runtime::spawn_blocking(move || builder.blocking_show()).await.unwrap_or(false)
}

fn state_inner(app: &AppHandle) -> Result<Arc<Inner>, String> {
    app.try_state::<PhoneSync>().map(|s| s.0.clone()).ok_or_else(|| "Phone sync isn't available (no config folder).".to_string())
}

#[tauri::command]
pub fn phone_sync_status(app: AppHandle) -> Result<PhoneSyncStatus, String> {
    let inner = state_inner(&app)?;
    Ok(status_of(&inner, &app.package_info().version.to_string()))
}

#[tauri::command]
pub async fn phone_sync_enable(app: AppHandle, on: bool, lang: Option<String>) -> Result<PhoneSyncStatus, String> {
    let inner = state_inner(&app)?;
    // Opening a port on the network: the user says so in a native dialog
    // (the webview can't turn it on by itself).
    if on && inner.port().is_none() && !confirm(&app, Confirm::Enable, lang.as_deref()).await {
        return Ok(status_of(&inner, &app.package_info().version.to_string()));
    }
    {
        let mut store = lock(&inner.store);
        store.enabled = on;
        let snapshot = store.clone();
        drop(store);
        inner.save(&snapshot)?;
    }
    if on {
        start_for_app(&app, &inner)?;
    } else {
        stop(&inner);
        *lock(&inner.error) = None;
    }
    Ok(status_of(&inner, &app.package_info().version.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub device_id: String,
    /// The QR payload: a one-time token and this computer's public key (v1.2),
    /// never the device key. Works once, until `expires_at_ms`.
    pub url: String,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
}

/// A v1.2 pairing QR for a new phone or (`repair`) a paired one.
fn new_pairing(inner: &Inner, repair: Option<&str>, port: u16, hosts: &[Ipv4Addr]) -> Result<Pairing, String> {
    let now = now_ms();
    let (id, token, desktop_pub) = inner.begin_pair(repair, port, now)?;
    Ok(Pairing { url: pairing_url(&id, &token, &desktop_pub, hosts, port, &desktop_name()), device_id: id, issued_at_ms: now, expires_at_ms: now + PAIR_TTL_MS })
}

#[tauri::command]
pub async fn phone_sync_pair(app: AppHandle, lang: Option<String>) -> Result<Pairing, String> {
    let inner = state_inner(&app)?;
    let Some(port) = inner.port() else {
        return Err("Turn phone sync on first.".to_string());
    };
    let hosts = lan_addresses();
    if hosts.is_empty() {
        return Err("No local network address found. Connect this computer to Wi-Fi (or a local network) first.".to_string());
    }
    // A new key that unlocks this computer's songs and notes: confirmed natively.
    if !confirm(&app, Confirm::Pair, lang.as_deref()).await {
        return Err(CANCELLED.to_string());
    }
    new_pairing(&inner, None, port, &hosts)
}

/// "Re-pair this phone" (the port or the address changed, or a phone paired
/// before 1.2): a new v1.2 QR for the same device, which replaces its key in
/// place once the phone used it (the old key works until then).
#[tauri::command]
pub fn phone_sync_repair(app: AppHandle, device_id: String) -> Result<Pairing, String> {
    let inner = state_inner(&app)?;
    let Some(port) = inner.port() else {
        return Err("Turn phone sync on first.".to_string());
    };
    let hosts = lan_addresses();
    if hosts.is_empty() {
        return Err("No local network address found. Connect this computer to Wi-Fi (or a local network) first.".to_string());
    }
    new_pairing(&inner, Some(&device_id), port, &hosts)
}

#[tauri::command]
pub fn phone_sync_forget(app: AppHandle, device_id: String) -> Result<PhoneSyncStatus, String> {
    let inner = state_inner(&app)?;
    let mut store = lock(&inner.store);
    if forget_device(&mut store, &device_id) {
        let snapshot = store.clone();
        drop(store);
        inner.save(&snapshot)?;
    }
    // A QR still up for it stops working too.
    lock(&inner.pairs).remove(&device_id);
    Ok(status_of(&inner, &app.package_info().version.to_string()))
}

/// The webview's answer to a `phone-sync-request`: a body, or a short error.
#[tauri::command]
pub fn phone_sync_reply(app: AppHandle, id: String, body: Option<Value>, error: Option<String>) -> Result<(), String> {
    let inner = state_inner(&app)?;
    let reply = match (body, error) {
        (_, Some(e)) => Err(clip(&e, MAX_ERROR_CHARS)),
        (Some(b), None) => Ok(b),
        (None, None) => Err("busy".to_string()),
    };
    inner.reply(&id, reply);
    Ok(())
}

// ---- Phone inbox commands (v1.1, the desktop's Inbox page) ----

/// The webview shows sample data (or stops): uploads and ideas are refused while on.
#[tauri::command]
pub fn phone_sync_set_demo(app: AppHandle, on: bool) -> Result<(), String> {
    state_inner(&app)?.demo.store(on, Ordering::Relaxed);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxList {
    pub items: Vec<crate::phone_inbox::InboxView>,
    /// Items still arriving (not in `items`).
    pub receiving: usize,
    /// The same, with their progress (they can be removed).
    pub incoming: Vec<crate::phone_inbox::IncomingView>,
}

/// Everything the phones sent, newest first. The inbox's files folder is
/// allowed for playback (asset protocol), like the beats folders.
#[tauri::command]
pub fn phone_inbox_list(app: AppHandle) -> Result<InboxList, String> {
    let inner = state_inner(&app)?;
    let dir = inner.inbox.files_dir();
    if dir.is_dir() {
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    }
    Ok(InboxList { items: inner.inbox.list(), receiving: inner.inbox.receiving(), incoming: inner.inbox.incoming() })
}

/// "File as a new song": `<parent_folder>/<name>/BandLab/` (a linked folder
/// only). Returns the sketch's key.
#[tauri::command]
pub async fn phone_inbox_file_sketch(app: AppHandle, id: String, parent_folder: String, name: String) -> Result<crate::phone_inbox::FiledSketch, String> {
    let scope = crate::scope::Scope::load(&app)?;
    if scope.folders().is_empty() {
        return Err("Link a project folder in Settings first.".to_string());
    }
    let parent = scope.folder_in_roots(&parent_folder)?;
    let inner = state_inner(&app)?;
    tauri::async_runtime::spawn_blocking(move || inner.inbox.file_sketch(&id, &parent, &name)).await.map_err(|e| format!("filing failed: {e}"))?
}

/// The folder of a song: its project's folder, or a sketch's song folder.
pub fn song_folder(scope: &crate::scope::Scope, key: &str) -> Result<PathBuf, String> {
    if let Ok(p) = scope.project(key) {
        return p.parent().map(Path::to_path_buf).ok_or_else(|| "invalid project path".to_string());
    }
    let dir = scope.folder_in_roots(key).map_err(|_| "This song's folder isn't there any more.".to_string())?;
    if dir.file_name().is_some_and(|n| n == crate::sketch::SKETCH_DIR) {
        return dir.parent().map(Path::to_path_buf).ok_or_else(|| "invalid sketch path".to_string());
    }
    Err("That isn't a song in a linked folder.".to_string())
}

/// The memo sub-folder for a project whose folder holds other projects too
/// (FL's flat `Projects/*.flp`): its file stem. None for a song alone in its
/// folder, and for a sketch (keyed by its BandLab folder).
pub fn memo_sub_for(song_key: &Path, folder: &Path) -> Option<String> {
    crate::daws::Daw::of_project(song_key)?;
    let projects = fs::read_dir(folder)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file() && crate::daws::Daw::of_project(&e.path()).is_some())
        .count();
    if projects > 1 {
        song_key.file_stem().map(|s| s.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Copies a memo into `<song folder>/Voice memos/` (`Voice memos/<song>/`
/// when the folder holds several projects). Returns the copies.
#[tauri::command]
pub async fn phone_inbox_attach_song(app: AppHandle, id: String, song_path: String) -> Result<Vec<String>, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let folder = song_folder(&scope, &song_path)?;
    let inner = state_inner(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let sub = memo_sub_for(Path::new(&song_path), &folder);
        inner.inbox.attach_to_song_folder(&id, &folder, &song_path, sub.as_deref())
    })
    .await
    .map_err(|e| format!("copy failed: {e}"))?
}

/// Links a memo to a beat or a saved prod and copies its audio into that
/// beats folder's `_memos/` (a beat: the beats folder holding it; a prod:
/// the one holding its lead file, else the first). Returns the copy.
#[tauri::command]
pub async fn phone_inbox_link_memo(app: AppHandle, id: String, kind: String, target_id: String) -> Result<String, String> {
    let scope = crate::scope::Scope::load(&app)?;
    let folder = beats_folder_for(&scope, &kind, &target_id)?;
    let key = format!("{kind}:{target_id}");
    let inner = state_inner(&app)?;
    tauri::async_runtime::spawn_blocking(move || inner.inbox.link_memo(&id, &key, &folder)).await.map_err(|e| format!("copy failed: {e}"))?
}

/// The beats folder a beat or a saved prod belongs to (from settings only).
pub fn beats_folder_for(scope: &crate::scope::Scope, kind: &str, target_id: &str) -> Result<PathBuf, String> {
    let folders = scope.beat_folders();
    match kind {
        "beat" => {
            let real = scope.beat(target_id)?;
            folders
                .iter()
                .find(|f| f.canonicalize().map(crate::paths::plain).is_ok_and(|r| real.starts_with(r)))
                .cloned()
                .ok_or_else(|| "That beat isn't inside a beats folder linked in Settings.".to_string())
        }
        "prod" => {
            if target_id.len() != 8 || !target_id.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("bad request".to_string());
            }
            let holds = |f: &&PathBuf| crate::leads::hashes_in(&f.join(crate::leads::LEADS_DIR)).iter().any(|l| l.hash == target_id);
            folders.iter().find(holds).or(folders.first()).cloned().ok_or_else(|| "Add a beats folder in Settings first.".to_string())
        }
        _ => Err("bad request".to_string()),
    }
}

/// Status from the desktop: an idea appended to a note ("filed" + where),
/// "dismissed", or back to "new" (also "File elsewhere": what was already
/// filed stays where it went).
#[tauri::command]
pub fn phone_inbox_mark(app: AppHandle, id: String, status: String, filed_to: Option<String>) -> Result<(), String> {
    use crate::phone_inbox::Status;
    let status = match status.as_str() {
        "new" => Status::New,
        "filed" => Status::Filed,
        "dismissed" => Status::Dismissed,
        _ => return Err(format!("unknown status: {status}")),
    };
    state_inner(&app)?.inbox.mark(&id, status, filed_to)
}

/// Removes an item and its files from the inbox (never anything filed into a song folder).
#[tauri::command]
pub fn phone_inbox_remove(app: AppHandle, id: String) -> Result<(), String> {
    state_inner(&app)?.inbox.remove(&id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn key() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn envelope_round_trip() {
        let a = aad("dev1", "/v1/hello");
        assert_eq!(a, "hivo-sync-v1|dev1|/v1/hello");
        let env = seal(&key(), &a, b"{\"x\":1}").unwrap();
        assert_eq!(B64.decode(&env.n).unwrap().len(), 24);
        assert!(!env.n.contains('=') && !env.c.contains('=') && !env.c.contains('+') && !env.c.contains('/'));
        assert_eq!(open(&key(), &a, &env).unwrap(), b"{\"x\":1}");
        // Two seals of the same message differ (random nonce).
        assert_ne!(seal(&key(), &a, b"{\"x\":1}").unwrap().c, env.c);
    }

    #[test]
    fn wrong_key_or_aad_fails() {
        let env = seal(&key(), &aad("dev1", "/v1/notes"), b"hi").unwrap();
        assert!(open(&[8u8; 32], &aad("dev1", "/v1/notes"), &env).is_none());
        assert!(open(&key(), &aad("dev1", "/v1/snapshot"), &env).is_none());
        assert!(open(&key(), &aad("dev2", "/v1/notes"), &env).is_none());
        assert!(open(&key(), &aad("dev1", &resp_path("/v1/notes")), &env).is_none());
        // Tamper with the first character; never replace it with itself (the
        // ciphertext is random, so it starts with 'A' one time in 64).
        let mut bad = env.clone();
        let swap = if env.c.starts_with('A') { 'B' } else { 'A' };
        bad.c = format!("{swap}{}", &env.c[1..]);
        assert!(open(&key(), &aad("dev1", "/v1/notes"), &bad).is_none());
        assert!(open(&key(), &aad("dev1", "/v1/notes"), &Envelope { n: "short".into(), c: env.c }).is_none());
    }

    #[test]
    fn stale_ts_and_replayed_nonce_rejected() {
        let mut g = ReplayGuard::default();
        let now = 1_000_000_000;
        assert_eq!(g.check("d", "n1", now - TS_WINDOW_MS - 1, now), Err(Reject::Stale));
        assert_eq!(g.check("d", "n1", now + TS_WINDOW_MS + 1, now), Err(Reject::Stale));
        assert_eq!(g.check("d", "n1", now, now), Ok(()));
        assert_eq!(g.check("d", "n1", now, now + 1), Err(Reject::Replayed));
        // Same nonce from another device is a different request.
        assert_eq!(g.check("e", "n1", now, now), Ok(()));
        assert_eq!(g.check("d", "", now, now), Err(Reject::BadNonce));
        // Forgotten after the TTL (its ts would be stale by then anyway).
        let later = now + NONCE_TTL_MS + 1;
        assert_eq!(g.check("d", "n1", later, later), Ok(()));
    }

    #[test]
    fn store_write_read_forget() {
        let dir = std::env::temp_dir().join(format!("hivo-phone-sync-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("phone-sync.json");
        let mut f = SyncFile { enabled: true, port: Some(41234), devices: vec![] };
        let d = add_device(&mut f, 5).unwrap();
        assert_eq!(B64.decode(&d.id).unwrap().len(), 16);
        assert_eq!(B64.decode(&d.key).unwrap().len(), 32);
        write_store(&path, &f).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let back = read_store(&path);
        assert_eq!(back, f);
        // A new pairing drops the never-seen one (abandoned QR), keeps seen ones.
        let mut f2 = back.clone();
        f2.devices[0].last_seen_ms = Some(6);
        let d2 = add_device(&mut f2, 7).unwrap();
        assert_eq!(f2.devices.len(), 2);
        let d3 = add_device(&mut f2, 8).unwrap();
        assert_eq!(f2.devices.iter().map(|x| x.id.clone()).collect::<Vec<_>>(), vec![d.id.clone(), d3.id.clone()]);
        assert!(!f2.devices.iter().any(|x| x.id == d2.id));
        assert!(forget_device(&mut f2, &d.id));
        assert!(!forget_device(&mut f2, &d.id));
        write_store(&path, &f2).unwrap();
        assert_eq!(read_store(&path).devices.len(), 1);
        assert!(!dir.join("phone-sync.json.tmp").exists(), "written atomically");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_store_is_kept_aside_and_reported() {
        let dir = std::env::temp_dir().join(format!("hivo-phone-sync-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("phone-sync.json");
        // Missing: defaults, nothing to say.
        assert_eq!(load_store(&path), (SyncFile::default(), None));
        // Broken: kept as .bad-<ms>, reported, and saving works again.
        fs::write(&path, "not json").unwrap();
        let (file, problem) = load_store(&path);
        assert_eq!(file, SyncFile::default());
        let problem = problem.expect("reported");
        assert!(!problem.blocks_saving && problem.message.contains("pairing again"), "{}", problem.message);
        let kept: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("phone-sync.json.bad-")).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(kept[0].path()).unwrap(), b"not json", "the broken file is kept");
        assert!(!path.exists());
        // Shown in the status until a save works.
        fs::write(&path, "still not json").unwrap();
        let inner = Inner::new(path.clone());
        assert!(status_of(&inner, "0.7.0").error.is_some_and(|e| e.contains("pairing again")));
        inner.save(&SyncFile::default()).unwrap();
        assert_eq!(status_of(&inner, "0.7.0").error, None);
        let bads = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("phone-sync.json.bad-")).count();
        assert_eq!(bads, 2, "a second broken file never replaces the first");
        // Can't be read at all (here: a folder in its place): left alone, saving refused.
        let blocked = dir.join("blocked").join("phone-sync.json");
        fs::create_dir_all(&blocked).unwrap();
        let (_, problem) = load_store(&blocked);
        assert!(problem.is_some_and(|p| p.blocks_saving));
        let inner = Inner::new(blocked.clone());
        assert!(inner.save(&SyncFile::default()).is_err());
        assert!(blocked.is_dir(), "nothing written over it");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_port_flags_phones_and_repair_replaces_in_place() {
        let mut f = SyncFile { enabled: true, port: Some(41000), devices: vec![] };
        let a = add_device(&mut f, 1).unwrap();
        f.devices[0].last_seen_ms = Some(2);
        f.devices[0].name = Some("Pixel".into());
        // Same port: nothing to say.
        assert!(!note_port(&mut f, 41000));
        assert_eq!(f.devices[0].paired_port, None);
        // The saved port was taken: phones paired before keep the old one.
        assert!(note_port(&mut f, 52000));
        assert_eq!((f.port, f.devices[0].paired_port), (Some(52000), Some(41000)));
        // Re-pair (v1.2): same id and name, the derived key, the new port.
        let before = f.devices[0].clone();
        complete_pairing(&mut f, &a.id, &[3u8; 32], true, 52000, 9).unwrap();
        let r = f.devices[0].clone();
        assert_eq!((r.id.as_str(), r.name.as_deref(), r.paired_port, r.last_seen_ms, r.derived), (a.id.as_str(), Some("Pixel"), Some(52000), Some(9), true));
        assert_ne!(r.key, before.key);
        assert_eq!(f.devices.len(), 1);
        assert!(complete_pairing(&mut f, "nobody", &[3u8; 32], true, 1, 1).is_err(), "a re-pair of a forgotten phone");
        // A new port again: an already-recorded port isn't overwritten.
        assert!(note_port(&mut f, 53000));
        assert_eq!(f.devices[0].paired_port, Some(52000));
    }

    #[test]
    fn pairing_url_format() {
        let hosts = [Ipv4Addr::new(192, 168, 1, 20), Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(10, 0, 0, 5)];
        let url = pairing_url("AAAAAAAAAAAAAAAAAAAAAA", &[0xfb; 32], &[0; 32], &hosts, 51234, "Studio Mac é");
        let t = B64.encode([0xfb; 32]);
        assert!(t.contains('-') || t.contains('_'), "url-safe alphabet: {t}");
        assert_eq!(url, format!("hivo://pair?v=2&d=AAAAAAAAAAAAAAAAAAAAAA&t={t}&x={}&h=192.168.1.20,10.0.0.5&p=51234&n=Studio%20Mac%20%C3%A9", B64.encode([0; 32])));
        assert_eq!(url.matches('=').count(), 7, "no padding: {url}");
        assert!(!url.contains("k="), "never a key in the QR");
    }

    #[test]
    fn ranks_private_addresses() {
        let list = vec![
            ("utun3".to_string(), Ipv4Addr::new(10, 8, 0, 2)),
            ("bridge100".to_string(), Ipv4Addr::new(192, 168, 64, 1)),
            ("en0".to_string(), Ipv4Addr::new(192, 168, 1, 20)),
            ("en5".to_string(), Ipv4Addr::new(172, 20, 0, 3)),
            ("en0".to_string(), Ipv4Addr::new(82, 1, 2, 3)),
            ("en7".to_string(), Ipv4Addr::new(10, 0, 0, 9)),
        ];
        let ranked = rank_addresses(&list, Some(Ipv4Addr::new(10, 0, 0, 9)));
        assert_eq!(ranked[0], Ipv4Addr::new(10, 0, 0, 9));
        assert_eq!(ranked[1], Ipv4Addr::new(192, 168, 1, 20));
        assert!(!ranked.contains(&Ipv4Addr::new(82, 1, 2, 3)));
        assert_eq!(ranked.len(), 4);
        assert!(rank_addresses(&list, None).iter().all(Ipv4Addr::is_private));
    }

    #[test]
    fn memo_folder_per_song_when_songs_share_a_folder() {
        let d = std::env::temp_dir().join(format!("hivo-memo-sub-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let alone = d.join("Envy");
        let flat = d.join("Projects");
        fs::create_dir_all(&alone).unwrap();
        fs::create_dir_all(&flat).unwrap();
        fs::write(alone.join("Envy.flp"), b"x").unwrap();
        fs::write(alone.join("Envy mix.wav"), b"x").unwrap();
        fs::write(flat.join("One.flp"), b"x").unwrap();
        fs::write(flat.join("Two.als"), b"x").unwrap();
        assert_eq!(memo_sub_for(&alone.join("Envy.flp"), &alone), None, "alone in its folder: Voice memos/");
        assert_eq!(memo_sub_for(&flat.join("One.flp"), &flat).as_deref(), Some("One"));
        // A sketch is keyed by its BandLab folder: never a sub-folder.
        assert_eq!(memo_sub_for(&flat.join("X").join("BandLab"), &flat.join("X")), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn payload_limits() {
        assert!(check_payload("/v1/snapshot", &json!({})).is_ok());
        assert!(check_payload("/v1/snapshot", &json!([])).is_err());
        let ok = json!({ "changes": [{ "kind": "beat", "id": "/b.wav", "text": "x", "baseHash": "811c9dc5" }] });
        assert!(check_payload("/v1/notes", &ok).is_ok());
        let many: Vec<Value> = (0..=MAX_CHANGES).map(|i| json!({ "kind": "song", "id": format!("{i}"), "text": "", "baseHash": "" })).collect();
        assert!(check_payload("/v1/notes", &json!({ "changes": many })).unwrap_err().contains("too many"));
        let long = "a".repeat(MAX_NOTE_CHARS + 1);
        assert!(check_payload("/v1/notes", &json!({ "changes": [{ "kind": "prod", "id": "1", "text": long, "baseHash": "" }] })).is_err());
        assert!(check_payload("/v1/notes", &json!({ "changes": [{ "kind": "file", "id": "1", "text": "", "baseHash": "" }] })).is_err());
    }

    // ---- Live listener ----

    struct FakeHost {
        inner: Mutex<Option<Arc<Inner>>>,
    }

    impl Host for FakeHost {
        fn forward(&self, request: &ForwardedRequest) -> bool {
            let inner = lock(&self.inner).clone().unwrap();
            let r = request.clone();
            std::thread::spawn(move || inner.reply(&r.id, Ok(json!({ "echo": r.path, "phone": r.phone_name, "body": r.body }))));
            true
        }
        fn hivo_version(&self) -> String {
            "0.5.5".into()
        }
        fn desktop_name(&self) -> String {
            "Test desk".into()
        }
    }

    fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> (u16, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        s.write_all(head.as_bytes()).unwrap();
        let _ = s.write_all(body);
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        let text = String::from_utf8_lossy(&out).to_string();
        let status: u16 = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4).unwrap_or(out.len());
        (status, out[split..].to_vec())
    }

    fn sealed_request(dev: &StoredDevice, path: &str, ts: i64, nonce: &str, body: Value) -> Vec<u8> {
        let plain = serde_json::to_vec(&json!({ "ts": ts, "nonce": nonce, "body": body })).unwrap();
        serde_json::to_vec(&seal(&dev.key_bytes().unwrap(), &aad(&dev.id, path), &plain).unwrap()).unwrap()
    }

    fn open_reply(dev: &StoredDevice, path: &str, body: &[u8]) -> Value {
        let env: Envelope = serde_json::from_slice(body).unwrap();
        serde_json::from_slice(&open(&dev.key_bytes().unwrap(), &aad(&dev.id, &resp_path(path)), &env).unwrap()).unwrap()
    }

    /// Opens a connection that sends headers announcing a body, then nothing.
    fn slow_client(port: u16, device: &str) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let head = format!("POST /v1/hello HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\nX-Hivo-Device: {device}\r\n\r\n{{");
        s.write_all(head.as_bytes()).unwrap();
        s
    }

    fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(5);
        while !ok() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn live_listener_body_deadline_per_ip_cap_and_device_first() {
        let dir = std::env::temp_dir().join(format!("hivo-phone-slow-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("phone-sync.json");
        let _ = fs::remove_file(&path);
        let inner = Inner::new(path.clone());
        inner.body_deadline_ms.store(300, Ordering::Relaxed);
        let dev = add_device(&mut lock(&inner.store), now_ms()).unwrap();
        let host = Arc::new(FakeHost { inner: Mutex::new(Some(inner.clone())) });
        let port = start(&inner, host, IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();

        // An unknown device is refused before its body is read (it never comes).
        let mut s = slow_client(port, "nobody");
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        assert!(String::from_utf8_lossy(&out).starts_with("HTTP/1.1 401"));
        wait_until("no slot held while its body is drained", || inner.in_flight.load(Ordering::SeqCst) == 0);
        drop(s);
        wait_until("the refused connection to close", || lock(&inner.per_ip).is_empty());

        // A known device that never sends its body loses its slot after the deadline.
        let slow: Vec<TcpStream> = (0..MAX_PER_IP).map(|_| slow_client(port, &dev.id)).collect();
        wait_until("every slow request to give its slot back", || inner.in_flight.load(Ordering::SeqCst) == 0 && lock(&inner.per_ip).values().sum::<usize>() == MAX_PER_IP);
        // Its address still holds MAX_PER_IP connections: one more is refused…
        assert_eq!(http(port, "GET", "/v1/ping", &[], b"").0, 503);
        // …until they go away.
        drop(slow);
        wait_until("the slow connections to close", || lock(&inner.per_ip).is_empty());
        assert_eq!(http(port, "GET", "/v1/ping", &[], b"").0, 200);
        stop(&inner);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn versions_unseen_devices_and_the_progress_throttle() {
        use std::cmp::Ordering as O;
        assert_eq!(major_minor("0.6.3"), Some((0, 6)));
        assert_eq!(major_minor("v1.2.0-beta"), Some((1, 2)));
        assert_eq!(major_minor("x"), None);
        assert_eq!(compare_versions("0.6.9", "0.6.1"), Some(O::Equal), "patches talk to each other");
        assert_eq!(compare_versions("0.7.0", "0.6.5"), Some(O::Greater));
        assert_eq!(compare_versions("0.5.9", "0.6.0"), Some(O::Less));
        assert_eq!(compare_versions("?", "0.6.0"), None);

        let mut file = SyncFile::default();
        let now = 1_000_000_000;
        let fresh = add_device(&mut file, now).unwrap();
        let mut old = add_device(&mut file, now - UNSEEN_TTL_MS - 1).unwrap();
        old.last_seen_ms = None;
        let mut seen = add_device(&mut file, now - UNSEEN_TTL_MS * 10).unwrap();
        seen.last_seen_ms = Some(now);
        file.devices = vec![fresh.clone(), old, seen.clone()];
        assert!(expire_unseen(&mut file, now));
        assert_eq!(file.devices.iter().map(|d| d.id.clone()).collect::<Vec<_>>(), vec![fresh.id, seen.id]);
        assert!(!expire_unseen(&mut file, now));

        // At most one event a second per item, and the last move always gets one.
        let t0 = Instant::now();
        let mut e = (t0, None);
        assert_eq!(progress_step(&mut e, t0), Some(Duration::ZERO));
        let ms = |n: u64| t0 + Duration::from_millis(n);
        assert_eq!(progress_step(&mut e, ms(200)), Some(Duration::from_millis(800)), "a trailing one");
        assert_eq!(progress_step(&mut e, ms(500)), None, "already covered");
        assert_eq!(progress_step(&mut e, ms(1200)), Some(Duration::from_millis(800)), "after the trailing one fired: the next one");
        assert_eq!(progress_step(&mut e, ms(5000)), Some(Duration::ZERO));
    }

    #[test]
    fn live_listener_hello_snapshot_and_rejections() {
        let dir = std::env::temp_dir().join(format!("hivo-phone-live-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("phone-sync.json");
        let _ = fs::remove_file(&path);
        let inner = Inner::new(path.clone());
        let dev = add_device(&mut lock(&inner.store), now_ms()).unwrap();
        let host = Arc::new(FakeHost { inner: Mutex::new(Some(inner.clone())) });
        let port = start(&inner, host, IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
        assert_eq!(read_store(&path).port, Some(port));

        let (s, b) = http(port, "GET", "/v1/ping", &[], b"");
        assert_eq!(s, 200);
        assert_eq!(serde_json::from_slice::<Value>(&b).unwrap(), json!({ "app": "hivo", "v": 1 }));

        let hdr = [("X-Hivo-Device", dev.id.as_str()), ("Content-Type", "application/json")];
        let hello = sealed_request(&dev, "/v1/hello", now_ms(), "n-hello", json!({ "phoneName": "Pixel\u{7} 9", "appVersion": "0.1.0" }));
        let (s, b) = http(port, "POST", "/v1/hello", &hdr, &hello);
        assert_eq!(s, 200);
        assert_eq!(open_reply(&dev, "/v1/hello", &b), json!({ "ok": true, "body": { "desktopName": "Test desk", "hivoVersion": "0.5.5", "protocol": "1.2" } }));
        let saved = read_store(&path);
        assert_eq!(saved.devices[0].name.as_deref(), Some("Pixel 9"));
        assert!(saved.devices[0].last_seen_ms.is_some());

        // Replayed body: 401.
        assert_eq!(http(port, "POST", "/v1/hello", &hdr, &hello).0, 401);
        // Stale ts (the phone's clock is off), but authenticated: a sealed "clock".
        let stale = sealed_request(&dev, "/v1/hello", now_ms() - TS_WINDOW_MS - 5_000, "n-stale", json!({}));
        let (s, b) = http(port, "POST", "/v1/hello", &hdr, &stale);
        assert_eq!(s, 200);
        assert_eq!(open_reply(&dev, "/v1/hello", &b), json!({ "ok": false, "error": "clock" }));
        let ahead = sealed_request(&dev, "/v1/inbox", now_ms() + TS_WINDOW_MS + 5_000, "n-ahead", json!({}));
        assert_eq!(open_reply(&dev, "/v1/inbox", &http(port, "POST", "/v1/inbox", &hdr, &ahead).1)["error"], "clock");
        // Authenticated but not a request (no ts/nonce, or an empty nonce): a sealed "bad request".
        let junk = serde_json::to_vec(&seal(&dev.key_bytes().unwrap(), &aad(&dev.id, "/v1/upload/chunk"), b"[1,2]").unwrap()).unwrap();
        let (s, b) = http(port, "POST", "/v1/upload/chunk", &hdr, &junk);
        assert_eq!(s, 200, "never a bare 401 once the envelope opened");
        assert_eq!(open_reply(&dev, "/v1/upload/chunk", &b), json!({ "ok": false, "error": "bad request" }));
        let no_nonce = sealed_request(&dev, "/v1/inbox", now_ms(), "", json!({}));
        assert_eq!(open_reply(&dev, "/v1/inbox", &http(port, "POST", "/v1/inbox", &hdr, &no_nonce).1)["error"], "bad request");
        // Sealed for another path: 401.
        let other = sealed_request(&dev, "/v1/snapshot", now_ms(), "n-other", json!({}));
        assert_eq!(http(port, "POST", "/v1/hello", &hdr, &other).0, 401);
        // Unknown device: 401.
        assert_eq!(http(port, "POST", "/v1/snapshot", &[("X-Hivo-Device", "nobody")], &other).0, 401);
        // Too big: 413.
        let big = vec![b' '; MAX_BODY_BYTES + 10];
        assert_eq!(http(port, "POST", "/v1/notes", &hdr, &big).0, 413);
        // Unknown path: 404.
        assert_eq!(http(port, "GET", "/v1/snapshot", &[], b"").0, 404);

        // Forwarded to the "webview" and answered.
        let (s, b) = http(port, "POST", "/v1/snapshot", &hdr, &other);
        assert_eq!(s, 200);
        assert_eq!(open_reply(&dev, "/v1/snapshot", &b), json!({ "ok": true, "body": { "echo": "/v1/snapshot", "phone": "Pixel 9", "body": {} } }));
        // Checked before forwarding.
        let bad = sealed_request(&dev, "/v1/notes", now_ms(), "n-bad", json!({ "changes": [{ "kind": "x", "id": "1", "text": "", "baseHash": "" }] }));
        let (s, b) = http(port, "POST", "/v1/notes", &hdr, &bad);
        assert_eq!(s, 200);
        assert_eq!(open_reply(&dev, "/v1/notes", &b), json!({ "ok": false, "error": "bad request" }));

        // Forgotten device: 401 right away.
        assert!(forget_device(&mut lock(&inner.store), &dev.id));
        let after = sealed_request(&dev, "/v1/snapshot", now_ms(), "n-after", json!({}));
        assert_eq!(http(port, "POST", "/v1/snapshot", &hdr, &after).0, 401);

        stop(&inner);
        assert!(inner.port().is_none());
        // The port is closed (or at least no longer answered by us).
        let closed = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300))
            .map(|mut s| {
                let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = s.write_all(b"GET /v1/ping HTTP/1.1\r\nHost: x\r\n\r\n");
                let mut buf = [0u8; 16];
                !matches!(s.read(&mut buf), Ok(n) if n > 0)
            })
            .unwrap_or(true);
        assert!(closed);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn busy_when_nobody_answers() {
        struct Deaf;
        impl Host for Deaf {
            fn forward(&self, _: &ForwardedRequest) -> bool {
                false
            }
            fn hivo_version(&self) -> String {
                String::new()
            }
            fn desktop_name(&self) -> String {
                String::new()
            }
        }
        let inner = Inner::new(std::env::temp_dir().join(format!("hivo-phone-deaf-{}.json", std::process::id())));
        assert_eq!(inner.forward(&Deaf, "/v1/snapshot", json!({}), "p".into()), Err("busy".to_string()));
        assert!(lock(&inner.pending).is_empty());
    }

    /// Cross-language check with the phone's real client (mobile/src/lib/
    /// e2e.test.ts): run with HIVO_E2E_DIR set, then the phone test, which
    /// writes `stop` when done. `cargo test e2e_server -- --ignored`.
    /// The phone pairs with the v1.2 QR in `pair-url` and syncs; a phone
    /// paired before 1.2 (key `[9; 32]`) still works too.
    #[test]
    #[ignore]
    fn e2e_server_for_the_phone_client() {
        let dir = PathBuf::from(std::env::var("HIVO_E2E_DIR").expect("HIVO_E2E_DIR"));
        let port: u16 = std::env::var("HIVO_E2E_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(48123);
        fs::create_dir_all(&dir).unwrap();
        let inner = Inner::new(dir.join("phone-sync.json"));
        {
            let mut store = lock(&inner.store);
            store.port = Some(port);
            store.devices = vec![StoredDevice {
                id: "e2eDevice0000000000000".into(),
                key: B64.encode([9u8; 32]),
                name: Some("E2E phone".into()),
                app_version: None,
                paired_at_ms: now_ms(),
                last_seen_ms: Some(now_ms()),
                paired_port: None,
                derived: false,
            }];
        }
        // A v1.2 QR (loopback in `h`: the phone test runs on this computer).
        let (id, token, desk_pub) = inner.begin_pair(None, port, now_ms()).unwrap();
        let url = format!("hivo://pair?v=2&d={id}&t={}&x={}&h=127.0.0.1&p={port}&n=Test%20desk", B64.encode(token), B64.encode(desk_pub));
        fs::write(dir.join("pair-url"), url).unwrap();
        // Answers like an empty library, so a real phone app can sync against it.
        struct E2eHost {
            inner: Mutex<Option<Arc<Inner>>>,
        }
        impl Host for E2eHost {
            fn forward(&self, request: &ForwardedRequest) -> bool {
                let inner = lock(&self.inner).clone().unwrap();
                let r = request.clone();
                let body = if r.path == "/v1/snapshot" { json!({ "items": [], "generatedAt": now_ms() }) } else { json!({ "results": [] }) };
                std::thread::spawn(move || inner.reply(&r.id, Ok(body)));
                true
            }
            fn hivo_version(&self) -> String {
                "0.7.0".into()
            }
            fn desktop_name(&self) -> String {
                "Test desk".into()
            }
        }
        let host = Arc::new(E2eHost { inner: Mutex::new(Some(inner.clone())) });
        start(&inner, host, IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
        fs::write(dir.join("ready"), port.to_string()).unwrap();
        let secs: u64 = std::env::var("HIVO_E2E_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(120);
        let started = Instant::now();
        while !dir.join("stop").exists() && started.elapsed() < Duration::from_secs(secs) {
            std::thread::sleep(Duration::from_millis(100));
        }
        let list = inner.inbox.list();
        fs::write(dir.join("result.json"), serde_json::to_vec_pretty(&list).unwrap()).unwrap();
        let devices: Vec<Value> = lock(&inner.store).devices.iter().map(|d| json!({ "id": d.id, "derived": d.derived, "name": d.name })).collect();
        fs::write(dir.join("devices.json"), serde_json::to_vec_pretty(&devices).unwrap()).unwrap();
        stop(&inner);
        assert!(dir.join("stop").exists(), "the phone test never finished");
    }

    // ---- v1.2: bound answers, one-time pairing, replay log ----

    /// The phone's half of the pairing: its device key and public key.
    fn phone_side(secret: [u8; 32], desktop_pub: &[u8; 32], token: &[u8; 32], id: &str) -> ([u8; 32], [u8; 32]) {
        let s = x25519_dalek::StaticSecret::from(secret);
        let phone_pub = x25519_dalek::PublicKey::from(&s).to_bytes();
        let shared = s.diffie_hellman(&x25519_dalek::PublicKey::from(*desktop_pub));
        (derive_device_key(shared.as_bytes(), token, id, desktop_pub, &phone_pub), phone_pub)
    }

    fn plain_v(nonce: &str, body: Value, v: Option<&str>) -> Vec<u8> {
        let mut p = json!({ "ts": now_ms(), "nonce": nonce, "body": body });
        if let Some(v) = v {
            p["v"] = json!(v);
        }
        serde_json::to_vec(&p).unwrap()
    }

    fn request_with(key: &[u8; 32], id: &str, path: &str, nonce: &str, body: Value, v: Option<&str>) -> Vec<u8> {
        serde_json::to_vec(&seal(key, &aad(id, path), &plain_v(nonce, body, v)).unwrap()).unwrap()
    }

    fn pair_request(key: &[u8; 32], id: &str, phone_pub: &[u8; 32], nonce: &str, body: Value) -> Vec<u8> {
        let env = seal(key, &aad(id, PAIR_PATH), &plain_v(nonce, body, Some(PROTOCOL))).unwrap();
        serde_json::to_vec(&json!({ "n": env.n, "c": env.c, "x": B64.encode(phone_pub) })).unwrap()
    }

    /// The answer, opened as bound to `nonce` (None: the 1.1 form).
    fn answer(key: &[u8; 32], id: &str, path: &str, nonce: Option<&str>, outcome: &Outcome) -> Option<Value> {
        let Outcome::Sealed(env) = outcome else { return None };
        serde_json::from_slice(&open(key, &resp_aad(id, path, nonce), env)?).ok()
    }

    fn quiet() -> FakeHost {
        FakeHost { inner: Mutex::new(None) }
    }

    fn temp_inner(tag: &str) -> (Arc<Inner>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("hivo-v12-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (Inner::new(dir.join("phone-sync.json")), dir)
    }

    fn derived_device(inner: &Inner, key: [u8; 32]) -> String {
        let id = B64.encode(random_bytes::<16>().unwrap());
        complete_pairing(&mut lock(&inner.store), &id, &key, false, 1, now_ms()).unwrap();
        id
    }

    #[test]
    fn key_derivation_test_vector() {
        let desk: [u8; 32] = std::array::from_fn(|i| i as u8 + 1);
        let phone: [u8; 32] = std::array::from_fn(|i| i as u8 + 0x21);
        let token = [0x55u8; 32];
        let id = B64.encode([7u8; 16]);
        let desk_s = x25519_dalek::StaticSecret::from(desk);
        let desk_pub = x25519_dalek::PublicKey::from(&desk_s).to_bytes();
        let (phone_key, phone_pub) = phone_side(phone, &desk_pub, &token, &id);
        let desk_key = desktop_derive(&desk_s, &token, &id, &phone_pub).unwrap();
        assert_eq!(desk_key, phone_key, "both sides derive the same key");
        // The same vector is in mobile/src/lib/handshake.test.ts.
        assert_eq!(B64.encode(desk_pub), "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw");
        assert_eq!(B64.encode(phone_pub), "WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns");
        assert_eq!(B64.encode(desk_key), "nuf6rptKkMpoSSsZ3ooSuRlVMKdcr0uHlFRRwqLz8bQ");
        // Another token, device or phone key: another key.
        assert_ne!(desktop_derive(&desk_s, &[0x56; 32], &id, &phone_pub).unwrap(), desk_key);
        assert_ne!(desktop_derive(&desk_s, &token, "other", &phone_pub).unwrap(), desk_key);
        let (_, other_pub) = phone_side([0x77; 32], &desk_pub, &token, &id);
        assert_ne!(desktop_derive(&desk_s, &token, &id, &other_pub).unwrap(), desk_key);
        // A low-order point (all zeros) gives no key.
        assert!(desktop_derive(&desk_s, &token, &id, &[0u8; 32]).is_none());
    }

    #[test]
    fn pairing_is_one_time_and_expires() {
        let (inner, dir) = temp_inner("pair");
        let host = quiet();
        let (id, token, desk_pub) = inner.begin_pair(None, 41000, now_ms()).unwrap();
        assert!(inner.device(&id).is_none(), "nothing stored before the phone pairs");
        // Someone who knows the device id but not the QR's token: refused, the QR still works.
        let (bad_key, mallory) = phone_side([0x99; 32], &desk_pub, &[0u8; 32], &id);
        let o = handle_sealed(&inner, &host, PAIR_PATH, Some(&id), &pair_request(&bad_key, &id, &mallory, "m1", json!({})));
        assert!(matches!(o, Outcome::Status(401)));
        assert!(inner.pair_pending(&id, now_ms()));
        // The phone: paired, the answer bound to its nonce, its name kept.
        let (key, phone_pub) = phone_side([0x42; 32], &desk_pub, &token, &id);
        let o = handle_sealed(&inner, &host, PAIR_PATH, Some(&id), &pair_request(&key, &id, &phone_pub, "p1", json!({ "phoneName": "Pixel", "appVersion": "0.7.0" })));
        assert!(answer(&key, &id, PAIR_PATH, None, &o).is_none(), "never unbound");
        let reply = answer(&key, &id, PAIR_PATH, Some("p1"), &o).expect("bound to p1");
        assert_eq!((reply["ok"].clone(), reply["body"]["protocol"].clone()), (json!(true), json!("1.2")));
        let d = inner.device(&id).unwrap();
        assert!(d.derived && d.name.as_deref() == Some("Pixel") && d.key_bytes() == Some(key) && d.paired_port == Some(41000));
        assert_eq!(read_store(&inner.path).devices[0].key, B64.encode(key), "saved");
        assert!(!inner.pair_pending(&id, now_ms()), "burnt");
        // The QR again (a photo of it), with another phone key: refused.
        let (k2, pub2) = phone_side([0x43; 32], &desk_pub, &token, &id);
        assert!(matches!(handle_sealed(&inner, &host, PAIR_PATH, Some(&id), &pair_request(&k2, &id, &pub2, "p2", json!({}))), Outcome::Status(401)));
        assert_eq!(inner.device(&id).unwrap().key_bytes(), Some(key), "the photo changed nothing");
        // The phone retrying (its answer was lost): answered again, with its key.
        let o = handle_sealed(&inner, &host, PAIR_PATH, Some(&id), &pair_request(&key, &id, &phone_pub, "p3", json!({})));
        assert_eq!(answer(&key, &id, PAIR_PATH, Some("p3"), &o).unwrap()["ok"], true);
        // Then it syncs like any phone.
        let o = handle_sealed(&inner, &host, "/v1/hello", Some(&id), &request_with(&key, &id, "/v1/hello", "h1", json!({}), Some("1.2")));
        assert_eq!(answer(&key, &id, "/v1/hello", Some("h1"), &o).unwrap()["ok"], true);

        // An expired QR: refused, nothing stored.
        let (id2, token2, desk2) = inner.begin_pair(None, 41000, now_ms() - PAIR_TTL_MS - 1).unwrap();
        let (k3, pub3) = phone_side([0x44; 32], &desk2, &token2, &id2);
        assert!(matches!(handle_sealed(&inner, &host, PAIR_PATH, Some(&id2), &pair_request(&k3, &id2, &pub3, "e1", json!({}))), Outcome::Status(401)));
        assert!(inner.device(&id2).is_none());
        // A new QR replaces one not used yet; Forget drops a re-pair QR.
        let (a, ..) = inner.begin_pair(None, 41000, now_ms()).unwrap();
        let (b, ..) = inner.begin_pair(None, 41000, now_ms()).unwrap();
        assert!(!inner.pair_pending(&a, now_ms()) && inner.pair_pending(&b, now_ms()));
        assert!(inner.begin_pair(Some("nobody"), 41000, now_ms()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn answers_are_bound_to_the_request() {
        let (inner, dir) = temp_inner("bind");
        let host = quiet();
        let key = [5u8; 32];
        let id = derived_device(&inner, key);
        let o = handle_sealed(&inner, &host, "/v1/hello", Some(&id), &request_with(&key, &id, "/v1/hello", "n-a", json!({}), Some("1.2")));
        assert!(answer(&key, &id, "/v1/hello", Some("n-a"), &o).is_some());
        assert!(answer(&key, &id, "/v1/hello", Some("n-b"), &o).is_none(), "the answer to another request");
        assert!(answer(&key, &id, "/v1/hello", None, &o).is_none(), "never unbound for a 1.2 pairing");
        assert!(answer(&key, &id, "/v1/inbox", Some("n-a"), &o).is_none(), "another path");
        // A 1.2 pairing is bound even if a request says nothing.
        let o = handle_sealed(&inner, &host, "/v1/inbox", Some(&id), &request_with(&key, &id, "/v1/inbox", "n-c", json!({}), None));
        assert_eq!(answer(&key, &id, "/v1/inbox", Some("n-c"), &o).unwrap()["ok"], true);
        // Errors too: a stale ts gets a bound "clock".
        let mut stale = json!({ "ts": now_ms() - TS_WINDOW_MS - 5_000, "nonce": "n-d", "body": {}, "v": "1.2" });
        let req = serde_json::to_vec(&seal(&key, &aad(&id, "/v1/inbox"), &serde_json::to_vec(&stale).unwrap()).unwrap()).unwrap();
        let o = handle_sealed(&inner, &host, "/v1/inbox", Some(&id), &req);
        assert_eq!(answer(&key, &id, "/v1/inbox", Some("n-d"), &o).unwrap()["error"], "clock");
        assert!(answer(&key, &id, "/v1/inbox", Some("n-e"), &o).is_none());
        stale["nonce"] = json!("bad nonce with spaces");
        let req = serde_json::to_vec(&seal(&key, &aad(&id, "/v1/inbox"), &serde_json::to_vec(&stale).unwrap()).unwrap()).unwrap();
        let o = handle_sealed(&inner, &host, "/v1/inbox", Some(&id), &req);
        assert_eq!(answer(&key, &id, "/v1/inbox", Some("bad nonce with spaces"), &o).unwrap()["error"], "bad request");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_phone_paired_before_1_2_still_works_and_can_upgrade() {
        let (inner, dir) = temp_inner("legacy");
        let host = quiet();
        let dev = add_device(&mut lock(&inner.store), now_ms()).unwrap();
        let old_key = dev.key_bytes().unwrap();
        // A 1.1 phone: unbound answers, as before.
        let o = handle_sealed(&inner, &host, "/v1/hello", Some(&dev.id), &request_with(&old_key, &dev.id, "/v1/hello", "l1", json!({ "phoneName": "Old" }), None));
        assert_eq!(answer(&old_key, &dev.id, "/v1/hello", None, &o).unwrap()["ok"], true);
        // The same pairing on a 1.2 phone: bound.
        let o = handle_sealed(&inner, &host, "/v1/inbox", Some(&dev.id), &request_with(&old_key, &dev.id, "/v1/inbox", "l2", json!({}), Some("1.2")));
        assert!(answer(&old_key, &dev.id, "/v1/inbox", None, &o).is_none());
        assert_eq!(answer(&old_key, &dev.id, "/v1/inbox", Some("l2"), &o).unwrap()["ok"], true);
        assert!(status_of(&inner, "0.7.0").devices[0].legacy_pairing, "Re-pair to upgrade security");
        // The old key can't pair (only a QR can).
        let o = handle_sealed(&inner, &host, PAIR_PATH, Some(&dev.id), &pair_request(&old_key, &dev.id, &[9; 32], "l3", json!({})));
        assert!(matches!(o, Outcome::Status(401)));

        // Re-pair: the old key works until the phone used the new QR…
        let (id, token, desk_pub) = inner.begin_pair(Some(&dev.id), 41000, now_ms()).unwrap();
        assert_eq!(id, dev.id);
        let o = handle_sealed(&inner, &host, "/v1/inbox", Some(&id), &request_with(&old_key, &id, "/v1/inbox", "l4", json!({}), None));
        assert_eq!(answer(&old_key, &id, "/v1/inbox", None, &o).unwrap()["ok"], true);
        let (key, phone_pub) = phone_side([0x61; 32], &desk_pub, &token, &id);
        let o = handle_sealed(&inner, &host, PAIR_PATH, Some(&id), &pair_request(&key, &id, &phone_pub, "l5", json!({ "phoneName": "Old" })));
        assert_eq!(answer(&key, &id, PAIR_PATH, Some("l5"), &o).unwrap()["ok"], true);
        // …then it's a 1.2 pairing: same device and name, the old key refused.
        let d = inner.device(&id).unwrap();
        assert!(d.derived && d.name.as_deref() == Some("Old"));
        assert_eq!(lock(&inner.store).devices.len(), 1);
        assert!(!status_of(&inner, "0.7.0").devices[0].legacy_pairing);
        let o = handle_sealed(&inner, &host, "/v1/inbox", Some(&id), &request_with(&old_key, &id, "/v1/inbox", "l6", json!({}), None));
        assert!(matches!(o, Outcome::Status(401)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_replay_after_a_restart_is_refused() {
        let (inner, dir) = temp_inner("restart");
        let path = inner.path.clone();
        let host = quiet();
        let dev = add_device(&mut lock(&inner.store), now_ms()).unwrap();
        let key = dev.key_bytes().unwrap();
        let snapshot = lock(&inner.store).clone();
        inner.save(&snapshot).unwrap();
        let req = request_with(&key, &dev.id, "/v1/inbox", "r1", json!({}), Some("1.2"));
        assert!(matches!(handle_sealed(&inner, &host, "/v1/inbox", Some(&dev.id), &req), Outcome::Sealed(_)));
        drop(inner);
        // Hivo restarted: the same request is still a replay.
        let again = Inner::new(path.clone());
        assert!(matches!(handle_sealed(&again, &host, "/v1/inbox", Some(&dev.id), &req), Outcome::Status(401)));
        let fresh = request_with(&key, &dev.id, "/v1/inbox", "r2", json!({}), Some("1.2"));
        assert!(matches!(handle_sealed(&again, &host, "/v1/inbox", Some(&dev.id), &fresh), Outcome::Sealed(_)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(replay_log(&path)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Loading keeps only the last NONCE_TTL_MS (and skips junk), then rewrites the log.
        let log = dir.join("guard.replay");
        let now = 1_000_000_000_000;
        fs::write(&log, format!("{}\td|old\n{}\td|fresh\njunk\n\n", now - NONCE_TTL_MS - 1, now - 1_000)).unwrap();
        let mut g = ReplayGuard::load(log.clone(), now);
        assert_eq!(g.check("d", "fresh", now, now), Err(Reject::Replayed));
        assert_eq!(g.check("d", "old", now, now), Ok(()));
        let kept = fs::read_to_string(&log).unwrap();
        assert!(!kept.contains("junk") && kept.contains("d|fresh") && kept.contains("d|old"), "{kept}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_upload_of_a_memo_and_demo_refusal() {
        let dir = std::env::temp_dir().join(format!("hivo-phone-upload-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("phone-sync.json");
        let inner = Inner::new(path.clone());
        let dev = add_device(&mut lock(&inner.store), now_ms()).unwrap();
        lock(&inner.store).devices[0].name = Some("Pixel".into());
        let host = Arc::new(FakeHost { inner: Mutex::new(Some(inner.clone())) });
        let port = start(&inner, host, IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
        let hdr = [("X-Hivo-Device", dev.id.as_str()), ("Content-Type", "application/json")];
        let mut n = 0;
        let mut call = |p: &str, body: Value| {
            n += 1;
            let req = sealed_request(&dev, p, now_ms(), &format!("n{n}"), body);
            let (s, b) = http(port, "POST", p, &hdr, &req);
            assert_eq!(s, 200, "{p}");
            open_reply(&dev, p, &b)
        };
        let start_body = json!({ "itemId": "memo1", "itemType": "memo", "title": "Flow", "fileIndex": 0, "fileCount": 1, "name": "rec.m4a", "size": 5 });
        assert_eq!(call("/v1/upload/start", start_body.clone()), json!({ "ok": true, "body": { "offset": 0 } }));
        let chunk = json!({ "itemId": "memo1", "fileIndex": 0, "offset": 0, "data": B64.encode(b"hello") });
        assert_eq!(call("/v1/upload/chunk", chunk.clone()), json!({ "ok": true, "body": { "offset": 5 } }));
        assert_eq!(call("/v1/upload/chunk", chunk), json!({ "ok": false, "error": "offset:5" }));
        let fin = call("/v1/upload/finish", json!({ "itemId": "memo1", "fileIndex": 0 }));
        assert_eq!(fin["body"]["status"], "stored");
        assert_eq!(call("/v1/inbox", json!({}))["body"]["items"][0]["status"], "new");
        let listed = inner.inbox.list();
        assert_eq!(listed[0].item.phone_name, "Pixel");
        assert_eq!(fs::read(&listed[0].files[0].path).unwrap(), b"hello");
        assert!(dir.join("phone-inbox").join("index.json").is_file(), "next to phone-sync.json");
        // Sample data on the desktop: nothing is received, the status still answers.
        inner.demo.store(true, Ordering::Relaxed);
        assert_eq!(call("/v1/ideas", json!({ "ideas": [{ "id": "i1", "title": "t" }] })), json!({ "ok": false, "error": "demo" }));
        assert_eq!(call("/v1/upload/start", json!({ "itemId": "m2", "itemType": "memo", "fileIndex": 0, "fileCount": 1, "name": "a.m4a", "size": 1 }))["error"], "demo");
        assert_eq!(call("/v1/inbox", json!({}))["ok"], true);
        stop(&inner);
        let _ = fs::remove_dir_all(&dir);
    }
}
