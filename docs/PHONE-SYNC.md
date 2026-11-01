# Hivo phone sync, v1 (contract for the desktop server and the phone app)

Scope v1 (phase B steps 2-3, docs/NOVEMBER-PLAN.md): the phone pairs with the
desktop over the local Wi-Fi, lists the desktop's **saved prods, beats and
songs**, and reads/writes **notes** on each. Nothing goes through Hivo's
server or any cloud (user decision 2026-10-25). Not in v1: BandLab share,
voice memos, files, ideas inbox, session view (step 4), mDNS discovery.

## Security model
- Opt-in: Settings → Phone sync, **off by default**. The HTTP listener exists
  only while it's on; turning it off closes the port.
- Pairing: the desktop generates a random 32-byte key per pairing and shows a
  QR code once. The phone stores the key (secure storage). The desktop keeps
  paired devices in its config dir (`phone-sync.json`, owner-only file, like
  ai.json / spotify.json), never in workspace.json, never sent to the webview
  after the QR is shown. "Forget" deletes a device's key.
- Transport: plain HTTP on the LAN (port chosen by the OS, saved and reused
  when free). **Every request and response body is an envelope encrypted and
  authenticated with the device key**: XChaCha20-Poly1305, 24-byte random
  nonce, AAD = `"hivo-sync-v1|" + deviceId + "|" + path`. Anything that fails
  to decrypt gets a bare 401 with no detail.
- Replay protection: each decrypted request carries `ts` (ms since epoch) and
  `nonce`; the desktop rejects `|now - ts| > 120 000` and any nonce seen in the
  last 10 minutes (bounded in-memory set).
- Limits: request body ≤ 1 MB, note text ≤ 20 000 chars (MAX_NOTE_CHARS), at
  most 500 note changes per push, simple rate limit (e.g. 10 req/s per device).
- Listens on all interfaces (the phone is another device), but only paired
  devices can do anything.

## Pairing QR payload
A URL, all base64url without padding:
`hivo://pair?v=1&d=<deviceId>&k=<key b64url>&h=<host1>,<host2>&p=<port>&n=<desktop name, URI-encoded>`
- `deviceId`: 16 random bytes, b64url (also stored with the key on the desktop).
- `h`: the desktop's private IPv4 addresses (10/8, 172.16/12, 192.168/16),
  best first. The phone tries them in order.
- Also shown as text under the QR (for the iOS Simulator, which has no camera:
  paste the URL).

## Envelope (HTTP)
Request: `POST http://<host>:<port><path>` with headers
`X-Hivo-Device: <deviceId>` and `Content-Type: application/json`, body
`{"n": "<nonce b64url>", "c": "<ciphertext+tag b64url>"}`.
Plaintext request JSON: `{"ts": <ms>, "nonce": "<random 16 bytes b64url>", "body": <payload>}`.
Response: same envelope shape with AAD path suffixed `|resp`; plaintext
`{"ok": true, "body": <payload>}` or `{"ok": false, "error": "<short message>"}`.
Health check without crypto: `GET /v1/ping` → `{"app":"hivo","v":1}` (no data).

## Endpoints (all POST, encrypted)
### `/v1/hello` — payload `{"phoneName": "<model, ≤60 chars>", "appVersion": "x.y.z"}`
→ `{"desktopName": "...", "hivoVersion": "0.5.x"}`. First successful hello
marks the device as paired-and-seen (desktop shows phone name + last seen).

### `/v1/snapshot` — payload `{}`
→ `{"items": Item[], "generatedAt": <ms>}` where
```
Item = {
  "kind": "prod" | "beat" | "song",
  "id":   "<prod: lead hash | beat: file path | song: project path>",
  "title": "...",
  "subtitle": "<prod: producer · year | beat: folder name | song: stage label>",
  "bpm": number|null, "key": string|null,
  "url": string|null,            // prods: the https link (YouTube etc.)
  "stage": string|null,          // songs: creation|production|prep|release|promotion|null
  "note": string,                // "" when none
  "noteHash": "<fnv1a-32 hex of note, '811c9dc5' for empty>"
}
```
Prods = the Digger's saved prods (`leads`), beats = the Digger's beat files,
songs = visible projects (not archived, not templates). Notes: prods →
`workspace.leadNotes[hash]`, beats → `workspace.beatNotes[path]`, songs →
`workspace.songs[path].notes`. Demo mode: the desktop answers
`{"ok": false, "error": "demo"}` (sample data is never synced).

### `/v1/notes` — payload `{"changes": [{"kind","id","text","baseHash"}]}`
For each change: if the desktop's current note hash == `baseHash`, the note
becomes `text`. Otherwise it's a **conflict**: the desktop keeps both,
`current + "\n\n--- from <phoneName> ---\n" + text`, and reports it. Unknown
ids (deleted since) → `"missing"`.
→ `{"results": [{"kind","id","status":"applied"|"conflict"|"missing","note":"<final text>","noteHash":"<hash>"}]}`

Two cases are `"applied"` without a merge even when the hash differs (added
2026-10-25 by the desktop build; the wire format is unchanged): the desktop
already holds exactly `text` (a retried push whose answer was lost would
otherwise duplicate the note), and the desktop's note is empty. Changes are
applied in order, so a second change to the same item sees the first.
The phone should always replace its cached note with `note`/`noteHash` from
the result, and keep its own text when the status is `"missing"`.

## Who does what on the desktop
- **Rust** (`src-tauri/src/phone_sync.rs`): listener (tiny_http on a thread),
  envelope crypto (chacha20poly1305 crate, XChaCha20Poly1305), replay set,
  limits, paired-device store (`phone-sync.json`), commands:
  `phone_sync_status`, `phone_sync_enable(on)`, `phone_sync_pair()` → the QR
  URL (new device), `phone_sync_forget(deviceId)`.
- **Data stays in the webview's store** (single writer of workspace.json):
  Rust forwards each decrypted `/v1/snapshot` and `/v1/notes` request to the
  webview with a Tauri event (`phone-sync-request {id, path, body, phoneName}`)
  and waits (≤10 s) for `phone_sync_reply(id, body|error)`; then encrypts and
  answers. If the window is gone or too slow → `{"ok":false,"error":"busy"}`.
- **TS** (`src/lib/phoneSync.ts` pure helpers + tests: snapshot builder,
  fnv1a hash, apply-changes with conflict merge; listener wired in the store).
  Notes writes go through the existing `setLeadNote` / `setBeatNote` /
  `updateSong(path, {notes})`.
- **Settings → Phone sync** section (EN/FR): on/off, "Pair a phone" → QR
  (npm `qrcode`, rendered as a data: URL image) + the URL as text + "Done",
  paired phones (name, last seen, Forget), the first-time note that macOS /
  Windows will ask to allow incoming connections.

## Phone app (`mobile/`, Expo, TypeScript)
- Screens: **Pair** (scan QR with expo-camera, or paste the `hivo://` URL),
  **Library** with three tabs (Saved prods / Beats / Songs, search box),
  **Note** editor (plain text, `[Verse 1]`/`[Hook]` headers, autosave),
  header shows desktop name + "Synced 2 min ago" + a Sync button.
- Offline first: snapshot + notes cached locally (AsyncStorage); edits queue
  with their `baseHash`; sync = push queued changes (`/v1/notes`), then pull
  `/v1/snapshot`; conflicts show a small banner on that note.
- Prods: an "Open link" button (the YouTube URL in the system browser).
- Crypto: `@noble/ciphers` (xchacha20poly1305) + `@noble/hashes` if needed,
  random bytes from `expo-crypto`. Key + deviceId in `expo-secure-store`.
- Android: cleartext HTTP to private IPs must be allowed (expo-build-properties
  `usesCleartextTraffic: true`). iOS: `NSAppTransportSecurity` →
  `NSAllowsLocalNetworking: true`, and `NSLocalNetworkUsageDescription`.
- Builds: Android release APK built locally (`npx expo prebuild` + Gradle,
  JDK 17 and the Android SDK are installed); iOS via `npx expo run:ios` on the
  Simulator (Xcode 26.6, iPhone 17 Pro).

## Shared test vectors
- fnv1a-32 (same as `leadHash`): "" → `811c9dc5`, "a" → `e40c292c`.
- Envelope: both sides test encrypt→decrypt round trips, wrong key → error,
  wrong AAD/path → error, stale ts → rejected, replayed nonce → rejected.

## Desktop implementation notes (step 2, 2026-10-25)
Built in `src-tauri/src/phone_sync.rs`, `src/lib/phoneSync.ts`,
`src/store/phoneSyncBridge.ts` and `src/components/PhoneSyncSettings.tsx`.
Precisions the phone can rely on (nothing here changes the formats above):
- **Note hash:** fnv1a-32 over the note's UTF-8 bytes, **not trimmed**
  (`fnv1a32` in `src/lib/digger.ts`). `leadHash` trims the url first, so it is
  the same function only for already-trimmed input; the vectors above hold.
  Notes are stored as typed, capped at 20 000 chars; a blank note is `""`.
- **Bare statuses** (no body, no envelope): 401 anything that doesn't open
  (unknown device, bad envelope, wrong key/AAD/path, stale `ts`, replayed
  nonce), 413 body over 1 MB, 429 more than 10 requests per second for a
  device, 503 more than 16 requests in flight, 404 unknown path or method.
- **Errors inside the envelope** (`ok: false`): `"demo"` (sample data),
  `"busy"` (no window, no answer within 10 s, workspace not loaded yet, or a
  project scan running), `"bad request"` (payload shape), `"too many changes
  (500 max)"` and `"note too long (20000 characters max)"` (the whole push is
  refused before anything is written).
- `nonce` (inside the plaintext) is 1 to 64 characters; the 16 random bytes
  b64url (22 chars) fit.
- `phoneName` is trimmed, control characters removed, ≤ 60 chars; an empty
  one becomes "Phone". It's the name used in conflict markers.
- **Pairing:** "Pair a phone" drops paired devices that never said hello (an
  abandoned QR) before adding the new one; at most 20 paired phones. `h` holds
  up to 4 private IPv4 addresses: the default route's first, then physical
  interfaces, 192.168 before 10 before 172.16.
- **Snapshot details:** song `title` is the project file name, song `bpm` is
  the project tempo rounded to 2 decimals, beat `bpm`/`key` are null (beats
  carry no analysis), prod `subtitle` is `producer · year` without empty parts.
- **Port:** chosen by the OS on first start, saved in `phone-sync.json` and
  reused while free. The QR always carries the current one.

## v1.1: phase B step 4 (ideas, voice memos, BandLab exports, session view)

Same pairing, envelope, replay window and bare statuses as v1. The phone
only adds endpoints; an older desktop answers them with a bare 404, which
the phone shows as "update the computer's Hivo" (`outdated`).

### What travels
- **Ideas**: a title and/or text written on the phone (punchlines, titles,
  concepts), optionally aimed at a prod/beat/song. What's shared to Hivo as
  text (a BandLab link, a lyric copied from elsewhere) also becomes an idea.
- **Voice memos**: an `.m4a` recorded in the app, optionally aimed at a
  prod/beat/song.
- **Sketches**: files shared to Hivo from BandLab (or any app): audio
  (`wav mp3 m4a aac flac ogg aif aiff`) or a `.zip` of stems. One share = one
  sketch, up to 20 files.

All of it lands in the desktop's **phone inbox** (`<app data>/phone-inbox/`,
Rust-owned, never in workspace.json, never under a project folder until the
user files it). Nothing goes through a server.

### `/v1/ideas` — payload `{"ideas": Idea[]}` (≤ 200 per push)
```
Idea = { "id": "<phone uuid>", "title": string (≤ 200), "text": string (≤ 20 000),
         "target": {"kind","id","title"} | null, "createdAt": ms, "updatedAt": ms,
         "deleted": bool }
```
→ `{"results": [{"id", "status": "stored"|"filed"|"dismissed"|"deleted", "filedTo": string|null}]}`
- New or newer (`updatedAt`) ideas are stored; an older copy never overwrites.
- An idea the desktop already **filed** (appended to a note) or **dismissed**
  isn't changed any more: the phone shows its status and stops editing it.
- `deleted: true` removes an unfiled idea from the inbox (a filed one stays filed).

### Uploads (voice memos and sketches), all in Rust
Files go in chunks so a big export survives a flaky Wi-Fi: each chunk is an
ordinary encrypted request (≤ 1 MB body), so every byte is authenticated.
- `/v1/upload/start` `{"itemId", "itemType": "memo"|"sketch", "title", "target": {"kind","id","title"}|null,
  "createdAt", "durationMs": number|null, "fileIndex", "fileCount", "name", "size", "text"?: string (≤ 2000)}`
  `text` (optional, 2026-11-01): what the sharing app sent with the files (BandLab's
  words and link), kept on the inbox item; the desktop takes the BandLab link from it
  for the song. Older phones send none. The phone names a file whose shared name is
  only a provider id (`msf:1000032969`) after the song's title (`mobile/src/lib/shareMeta.ts`).
  → `{"offset": <bytes already received>}`. Starting again resumes: same
  `itemId`/`fileIndex`/`size` = the offset so far; a file already complete
  answers its size.
- `/v1/upload/chunk` `{"itemId", "fileIndex", "offset", "data": "<b64url, ≤ 393 216 raw bytes>"}`
  → `{"offset": <new offset>}`. A chunk whose `offset` isn't the current one
  is refused with `"offset:<current>"`, so the phone re-sends from there.
- `/v1/upload/finish` `{"itemId", "fileIndex"}` → `{"status": "stored"|"waiting", "received": n, "of": fileCount}`.
  Checks the size; the item shows in the inbox when all `fileCount` files are in.
- `/v1/inbox` `{}` → `{"items": [{"id", "type", "status": "new"|"filed"|"dismissed", "filedTo"}]}`
  (what this phone sent that the desktop still knows, for its status badges).

Limits (paired constants, Rust `phone_inbox.rs` ↔ phone `src/lib/outbox.ts`):
`MAX_FILE_BYTES` 500 MB, `MAX_ITEM_FILES` 20, `MAX_CHUNK_BYTES` 393 216,
`MAX_INBOX_BYTES` 4 GB (everything in the inbox, filed items included until
removed), `MAX_IDEAS_PER_PUSH` 200, `MAX_TITLE_CHARS` 200, `MAX_MEMO_MS` 15 min.
Unfinished uploads are dropped after 7 days.

### Error states, decided up front
Inside the envelope (`ok: false`), on top of v1's:
| error | when | the phone says / does |
|---|---|---|
| `demo` | desktop in sample-data mode | "Hivo on the computer shows sample data" (kept in the outbox) |
| `inbox full` | `MAX_INBOX_BYTES` reached | "The computer's phone inbox is full: file or remove items there" (kept, retried at next sync) |
| `disk full` | the desktop's disk refused a write | "The computer's disk is full" (kept, retried) |
| `too big` | file > 500 MB, > 20 files, chunk > max | "Too big to send (500 MB per file, 20 files)" (failed, the user can remove it) |
| `type` | not an allowed audio/zip name | "Hivo only takes audio files and .zip stems" (failed) |
| `offset:<n>` | chunk out of order (lost reply, resume) | silently re-sends from `n` |
| `unknown upload` | chunk/finish without a start, or dropped after 7 days | silently starts that file again from 0 |
| `size` | finish with fewer/more bytes than declared | starts that file again from 0 (once), then failed |
| `bad request` | malformed payload | `outdated` for notes and ideas; for an upload, that one item fails ("refused") and the others still go |
| `clock` | the request opened but its `ts` is more than 2 minutes off | "This phone's clock is off: set it to automatic" (nothing sent until it's fixed) |

On the phone (2026-11 review, B20/W13): only `offline`, `off`, `busy`, `forgotten`, `clock`, `demo` and `outdated` stop the uploads; any other sealed error fails just that item with its reason. `inbox full` holds that item and bigger ones (smaller ones still go); `disk full` holds all. A bare 401 on a phone that synced before says "forgotten, or this phone's clock is off" (older desktops answer a wrong clock that way).

Bare statuses as v1 (401 `forgotten`, 413, 429/503 `busy`: the uploader waits and goes on).

On the phone, before anything is sent:
- **Share**: not audio/zip/text → "Hivo takes audio, .zip stems or text"; more than 20 files → the first 20 + a warning; a file the phone can't read (revoked permission, cloud file not downloaded) → that file is skipped and named; a file over 500 MB → refused with its size; the phone's storage full while copying → "Not enough space on the phone"; not paired yet → kept in the outbox, "Pair with your computer to send it".
- **Recording**: microphone refused → "Allow the microphone in the phone's settings" with a button to them; under 1 s → discarded ("Too short"); 15 min → stops by itself and keeps it; a call or another app taking the mic → the recording stops and what was recorded is kept.
- **Ideas**: empty title and text → not kept; text capped at 20 000 characters (as notes).
- **Outbox**: every item shows its state: waiting (not on the same Wi-Fi), sending n %, on the computer, filed, failed (reason, Retry / Remove). Nothing is deleted from the phone until the desktop said `stored`.

On the desktop:
- **File a sketch** → `<project folder>/<name>/BandLab/` (zip stems are unpacked there: audio entries only, flat, no paths kept, 2 GB unpacked max): name empty/invalid → refused; name taken → "already exists, pick another"; no linked project folder → "Link a project folder in Settings first"; folder not writable / disk full → the half-made folder is removed and the error shown; a zip without audio → "No audio in this zip".
- **Attach a memo to a song** → copied into `<song folder>/Voice memos/` (never over a file); the song's folder gone → "This song's folder isn't there any more". To a beat or a prod: the memo stays in the inbox, marked filed to it.
- **File an idea** → appended to the target's note under a `--- idea from <phone> ---` marker; target gone → pick another; the note would pass 20 000 characters → refused, "the note is full".
- **Inbox file missing** (deleted by hand) → the item says "file missing" and can only be removed.
- **Session view**: no lyrics → "Nothing written yet" + a button to the note; the song removed while open → the window keeps the last text and says so.
