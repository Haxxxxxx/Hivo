# Hivo phone sync, v1 (contract for the desktop server and the phone app)

Scope v1 (phase B steps 2-3, docs/NOVEMBER-PLAN.md): the phone pairs with the
desktop over the local Wi-Fi, lists the desktop's **saved prods, beats and
songs**, and reads/writes **notes** on each. Nothing goes through Hivo's
server or any cloud (user decision 2026-10-25). Not in v1: BandLab share,
voice memos, files, ideas inbox, session view (step 4), mDNS discovery.

## Security model
**Since protocol 1.2 (2026-11), pairing, answer binding and the replay set
work as described in "v1.2" at the end of this file** (with its confirmation
code and computer id, "v1.2 addition"); what follows is v1, still accurate
for phones paired before 1.2.
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
  last 10 minutes (bounded in-memory set). Since 2026-11-01 a request whose
  envelope opened but whose `ts` is outside the window gets a **sealed**
  `{"ok": false, "error": "clock"}` (the phone's clock is off), not a bare
  401; a replayed nonce still gets the bare 401.
- Limits: request body ≤ 1 MB, note text ≤ 20 000 chars (MAX_NOTE_CHARS), at
  most 500 note changes per push, simple rate limit (e.g. 10 req/s per device).
- Listens on all interfaces (the phone is another device), but only paired
  devices can do anything.

## Pairing QR payload
(v1 QR, made by desktops before 1.2. Hivo 1.2 shows a `v=2` QR instead: see
"v1.2" below.) A URL, all base64url without padding:
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

Version check (2026-11-02, major.minor only: patches always talk to each
other). The phone says hello once per app run (not only after pairing).
Phone older than the desktop: Settings → Phone sync says "Update Hivo on
this phone" on its row (`phoneOutdated` in the status). Desktop older: the
phone says "Update Hivo on the computer" under its header
(`desktopIsOlder`, `mobile/src/lib/update.ts`), and the desktop, seeing a
newer phone's hello, runs its update check (`phone-sync-phone-newer`
event, quiet: the usual update banner shows if there is one).

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
Optional since 2026-11 (older phones ignore it, older desktops don't send
it): `"renamed": [{"kind": "song"|"beat", "from": "<old id>", "to": "<new id>"}]`,
the songs and beats whose id changed in the last 7 days (a relink, a
renamed or moved file, "Continue in FL Studio" turning `X/BandLab` into
`X/X.flp`, chains collapsed). Fed from the desktop's relinks and beat-note
moves (`workspace.phoneRenames`, `addRenames` in `src/lib/phoneSync.ts`).
The phone moves its pending edits, gone items and conflict / "too long"
marks from `from` to `to` (`applyRenames` in `mobile/src/lib/sync.ts`). A
gone item (its push already answered `"missing"`) becomes a pending edit
again against the base it was edited from (unknown: `""`, so the desktop
merges, never overwrites), and goes in the same sync.

Prods = the Digger's saved prods (`leads`), beats = the Digger's beat files,
songs = visible projects (not archived, not templates). Notes: prods →
`workspace.leadNotes[hash]`, beats → `workspace.beatNotes[path]`, songs →
`workspace.songs[path].notes`. Demo mode: the desktop answers
`{"ok": false, "error": "demo"}` (sample data is never synced).

### `/v1/notes` — payload `{"changes": [{"kind","id","text","baseHash"}]}`
For each change: if the desktop's current note hash == `baseHash`, the note
becomes `text`. Otherwise it's a **conflict**: the desktop keeps both and
reports it. Since 2026-11-01 the merge is **by line** (the phone's text
usually starts from the same note, so appending all of it doubled the
note): the desktop's note, then only the phone's lines it doesn't hold at
that position (a line diff, longest common subsequence compared trimmed,
since 2026-11-02: a chorus or `[Hook]` the phone repeated is new even if
the desktop has it once; past 4 million line pairs it counts lines
instead; blank lines between kept lines kept, collapsed to one) under
`"\n\n--- from <phoneName> ---\n"`. When the phone adds no new line, the
note stays the desktop's (still `"conflict"`). Unknown ids (deleted since) →
`"missing"`.
→ `{"results": [{"kind","id","status":"applied"|"conflict"|"missing"|"too long","note":"<final text>","noteHash":"<hash>"}]}`

`"too long"` (2026-11-01): the text, or the merge, would pass 20 000
characters (UTF-16 units, as the desktop stores them). Nothing is cut and
nothing is written: `note`/`noteHash` are the desktop's current note, and
**the phone keeps its own edit** (as for `"missing"`), telling the user to
shorten the note on one side. Phones that don't know the status skip it,
which keeps the edit pending too.

Two cases are `"applied"` without a merge even when the hash differs (added
2026-10-25 by the desktop build; the wire format is unchanged): the desktop
already holds exactly `text` (a retried push whose answer was lost would
otherwise duplicate the note), and the desktop's note is empty. Changes are
applied in order, so a second change to the same item sees the first.
The phone should always replace its cached note with `note`/`noteHash` from
the result, and keep its own text when the status is `"missing"` or `"too long"`.

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
- Offline first: snapshot + notes cached locally (files in the app's documents
  for the library cache, ideas and note edits; small rows in AsyncStorage for
  the rest, `mobile/src/lib/persist.ts`); edits queue
  with their `baseHash`; sync = push queued changes (`/v1/notes`), then pull
  `/v1/snapshot`; conflicts show a small banner on that note.
- Prods (any item with a link): "Open link" in the system browser; a YouTube
  link gets "Play here" (the docked mini player, `MiniPlayer.tsx`: a locked-down
  `react-native-webview` showing the website's `embed.html` with the
  youtube-nocookie embed, play only) and "Open in YouTube".
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
- **Bare statuses** (no body, no envelope): 401 only for what can't be
  authenticated (unknown device, bad envelope, wrong key/AAD/path) and a
  replayed nonce, 413 body over 1 MB, 429 more than 10 requests per second
  for a device, 503 more than 16 requests in flight, 404 unknown path or
  method. **Once the envelope opened, every error is sealed** (2026-11-01):
  a bare 401 means "this computer doesn't know this phone's key", nothing else.
- **Errors inside the envelope** (`ok: false`): `"demo"` (sample data),
  `"busy"` (no window, no answer within 10 s, workspace not loaded yet, the
  very first project scan still running, or the replay set full), `"clock"`
  (`ts` more than 120 s from the desktop's clock: the phone says "the phone's
  clock is off"), `"read only"` (2026-11-02, snapshot and notes: the
  desktop's workspace is unreadable or was saved by a newer Hivo, so nothing
  can be written until the user opens Hivo there; the phone says "Hivo on
  the computer can't save right now: open it to fix"; older desktops answered
  `"busy"` forever), `"bad request"` (the plaintext isn't `{ts, nonce, body}`,
  an empty or over-long nonce, or a payload of the wrong shape), `"too many
  changes (500 max)"` and `"note too long (20000 characters max)"` (the whole
  push is refused before anything is written). A scan running when a request
  comes in is waited for (up to 5 s), then the desktop answers from the last
  finished scan.
- `nonce` (inside the plaintext) is 1 to 64 characters; the 16 random bytes
  b64url (22 chars) fit.
- `phoneName` is trimmed, control characters removed, ≤ 60 chars; an empty
  one becomes "Phone". It's the name used in conflict markers.
- **Pairing:** "Pair a phone" drops paired devices that never said hello (an
  abandoned QR) before adding the new one; at most 20 paired phones. Since
  2026-11-02 a paired device that never said hello within 24 h is dropped
  anyway (its key stops working), and turning phone sync on and pairing a
  new phone each ask first in a native dialog (Rust side, EN/FR), so the
  webview can't open the port or mint a key by itself.
- **Listener limits (2026-11-02):** an unknown `X-Hivo-Device` gets its
  401 before its body is read; a body must arrive within 20 s or the request
  loses its slot (no answer); one address holds at most 4 connections at
  once (bodies still arriving included), more get a bare 503. Bodies up to
  1 KB are read by tiny_http before the request reaches Hivo.
- **Windows firewall:** the phone's "Not on the same Wi-Fi" now adds "or the
  computer's firewall blocks Hivo"; on Windows, Settings → Phone sync has a
  button to "Allow an app through Windows Firewall". `h` holds
  up to 4 private IPv4 addresses: the default route's first, then physical
  interfaces, 192.168 before 10 before 172.16.
- **Snapshot details:** song `title` is the project file name, song `bpm` is
  the project tempo rounded to 2 decimals, beat `bpm`/`key` are null (beats
  carry no analysis), prod `subtitle` is `producer · year` without empty parts.
- **Port:** chosen by the OS on first start, saved in `phone-sync.json` and
  reused while free. The QR always carries the current one. Each paired phone
  records the port its QR carried; when the saved port was taken and the
  listener opened another, Settings → Phone sync says which phones need the
  new QR, and **Re-pair this phone** shows one for the same `deviceId` with a
  new key (the device is replaced in place: its name and what it sent stay,
  the old key stops working). The same button helps when the computer's
  address changed. A phone scanning a QR with a `d` it already holds should
  keep its data.

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
removed, unfinished uploads by their declared size), `MAX_IDEAS_PER_PUSH`
200, `MAX_TITLE_CHARS` 200, `MAX_MEMO_MS` 15 min. Unfinished uploads that
haven't moved for 7 days are dropped, at start and every hour while the app
runs. The desktop lists them under "Still arriving" with their progress
(`phone-inbox-changed` fires on upload start/chunk/finish, at most once a
second per item with a trailing event so the last progress shows, and
always when an item is complete), and **Remove** frees their
space at once (a phone still sending one gets `unknown upload` and starts it
again).

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
| `unknown upload` | chunk/finish without a start, a start of file > 0 for an item the desktop doesn't know (2026-11-02), the item removed on the desktop or dropped after 7 days (also when its folder vanished between lookup and write) | silently sends **every file of the item again from file 0** (2026-11-02; was only that file, which left the desktop with an item that could never be complete), at most twice, then failed |
| other (`could not write…`) | the desktop's own I/O trouble | held, retried at the next sync (2026-11-02; was failed for good as "refused") |
| `size` | finish with fewer/more bytes than declared | starts that file again from 0 (once), then failed |
| `bad request` | malformed payload (also: the envelope opened but the plaintext isn't a request) | `outdated` for notes and ideas; for an upload, that one item fails ("refused") and the others still go (never "forgotten") |
| `clock` | the request opened but its `ts` is outside the 120 s window (2026-11-01; was a bare 401) | "This phone's clock is off: set it to automatic" (nothing sent until it's fixed) |

On the phone (2026-11 review, B20/W13): only `offline`, `off`, `busy`, `forgotten`, `clock`, `demo` and `outdated` stop the uploads. Only what's wrong with the item itself fails it (`bad request`, `type`, `size`, `too big`); since 2026-11-02 any other sealed error (the desktop couldn't write) holds every item until the next sync, like `disk full`. An item is marked sent (and an export's files purged from the phone) only when `finish` answers `"stored"` for the whole item; `"waiting"` after the phone's last file, or an item whose files were all done before this run that the desktop no longer has, sends every file again. `inbox full` holds that item and bigger ones (smaller ones still go); `disk full` holds all. A bare 401 on a phone that synced before says "forgotten, or this phone's clock is off" (older desktops answer a wrong clock that way).

Bare statuses as v1 (401 `forgotten`, only when the key isn't known; 413, 429/503 `busy`: the uploader waits and goes on).

On the phone, before anything is sent:
- **Share**: files can be aimed at a song only (the desktop files an export as a new song or into a song's `BandLab/`; text can still go to a prod or a beat as an idea). An export aimed at a song that's on the desktop shows "Attach to <song>" as its first action there, and the song's drawer (Files) lists its `BandLab/` audio. Not audio/zip/text → "Hivo takes audio, .zip stems or text"; more than 20 files → the first 20 + a warning; a file the phone can't read (revoked permission, cloud file not downloaded) → that file is skipped and named; a file over 500 MB → refused with its size; the phone's storage full while copying → "Not enough space on the phone"; not paired yet → kept in the outbox, "Pair with your computer to send it".
- **Recording**: microphone refused → "Allow the microphone in the phone's settings" with a button to them; under 1 s → discarded ("Too short"); 15 min → stops by itself and keeps it; a call or another app taking the mic → the recording stops and what was recorded is kept.
- **Ideas**: empty title and text → not kept; text capped at 20 000 characters (as notes).
- **Outbox**: every item shows its state: waiting (not on the same Wi-Fi), sending n %, on the computer, filed, failed (reason, Retry / Remove). Nothing is deleted from the phone until the desktop said `stored`.

On the desktop:
- **File a sketch** → `<project folder>/<name>/BandLab/` (zip stems are unpacked there: audio entries only, flat, no paths kept, 2 GB unpacked max; when a mixdown came with the zip, the stems go to `BandLab/Stems/` so "Continue in FL Studio" lays out the stems and leaves the mixdown, still the song's render, off the playlist, and the inbox says so): name empty/invalid → refused; name taken → "already exists, pick another"; no linked project folder → "Link a project folder in Settings first"; the workspace not loaded yet → refused before anything is made; folder not writable / disk full → the half-made folder is removed and the error shown; a zip without audio → "No audio in this zip"; more than 20 audio files → filed, and the inbox and "Continue in FL Studio" say only the first 20 go on the playlist.
- **Attach to a song** → a memo is copied into `<song folder>/Voice memos/` (named after its title; `Voice memos/<song file stem>/` when the song's folder holds more than one project, FL's flat `Projects/*.flp`, since 2026-11-02) and filed as `song:<song key>` with the copy in `copiedTo` (the drawer matches memos by song key; a rename or relink moves it; memos filed before keep the copy's path and are matched by folder); a sketch's audio into `<song folder>/BandLab/` under the phone's names, zips unpacked (stems in `BandLab/Stems/` with a mixdown). Never over a file. The song's folder gone → "This song's folder isn't there any more". To a beat or a prod: the memo is copied into that beats folder's `_memos/` (a beat: the beats folder holding it; a prod: the one holding its lead) and marked filed to it, so Remove never deletes the only copy. Memos linked before this have no copy: their Remove asks "Delete the only copy?".
- **Filing is all or nothing**: the item is marked filed first, then copied; a copy that fails puts it back to new and removes what was half made. A retry of a filing that went through (its answer lost) answers the same, without a second copy. An idea already in the target note isn't appended twice.
- **Filed items**: "Show in folder" (a sketch's BandLab folder, a memo's copy) and, for ideas and memos, "File elsewhere" (back to new; what was already filed stays where it went).
- **File an idea** → appended to the target's note under a `--- idea from <phone> ---` marker; target gone → pick another; the note would pass 20 000 characters → refused, "the note is full".
- **Inbox file missing** (deleted by hand) → the item says "file missing" and can only be removed.
- **Session view**: no lyrics → "Nothing written yet" + a button to the note; the song removed while open → the window keeps the last text and says so; a song renamed or relinked (or continued in FL Studio) → the window follows it; the main window closed → the session window closes too.

## v1.2: bound answers, one-time pairing, replay set across restarts (2026-11)

Answers the 2026-11 security review: (1) an answer wasn't tied to its
request, so someone on the Wi-Fi could replay an old sealed answer (an
upload's `finish: stored`, so the phone deletes a sketch it thinks was
delivered, or an old notes `applied`); (2) the QR carried the permanent
device key, so a photo or screenshot of it was permanent access; (3) the
replay set lived in memory, so for 2 minutes after a restart a recorded
request was accepted again. Same envelope (XChaCha20-Poly1305, 24-byte
nonce), same request AAD, same paths, same bare statuses.

### Answers bound to their request
- Every request plaintext now says what the phone speaks:
  `{"ts", "nonce", "body", "v": "1.2"}` (older desktops ignore `v`).
- The desktop seals the answer with
  `AAD = "hivo-sync-v1|" + deviceId + "|" + path + "|resp|" + <the request's nonce>`
  (1.1: the same without the last `|<nonce>`). Every path, uploads and
  errors included (`clock`, `bad request`, `busy`...). A request whose
  plaintext doesn't parse has no nonce: its `bad request` is bound to `""`,
  which a 1.2 phone refuses (it never sends one).
- The phone opens an answer only with the AAD of the request it just sent
  (`openAnswer` in `mobile/src/lib/client.ts`). An answer recorded earlier,
  for any other request, doesn't open. Bare statuses (401, 404, 413,
  429/503) aren't authenticated and never mark anything as delivered: they
  only stop or delay a sync.
- Standard construction: the request nonce is a fresh 16-byte random value
  the desktop already checks once (replay set), so binding it in the
  answer's AAD is the usual request/response binding (like a TLS
  transcript or an AEAD-sealed RPC id), with nothing new inside the
  plaintext.

### Pairing (QR format `v=2`)
`hivo://pair?v=2&d=<deviceId>&t=<token>&x=<desktop X25519 public key>&h=<host1>,<host2>&p=<port>&n=<desktop name>`
- `t`: 32 random bytes, **works once, for 5 minutes** (`PAIR_TTL_MS`),
  kept in memory only (a restart voids every QR shown). `x`: a fresh X25519
  key pair per QR; its secret never leaves memory. No device key anywhere
  in the QR. "Pair a phone" drops the previous unused QR; "Re-pair this
  phone" makes one for the same `d`.
- The phone makes its own X25519 key pair and derives the device key:
  ```
  shared = X25519(phone secret, desktop public)        // desktop: X25519(desktop secret, phone public)
  key    = HKDF-SHA256(salt = token, ikm = shared,
                       info = "hivo-sync-v1.2|pair|" + deviceId + "|" + b64url(desktop pub) + "|" + b64url(phone pub),
                       length = 32)
  ```
  The token is mixed in as the HKDF salt, the way Noise's `psk` modes and
  WireGuard's preshared key mix a secret into a DH: the token alone (a photo
  of the QR) gives no key, the DH alone (someone on the Wi-Fi without the
  QR) gives no key either. Both public keys and the device id are bound in
  `info`. An all-zero shared secret (a low-order point) is refused on both
  sides.
- First request: `POST /v1/pair`, header `X-Hivo-Device: <deviceId>`, body
  `{"n", "c", "x": "<phone X25519 public key, b64url>"}`, the envelope
  sealed with the derived key, AAD `hivo-sync-v1|<deviceId>|/v1/pair`,
  payload as hello (`{"phoneName", "appVersion"}`). The desktop derives the
  same key from `x`; if the envelope opens, the phone had the token. The
  QR is then burnt, the device is stored with its key (`derived: true` in
  `phone-sync.json`; a re-pair replaces the key in place, name kept, the
  old key works until this moment), and the answer is a hello answer,
  bound to the request's nonce. Opening it proves to the phone that it is
  talking to the computer that showed the QR (only it has the X25519
  secret).
- Refusals: wrong token, unknown device, QR used, replaced or expired →
  bare 401 (the phone says "This code was already used or is more than 5
  minutes old: show a new one", `expired`). A failed attempt doesn't burn
  the QR (the real phone can still use it). A `clock` error doesn't finish
  the pairing either. A phone whose `/v1/pair` answer was lost (no answer,
  `busy`) sends it once more a second later with the same key, and gets an
  answer (the desktop opens it with the key it stored).
- Who can pair: whoever scans the QR first within 5 minutes, but since
  the "v1.2 addition" below nothing works until the user confirms on the
  desktop that both screens show the same code. A second phone with the
  same QR gets `expired`; one that pairs in your place shows a code your
  phone doesn't (yours says `expired`): "Not my phone" drops it.

### Version negotiation and compatibility
- `/v1/hello` (and `/v1/pair`) answer `{"desktopName", "hivoVersion", "protocol": "1.2", "computerId"}`
  (`computerId` and `/v1/pair`'s `"confirm": "pending"`: "v1.2 addition" below).
- **New pairings always use v1.2** (the desktop only makes `v=2` QRs).
  A 1.1 phone scanning one says "This link is for another version of
  Hivo. Update the app." (`version`).
- **Phones paired before 1.2** keep their key and keep working: the
  desktop binds its answers when the request says `v` ≥ 1.2 and answers
  in the 1.1 form only to a phone paired the old way that doesn't (a 1.1
  phone). Settings → Phone sync marks those rows "Paired with an older
  Hivo: re-pair it to upgrade its security" (`legacyPairing` in the
  status), with an orange Re-pair button that shows a `v=2` QR for the
  same device.
- **A 1.2 phone on an old pairing**: takes unbound answers until the
  computer answers bound once (its Hivo was updated), then saves
  `bound: true` with the pairing and refuses unbound answers from then on
  (no downgrade). A 1.2 pairing (`scheme: "1.2"`) never takes one.
- **A 1.2 phone and a 1.1 desktop**: a `v=1` QR still pairs as before; a
  1.1 desktop never makes a `v=2` one (and answers `/v1/pair` with 404,
  `outdated`).
- Downgrading the desktop below 1.2 after a v1.2 pairing: the older
  desktop answers unbound, the phone refuses ("The desktop answered with
  an error"); update the desktop or pair again.

### Replay set across restarts
Every accepted `(device, nonce)` is appended to `phone-sync.replay` next to
`phone-sync.json` (owner-only) before the request is answered. At start the
desktop reloads the entries of the last 10 minutes (`NONCE_TTL_MS`, more
than twice the 2-minute window) and rewrites the file with those only; it
is rewritten the same way every 10 000 appends. A request replayed right
after a restart is still a replay (bare 401). If the log can't be written,
the request is refused as `busy` (fail closed). Nonces are printable ASCII
(1 to 64 characters), else `bad request`.

### Tests
- Rust (`phone_sync.rs`): `key_derivation_test_vector`,
  `pairing_is_one_time_and_expires`, `answers_are_bound_to_the_request`,
  `a_phone_paired_before_1_2_still_works_and_can_upgrade`,
  `a_replay_after_a_restart_is_refused`.
- Phone (`mobile/src/lib/handshake.test.ts`): the same vector, pairing
  against a fake 1.2 desktop (single use, a stranger's answer refused),
  binding, hello negotiation (1.1 desktop, upgrade, no downgrade).
- Shared vector: desktop secret = bytes 1..32, phone secret = bytes
  0x21..0x40, token = 32 × 0x55, deviceId = b64url(16 × 0x07) →
  desktop pub `B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw`, phone pub
  `WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns`, key
  `nuf6rptKkMpoSSsZ3ooSuRlVMKdcr0uHlFRRwqLz8bQ` (also checked with
  Node's own X25519 + HKDF).
- `scripts/e2e-phone-sync.sh`: the real Rust server shows a `v=2` QR, the
  phone's real client pairs with it, a second use is refused, every request
  gets `pending` until the code is confirmed on the desktop side (a test
  hook: the phone test writes `<deviceId> <code>` to `confirm`, the server
  confirms only when that's the code it shows; a wrong code is refused),
  then it syncs, sends ideas and a sketch; an old-style pairing still works
  and gets bound answers, with the same `computerId`.

## v1.2 addition: confirmation code, computer id (2026-11)

Documented as part of 1.2, not a new version: 1.2 had not shipped in a
release yet (last tag v0.6.1), so no 1.2 phone exists without it. The
protocol string stays `"1.2"`, the QR stays `v=2`, the key derivation and
its test vector don't change.

### Confirmation code
Closes the gap left in 1.2: whoever scanned the QR first within its 5
minutes paired in your place.
- Both sides compute, never send, a 6-digit code from the pairing transcript:
  ```
  code = HKDF-SHA256(salt = token, ikm = desktop pub || phone pub (64 bytes),
                     info = "hivo-sync-v1.2|confirm|" + deviceId, length = 4)
         read as a big-endian u32, mod 1 000 000, zero-padded to 6 digits
  ```
  (`confirm_code` in `phone_sync.rs`, `confirmCode` in
  `mobile/src/lib/handshake.ts`). Shown as `123 456`. The token is secret
  (salt), so nobody without the QR can predict a code, and the phone's
  public key is in it: a phone other than yours (or someone swapping the
  key on the Wi-Fi) shows another code than the desktop, or none.
- After a first `/v1/pair` opens, the QR is burnt as before, but the phone
  is **not stored**: it waits in memory (`Confirming`: its key, the code,
  the name it sent) and the `/v1/pair` answer adds `"confirm": "pending"`.
  The phone shows the code ("Check the code on your computer",
  `ConfirmPairing.tsx`) and asks `/v1/hello` every 2 s.
- Until confirmed, every request opened with that key, on every path, gets
  the sealed, bound `{"ok": false, "error": "pending"}` (the phone's
  `pending` error); nothing reaches the webview or the inbox. A retried
  `/v1/pair` gets the pair answer with `"confirm": "pending"` again.
- Desktop (Settings → Phone sync): the code, the phone's name, **Confirm**
  and **Not my phone** (`phone_sync_confirm`, `accept` true / false;
  `status.confirming`). Confirm opens a native dialog repeating the code
  (the webview can't confirm a phone by itself, like "Pair a phone"); only
  then is the device stored in `phone-sync.json` with its key, name and
  app version, and its requests work. Not my phone (or Forget) drops it.
- A pairing not confirmed within 5 minutes (`CONFIRM_TTL_MS` = 300 000,
  paired in `phone_sync.rs` and `mobile/src/lib/confirm.ts`), or still
  waiting when Hivo quits, is dropped: its key opens nothing, the phone gets
  a bare 401 and says `not-confirmed` ("pair again and check that both
  codes match"). A user cancelling on the phone saves nothing either.
- A re-pair ("Re-pair this phone"): the new key waits the same way while
  the old key keeps working; Confirm replaces it, Not my phone keeps the
  old one. A new pairing waiting counts against the 20-phone limit.
- Unaffected: phones paired before 1.2 and phones already paired (stored)
  never see `pending`.

### Computer id
- `phone-sync.json` holds `computerId`: 16 random bytes, base64url, made
  once per install the first time a phone asks (same owner-only, atomic
  file; not a secret). `/v1/hello` and `/v1/pair` return it.
- The phone keeps it with the pairing (`Pairing.computerId`, also learned
  from the first hello of a pairing made before). Pairing again:
  - **same computer id** as the current pairing (a re-pair, or a new QR
    from the same computer): the library cache, the notes waiting to sync
    and the conflicts stay as they are (`carryOver` in `confirm.ts`);
  - another id (or none): as before, only the phone's own text is kept and
    re-based on the new computer's first snapshot.
- Ideas and memos are bound to `computer:<id>` instead of the device id
  (`extrasBinding`): pairing again with the same computer, even after
  "Unpair", sends nothing again; another computer gets everything still on
  the phone, as before. A binding saved by device id moves to the computer
  id on the first sync after the update, without re-sending.
- Limit: the desktop's inbox is keyed by device id, so after pairing again
  with a new device id, statuses ("filed") of items sent under the old one
  stop updating on the phone (they keep the last one they had). An
  explicit "Unpair" still drops the library cache (the phone's own text
  stays).

### Tests (addition)
- Rust: `confirmation_code_test_vector`, `a_pairing_is_pending_until_confirmed`,
  `not_my_phone_and_a_timeout_drop_the_pairing` (reject, timeout, refused
  re-pair, restart), `the_computer_id_is_stable_across_restarts`.
- Phone: the same vector in `handshake.test.ts` (and a pending fake
  desktop), `confirm.test.ts` (waiting, not-confirmed, timeout, cancel,
  same-computer carry-over, extras binding).
- Shared vector (same inputs as the key vector): code `654180` (also
  checked with Node's HKDF).

## Phone-side reliability (2026-11, 0.7.1; no protocol change)
- **Refused vs offline:** a request that gets no answer is "off" (phone sync
  off, Hivo closed) only when a plain TCP connect to that host is refused
  (`probeTcp` in `modules/hivo-share`); anything else (no route, Wi-Fi off,
  timeout) is "offline". The offline message mentions a Wi-Fi without
  internet (Android then routes over mobile data; the app doesn't bind to
  the Wi-Fi network).
- **Finding the computer again** (`src/lib/discover.ts`, 0.7.1: manual
  only, never after a failed sync): Settings → "Look for my computer
  again" sends the usual sealed `/v1/hello` to the saved hosts first (4 s
  each; one answering = "It's at its usual address"), then to each address
  of the /24 the phone is on now (`localIPv4s` in `modules/hivo-share`:
  private IPv4 on a `wlan*`/`eth*` interface, never mobile data), or, when
  the phone can't tell, of the saved hosts' /24s (2 networks max), 32 at a
  time, 1.5 s each, with progress, Cancel, and the screen kept on. Only an
  answer that opens with the pairing's key (or a sealed error: clock, demo,
  read only, pending) counts; the new address goes first in the saved
  hosts. A desktop sees at most one hello from this phone per address, the
  same request as at launch (it carries the device id in `X-Hivo-Device`,
  as every request does).
- **Storage** (`src/lib/persist.ts`): rows read one by one, a row that can't
  be read is never written over, the library cache is a file
  (`<documents>/hivo-data/library-cache.json`, atomic write) moved once from
  the old `hivo.sync.v1` row. A stopped voice memo is in the outbox at once
  as `state: "draft"` (never sent until Keep). Shares that reached the app
  are remembered (`hivo.share.pending.v1`) until sent or left.
- **Sync control:** a sync is cancelled on unpair / pair (no upload goes on
  to the old computer), restarted when it got no answer for over a minute (not since
  it started: a long upload that keeps sending goes on) and the app
  comes back, skipped on return when one finished under 30 s ago; the
  screen stays on while an upload sends; a desktop that answers
  `offset:n` without moving forward 5 times holds the item
  ("desktop-error") instead of looping.
