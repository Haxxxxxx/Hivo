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

use crate::actions::validate_name;
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

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(max).collect()
}

fn clip_line(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
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

pub struct Inbox {
    root: PathBuf,
    items: Mutex<Vec<InboxItem>>,
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
        let index: IndexFile = fs::read_to_string(root.join("index.json")).ok().and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
        let inbox = Inbox { root, items: Mutex::new(index.items) };
        inbox.drop_stale(now_ms());
        inbox
    }

    pub fn files_dir(&self) -> PathBuf {
        self.root.join("files")
    }

    fn item_dir(&self, id: &str) -> PathBuf {
        self.files_dir().join(id)
    }

    fn save(&self, items: &[InboxItem]) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| io_error(&e, "could not create the phone inbox"))?;
        let raw = serde_json::to_vec(&IndexFile { items: items.to_vec() }).map_err(|e| e.to_string())?;
        let tmp = self.root.join("index.json.tmp");
        crate::cover::write_private(&tmp, &raw).map_err(|e| io_error(&e, "could not save the phone inbox"))?;
        fs::rename(&tmp, self.root.join("index.json")).map_err(|e| io_error(&e, "could not save the phone inbox"))
    }

    fn drop_stale(&self, now: i64) {
        let mut items = lock(&self.items);
        let before = items.len();
        let stale: Vec<String> = items.iter().filter(|i| !i.ready() && now - i.updated_at > PARTIAL_TTL_MS).map(|i| i.id.clone()).collect();
        for id in &stale {
            let _ = fs::remove_dir_all(self.item_dir(id));
        }
        items.retain(|i| !stale.contains(&i.id));
        if items.len() != before {
            let snapshot = items.clone();
            drop(items);
            let _ = self.save(&snapshot);
        }
    }

    fn used_bytes(items: &[InboxItem]) -> u64 {
        items.iter().map(InboxItem::bytes).sum()
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
            });
            changed = true;
            results.push(json!({ "id": item_id, "status": "stored", "filedTo": null }));
        }
        if changed {
            let snapshot = items.clone();
            drop(items);
            self.save(&snapshot)?;
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
        let pos = match items.iter().position(|i| i.id == id) {
            Some(p) => {
                if items[p].item_type != item_type || items[p].file_count != file_count {
                    return Err("bad request".to_string());
                }
                p
            }
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
                fs::create_dir_all(&dir).map_err(|e| io_error(&e, "could not create the item folder"))?;
                let slot = FileSlot { index, name: name.clone(), size, stored: stored_name(index, &name), complete: false };
                fs::File::create(part_path(&dir, &slot)).map_err(|e| io_error(&e, "could not start the file"))?;
                items[pos].files.push(slot);
                0
            }
        };
        let snapshot = items.clone();
        drop(items);
        self.save(&snapshot)?;
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
        let mut f = fs::OpenOptions::new().append(true).open(&path).map_err(|e| io_error(&e, "could not write the file"))?;
        f.write_all(&bytes).map_err(|e| io_error(&e, "could not write the file"))?;
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
            fs::rename(&part, dir.join(&slot.stored)).map_err(|e| io_error(&e, "could not keep the file"))?;
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
        let snapshot = items.clone();
        drop(items);
        self.save(&snapshot)?;
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

    fn get_ready(&self, id: &str) -> Result<InboxItem, String> {
        lock(&self.items).iter().find(|i| i.id == id && i.ready()).cloned().ok_or_else(|| "That item isn't in the phone inbox any more.".to_string())
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
                    Err(format!("file missing: {}", f.name))
                }
            })
            .collect()
    }

    /// Sets the status (filed somewhere, dismissed, or back to new).
    pub fn mark(&self, id: &str, status: Status, filed_to: Option<String>) -> Result<(), String> {
        let mut items = lock(&self.items);
        let item = items.iter_mut().find(|i| i.id == id).ok_or("That item isn't in the phone inbox any more.")?;
        item.status = status;
        item.filed_to = if status == Status::Filed { filed_to.map(|f| clip_line(&f, 4096)) } else { None };
        item.filed_at = if status == Status::New { None } else { Some(now_ms()) };
        let snapshot = items.clone();
        drop(items);
        self.save(&snapshot)
    }

    /// Removes the item and its files from the inbox.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut items = lock(&self.items);
        let before = items.len();
        items.retain(|i| i.id != id);
        if items.len() == before {
            return Ok(());
        }
        let _ = fs::remove_dir_all(self.item_dir(id));
        let snapshot = items.clone();
        drop(items);
        self.save(&snapshot)
    }

    /// "File as a new song": `<parent>/<name>/BandLab/` with the audio (zips
    /// unpacked). Returns the sketch's key (the BandLab folder, as the scan
    /// lists it). Anything half made is removed on failure.
    pub fn file_sketch(&self, id: &str, parent: &Path, name: &str) -> Result<String, String> {
        let item = self.get_ready(id)?;
        if item.item_type == ItemType::Idea {
            return Err("An idea has no audio to file as a song.".to_string());
        }
        let sources = self.file_paths(&item)?;
        let name = validate_name(name)?;
        let song = parent.join(name);
        if song.exists() {
            return Err(format!("\"{name}\" already exists in that folder: pick another name."));
        }
        let dir = song.join(SKETCH_DIR);
        fs::create_dir_all(&dir).map_err(|e| io_error(&e, "could not create the song folder"))?;
        match fill_sketch(&sources, &dir) {
            Ok(0) => {
                let _ = fs::remove_dir_all(&song);
                Err("No audio in this zip.".to_string())
            }
            Ok(_) => {
                let key = dir.to_string_lossy().to_string();
                self.mark(id, Status::Filed, Some(key.clone()))?;
                Ok(key)
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&song);
                Err(e)
            }
        }
    }

    /// Copies a memo (or a sketch's audio) into `<song folder>/Voice memos/`,
    /// never over a file. Returns the copied paths.
    pub fn attach_to_song_folder(&self, id: &str, song_folder: &Path) -> Result<Vec<String>, String> {
        let item = self.get_ready(id)?;
        if item.item_type == ItemType::Idea {
            return Err("An idea has no audio to copy.".to_string());
        }
        if !song_folder.is_dir() {
            return Err("This song's folder isn't there any more.".to_string());
        }
        let sources = self.file_paths(&item)?;
        let dir = song_folder.join(MEMOS_DIR);
        fs::create_dir_all(&dir).map_err(|e| io_error(&e, "could not create the Voice memos folder"))?;
        let mut out = Vec::new();
        for (src, name) in &sources {
            let ext = ext_of(name);
            if ext == "zip" {
                continue;
            }
            let base = if item.title.trim().is_empty() { "Voice memo".to_string() } else { crate::audio::safe_name(item.title.trim()) };
            let base: String = base.chars().take(80).collect();
            let target = crate::actions::free_path(&dir, &base, &ext);
            copy_new(src, &target)?;
            out.push(target.to_string_lossy().to_string());
        }
        if out.is_empty() {
            return Err("Nothing to copy: this item only holds zip files.".to_string());
        }
        self.mark(id, Status::Filed, out.first().cloned())?;
        Ok(out)
    }
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
    let mut src = fs::File::open(from).map_err(|e| io_error(&e, "could not read the file"))?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(to).map_err(|e| io_error(&e, "could not write the file"))?;
    if let Err(e) = io::copy(&mut src, &mut out) {
        drop(out);
        let _ = fs::remove_file(to);
        return Err(io_error(&e, "could not copy the file"));
    }
    Ok(())
}

/// Copies audio files and unpacks the audio inside zips into `dir`.
/// Returns how many audio files landed there.
fn fill_sketch(sources: &[(PathBuf, String)], dir: &Path) -> Result<usize, String> {
    let mut count = 0;
    let mut budget = MAX_UNZIP_BYTES;
    for (src, name) in sources {
        if ext_of(name) == "zip" {
            count += unzip_audio(src, dir, &mut budget)?;
            continue;
        }
        // The phone's name for it, never over a file already there.
        let clean = crate::audio::safe_name(name);
        let stem = Path::new(&clean).file_stem().unwrap_or_default().to_string_lossy().to_string();
        copy_new(src, &crate::actions::free_path(dir, &stem, &ext_of(&clean)))?;
        count += 1;
    }
    Ok(count)
}

/// The audio entries of a zip, flat (only the file name is kept, so nothing
/// can land outside `dir`), never over an existing file, within `budget`.
pub fn unzip_audio(zip_path: &Path, dir: &Path, budget: &mut u64) -> Result<usize, String> {
    let file = fs::File::open(zip_path).map_err(|e| io_error(&e, "could not read the zip"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "This zip can't be read.".to_string())?;
    let mut count = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| "This zip can't be read.".to_string())?;
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
            return Err("The zip unpacks to more than 2 GB of audio.".to_string());
        }
        let clean = crate::audio::safe_name(file_name);
        let stem = Path::new(&clean).file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = ext_of(&clean);
        let target = crate::actions::free_path(dir, &stem, &ext);
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| io_error(&e, "could not write the audio"))?;
        let limit = *budget + 1;
        let written = io::copy(&mut (&mut entry).take(limit), &mut out).map_err(|e| io_error(&e, "could not unpack the zip"))?;
        if written > *budget {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err("The zip unpacks to more than 2 GB of audio.".to_string());
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
        let key = inbox.file_sketch("dev.s1", &projects, "Night Run").unwrap();
        let dir = projects.join("Night Run").join(SKETCH_DIR);
        assert_eq!(PathBuf::from(&key), dir);
        let mut names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["Drums.wav", "Night Run.mp3", "Vox.wav", "evil.wav"], "flat, audio only, nothing outside");
        assert!(!d.0.join("evil.wav").exists() && !projects.join("evil.wav").exists());
        assert_eq!(inbox.list()[0].item.status, Status::Filed);
        assert_eq!(inbox.list()[0].item.filed_to.as_deref(), Some(key.as_str()));
        // Name taken.
        upload(&inbox, "s2", "sketch", &[("b.wav", b"b".to_vec())]);
        assert!(inbox.file_sketch("dev.s2", &projects, "Night Run").unwrap_err().contains("already exists"));
        assert!(inbox.file_sketch("dev.s2", &projects, "a/b").is_err());
        // A zip without audio: refused, nothing left behind.
        let empty = d.0.join("empty.zip");
        zip_with(&empty, &[("readme.txt", b"x")]);
        upload(&inbox, "s3", "sketch", &[("empty.zip", fs::read(&empty).unwrap())]);
        assert_eq!(inbox.file_sketch("dev.s3", &projects, "Empty").unwrap_err(), "No audio in this zip.");
        assert!(!projects.join("Empty").exists());
        // A file deleted by hand: "file missing", nothing created.
        let v = inbox.list().into_iter().find(|v| v.item.id == "dev.s2").unwrap();
        fs::remove_file(&v.files[0].path).unwrap();
        assert!(inbox.list().iter().find(|v| v.item.id == "dev.s2").unwrap().files[0].missing);
        assert!(inbox.file_sketch("dev.s2", &projects, "Other").unwrap_err().starts_with("file missing"));
        assert!(!projects.join("Other").exists());
    }

    #[test]
    fn attaches_a_memo_to_a_song_folder() {
        let d = temp("memo");
        let inbox = Inbox::open(d.0.join("inbox"));
        upload(&inbox, "m1", "memo", &[("rec.m4a", b"take".to_vec())]);
        let song = d.0.join("Envy");
        assert_eq!(inbox.attach_to_song_folder("dev.m1", &song).unwrap_err(), "This song's folder isn't there any more.");
        fs::create_dir_all(&song).unwrap();
        let out = inbox.attach_to_song_folder("dev.m1", &song).unwrap();
        assert_eq!(PathBuf::from(&out[0]), song.join(MEMOS_DIR).join("Night run.m4a"));
        // Again (refiled): never over the first copy.
        let out2 = inbox.attach_to_song_folder("dev.m1", &song).unwrap();
        assert_ne!(out2[0], out[0]);
        assert_eq!(fs::read(&out[0]).unwrap(), b"take");
        assert_eq!(inbox.list()[0].item.status, Status::Filed);
        inbox.remove("dev.m1").unwrap();
        assert!(inbox.list().is_empty());
        assert!(!d.0.join("inbox").join("files").join("dev.m1").exists());
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
        inbox.drop_stale(now_ms() + PARTIAL_TTL_MS + 1);
        assert_eq!(inbox.receiving(), 0);
        assert!(!d.0.join("files").join("dev.old").exists());
    }

    #[test]
    fn disk_full_is_named() {
        assert_eq!(io_error(&io::Error::from(io::ErrorKind::StorageFull), "x"), "disk full");
        #[cfg(unix)]
        assert_eq!(io_error(&io::Error::from_raw_os_error(28), "x"), "disk full");
        assert!(io_error(&io::Error::from(io::ErrorKind::PermissionDenied), "could not write").starts_with("could not write"));
    }
}
