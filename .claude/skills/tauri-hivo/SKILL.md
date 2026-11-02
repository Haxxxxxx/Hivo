---
name: tauri-hivo
description: Hivo's Tauri 2 conventions on top of the generic tauri-v2 skill: which plugins are used (opener, dialog, updater, process; never shell), the strict host-pinned CSP kept identical in csp and devCsp, minimal capabilities, path scoping in Rust, the drop guard, paired constants, and the npm/crate version check. Use before touching src-tauri/, tauri.conf.json, capabilities, or any Rust command.
---

# Tauri in Hivo

Use the generic `tauri-v2` skill for the framework; this is what's decided here.

## Plugins and permissions
- Plugins: `opener` (open URLs and reveal files), `dialog`, `updater`, `process`.
  **Never `tauri-plugin-shell`**: the generic skill suggests it for URLs; here
  `openExternal()` in `src/lib/tauri.ts` goes through `opener`, whose default
  URL list already covers http(s) and `mailto:`.
- `src-tauri/capabilities/default.json` stays minimal: `core:default`, the window
  destroy permission, `opener:allow-open-url` + `allow-default-urls`,
  `updater:default`, `process:default`. Add a permission only with the feature
  that needs it, and check the id in `src-tauri/gen/schemas` after `cargo check`.
- **App commands are ACL'd**: `src-tauri/build.rs` declares every command
  (`AppManifest::commands`, which generates `allow-<command>`), `default.json`
  grants each one to the main window, `session.json` grants none (the session
  window only uses events, keep-on-top and close). A new command goes in
  `generate_handler!`, `build.rs` and `default.json`; the Rust test
  `app_commands_are_declared_and_granted` fails otherwise, and a missing grant
  is a "not allowed" error at runtime.
- `freezePrototype` stays off: the bundled QR code library assigns
  `exports.toString` on a plain object, which throws once `Object.prototype`
  is frozen (the override mistake).
- Plugin versions: the npm package and the Rust crate must share a major.minor
  (`npm run check:tauri`, also in CI). Stay on the 2.x lines, not 3.0 alphas.

## CSP
- `tauri.conf.json` → `security.csp` **and** `devCsp` are the source of truth and
  must say the same thing apart from the dev server/local Supabase hosts and
  `'unsafe-inline'` in `devCsp`'s `script-src` (the Vite dev server needs it;
  the hosts are otherwise identical). Every
  host is pinned (the Supabase project ref, `i.ytimg.com` and `i.scdn.co` in
  `img-src`, `www.hi-vo.fr` in `frame-src`); never `'unsafe-eval'`, never a
  wildcard. Lookups (MusicBrainz, Deezer, iTunes, Spotify) run in Rust
  (`lookup.rs`), so no lookup host is in `connect-src`. Fonts are
  bundled (`@fontsource`), so no Google Fonts host anywhere.
- The Digger's player frames `https://www.hi-vo.fr/embed.html?v=<id>`
  (`web/public/embed.html`, `EMBED_PAGE` in `src/lib/digger.ts`), not YouTube:
  the webview's `tauri://localhost` origin sends no referrer and YouTube answers
  error 153 without one. The wrapper's own CSP (`web/vercel.json`) lists the
  app origins in `frame-ancestors`; a new app origin must be added there.
  The iframe is sandboxed (`allow-scripts allow-same-origin
  allow-presentation`, inherited by the YouTube frame inside): no popups,
  forms or top navigation.
- Linked folders (watched, beats, samples, export) refuse a drive or volume
  root, the home folder or above, `~/Library` / `~/AppData` and the system
  folders (`too_broad` in `settings.rs`). An unlinked folder is
  `forbid_directory`'d on the asset scope unless a still-linked folder
  overlaps it; Tauri can't un-forbid, so relinking it the same session needs
  a restart for playback.
- `media-src`/`img-src` allow the `asset:` protocol; folders are allowed from
  Rust (`asset_protocol_scope().allow_directory`) only for the user's own folders.

## Paths and commands
- Every command that takes a path goes through `Scope::load(&app)` /
  `Scope::known_file` (`src-tauri/src/scope.rs`): only files under the linked
  project folders, beats folders or the export folder; UNC and device paths are
  refused (`paths.rs`). Never trust a path from the webview.
- `#[serde(deny_unknown_fields)]` on request structs, `clip()`-style caps on every
  string from the webview, and anything that goes into an AI prompt is data,
  never instructions (see `digger.rs`, `ai.rs`).
- Never write to `.flp` files; app data lives in `workspace.json` in the config dir.

## Window
- `dragDropEnabled: false` (the Pipeline needs HTML5 drag-and-drop), so the
  webview would navigate to a dropped file; `src/lib/dropGuard.ts` refuses OS file
  drops at the window level. In-app drags use a custom MIME type, never `Files`.
- Min size 900×600; the drawer is 380px and the sidebar 224px, so views must
  survive ~296px of content or close the drawer on view change (they do).

## Paired constants (keep both sides equal)
- `WAVE_*` in `src/lib/shorts.ts` ↔ `src-tauri/src/shorts.rs`.
- `MAX_QUERY_CHARS`, `MAX_EXCLUDE`, `MAX_KEY_CHARS`, `MAX_FOUND_TITLES`, `MAX_TITLE_CHARS`, `MAX_LIKED` in `src/lib/digger.ts` ↔ `digger.rs`/`youtube.rs`.
- `found_key` (Rust) ↔ `foundKey` (TS): "text | site", or "url | site" when the text is empty.
- `MAX_ANALYZE` in `src/store/useDigger.ts` ↔ `beats.rs`.
- `lead_hash` (Rust, `leads.rs`) ↔ `leadHash` (TS, `digger.ts`): FNV-1a 32-bit
  over the trimmed url's UTF-8 bytes, 8 lowercase hex digits; both tests use
  the vector `"https://youtu.be/dQw4w9WgXcQ"` → `8fd69810`.
- `MAX_LEAD_SLUG` in `src/lib/digger.ts` ↔ `leads.rs`.
- `MAX_CONVERTER_CHARS` in `src/components/SettingsView.tsx` ↔ `settings.rs`.
- `MAX_CHANGES` in `src/lib/phoneSync.ts` and `MAX_NOTE_CHARS` in `src/lib/notes.ts` ↔ `phone_sync.rs`.
- Phone protocol 1.2: `PROTOCOL`, the answer AAD (`resp_aad`) and `PAIR_INFO_PREFIX` / `derive_device_key` in `phone_sync.rs` ↔ `mobile/src/lib/envelope.ts` / `handshake.ts`; both test the same key-derivation vector (docs/PHONE-SYNC.md, v1.2).

## Dev and build
- `npm run tauri dev` watches `src-tauri/`; a branch switch rebuilds and restarts
  the window. `cargo test --locked` is what CI runs; a lockfile the dev build
  rewrote after a merge must be committed.
- Release builds and signing: see the `release` skill.
