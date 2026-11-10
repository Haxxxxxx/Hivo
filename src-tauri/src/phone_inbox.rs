//! The phone inbox (phase B step 4, docs/PHONE-SYNC.md v1.1): ideas, voice
//! memos and sketches (BandLab exports) sent by paired phones.
//!
//! Rust owns it: `<config dir>/phone-inbox/index.json` plus one folder of
//! files per item under `files/`. Nothing here is in workspace.json, and
//! nothing lands in a project folder until the user files it (a sketch
//! becomes `<project folder>/<name>/BandLab/`, a memo attached to a song is
//! copied to `<song folder>/Voice memos/`). Uploads come in chunks, each one
//! an ordinary sealed request, so every byte is authenticated; the offset of
//! a file is the length of its `.part` file, which makes resuming free.

use crate::error::app_err;
use crate::actions::validate_name;
use crate::phone_sync::StoreProblem;
use crate::sketch::{is_sketch_audio, SKETCH_DIR};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

// ---- Limits (paired with mobile/src/lib/outbox.ts) ----

pub const MAX_FILE_BYTES: u64 = 500 * 1024 * 1024;
pub const MAX_ITEM_FILES: usize = 20;
pub const MAX_CHUNK_BYTES: usize = 393_216;
pub const MAX_INBOX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_IDEAS_PER_PUSH: usize = 200;
pub const MAX_TITLE_CHARS: usize = 200;
/// What was shared with an upload (BandLab's words and link); same as the
/// phone's `MAX_SHARE_TEXT` (src/lib/shareMeta.ts).
pub const MAX_SHARE_TEXT_CHARS: usize = 2000;
/// Same as `MAX_NOTE_CHARS` (an idea's text ends up in a note).
pub const MAX_IDEA_CHARS: usize = crate::phone_sync::MAX_NOTE_CHARS;
pub const MAX_MEMO_MS: i64 = 15 * 60 * 1000;
/// At most this many items of any kind; older filed/dismissed ones go first.
const MAX_ITEMS: usize = 5_000;
/// Unfinished uploads are dropped after this.
const PARTIAL_TTL_MS: i64 = 7 * 24 * 3600 * 1000;
/// Unpacked audio from one sketch's zips, at most.
pub const MAX_UNZIP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ID_CHARS: usize = 64;
pub const MEMOS_DIR: &str = "Voice memos";
/// Where a memo linked to a beat or a saved prod is copied, inside the
/// beats folder (next to `_leads`), so removing it from the inbox never
/// deletes its only copy.
pub const BEAT_MEMOS_DIR: &str = "_memos";
/// Stems unpacked from a zip that came with a mixdown go here, inside the
/// sketch's BandLab folder: the mixdown stays the song's render, and
/// "Continue in FL Studio" lays out the stems only (sketch.rs).
pub const STEMS_DIR: &str = "Stems";
/// How often the running app drops unfinished uploads past `PARTIAL_TTL_MS`.
pub const SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(3600);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(max).collect()
}

fn clip_line(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// The contract's answer for a chunk/finish without a start, or an item
/// this computer dropped: the phone sends the whole item again.
pub const UNKNOWN_UPLOAD: &str = "unknown upload";

/// While uploading: a file or folder that vanished (the item was removed on
/// the desktop between the lookup and the write) is "unknown upload", so the
/// phone starts the item again instead of failing it.
fn upload_io_error(e: &io::Error, what: &str) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        UNKNOWN_UPLOAD.to_string()
    } else {
        io_error(e, what)
    }
}

/// "disk full" when the disk refused the write, else a short message.
pub fn io_error(e: &io::Error, what: &str) -> String {
    let enospc = matches!(e.raw_os_error(), Some(28) if cfg!(unix)) || matches!(e.raw_os_error(), Some(112) if cfg!(windows));
    if e.kind() == io::ErrorKind::StorageFull || enospc {
        "disk full".to_string()
    } else {
        format!("{what}: {e}")
    }
}

/// `io_error` for the desktop's filing commands: a coded error (the
/// webview translates it). Upload errors stay plain: they're the phone's
/// protocol (docs/PHONE-SYNC.md).
fn desk_io(e: &io::Error, what: &str) -> String {
    let plain = io_error(e, what);
    if plain == "disk full" {
        app_err("io.diskFull", plain).into()
    } else {
        app_err("inbox.io", plain).into()
    }
}

// ---- Model ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Idea,
    Memo,
    Sketch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    New,
    Filed,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub title: String,
}

fn parse_target(v: Option<&Value>) -> Option<Target> {
    let v = v?;
    let kind = v.get("kind")?.as_str()?;
    let id = v.get("id")?.as_str()?;
    if !matches!(kind, "prod" | "beat" | "song") || id.is_empty() || id.len() > 4096 {
        return None;
    }
    let title = v.get("title").and_then(Value::as_str).map(|t| clip_line(t, MAX_TITLE_CHARS)).unwrap_or_default();
    Some(Target { kind: kind.to_string(), id: id.to_string(), title })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSlot {
    pub index: usize,
    /// The phone's file name, cleaned.
    pub name: String,
    pub size: u64,
    /// The file's name inside the item's folder.
    pub stored: String,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// `<deviceId>.<itemId>`: unique across phones, safe as a folder name.
    pub id: String,
    pub item_id: String,
    pub device_id: String,
    pub phone_name: String,
    pub item_type: ItemType,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub target: Option<Target>,
    pub created_at: i64,
    pub updated_at: i64,
    /// When the last file arrived (ideas: when first stored).
    #[serde(default)]
    pub received_at: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub file_count: usize,
    #[serde(default)]
    pub files: Vec<FileSlot>,
    pub status: Status,
    #[serde(default)]
    pub filed_to: Option<String>,
    #[serde(default)]
    pub filed_at: Option<i64>,
    /// How it was filed: "song" (a new sketch song), "folder" (copied into
    /// a song's folder), "link" (a memo linked to a beat or a prod, copied
    /// into the beats folder's `_memos`). None for items filed before this
    /// was recorded.
    #[serde(default)]
    pub filed_as: Option<String>,
    /// The durable copy of a memo linked to a beat or a prod.
    #[serde(default)]
    pub copied_to: Option<String>,
}

impl InboxItem {
    /// Ideas always; memos and sketches once every file is in.
    pub fn ready(&self) -> bool {
        self.item_type == ItemType::Idea || (self.files.len() == self.file_count && self.files.iter().all(|f| f.complete))
    }

    fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct IndexFile {
    #[serde(default)]
    items: Vec<InboxItem>,
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID_CHARS && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn ext_of(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn allowed(item_type: ItemType, name: &str) -> bool {
    let audio = is_sketch_audio(Path::new(name));
    match item_type {
        ItemType::Memo => audio,
        ItemType::Sketch => audio || ext_of(name) == "zip",
        ItemType::Idea => false,
    }
}

/// `NN-<clean name>`: unique in the item's folder, keeps the extension.
fn stored_name(index: usize, name: &str) -> String {
    let clean = crate::audio::safe_name(name);
    let clean: String = clean.chars().take(120).collect();
    format!("{index:02}-{clean}")
}

// ---- The store ----

/// The index, or an empty one when there's no file. Like `phone-sync.json`
/// (`phone_sync::load_store`): a file that can't be read is left alone and
/// blocks saving; one that doesn't parse is kept as `index.json.bad-<ms>`
/// (never over an older one) and the inbox starts empty.
fn load_index(path: &Path) -> (IndexFile, Option<StoreProblem>) {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return (IndexFile::default(), None),
        Err(e) => {
            let detail = format!("The phone inbox (phone-inbox/index.json) can't be read right now ({e}). Nothing is saved over it: fix that and restart Hivo.");
            let message = app_err("phone.inboxUnreadable", detail).with("reason", e.to_string()).into();
            return (IndexFile::default(), Some(StoreProblem { message, blocks_saving: true }));
        }
    };
    let parse = match serde_json::from_slice(&raw) {
        Ok(index) => return (index, None),
        Err(e) => e,
    };
    let bad = crate::workspace::bad_path(path);
    let problem = match fs::rename(path, &bad) {
        Ok(()) => {
            let kept = bad.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let detail = format!("The phone inbox couldn't be read ({parse}), so it starts empty. The old list is kept as {kept} in Hivo's settings folder (phone-inbox).");
            StoreProblem { message: app_err("phone.inboxReset", detail).with("reason", parse.to_string()).with("name", kept).into(), blocks_saving: false }
        }
        Err(e) => {
            let detail = format!("The phone inbox couldn't be read ({parse}) or moved aside ({e}). Nothing is saved over it: fix that and restart Hivo.");
            StoreProblem { message: app_err("phone.inboxStuck", detail).with("reason", format!("{parse}; {e}")).into(), blocks_saving: true }
        }
    };
    (IndexFile::default(), Some(problem))
}

pub struct Inbox {
    root: PathBuf,
    items: Mutex<Vec<InboxItem>>,
    /// Taken before `items` for every write of the index (`persist`): the
    /// snapshot is cloned and written under it, so an older snapshot from
    /// another request thread never lands after a newer one.
    save_lock: Mutex<()>,
    /// What went wrong reading `index.json` at launch (`load_index`), shown
    /// in Settings → Phone sync until a save works.
    problem: Mutex<Option<StoreProblem>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a phone gets back: a body, or a short error from the contract.
pub type Answer = Result<Value, String>;

impl Inbox {
    /// Reads the index (nothing is created until the first write) and drops
    /// uploads older than a week that never finished.
    pub fn open(root: PathBuf) -> Inbox {
        let (index, problem) = load_index(&root.join("index.json"));
        if let Some(p) = &problem {
            eprintln!("phone inbox: {}", crate::error::detail_of(&p.message));
        }
        let inbox = Inbox { root, items: Mutex::new(index.items), save_lock: Mutex::new(()), problem: Mutex::new(problem) };
        inbox.drop_stale(now_ms());
        inbox
    }

    /// The index problem found at launch, while no save has worked since.
    pub fn problem(&self) -> Option<String> {
        lock(&self.problem).as_ref().map(|p| p.message.clone())
    }

    pub fn files_dir(&self) -> PathBuf {
        self.root.join("files")
    }

    fn item_dir(&self, id: &str) -> PathBuf {
        self.files_dir().join(id)
    }

    /// Writes the current items. Callers drop their `items` guard first (lock
    /// order: `save_lock`, then `items`).
    fn persist(&self) -> Result<(), String> {
        let _writing = lock(&self.save_lock);
        let snapshot = lock(&self.items).clone();
        self.save(&snapshot)
    }

    fn save(&self, items: &[InboxItem]) -> Result<(), String> {
        let mut problem = lock(&self.problem);
        // Plain, like the other save errors (they reach phones too).
        if let Some(p) = problem.as_ref().filter(|p| p.blocks_saving) {
            return Err(crate::error::detail_of(&p.message));
        }
        fs::create_dir_all(&self.root).map_err(|e| io_error(&e, "could not create the phone inbox"))?;
        let raw = serde_json::to_vec(&IndexFile { items: items.to_vec() }).map_err(|e| e.to_string())?;
        crate::cover::write_private(&self.root.join("index.json"), &raw).map_err(|e| io_error(&e, "could not save the phone inbox"))?;
        *problem = None;
        Ok(())
    }

    /// Drops uploads that haven't moved for `PARTIAL_TTL_MS` (at start and
    /// every `SWEEP_EVERY` while the app runs, see `sweep_every`). True when
    /// something was dropped.
    pub fn drop_stale(&self, now: i64) -> bool {
        let mut items = lock(&self.items);
        let before = items.len();
        let stale: Vec<String> = items.iter().filter(|i| !i.ready() && now - i.updated_at > PARTIAL_TTL_MS).map(|i| i.id.clone()).collect();
        for id in &stale {
            let _ = fs::remove_dir_all(self.item_dir(id));
        }
        items.retain(|i| !stale.contains(&i.id));
        if items.len() == before {
            return false;
        }
        drop(items);
        let _ = self.persist();
        true
    }

    fn used_bytes(items: &[InboxItem]) -> u64 {
        items.iter().map(InboxItem::bytes).sum()
    }

    /// Over the byte quota with `need` more: drops the oldest filed sketches
    /// (BandLab exports already copied into their own song folder, the big
    /// ones), never `keep`. Memos stay: the drawer and the beat panels list
    /// them from this index. Without it the quota only ever filled: "inbox
    /// full" after a few dozen exports (review 2026-11-10).
    fn free_copied(&self, items: &mut Vec<InboxItem>, keep: &str, need: u64) {
        while Self::used_bytes(items) + need > MAX_INBOX_BYTES {
            let Some(pos) = items
                .iter()
                .enumerate()
                .filter(|(_, i)| i.id != keep && i.status == Status::Filed && i.filed_as.as_deref() == Some("song"))
                .min_by_key(|(_, i)| i.filed_at.unwrap_or(i.updated_at))
                .map(|(p, _)| p)
            else {
                return;
            };
            let gone = items.remove(pos);
            let _ = fs::remove_dir_all(self.item_dir(&gone.id));
        }
    }

    /// Makes room for one more item: drops the oldest filed/dismissed ones.
    fn make_room(&self, items: &mut Vec<InboxItem>) {
        while items.len() >= MAX_ITEMS {
            let Some(pos) = items.iter().enumerate().filter(|(_, i)| i.status != Status::New).min_by_key(|(_, i)| i.filed_at.unwrap_or(i.updated_at)).map(|(p, _)| p) else {
                return;
            };
            let gone = items.remove(pos);
            let _ = fs::remove_dir_all(self.item_dir(&gone.id));
        }
    }

    // ---- Phone endpoints ----

    /// `/v1/ideas`.
    pub fn push_ideas(&self, device_id: &str, phone_name: &str, body: &Value, now: i64) -> Answer {
        let list = body.get("ideas").and_then(Value::as_array).ok_or("bad request")?;
        if list.len() > MAX_IDEAS_PER_PUSH {
            return Err("too big".to_string());
        }
        let mut items = lock(&self.items);
        let mut results = Vec::new();
        let mut changed = false;
        for raw in list {
            let item_id = raw.get("id").and_then(Value::as_str).filter(|s| valid_id(s)).ok_or("bad request")?;
            let id = format!("{device_id}.{item_id}");
            let updated_at = raw.get("updatedAt").and_then(Value::as_i64).unwrap_or(now);
            let deleted = raw.get("deleted").and_then(Value::as_bool).unwrap_or(false);
            let title = clip_line(raw.get("title").and_then(Value::as_str).unwrap_or(""), MAX_TITLE_CHARS);
            let text = clip(raw.get("text").and_then(Value::as_str).unwrap_or(""), MAX_IDEA_CHARS);
            let pos = items.iter().position(|i| i.id == id);
            if let Some(p) = pos {
                if items[p].item_type != ItemType::Idea {
                    return Err("bad request".to_string());
                }
                let it = &items[p];
                if it.status != Status::New {
                    results.push(json!({ "id": item_id, "status": status_word(it.status), "filedTo": it.filed_to }));
                    continue;
                }
                if deleted {
                    items.remove(p);
                    changed = true;
                    results.push(json!({ "id": item_id, "status": "deleted", "filedTo": null }));
                    continue;
                }
                if updated_at > items[p].updated_at {
                    let it = &mut items[p];
                    it.title = title;
                    it.text = text;
                    it.target = parse_target(raw.get("target"));
                    it.updated_at = updated_at;
                    it.phone_name = phone_name.to_string();
                    changed = true;
                }
                results.push(json!({ "id": item_id, "status": "stored", "filedTo": null }));
                continue;
            }
            if deleted || (title.is_empty() && text.trim().is_empty()) {
                results.push(json!({ "id": item_id, "status": "deleted", "filedTo": null }));
                continue;
            }
            self.make_room(&mut items);
            items.push(InboxItem {
                id,
                item_id: item_id.to_string(),
                device_id: device_id.to_string(),
                phone_name: phone_name.to_string(),
                item_type: ItemType::Idea,
                title,
                text,
                target: parse_target(raw.get("target")),
                created_at: raw.get("createdAt").and_then(Value::as_i64).unwrap_or(now),
                updated_at,
                received_at: Some(now),
                duration_ms: None,
                file_count: 0,
                files: Vec::new(),
                status: Status::New,
                filed_to: None,
                filed_at: None,
                filed_as: None,
                copied_to: None,
            });
            changed = true;
            results.push(json!({ "id": item_id, "status": "stored", "filedTo": null }));
        }
        if changed {
            drop(items);
            self.persist()?;
        }
        Ok(json!({ "results": results }))
    }

    /// `/v1/upload/start`: creates or resumes one file of an item.
    pub fn upload_start(&self, device_id: &str, phone_name: &str, body: &Value, now: i64) -> Answer {
        let item_id = body.get("itemId").and_then(Value::as_str).filter(|s| valid_id(s)).ok_or("bad request")?;
        let item_type = match body.get("itemType").and_then(Value::as_str) {
            Some("memo") => ItemType::Memo,
            Some("sketch") => ItemType::Sketch,
            _ => return Err("bad request".to_string()),
        };
        let file_count = body.get("fileCount").and_then(Value::as_u64).ok_or("bad request")? as usize;
        let index = body.get("fileIndex").and_then(Value::as_u64).ok_or("bad request")? as usize;
        let size = body.get("size").and_then(Value::as_u64).ok_or("bad request")?;
        let name = clip_line(body.get("name").and_then(Value::as_str).unwrap_or(""), 200);
        if file_count == 0 || index >= file_count || name.is_empty() {
            return Err("bad request".to_string());
        }
        if file_count > MAX_ITEM_FILES || (item_type == ItemType::Memo && file_count != 1) || size > MAX_FILE_BYTES {
            return Err("too big".to_string());
        }
        if size == 0 {
            return Err("size".to_string());
        }
        if !allowed(item_type, &name) {
            return Err("type".to_string());
        }
        let duration_ms = body.get("durationMs").and_then(Value::as_i64).map(|d| d.clamp(0, MAX_MEMO_MS));
        let id = format!("{device_id}.{item_id}");
        let mut items = lock(&self.items);
        self.free_copied(&mut items, &id, size);
        let pos = match items.iter().position(|i| i.id == id) {
            Some(p) => {
                if items[p].item_type != item_type || items[p].file_count != file_count {
                    return Err("bad request".to_string());
                }
                p
            }
            // A later file of an item this computer doesn't know (removed here,
            // or dropped after 7 days): the phone sends it all again from file
            // 0, or the item could never become ready.
            None if index > 0 => return Err(UNKNOWN_UPLOAD.to_string()),
            None => {
                if Self::used_bytes(&items) + size > MAX_INBOX_BYTES {
                    return Err("inbox full".to_string());
                }
                self.make_room(&mut items);
                items.push(InboxItem {
                    id: id.clone(),
                    item_id: item_id.to_string(),
                    device_id: device_id.to_string(),
                    phone_name: phone_name.to_string(),
                    item_type,
                    title: clip_line(body.get("title").and_then(Value::as_str).unwrap_or(""), MAX_TITLE_CHARS),
                    // Optional (v1.1+): older phones send none.
                    text: clip(body.get("text").and_then(Value::as_str).unwrap_or(""), MAX_SHARE_TEXT_CHARS),
                    target: parse_target(body.get("target")),
                    created_at: body.get("createdAt").and_then(Value::as_i64).unwrap_or(now),
                    updated_at: now,
                    received_at: None,
                    duration_ms,
                    file_count,
                    files: Vec::new(),
                    status: Status::New,
                    filed_to: None,
                    filed_at: None,
                    filed_as: None,
                    copied_to: None,
                });
                items.len() - 1
            }
        };
        let dir = self.item_dir(&id);
        let item = &mut items[pos];
        item.updated_at = now;
        let offset = match item.files.iter().position(|f| f.index == index) {
            Some(s) if item.files[s].size == size => {
                let slot = &item.files[s];
                if slot.complete {
                    size
                } else {
                    part_len(&dir, slot).min(size)
                }
            }
            existing => {
                // New file, or the same index with another size: start over.
                if let Some(s) = existing {
                    let old = item.files.remove(s);
                    let _ = fs::remove_file(dir.join(&old.stored));
                    let _ = fs::remove_file(part_path(&dir, &old));
                }
                let others: u64 = items.iter().filter(|i| i.id != id).map(InboxItem::bytes).sum::<u64>() + items[pos].bytes();
                if others + size > MAX_INBOX_BYTES {
                    return Err("inbox full".to_string());
                }
                fs::create_dir_all(&dir).map_err(|e| upload_io_error(&e, "could not create the item folder"))?;
                let slot = FileSlot { index, name: name.clone(), size, stored: stored_name(index, &name), complete: false };
                fs::File::create(part_path(&dir, &slot)).map_err(|e| upload_io_error(&e, "could not start the file"))?;
                items[pos].files.push(slot);
                0
            }
        };
        drop(items);
        self.persist()?;
        Ok(json!({ "offset": offset }))
    }

    /// `/v1/upload/chunk`: appends at the current offset only.
    pub fn upload_chunk(&self, device_id: &str, body: &Value) -> Answer {
        let item_id = body.get("itemId").and_then(Value::as_str).filter(|s| valid_id(s)).ok_or("bad request")?;
        let index = body.get("fileIndex").and_then(Value::as_u64).ok_or("bad request")? as usize;
        let offset = body.get("offset").and_then(Value::as_u64).ok_or("bad request")?;
        let data = body.get("data").and_then(Value::as_str).ok_or("bad request")?;
        if data.len() > MAX_CHUNK_BYTES.div_ceil(3) * 4 + 4 {
            return Err("too big".to_string());
        }
        let bytes = B64.decode(data.as_bytes()).map_err(|_| "bad request".to_string())?;
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err("too big".to_string());
        }
        let id = format!("{device_id}.{item_id}");
        // Hold the lock while writing: chunks of one file never interleave.
        let items = lock(&self.items);
        let item = items.iter().find(|i| i.id == id).ok_or("unknown upload")?;
        let slot = item.files.iter().find(|f| f.index == index).ok_or("unknown upload")?;
        if slot.complete {
            return Ok(json!({ "offset": slot.size }));
        }
        let dir = self.item_dir(&id);
        let path = part_path(&dir, slot);
        if !path.is_file() {
            return Err("unknown upload".to_string());
        }
        let current = part_len(&dir, slot);
        if offset != current {
            return Err(format!("offset:{current}"));
        }
        if current + bytes.len() as u64 > slot.size {
            return Err("size".to_string());
        }
        let mut f = fs::OpenOptions::new().append(true).open(&path).map_err(|e| upload_io_error(&e, "could not write the file"))?;
        f.write_all(&bytes).map_err(|e| upload_io_error(&e, "could not write the file"))?;
        Ok(json!({ "offset": current + bytes.len() as u64 }))
    }

    /// `/v1/upload/finish`: checks the size; the item is ready when all files are in.
    /// Returns the answer and whether the item just became ready.
    pub fn upload_finish(&self, device_id: &str, body: &Value, now: i64) -> Result<(Value, bool), String> {
        let item_id = body.get("itemId").and_then(Value::as_str).filter(|s| valid_id(s)).ok_or("bad request")?;
        let index = body.get("fileIndex").and_then(Value::as_u64).ok_or("bad request")? as usize;
        let id = format!("{device_id}.{item_id}");
        let mut items = lock(&self.items);
        let pos = items.iter().position(|i| i.id == id).ok_or("unknown upload")?;
        let dir = self.item_dir(&id);
        let s = items[pos].files.iter().position(|f| f.index == index).ok_or("unknown upload")?;
        let was_ready = items[pos].ready();
        if !items[pos].files[s].complete {
            let slot = items[pos].files[s].clone();
            let part = part_path(&dir, &slot);
            if !part.is_file() {
                return Err("unknown upload".to_string());
            }
            if part_len(&dir, &slot) != slot.size {
                // Start that file again from zero.
                let _ = fs::File::create(&part);
                return Err("size".to_string());
            }
            fs::rename(&part, dir.join(&slot.stored)).map_err(|e| upload_io_error(&e, "could not keep the file"))?;
            items[pos].files[s].complete = true;
        }
        let item = &mut items[pos];
        item.updated_at = now;
        let ready = item.ready();
        if ready && item.received_at.is_none() {
            item.received_at = Some(now);
        }
        let received = item.files.iter().filter(|f| f.complete).count();
        let of = item.file_count;
        drop(items);
        self.persist()?;
        Ok((json!({ "status": if ready { "stored" } else { "waiting" }, "received": received, "of": of }), ready && !was_ready))
    }

    /// `/v1/inbox`: what this phone sent that's still here.
    pub fn status_for(&self, device_id: &str) -> Value {
        let items = lock(&self.items);
        let list: Vec<Value> = items
            .iter()
            .filter(|i| i.device_id == device_id && i.ready())
            .map(|i| json!({ "id": i.item_id, "type": i.item_type, "status": i.status, "filedTo": i.filed_to }))
            .collect();
        json!({ "items": list })
    }

    // ---- Desktop side ----

    /// Every finished item, newest first, with its files' absolute paths
    /// (for playback) and whether each is still on disk.
    pub fn list(&self) -> Vec<InboxView> {
        let items = lock(&self.items);
        let mut out: Vec<InboxView> = items
            .iter()
            .filter(|i| i.ready())
            .map(|i| {
                let dir = self.item_dir(&i.id);
                InboxView {
                    files: i
                        .files
                        .iter()
                        .map(|f| {
                            let path = dir.join(&f.stored);
                            FileView { name: f.name.clone(), size: f.size, missing: !path.is_file(), path: path.to_string_lossy().to_string() }
                        })
                        .collect(),
                    item: i.clone(),
                }
            })
            .collect();
        out.sort_by_key(|v| std::cmp::Reverse(v.item.received_at.unwrap_or(v.item.created_at)));
        out
    }

    /// How many items are still arriving.
    pub fn receiving(&self) -> usize {
        lock(&self.items).iter().filter(|i| !i.ready()).count()
    }

    /// The items still arriving, most recently active first, with how far
    /// they got. They hold space in the quota, so the desktop lists them
    /// and can remove them (`remove`).
    pub fn incoming(&self) -> Vec<IncomingView> {
        let items = lock(&self.items);
        let mut out: Vec<IncomingView> = items
            .iter()
            .filter(|i| !i.ready())
            .map(|i| {
                let dir = self.item_dir(&i.id);
                IncomingView {
                    id: i.id.clone(),
                    item_type: i.item_type,
                    title: i.title.clone(),
                    phone_name: i.phone_name.clone(),
                    file_count: i.file_count,
                    files_done: i.files.iter().filter(|f| f.complete).count(),
                    received_bytes: i.files.iter().map(|f| if f.complete { f.size } else { part_len(&dir, f).min(f.size) }).sum(),
                    total_bytes: i.bytes(),
                    updated_at: i.updated_at,
                }
            })
            .collect();
        out.sort_by_key(|v| std::cmp::Reverse(v.updated_at));
        out
    }

    fn get_ready(&self, id: &str) -> Result<InboxItem, String> {
        lock(&self.items).iter().find(|i| i.id == id && i.ready()).cloned().ok_or_else(gone)
    }

    /// Each file's path in the inbox and its name on the phone, in order.
    fn file_paths(&self, item: &InboxItem) -> Result<Vec<(PathBuf, String)>, String> {
        let dir = self.item_dir(&item.id);
        let mut files = item.files.clone();
        files.sort_by_key(|f| f.index);
        files
            .iter()
            .map(|f| {
                let p = dir.join(&f.stored);
                if p.is_file() {
                    Ok((p, f.name.clone()))
                } else {
                    Err(app_err("inbox.fileMissing", format!("file missing: {}", f.name)).with("name", f.name.as_str()).into())
                }
            })
            .collect()
    }

    /// Sets the status (filed somewhere, dismissed, or back to new).
    pub fn mark(&self, id: &str, status: Status, filed_to: Option<String>) -> Result<(), String> {
        let mut items = lock(&self.items);
        let item = items.iter_mut().find(|i| i.id == id).ok_or_else(gone)?;
        item.status = status;
        item.filed_to = if status == Status::Filed { filed_to.map(|f| clip_line(&f, 4096)) } else { None };
        item.filed_at = if status == Status::New { None } else { Some(now_ms()) };
        if status != Status::Filed {
            item.filed_as = None;
        }
        drop(items);
        self.persist()
    }

    /// Files an item in two steps that can't leave it half done: it's marked
    /// filed (and saved) first, then `work` copies; when `work` fails, the
    /// item gets its old status back. A retry never copies twice, and an
    /// index that can't be saved stops before anything is copied.
    fn filing<T>(&self, id: &str, filed_to: &str, filed_as: &str, copied_to: Option<String>, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let before = {
            let mut items = lock(&self.items);
            let item = items.iter_mut().find(|i| i.id == id).ok_or_else(gone)?;
            let before = item.clone();
            item.status = Status::Filed;
            item.filed_to = Some(clip_line(filed_to, 4096));
            item.filed_at = Some(now_ms());
            item.filed_as = Some(filed_as.to_string());
            // Where this filing copies to (None: the copy is `filed_to` itself).
            item.copied_to = copied_to;
            drop(items);
            if let Err(e) = self.persist() {
                self.put_back(before);
                return Err(e);
            }
            before
        };
        work().inspect_err(|_| self.put_back(before))
    }

    /// Restores an item as it was before `filing` (best effort on disk).
    fn put_back(&self, before: InboxItem) {
        let mut items = lock(&self.items);
        if let Some(item) = items.iter_mut().find(|i| i.id == before.id) {
            *item = before;
        }
        drop(items);
        let _ = self.persist();
    }

    /// Removes the item and its files from the inbox (an item still arriving
    /// too: its space is freed; a phone still sending it starts it again).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut items = lock(&self.items);
        let before = items.len();
        items.retain(|i| i.id != id);
        if items.len() == before {
            return Ok(());
        }
        let _ = fs::remove_dir_all(self.item_dir(id));
        drop(items);
        self.persist()
    }

    /// "File as a new song": `<parent>/<name>/BandLab/` with the audio (zips
    /// unpacked; into `BandLab/Stems/` when a mixdown came with them). Anything
    /// half made is removed on failure. Filing the same item again to the
    /// same place (a retry whose answer was lost) answers the same.
    pub fn file_sketch(&self, id: &str, parent: &Path, name: &str) -> Result<FiledSketch, String> {
        let item = self.get_ready(id)?;
        if item.item_type == ItemType::Idea {
            return Err(app_err("inbox.ideaNoAudio", "An idea has no audio to file as a song.").into());
        }
        let name = validate_name(name)?;
        let song = parent.join(name);
        let dir = song.join(SKETCH_DIR);
        let key = dir.to_string_lossy().to_string();
        if item.status == Status::Filed && item.filed_to.as_deref() == Some(key.as_str()) && dir.is_dir() {
            return Ok(FiledSketch { key, filled: count_sketch(&dir) });
        }
        let sources = self.file_paths(&item)?;
        if song.exists() {
            return Err(app_err("inbox.nameTaken", format!("\"{name}\" already exists in that folder: pick another name.")).with("name", name).into());
        }
        let filled = self.filing(id, &key, "song", None, || {
            fs::create_dir_all(&dir).map_err(|e| desk_io(&e, "could not create the song folder"))?;
            let mut created = Vec::new();
            match fill_sketch(&sources, &dir, &mut created) {
                Ok(f) if f.total() == 0 => Err(app_err("inbox.zipNoAudio", "No audio in this zip.").into()),
                other => other,
            }
            .inspect_err(|_| {
                let _ = fs::remove_dir_all(&song);
            })
        })?;
        Ok(FiledSketch { key, filled })
    }

    /// Attaches the item's audio to an existing song: a memo is copied into
    /// `<song folder>/Voice memos/` (named after its title), a sketch's audio
    /// into `<song folder>/BandLab/` under the phone's names, zips unpacked
    /// (stems into `BandLab/Stems/` when a mixdown came with them). Never over
    /// a file. Returns the copied paths.
    /// A memo is filed as `song:<song_key>` with its copy in `copied_to`;
    /// `memo_sub` (the song's file stem, when its folder holds several
    /// projects) puts it in `Voice memos/<memo_sub>/`.
    pub fn attach_to_song_folder(&self, id: &str, song_folder: &Path, song_key: &str, memo_sub: Option<&str>) -> Result<Vec<String>, String> {
        let item = self.get_ready(id)?;
        if item.item_type == ItemType::Idea {
            return Err(app_err("inbox.ideaNoAudio", "An idea has no audio to copy.").into());
        }
        if !song_folder.is_dir() {
            return Err(app_err("inbox.songFolderGone", "This song's folder isn't there any more.").into());
        }
        let sources = self.file_paths(&item)?;
        if item.item_type == ItemType::Sketch {
            let dir = song_folder.join(SKETCH_DIR);
            let key = dir.to_string_lossy().to_string();
            if item.status == Status::Filed && item.filed_to.as_deref() == Some(key.as_str()) && dir.is_dir() {
                return Ok(vec![key]);
            }
            return self.filing(id, &key, "folder", None, || {
                let made_dir = !dir.exists();
                fs::create_dir_all(&dir).map_err(|e| desk_io(&e, "could not create the BandLab folder"))?;
                let mut created = Vec::new();
                let result = match fill_sketch(&sources, &dir, &mut created) {
                    Ok(f) if f.total() == 0 => Err(app_err("inbox.zipNoAudio", "No audio in this zip.").into()),
                    other => other,
                };
                if result.is_err() {
                    for p in &created {
                        let _ = fs::remove_file(p);
                    }
                    let _ = fs::remove_dir(dir.join(STEMS_DIR));
                    if made_dir {
                        let _ = fs::remove_dir(&dir);
                    }
                }
                result.map(|_| created.iter().map(|p| p.to_string_lossy().to_string()).collect())
            });
        }
        let (src, name) = sources.first().ok_or_else(|| String::from(app_err("inbox.memoNoAudio", "This memo has no audio.")))?;
        // Filed to the song by its key (the drawer matches on it), the copy
        // in `copied_to`. A retry whose answer was lost answers the same.
        let song = format!("song:{song_key}");
        if item.status == Status::Filed && item.filed_as.as_deref() == Some("folder") && item.filed_to.as_deref() == Some(song.as_str()) {
            if let Some(done) = item.copied_to.as_deref().filter(|f| Path::new(f).is_file()) {
                return Ok(vec![done.to_string()]);
            }
        }
        // Several songs in one folder (FL's flat `Projects/*.flp`): one
        // memo folder per song, so they don't all share one.
        let dir = match memo_sub {
            Some(sub) => song_folder.join(MEMOS_DIR).join(crate::audio::safe_name(sub)),
            None => song_folder.join(MEMOS_DIR),
        };
        let target = memo_target(&dir, &item, name);
        let path = target.to_string_lossy().to_string();
        self.filing(id, &song, "folder", Some(path.clone()), || {
            fs::create_dir_all(&dir).map_err(|e| desk_io(&e, "could not create the Voice memos folder"))?;
            copy_new(src, &target)
        })?;
        Ok(vec![path])
    }

    /// Links a memo to a beat or a saved prod (`filed_to` = `<kind>:<id>`)
    /// and copies its audio into `<beats folder>/_memos/`, so the inbox never
    /// holds the only copy. Returns the copy.
    pub fn link_memo(&self, id: &str, target_key: &str, beats_folder: &Path) -> Result<String, String> {
        let item = self.get_ready(id)?;
        if item.item_type != ItemType::Memo {
            return Err(app_err("inbox.onlyMemo", "Only a voice memo can be linked to a beat or a prod.").into());
        }
        if item.status == Status::Filed && item.filed_to.as_deref() == Some(target_key) {
            if let Some(copy) = item.copied_to.as_deref().filter(|c| Path::new(c).is_file()) {
                return Ok(copy.to_string());
            }
        }
        if !beats_folder.is_dir() {
            return Err(app_err("inbox.beatFolderGone", "This beats folder isn't there any more.").into());
        }
        let sources = self.file_paths(&item)?;
        let (src, name) = sources.first().ok_or_else(|| String::from(app_err("inbox.memoNoAudio", "This memo has no audio.")))?;
        let dir = beats_folder.join(BEAT_MEMOS_DIR);
        let target = memo_target(&dir, &item, name);
        let path = target.to_string_lossy().to_string();
        self.filing(id, target_key, "link", Some(path.clone()), || {
            fs::create_dir_all(&dir).map_err(|e| desk_io(&e, "could not create the _memos folder"))?;
            copy_new(src, &target)
        })?;
        Ok(path)
    }
}

fn gone() -> String {
    app_err("inbox.gone", "That item isn't in the phone inbox any more.").into()
}

/// `<dir>/<memo title>.<ext>` (or "Voice memo"), never an existing file.
fn memo_target(dir: &Path, item: &InboxItem, name: &str) -> PathBuf {
    let base = if item.title.trim().is_empty() { "Voice memo".to_string() } else { crate::audio::safe_name(item.title.trim()) };
    let base: String = base.chars().take(80).collect();
    crate::actions::free_path(dir, &base, &ext_of(name))
}

/// Sweeps stale uploads every `every` while the inbox lives (the app keeps
/// it for its whole run); `on_drop` runs when something was dropped.
pub fn sweep_every(inbox: &std::sync::Arc<Inbox>, every: std::time::Duration, on_drop: impl Fn() + Send + 'static) {
    let weak = std::sync::Arc::downgrade(inbox);
    let _ = std::thread::Builder::new().name("phone-inbox-sweep".into()).spawn(move || loop {
        std::thread::sleep(every);
        let Some(inbox) = weak.upgrade() else { return };
        if inbox.drop_stale(now_ms()) {
            on_drop();
        }
    });
}

/// What filing a sketch's audio put where.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filled {
    /// Audio files copied as they came (the mixdown when stems came with it).
    pub audio: usize,
    /// Audio unpacked from zips.
    pub stems: usize,
    /// The stems went to `BandLab/Stems/`, the mixdown staying in `BandLab/`.
    pub stems_apart: bool,
}

impl Filled {
    pub fn total(&self) -> usize {
        self.audio + self.stems
    }
}

/// A new sketch song: its key (the BandLab folder, as the scan lists it)
/// and what's in it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiledSketch {
    pub key: String,
    #[serde(flatten)]
    pub filled: Filled,
}

/// What a BandLab folder already holds (for a repeated filing).
fn count_sketch(dir: &Path) -> Filled {
    let audio_in = |d: &Path| fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()).filter(|e| e.path().is_file() && is_sketch_audio(&e.path())).count()).unwrap_or(0);
    let stems = audio_in(&dir.join(STEMS_DIR));
    Filled { audio: audio_in(dir), stems, stems_apart: stems > 0 }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingView {
    pub id: String,
    pub item_type: ItemType,
    pub title: String,
    pub phone_name: String,
    pub file_count: usize,
    pub files_done: usize,
    pub received_bytes: u64,
    /// Declared sizes of the files started so far.
    pub total_bytes: u64,
    pub updated_at: i64,
}

fn status_word(s: Status) -> &'static str {
    match s {
        Status::New => "stored",
        Status::Filed => "filed",
        Status::Dismissed => "dismissed",
    }
}

fn part_path(dir: &Path, slot: &FileSlot) -> PathBuf {
    dir.join(format!("{}.part", slot.stored))
}

fn part_len(dir: &Path, slot: &FileSlot) -> u64 {
    fs::metadata(part_path(dir, slot)).map(|m| m.len()).unwrap_or(0)
}

/// Copies without ever replacing an existing file.
fn copy_new(from: &Path, to: &Path) -> Result<(), String> {
    let mut src = fs::File::open(from).map_err(|e| desk_io(&e, "could not read the file"))?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(to).map_err(|e| desk_io(&e, "could not write the file"))?;
    if let Err(e) = io::copy(&mut src, &mut out) {
        drop(out);
        let _ = fs::remove_file(to);
        return Err(desk_io(&e, "could not copy the file"));
    }
    Ok(())
}

/// Copies audio files and unpacks the audio inside zips into `dir`. When
/// zips come with plain audio (a BandLab mixdown plus its stems), the stems
/// go to `dir/Stems/` so the mixdown isn't laid out over them. Every file
/// made is pushed to `created` (for the caller's cleanup).
fn fill_sketch(sources: &[(PathBuf, String)], dir: &Path, created: &mut Vec<PathBuf>) -> Result<Filled, String> {
    let has_zip = sources.iter().any(|(_, n)| ext_of(n) == "zip");
    let has_audio = sources.iter().any(|(_, n)| ext_of(n) != "zip");
    let apart = has_zip && has_audio;
    let stems_dir = if apart { dir.join(STEMS_DIR) } else { dir.to_path_buf() };
    let mut filled = Filled::default();
    let mut budget = MAX_UNZIP_BYTES;
    for (src, name) in sources {
        if ext_of(name) == "zip" {
            fs::create_dir_all(&stems_dir).map_err(|e| desk_io(&e, "could not create the Stems folder"))?;
            filled.stems += unzip_audio(src, &stems_dir, &mut budget, created)?;
            continue;
        }
        // The phone's name for it, never over a file already there.
        let clean = crate::audio::safe_name(name);
        let stem = Path::new(&clean).file_stem().unwrap_or_default().to_string_lossy().to_string();
        let target = crate::actions::free_path(dir, &stem, &ext_of(&clean));
        copy_new(src, &target)?;
        created.push(target);
        filled.audio += 1;
    }
    filled.stems_apart = apart && filled.stems > 0;
    if apart && filled.stems == 0 {
        let _ = fs::remove_dir(&stems_dir);
    }
    Ok(filled)
}

/// The audio entries of a zip, flat (only the file name is kept, so nothing
/// can land outside `dir`), never over an existing file, within `budget`.
/// Each file made is pushed to `created`.
pub fn unzip_audio(zip_path: &Path, dir: &Path, budget: &mut u64, created: &mut Vec<PathBuf>) -> Result<usize, String> {
    let file = fs::File::open(zip_path).map_err(|e| desk_io(&e, "could not read the zip"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| String::from(app_err("inbox.badZip", "This zip can't be read.")))?;
    let mut count = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| String::from(app_err("inbox.badZip", "This zip can't be read.")))?;
        if !entry.is_file() {
            continue;
        }
        let raw_name = entry.name().map(|n| n.replace('\\', "/")).unwrap_or_default();
        let Some(file_name) = raw_name.rsplit('/').next().filter(|n| !n.is_empty() && !n.starts_with('.')) else { continue };
        // macOS adds __MACOSX/._name resource forks.
        if raw_name.starts_with("__MACOSX/") || !is_sketch_audio(Path::new(file_name)) {
            continue;
        }
        if entry.size() > *budget {
            return Err(app_err("inbox.zipTooBig", "The zip unpacks to more than 2 GB of audio.").into());
        }
        let clean = crate::audio::safe_name(file_name);
        let stem = Path::new(&clean).file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = ext_of(&clean);
        let target = crate::actions::free_path(dir, &stem, &ext);
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| desk_io(&e, "could not write the audio"))?;
        created.push(target.clone());
        let limit = *budget + 1;
        let written = io::copy(&mut (&mut entry).take(limit), &mut out).map_err(|e| desk_io(&e, "could not unpack the zip"))?;
        if written > *budget {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err(app_err("inbox.zipTooBig", "The zip unpacks to more than 2 GB of audio.").into());
        }
        *budget -= written;
        count += 1;
    }
    Ok(count)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub name: String,
    pub size: u64,
    pub path: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxView {
    #[serde(flatten)]
    pub item: InboxItem,
    pub files: Vec<FileView>,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn temp(name: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("hivo-inbox-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Dir(d)
    }

    fn start(inbox: &Inbox, item: &str, ty: &str, index: usize, count: usize, name: &str, size: u64) -> Answer {
        inbox.upload_start(
            "dev",
            "Pixel",
            &json!({ "itemId": item, "itemType": ty, "title": "Night run", "fileIndex": index, "fileCount": count, "name": name, "size": size, "createdAt": 1 }),
            now_ms(),
        )
    }

    fn chunk(inbox: &Inbox, item: &str, index: usize, offset: u64, bytes: &[u8]) -> Answer {
        inbox.upload_chunk("dev", &json!({ "itemId": item, "fileIndex": index, "offset": offset, "data": B64.encode(bytes) }))
    }

    fn finish(inbox: &Inbox, item: &str, index: usize) -> Result<(Value, bool), String> {
        inbox.upload_finish("dev", &json!({ "itemId": item, "fileIndex": index }), now_ms())
    }

    #[test]
    fn upload_resume_and_finish() {
        let d = temp("upload");
        let inbox = Inbox::open(d.0.clone());
        assert_eq!(start(&inbox, "m1", "memo", 0, 1, "take.m4a", 6).unwrap(), json!({ "offset": 0 }));
        assert_eq!(chunk(&inbox, "m1", 0, 0, b"abc").unwrap(), json!({ "offset": 3 }));
        // A lost reply: the phone sends the same chunk again.
        assert_eq!(chunk(&inbox, "m1", 0, 0, b"abc").unwrap_err(), "offset:3");
        // Not finished yet: not listed, and finish refuses a short file.
        assert!(inbox.list().is_empty());
        assert_eq!(inbox.receiving(), 1);
        // Resume after a restart: the offset is what's on disk.
        let again = Inbox::open(d.0.clone());
        assert_eq!(start(&again, "m1", "memo", 0, 1, "take.m4a", 6).unwrap(), json!({ "offset": 3 }));
        assert_eq!(chunk(&again, "m1", 0, 3, b"def").unwrap(), json!({ "offset": 6 }));
        assert_eq!(chunk(&again, "m1", 0, 6, b"g").unwrap_err(), "size", "past the declared size");
        let (body, became_ready) = finish(&again, "m1", 0).unwrap();
        assert_eq!(body, json!({ "status": "stored", "received": 1, "of": 1 }));
        assert!(became_ready);
        let list = again.list();
        assert_eq!(list.len(), 1);
        assert_eq!(fs::read(&list[0].files[0].path).unwrap(), b"abcdef");
        assert_eq!(list[0].item.title, "Night run");
        // Finishing again or restarting a complete file: idempotent.
        assert!(!finish(&again, "m1", 0).unwrap().1);
        assert_eq!(start(&again, "m1", "memo", 0, 1, "take.m4a", 6).unwrap(), json!({ "offset": 6 }));
        assert_eq!(again.status_for("dev")["items"][0]["status"], "new");
        assert_eq!(again.status_for("other")["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn short_file_starts_over() {
        let d = temp("short");
        let inbox = Inbox::open(d.0.clone());
        start(&inbox, "m2", "memo", 0, 1, "take.m4a", 4).unwrap();
        chunk(&inbox, "m2", 0, 0, b"ab").unwrap();
        assert_eq!(finish(&inbox, "m2", 0).unwrap_err(), "size");
        assert_eq!(start(&inbox, "m2", "memo", 0, 1, "take.m4a", 4).unwrap(), json!({ "offset": 0 }));
        assert_eq!(chunk(&inbox, "x", 0, 0, b"ab").unwrap_err(), "unknown upload");
        assert_eq!(finish(&inbox, "x", 0).unwrap_err(), "unknown upload");
    }

    #[test]
    fn refuses_types_sizes_and_counts() {
        let d = temp("refuse");
        let inbox = Inbox::open(d.0.clone());
        assert_eq!(start(&inbox, "a", "memo", 0, 1, "notes.txt", 4).unwrap_err(), "type");
        assert_eq!(start(&inbox, "a", "memo", 0, 1, "stems.zip", 4).unwrap_err(), "type", "a memo is one audio file");
        assert!(start(&inbox, "b", "sketch", 0, 2, "stems.zip", 4).is_ok());
        assert_eq!(start(&inbox, "c", "sketch", 0, MAX_ITEM_FILES + 1, "a.wav", 4).unwrap_err(), "too big");
        assert_eq!(start(&inbox, "d", "sketch", 0, 1, "a.wav", MAX_FILE_BYTES + 1).unwrap_err(), "too big");
        assert_eq!(start(&inbox, "e", "memo", 0, 2, "a.m4a", 4).unwrap_err(), "too big");
        assert_eq!(start(&inbox, "f", "memo", 0, 1, "a.m4a", 0).unwrap_err(), "size");
        assert_eq!(start(&inbox, "../x", "memo", 0, 1, "a.m4a", 4).unwrap_err(), "bad request");
        assert_eq!(start(&inbox, "g", "video", 0, 1, "a.m4a", 4).unwrap_err(), "bad request");
        assert_eq!(start(&inbox, "h", "memo", 1, 1, "a.m4a", 4).unwrap_err(), "bad request");
        let big = "A".repeat(MAX_CHUNK_BYTES * 2);
        let r = inbox.upload_chunk("dev", &json!({ "itemId": "b", "fileIndex": 0, "offset": 0, "data": big }));
        assert_eq!(r.unwrap_err(), "too big");
    }

    #[test]
    fn inbox_full() {
        let d = temp("full");
        let inbox = Inbox::open(d.0.clone());
        // Fill the quota with declared sizes (sparse: nothing is written yet).
        let per = MAX_FILE_BYTES;
        let n = (MAX_INBOX_BYTES / per) as usize;
        for i in 0..n {
            start(&inbox, &format!("s{i}"), "sketch", 0, 1, "a.wav", per).unwrap();
        }
        assert_eq!(start(&inbox, "one-more", "sketch", 0, 1, "a.wav", per).unwrap_err(), "inbox full");
        inbox.remove("dev.s0").unwrap();
        assert!(start(&inbox, "one-more", "sketch", 0, 1, "a.wav", per).is_ok());
        // Full again; a filed sketch (copied into its song folder) makes
        // room by itself, a filed memo-style link doesn't (review 2026-11-10).
        {
            let mut items = lock(&inbox.items);
            for (id, how) in [("dev.s1", "link"), ("dev.s2", "song")] {
                let it = items.iter_mut().find(|i| i.id == id).unwrap();
                it.status = Status::Filed;
                it.filed_as = Some(how.to_string());
                it.filed_at = Some(1);
            }
        }
        assert!(start(&inbox, "two-more", "sketch", 0, 1, "a.wav", per).is_ok());
        let ids: Vec<String> = lock(&inbox.items).iter().map(|i| i.id.clone()).collect();
        assert!(ids.contains(&"dev.s1".to_string()) && !ids.contains(&"dev.s2".to_string()));
    }

    #[test]
    fn ideas_store_update_file_and_delete() {
        let d = temp("ideas");
        let inbox = Inbox::open(d.0.clone());
        let push = |ideas: Value| inbox.push_ideas("dev", "Pixel", &json!({ "ideas": ideas }), 50);
        let r = push(json!([
            { "id": "i1", "title": "Cold room", "text": "hook idea", "updatedAt": 10, "createdAt": 5, "target": { "kind": "beat", "id": "/b.wav", "title": "Dark" } },
            { "id": "i2", "title": " ", "text": "  ", "updatedAt": 10 }
        ]))
        .unwrap();
        assert_eq!(r["results"][0]["status"], "stored");
        assert_eq!(r["results"][1]["status"], "deleted", "an empty idea isn't kept");
        // An older copy never overwrites; a newer one does.
        push(json!([{ "id": "i1", "title": "old", "text": "", "updatedAt": 9 }])).unwrap();
        assert_eq!(inbox.list()[0].item.title, "Cold room");
        push(json!([{ "id": "i1", "title": "Cold room 2", "text": "x", "updatedAt": 11 }])).unwrap();
        assert_eq!(inbox.list()[0].item.title, "Cold room 2");
        assert_eq!(inbox.list()[0].item.target, None, "the target follows the newest copy");
        // Filed on the desktop: the phone gets "filed" and can't change it.
        inbox.mark("dev.i1", Status::Filed, Some("Envy".into())).unwrap();
        let r = push(json!([{ "id": "i1", "title": "late edit", "updatedAt": 99 }])).unwrap();
        assert_eq!(r["results"][0], json!({ "id": "i1", "status": "filed", "filedTo": "Envy" }));
        assert_eq!(inbox.list()[0].item.title, "Cold room 2");
        let r = push(json!([{ "id": "i1", "deleted": true, "updatedAt": 100 }])).unwrap();
        assert_eq!(r["results"][0]["status"], "filed", "a filed idea stays filed");
        // An unfiled one can be deleted from the phone.
        push(json!([{ "id": "i3", "title": "t", "updatedAt": 1 }])).unwrap();
        let r = push(json!([{ "id": "i3", "deleted": true, "updatedAt": 2 }])).unwrap();
        assert_eq!(r["results"][0]["status"], "deleted");
        assert_eq!(inbox.list().len(), 1);
        // Limits.
        let many: Vec<Value> = (0..=MAX_IDEAS_PER_PUSH).map(|i| json!({ "id": format!("n{i}"), "title": "t" })).collect();
        assert_eq!(push(json!(many)).unwrap_err(), "too big");
        assert_eq!(push(json!([{ "id": "a/b", "title": "t" }])).unwrap_err(), "bad request");
        let long = "a".repeat(MAX_IDEA_CHARS + 50);
        push(json!([{ "id": "long", "text": long, "updatedAt": 1 }])).unwrap();
        assert_eq!(inbox.list().iter().find(|v| v.item.item_id == "long").unwrap().item.text.chars().count(), MAX_IDEA_CHARS);
        // Persisted.
        assert_eq!(Inbox::open(d.0.clone()).list().len(), 2);
    }

    fn zip_with(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zw = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zw.start_file(*name, opts).unwrap();
            zw.write_all(data).unwrap();
        }
        zw.finish().unwrap();
    }

    fn upload(inbox: &Inbox, item: &str, ty: &str, files: &[(&str, Vec<u8>)]) {
        for (i, (name, data)) in files.iter().enumerate() {
            start(inbox, item, ty, i, files.len(), name, data.len() as u64).unwrap();
            chunk(inbox, item, i, 0, data).unwrap();
            finish(inbox, item, i).unwrap();
        }
    }

    #[test]
    fn files_a_sketch_with_zip_stems() {
        let d = temp("sketch");
        let inbox = Inbox::open(d.0.join("inbox"));
        let z = d.0.join("stems.zip");
        zip_with(&z, &[("Stems/Vox.wav", b"vox"), ("Stems/Drums.wav", b"drums"), ("../evil.wav", b"evil"), ("__MACOSX/._Vox.wav", b"junk"), ("readme.txt", b"no")]);
        upload(&inbox, "s1", "sketch", &[("Night Run.mp3", b"mix".to_vec()), ("stems.zip", fs::read(&z).unwrap())]);
        let projects = d.0.join("Projects");
        fs::create_dir_all(&projects).unwrap();
        let filed = inbox.file_sketch("dev.s1", &projects, "Night Run").unwrap();
        let key = filed.key.clone();
        let dir = projects.join("Night Run").join(SKETCH_DIR);
        assert_eq!(PathBuf::from(&key), dir);
        // A mixdown with stems: the mixdown in BandLab/, the stems apart in Stems/.
        assert_eq!(filed.filled, Filled { audio: 1, stems: 3, stems_apart: true });
        assert_eq!(names_in(&dir), vec!["Night Run.mp3", "Stems"]);
        assert_eq!(names_in(&dir.join(STEMS_DIR)), vec!["Drums.wav", "Vox.wav", "evil.wav"], "flat, audio only, nothing outside");
        assert!(!d.0.join("evil.wav").exists() && !projects.join("evil.wav").exists());
        assert_eq!(inbox.list()[0].item.status, Status::Filed);
        assert_eq!(inbox.list()[0].item.filed_to.as_deref(), Some(key.as_str()));
        // A retry (the answer was lost): the same answer, nothing copied twice.
        assert_eq!(inbox.file_sketch("dev.s1", &projects, "Night Run").unwrap(), filed);
        assert_eq!(names_in(&dir.join(STEMS_DIR)).len(), 3);
        // Name taken.
        upload(&inbox, "s2", "sketch", &[("b.wav", b"b".to_vec())]);
        assert!(inbox.file_sketch("dev.s2", &projects, "Night Run").unwrap_err().contains("already exists"));
        assert!(inbox.file_sketch("dev.s2", &projects, "a/b").is_err());
        // A zip without audio: refused, nothing left behind.
        let empty = d.0.join("empty.zip");
        zip_with(&empty, &[("readme.txt", b"x")]);
        upload(&inbox, "s3", "sketch", &[("empty.zip", fs::read(&empty).unwrap())]);
        assert_eq!(crate::error::detail_of(&inbox.file_sketch("dev.s3", &projects, "Empty").unwrap_err()), "No audio in this zip.");
        assert!(!projects.join("Empty").exists());
        // A file deleted by hand: "file missing", nothing created.
        let v = inbox.list().into_iter().find(|v| v.item.id == "dev.s2").unwrap();
        fs::remove_file(&v.files[0].path).unwrap();
        assert!(inbox.list().iter().find(|v| v.item.id == "dev.s2").unwrap().files[0].missing);
        assert!(crate::error::detail_of(&inbox.file_sketch("dev.s2", &projects, "Other").unwrap_err()).starts_with("file missing"));
        assert!(!projects.join("Other").exists());
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        names.sort();
        names
    }

    #[test]
    fn a_zip_alone_stays_flat_and_more_than_twenty_are_counted() {
        let d = temp("many");
        let inbox = Inbox::open(d.0.join("inbox"));
        let z = d.0.join("stems.zip");
        let entries: Vec<(String, Vec<u8>)> = (0..25).map(|i| (format!("stem {i:02}.wav"), vec![b'x'])).collect();
        let refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
        zip_with(&z, &refs);
        upload(&inbox, "z1", "sketch", &[("stems.zip", fs::read(&z).unwrap())]);
        let projects = d.0.join("Projects");
        fs::create_dir_all(&projects).unwrap();
        let filed = inbox.file_sketch("dev.z1", &projects, "Many").unwrap();
        // No mixdown: flat, as before; 25 files, which the desktop names (> 20).
        assert_eq!(filed.filled, Filled { audio: 0, stems: 25, stems_apart: false });
        assert!(filed.filled.total() > crate::flp_build::MAX_CLIPS);
        assert_eq!(names_in(&PathBuf::from(&filed.key)).len(), 25);
    }

    #[test]
    fn attaches_zip_stems_to_an_existing_song() {
        let d = temp("attach-stems");
        let inbox = Inbox::open(d.0.join("inbox"));
        let z = d.0.join("stems.zip");
        zip_with(&z, &[("Stems/Vox.wav", b"vox"), ("Stems/Drums.wav", b"drums"), ("notes.txt", b"no")]);
        upload(&inbox, "s1", "sketch", &[("Envy mix.mp3", b"mix".to_vec()), ("stems.zip", fs::read(&z).unwrap())]);
        let song = d.0.join("Envy");
        fs::create_dir_all(&song).unwrap();
        fs::write(song.join("Envy.flp"), b"x").unwrap();
        let out = inbox.attach_to_song_folder("dev.s1", &song, "/Envy/Envy.flp", None).unwrap();
        // The phone's names, zips unpacked, stems apart from the mixdown.
        let dir = song.join(SKETCH_DIR);
        assert_eq!(names_in(&dir), vec!["Envy mix.mp3", "Stems"]);
        assert_eq!(names_in(&dir.join(STEMS_DIR)), vec!["Drums.wav", "Vox.wav"]);
        assert_eq!(out.len(), 3);
        let item = inbox.list()[0].item.clone();
        assert_eq!((item.status, item.filed_to.as_deref(), item.filed_as.as_deref()), (Status::Filed, Some(dir.to_string_lossy().as_ref()), Some("folder")));
        // Retried: nothing copied twice.
        inbox.attach_to_song_folder("dev.s1", &song, "/Envy/Envy.flp", None).unwrap();
        assert_eq!(names_in(&dir.join(STEMS_DIR)).len(), 2);
        assert!(fs::read(song.join("Envy.flp")).unwrap() == b"x", "the project is never touched");
    }

    #[test]
    fn linking_a_memo_copies_it_into_the_beats_folder() {
        let d = temp("link");
        let inbox = Inbox::open(d.0.join("inbox"));
        upload(&inbox, "m1", "memo", &[("rec.m4a", b"take".to_vec())]);
        let beats = d.0.join("Beats");
        assert_eq!(crate::error::detail_of(&inbox.link_memo("dev.m1", "beat:/b.wav", &beats).unwrap_err()), "This beats folder isn't there any more.");
        assert_eq!(inbox.list()[0].item.status, Status::New, "a failure leaves it new");
        fs::create_dir_all(&beats).unwrap();
        let copy = inbox.link_memo("dev.m1", "beat:/b.wav", &beats).unwrap();
        assert_eq!(PathBuf::from(&copy), beats.join(BEAT_MEMOS_DIR).join("Night run.m4a"));
        let item = inbox.list()[0].item.clone();
        assert_eq!(item.filed_to.as_deref(), Some("beat:/b.wav"));
        assert_eq!(item.copied_to.as_deref(), Some(copy.as_str()));
        assert_eq!(item.filed_as.as_deref(), Some("link"));
        // A retry answers the same copy; removing the item keeps the copy.
        assert_eq!(inbox.link_memo("dev.m1", "beat:/b.wav", &beats).unwrap(), copy);
        assert_eq!(names_in(&beats.join(BEAT_MEMOS_DIR)).len(), 1);
        inbox.remove("dev.m1").unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"take");
        // Only memos link.
        upload(&inbox, "s1", "sketch", &[("a.wav", b"a".to_vec())]);
        assert!(inbox.link_memo("dev.s1", "beat:/b.wav", &beats).is_err());
    }

    #[test]
    fn a_failed_copy_puts_the_item_back() {
        let d = temp("rollback");
        let inbox = Inbox::open(d.0.join("inbox"));
        upload(&inbox, "m1", "memo", &[("rec.m4a", b"take".to_vec())]);
        let song = d.0.join("Envy");
        fs::create_dir_all(&song).unwrap();
        // "Voice memos" is a file: the folder can't be made, the copy fails.
        fs::write(song.join(MEMOS_DIR), b"x").unwrap();
        assert!(inbox.attach_to_song_folder("dev.m1", &song, "/Envy/Envy.flp", None).is_err());
        let item = inbox.list()[0].item.clone();
        assert_eq!((item.status, item.filed_to, item.filed_as), (Status::New, None, None));
        assert_eq!(Inbox::open(d.0.join("inbox")).list()[0].item.status, Status::New, "saved as new too");
    }

    #[test]
    fn receiving_items_are_listed_and_can_be_removed() {
        let d = temp("incoming");
        let inbox = Inbox::open(d.0.clone());
        start(&inbox, "big", "sketch", 0, 2, "a.wav", 10).unwrap();
        chunk(&inbox, "big", 0, 0, b"abcd").unwrap();
        let list = inbox.incoming();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id.as_str(), list[0].file_count, list[0].files_done, list[0].received_bytes, list[0].total_bytes), ("dev.big", 2, 0, 4, 10));
        assert!(inbox.list().is_empty(), "not in the finished list");
        inbox.remove("dev.big").unwrap();
        assert!(inbox.incoming().is_empty());
        assert_eq!(inbox.receiving(), 0);
        assert!(!d.0.join("files").join("dev.big").exists(), "its space is freed");
        // The phone still sending it: the chunk says so, and it starts again.
        assert_eq!(chunk(&inbox, "big", 0, 4, b"ef").unwrap_err(), "unknown upload");
    }

    #[test]
    fn stale_uploads_are_swept_while_running() {
        let d = temp("sweep");
        let inbox = std::sync::Arc::new(Inbox::open(d.0.clone()));
        let old = now_ms() - PARTIAL_TTL_MS - 1_000;
        inbox.upload_start("dev", "Pixel", &json!({ "itemId": "old", "itemType": "memo", "fileIndex": 0, "fileCount": 1, "name": "a.m4a", "size": 4 }), old).unwrap();
        start(&inbox, "fresh", "memo", 0, 1, "b.m4a", 4).unwrap();
        assert_eq!(inbox.receiving(), 2);
        let (tx, rx) = std::sync::mpsc::channel();
        sweep_every(&inbox, std::time::Duration::from_millis(20), move || {
            let _ = tx.send(());
        });
        rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the sweep ran");
        assert_eq!(inbox.receiving(), 1, "only the stale one");
        assert!(!d.0.join("files").join("dev.old").exists());
        assert_eq!(inbox.incoming()[0].id, "dev.fresh");
    }

    #[test]
    fn attaches_a_memo_to_a_song_folder() {
        let d = temp("memo");
        let inbox = Inbox::open(d.0.join("inbox"));
        upload(&inbox, "m1", "memo", &[("rec.m4a", b"take".to_vec())]);
        let song = d.0.join("Envy");
        assert_eq!(crate::error::detail_of(&inbox.attach_to_song_folder("dev.m1", &song, "/Envy/Envy.flp", None).unwrap_err()), "This song's folder isn't there any more.");
        fs::create_dir_all(&song).unwrap();
        let out = inbox.attach_to_song_folder("dev.m1", &song, "/Envy/Envy.flp", None).unwrap();
        assert_eq!(PathBuf::from(&out[0]), song.join(MEMOS_DIR).join("Night run.m4a"));
        // A retry: the same copy, not a second one.
        assert_eq!(inbox.attach_to_song_folder("dev.m1", &song, "/Envy/Envy.flp", None).unwrap(), out);
        // Back to new ("File elsewhere") and attached again: never over the first copy.
        inbox.mark("dev.m1", Status::New, None).unwrap();
        let out2 = inbox.attach_to_song_folder("dev.m1", &song, "/Envy/Envy.flp", None).unwrap();
        assert_ne!(out2[0], out[0]);
        assert_eq!(fs::read(&out[0]).unwrap(), b"take");
        assert_eq!(inbox.list()[0].item.status, Status::Filed);
        inbox.remove("dev.m1").unwrap();
        assert!(inbox.list().is_empty());
        assert!(!d.0.join("inbox").join("files").join("dev.m1").exists());
    }

    #[test]
    fn a_memo_is_filed_by_song_key_in_its_own_folder_when_songs_share_one() {
        let d = temp("memo-flat");
        let inbox = Inbox::open(d.0.join("inbox"));
        upload(&inbox, "m1", "memo", &[("rec.m4a", b"take".to_vec())]);
        let projects = d.0.join("Projects");
        fs::create_dir_all(&projects).unwrap();
        let key = projects.join("Envy.flp").to_string_lossy().to_string();
        let out = inbox.attach_to_song_folder("dev.m1", &projects, &key, Some("Envy")).unwrap();
        assert_eq!(PathBuf::from(&out[0]), projects.join(MEMOS_DIR).join("Envy").join("Night run.m4a"));
        let item = inbox.list()[0].item.clone();
        assert_eq!(item.filed_to, Some(format!("song:{key}")), "matched by song key, not by folder");
        assert_eq!(item.copied_to.as_deref(), Some(out[0].as_str()));
        // A retry answers the same copy.
        assert_eq!(inbox.attach_to_song_folder("dev.m1", &projects, &key, Some("Envy")).unwrap(), out);
    }

    #[test]
    fn removing_a_half_arrived_item_makes_the_phone_send_it_all_again() {
        let d = temp("remove-resume");
        let inbox = Inbox::open(d.0.clone());
        // Two of three files in, the third under way.
        for i in 0..2 {
            start(&inbox, "s", "sketch", i, 3, &format!("{i}.wav"), 2).unwrap();
            chunk(&inbox, "s", i, 0, b"ab").unwrap();
            finish(&inbox, "s", i).unwrap();
        }
        start(&inbox, "s", "sketch", 2, 3, "2.wav", 2).unwrap();
        inbox.remove("dev.s").unwrap();
        // The phone resumes file 2: unknown, so it doesn't rebuild a one-file item.
        assert_eq!(chunk(&inbox, "s", 2, 0, b"ab").unwrap_err(), UNKNOWN_UPLOAD);
        assert_eq!(start(&inbox, "s", "sketch", 2, 3, "2.wav", 2).unwrap_err(), UNKNOWN_UPLOAD);
        assert_eq!(inbox.receiving(), 0, "nothing half made");
        // From file 0 again: all three arrive and the item is ready.
        for i in 0..3 {
            assert_eq!(start(&inbox, "s", "sketch", i, 3, &format!("{i}.wav"), 2).unwrap(), json!({ "offset": 0 }));
            chunk(&inbox, "s", i, 0, b"ab").unwrap();
            let (body, _) = finish(&inbox, "s", i).unwrap();
            assert_eq!(body["status"], if i == 2 { "stored" } else { "waiting" });
        }
        assert_eq!(inbox.list().len(), 1);
    }

    #[test]
    fn a_vanished_item_folder_is_an_unknown_upload() {
        let d = temp("vanished");
        let inbox = Inbox::open(d.0.clone());
        start(&inbox, "m", "memo", 0, 1, "a.m4a", 4).unwrap();
        chunk(&inbox, "m", 0, 0, b"ab").unwrap();
        // The folder went away between the lookup and the write.
        fs::remove_dir_all(d.0.join("files").join("dev.m")).unwrap();
        assert_eq!(chunk(&inbox, "m", 0, 2, b"cd").unwrap_err(), UNKNOWN_UPLOAD);
        assert_eq!(finish(&inbox, "m", 0).unwrap_err(), UNKNOWN_UPLOAD);
        assert_eq!(upload_io_error(&io::Error::from(io::ErrorKind::NotFound), "x"), UNKNOWN_UPLOAD);
    }

    #[test]
    fn keeps_the_shared_text_of_an_upload() {
        let d = temp("share-text");
        let inbox = Inbox::open(d.0.clone());
        let body = json!({ "itemId": "s1", "itemType": "sketch", "title": "Night run", "text": format!("Night Run on BandLab\nhttps://www.bandlab.com/post/abc{}", "x".repeat(3000)), "fileIndex": 0, "fileCount": 1, "name": "Night Run.m4a", "size": 3, "createdAt": 1 });
        inbox.upload_start("dev", "Pixel", &body, now_ms()).unwrap();
        let text_of = |id: &str| lock(&inbox.items).iter().find(|i| i.item_id == id).unwrap().text.clone();
        let text = text_of("s1");
        assert!(text.starts_with("Night Run on BandLab\nhttps://www.bandlab.com/post/abc"));
        assert_eq!(text.chars().count(), MAX_SHARE_TEXT_CHARS);
        // Older phones send no text.
        start(&inbox, "s2", "sketch", 0, 1, "a.m4a", 3).unwrap();
        assert_eq!(text_of("s2"), "");
    }

    #[test]
    fn drops_stale_partial_uploads() {
        let d = temp("stale");
        let inbox = Inbox::open(d.0.clone());
        start(&inbox, "old", "memo", 0, 1, "a.m4a", 4).unwrap();
        assert_eq!(inbox.receiving(), 1);
        assert!(inbox.drop_stale(now_ms() + PARTIAL_TTL_MS + 1));
        assert_eq!(inbox.receiving(), 0);
        assert!(!inbox.drop_stale(now_ms() + PARTIAL_TTL_MS + 1), "nothing left to drop");
        assert!(!d.0.join("files").join("dev.old").exists());
    }

    #[test]
    fn disk_full_is_named() {
        assert_eq!(io_error(&io::Error::from(io::ErrorKind::StorageFull), "x"), "disk full");
        #[cfg(unix)]
        assert_eq!(io_error(&io::Error::from_raw_os_error(28), "x"), "disk full");
        assert!(io_error(&io::Error::from(io::ErrorKind::PermissionDenied), "could not write").starts_with("could not write"));
    }

    #[test]
    fn concurrent_saves_keep_the_latest_state() {
        let d = temp("race");
        let inbox = std::sync::Arc::new(Inbox::open(d.0.clone()));
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let inbox = inbox.clone();
                std::thread::spawn(move || {
                    for i in 0..15 {
                        inbox.push_ideas("dev", "Pixel", &json!({ "ideas": [{ "id": format!("t{t}i{i}"), "title": "x", "updatedAt": 1 }] }), 1).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        // The file on disk is the last state, not an older snapshot written late.
        assert_eq!(Inbox::open(d.0.clone()).list().len(), 120);
    }

    #[test]
    fn a_broken_index_is_set_aside_and_an_unreadable_one_blocks_saving() {
        let d = temp("badindex");
        fs::write(d.0.join("index.json"), "not json").unwrap();
        let inbox = Inbox::open(d.0.clone());
        assert!(inbox.list().is_empty());
        let problem = inbox.problem().expect("reported");
        assert_eq!(crate::error::code_of(&problem).as_deref(), Some("phone.inboxReset"));
        let kept: Vec<_> = fs::read_dir(&d.0).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("index.json.bad-")).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(kept[0].path()).unwrap(), b"not json", "the broken file is kept");
        // A save works and clears the note.
        inbox.push_ideas("dev", "Pixel", &json!({ "ideas": [{ "id": "i1", "title": "x", "updatedAt": 1 }] }), 1).unwrap();
        assert_eq!(inbox.problem(), None);
        assert_eq!(Inbox::open(d.0.clone()).list().len(), 1);
        // Can't be read at all (a folder in its place): left alone, saving refused.
        let blocked = d.0.join("blocked");
        fs::create_dir_all(blocked.join("index.json")).unwrap();
        let inbox = Inbox::open(blocked.clone());
        assert_eq!(inbox.problem().and_then(|p| crate::error::code_of(&p)).as_deref(), Some("phone.inboxUnreadable"));
        assert!(inbox.push_ideas("dev", "Pixel", &json!({ "ideas": [{ "id": "i1", "title": "x", "updatedAt": 1 }] }), 1).is_err());
        assert!(blocked.join("index.json").is_dir(), "nothing written over it");
        // No file at all is just empty.
        assert_eq!(Inbox::open(d.0.join("fresh")).problem(), None);
    }
}
