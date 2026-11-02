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
pub const REQUEST_EVENT: &str = "phone-sync-request";
const FORWARDED: [&str; 2] = ["/v1/snapshot", "/v1/notes"];
/// v1.1 (step 4): answered here from the phone inbox (crate::phone_inbox).
const INBOX_PATHS: [&str; 5] = ["/v1/ideas", "/v1/upload/start", "/v1/upload/chunk", "/v1/upload/finish", "/v1/inbox"];
pub const INBOX_EVENT: &str = "phone-inbox-changed";
/// Progress events (upload start/chunk/finish) at most this often.
const INBOX_EVENT_EVERY: Duration = Duration::from_millis(1000);

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
}

impl ReplayGuard {
    /// Accepts a (device, nonce, ts) once inside the window.
    pub fn check(&mut self, device_id: &str, nonce: &str, ts: i64, now: i64) -> Result<(), Reject> {
        if nonce.is_empty() || nonce.len() > 64 {
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

pub fn read_store(path: &Path) -> SyncFile {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

pub fn write_store(path: &Path, file: &SyncFile) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    crate::cover::write_private(path, raw.as_bytes()).map_err(|e| format!("could not save phone sync settings: {e}"))
}

/// A new device: 16-byte id and 32-byte key. Devices that were paired but
/// never said hello (an abandoned QR) are dropped first.
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
    };
    file.devices.push(device.clone());
    Ok(device)
}

/// "Re-pair this phone": a new key for the same device id, in place (its
/// name and what it sent stay; the old key stops working). Until the phone
/// scans the new QR it counts as never seen.
pub fn repair_device(file: &mut SyncFile, id: &str, port: u16, now: i64) -> Result<StoredDevice, String> {
    let d = file.devices.iter_mut().find(|d| d.id == id).ok_or("That phone isn't paired any more.")?;
    d.key = B64.encode(random_bytes::<32>()?);
    d.paired_at_ms = now;
    d.last_seen_ms = None;
    d.paired_port = Some(port);
    Ok(d.clone())
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

/// `hivo://pair?v=1&d=<id>&k=<key>&h=<ip1>,<ip2>&p=<port>&n=<name>`.
/// Only private IPv4 addresses go in `h`.
pub fn pairing_url(device_id: &str, key: &str, hosts: &[Ipv4Addr], port: u16, desktop_name: &str) -> String {
    let h = hosts.iter().filter(|ip| ip.is_private()).map(|ip| ip.to_string()).collect::<Vec<_>>().join(",");
    format!("hivo://pair?v=1&d={device_id}&k={key}&h={h}&p={port}&n={}", uri_encode(desktop_name))
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
    pub inbox: Arc<crate::phone_inbox::Inbox>,
    /// The webview says so when it shows sample data: uploads are refused.
    demo: AtomicBool,
    /// When the last progress event went out (`inbox_progress`).
    last_progress: Mutex<Option<Instant>>,
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
        let store = read_store(&path);
        let inbox = Arc::new(crate::phone_inbox::Inbox::open(inbox_root(&path)));
        Arc::new(Inner {
            inbox,
            demo: AtomicBool::new(false),
            path,
            store: Mutex::new(store),
            listener: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            replay: Mutex::new(ReplayGuard::default()),
            rate: Mutex::new(HashMap::new()),
            in_flight: AtomicUsize::new(0),
            next_id: AtomicU64::new(1),
            error: Mutex::new(None),
            last_progress: Mutex::new(None),
        })
    }

    /// An upload moved: the desktop's "Receiving…" line refreshes, at most
    /// once a second.
    fn inbox_progress(&self, host: &dyn Host) {
        let mut last = lock(&self.last_progress);
        if last.is_some_and(|t| t.elapsed() < INBOX_EVENT_EVERY) {
            return;
        }
        *last = Some(Instant::now());
        drop(last);
        host.inbox_changed();
    }

    fn save(&self, file: &SyncFile) -> Result<(), String> {
        write_store(&self.path, file)
    }

    fn device(&self, id: &str) -> Option<StoredDevice> {
        lock(&self.store).devices.iter().find(|d| d.id == id).cloned()
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
                    if inner.in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
                        inner.in_flight.fetch_sub(1, Ordering::SeqCst);
                        let _ = request.respond(tiny_http::Response::empty(503));
                        continue;
                    }
                    let worker = inner.clone();
                    let host = host.clone();
                    let spawned = std::thread::Builder::new().name("phone-sync-req".into()).spawn(move || {
                        handle(&worker, host.as_ref(), request);
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

fn handle(inner: &Arc<Inner>, host: &dyn Host, mut req: tiny_http::Request) {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let method = req.method().clone();
    let outcome = match (&method, path.as_str()) {
        (tiny_http::Method::Get, "/v1/ping") => {
            let _ = req.respond(json_response(200, &json!({ "app": "hivo", "v": 1 })));
            return;
        }
        (tiny_http::Method::Post, p) if p == "/v1/hello" || FORWARDED.contains(&p) || INBOX_PATHS.contains(&p) => {
            let device = header(&req, "X-Hivo-Device").map(str::to_string);
            let too_big = req.body_length().is_some_and(|n| n > MAX_BODY_BYTES);
            if too_big {
                Outcome::Status(413)
            } else {
                let mut body = Vec::new();
                match req.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut body) {
                    Err(_) => Outcome::Status(400),
                    Ok(_) if body.len() > MAX_BODY_BYTES => Outcome::Status(413),
                    Ok(_) => handle_sealed(inner, host, &path, device.as_deref(), &body),
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
    let Some(device) = inner.device(device_id) else { return Outcome::Status(401) };
    let Some(key) = device.key_bytes() else { return Outcome::Status(401) };
    let Ok(env) = serde_json::from_slice::<Envelope>(body) else { return Outcome::Status(401) };
    let Some(plain) = open(&key, &aad(device_id, path), &env) else { return Outcome::Status(401) };
    // Authenticated from here on: errors are answered sealed, never as a
    // bare 401 (which the phone reads as "this computer forgot me").
    let Ok(sealed) = serde_json::from_slice::<SealedRequest>(&plain) else {
        return sealed_answer(&key, device_id, path, Err("bad request".to_string()));
    };
    let checked = lock(&inner.replay).check(device_id, &sealed.nonce, sealed.ts, now_ms());
    match checked {
        Ok(()) => {}
        // Replays stay refused without a word.
        Err(Reject::Replayed) => return Outcome::Status(401),
        // The phone's clock is more than TS_WINDOW_MS off this computer's.
        Err(Reject::Stale) => return sealed_answer(&key, device_id, path, Err("clock".to_string())),
        Err(Reject::BadNonce) => return sealed_answer(&key, device_id, path, Err("bad request".to_string())),
        Err(Reject::Full) => return sealed_answer(&key, device_id, path, Err("busy".to_string())),
    }
    if !inner.allow_rate(device_id) {
        return Outcome::Status(429);
    }

    let answer: Reply = match path {
        "/v1/hello" => {
            let name = sealed.body.get("phoneName").and_then(Value::as_str).map(|s| clip(s, MAX_PHONE_NAME)).filter(|s| !s.is_empty());
            let version = sealed.body.get("appVersion").and_then(Value::as_str).map(|s| clip(s, 20)).filter(|s| !s.is_empty());
            inner.touch(device_id, Some(name.unwrap_or_else(|| "Phone".to_string())), version);
            Ok(json!({ "desktopName": host.desktop_name(), "hivoVersion": host.hivo_version() }))
        }
        p if INBOX_PATHS.contains(&p) => {
            inner.touch(device_id, None, None);
            let phone = device.name.clone().unwrap_or_else(|| "Phone".to_string());
            answer_inbox(inner, host, p, device_id, &phone, &sealed.body)
        }
        p if FORWARDED.contains(&p) => {
            inner.touch(device_id, None, None);
            match check_payload(p, &sealed.body) {
                Err(e) => Err(e),
                Ok(()) => {
                    let phone = device.name.clone().unwrap_or_else(|| "Phone".to_string());
                    inner.forward(host, p, sealed.body, phone)
                }
            }
        }
        _ => return Outcome::Status(404),
    };
    sealed_answer(&key, device_id, path, answer)
}

/// `{"ok": true, "body"}` or `{"ok": false, "error"}`, sealed for the device.
fn sealed_answer(key: &[u8; 32], device_id: &str, path: &str, answer: Reply) -> Outcome {
    let plaintext = match answer {
        Ok(body) => json!({ "ok": true, "body": body }),
        Err(e) => json!({ "ok": false, "error": clip(&e, MAX_ERROR_CHARS) }),
    };
    let bytes = serde_json::to_vec(&plaintext).unwrap_or_default();
    match seal(key, &aad(device_id, &resp_path(path)), &bytes) {
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
    match path {
        "/v1/ideas" => {
            let r = inner.inbox.push_ideas(device_id, phone, body, now);
            if r.is_ok() {
                host.inbox_changed();
            }
            r
        }
        "/v1/upload/start" => inner.inbox.upload_start(device_id, phone, body, now).inspect(|_| inner.inbox_progress(host)),
        "/v1/upload/chunk" => inner.inbox.upload_chunk(device_id, body).inspect(|_| inner.inbox_progress(host)),
        "/v1/upload/finish" => inner.inbox.upload_finish(device_id, body, now).map(|(v, ready)| {
            if ready {
                host.inbox_changed();
            } else {
                inner.inbox_progress(host);
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

fn status_of(inner: &Inner) -> PhoneSyncStatus {
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
                id: d.id,
                name: d.name,
                app_version: d.app_version,
                paired_at_ms: d.paired_at_ms,
                last_seen_ms: d.last_seen_ms,
            })
            .collect(),
        error: lock(&inner.error).clone(),
    }
}

fn state_inner(app: &AppHandle) -> Result<Arc<Inner>, String> {
    app.try_state::<PhoneSync>().map(|s| s.0.clone()).ok_or_else(|| "Phone sync isn't available (no config folder).".to_string())
}

#[tauri::command]
pub fn phone_sync_status(app: AppHandle) -> Result<PhoneSyncStatus, String> {
    let inner = state_inner(&app)?;
    Ok(status_of(&inner))
}

#[tauri::command]
pub fn phone_sync_enable(app: AppHandle, on: bool) -> Result<PhoneSyncStatus, String> {
    let inner = state_inner(&app)?;
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
    Ok(status_of(&inner))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub device_id: String,
    /// The QR payload. Holds the key: shown once, never returned again.
    pub url: String,
}

#[tauri::command]
pub fn phone_sync_pair(app: AppHandle) -> Result<Pairing, String> {
    let inner = state_inner(&app)?;
    let Some(port) = inner.port() else {
        return Err("Turn phone sync on first.".to_string());
    };
    let hosts = lan_addresses();
    if hosts.is_empty() {
        return Err("No local network address found. Connect this computer to Wi-Fi (or a local network) first.".to_string());
    }
    let mut store = lock(&inner.store);
    let device = add_device(&mut store, now_ms())?;
    if let Some(d) = store.devices.iter_mut().find(|d| d.id == device.id) {
        d.paired_port = Some(port);
    }
    let snapshot = store.clone();
    drop(store);
    inner.save(&snapshot)?;
    Ok(Pairing { url: pairing_url(&device.id, &device.key, &hosts, port, &desktop_name()), device_id: device.id })
}

/// "Re-pair this phone" (the port or the address changed): a new QR for the
/// same device, which replaces it in place.
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
    let mut store = lock(&inner.store);
    let device = repair_device(&mut store, &device_id, port, now_ms())?;
    let snapshot = store.clone();
    drop(store);
    inner.save(&snapshot)?;
    Ok(Pairing { url: pairing_url(&device.id, &device.key, &hosts, port, &desktop_name()), device_id: device.id })
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
    Ok(status_of(&inner))
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
fn song_folder(scope: &crate::scope::Scope, key: &str) -> Result<PathBuf, String> {
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
        // Missing or broken file = defaults.
        fs::write(&path, "not json").unwrap();
        assert_eq!(read_store(&path), SyncFile::default());
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
        // Re-pair: same id and name, a new key, the new port, not seen yet.
        let before = f.devices[0].clone();
        let r = repair_device(&mut f, &a.id, 52000, 9).unwrap();
        assert_eq!((r.id.as_str(), r.name.as_deref(), r.paired_port, r.last_seen_ms), (a.id.as_str(), Some("Pixel"), Some(52000), None));
        assert_ne!(r.key, before.key);
        assert_eq!(f.devices.len(), 1);
        assert!(repair_device(&mut f, "nobody", 1, 1).is_err());
        // A new port again: an already-recorded port isn't overwritten.
        assert!(note_port(&mut f, 53000));
        assert_eq!(f.devices[0].paired_port, Some(52000));
    }

    #[test]
    fn pairing_url_format() {
        let hosts = [Ipv4Addr::new(192, 168, 1, 20), Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(10, 0, 0, 5)];
        let url = pairing_url("AAAAAAAAAAAAAAAAAAAAAA", "a-b_c", &hosts, 51234, "Studio Mac é");
        assert_eq!(url, "hivo://pair?v=1&d=AAAAAAAAAAAAAAAAAAAAAA&k=a-b_c&h=192.168.1.20,10.0.0.5&p=51234&n=Studio%20Mac%20%C3%A9");
        let mut f = SyncFile::default();
        let d = add_device(&mut f, 1).unwrap();
        let url = pairing_url(&d.id, &d.key, &hosts[..1], 1, "x");
        assert!(!url.contains('=') || url.matches('=').count() == 6, "no padding: {url}");
        assert!(!d.key.contains(['=', '+', '/']));
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
        assert_eq!(open_reply(&dev, "/v1/hello", &b), json!({ "ok": true, "body": { "desktopName": "Test desk", "hivoVersion": "0.5.5" } }));
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
            }];
        }
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
        stop(&inner);
        assert!(dir.join("stop").exists(), "the phone test never finished");
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
