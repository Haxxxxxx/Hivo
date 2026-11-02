# November plan: finish crew sharing; the mobile creation companion after

Status (2026-10-27): **parts A and A2 done** (except the crew pitch, in progress, and the Windows test, later); **part B steps 1-3 shipped** in 0.6.0-0.6.1, **step 4 built** (ships as 0.7.0); **part C** is the backlog added 2026-10-27. Asked for on 2026-10-25. Order decided by the user: part A (crew), then part A2 (finish the brief), then part B (mobile), then part C. Tracking: tick items here as they close, and the matching boxes in ROADMAP.md section 7.

**Release cadence (2026-10-27):** releases are batched. Fixes wait on `main` and ship with the next finished step; step 4 ships as **0.7.0**. A patch release only for something that breaks installed apps with no workaround.

---

## Part A: crew and sharing (first)

Guardrail 4.1: nothing new is built on the crew foundation until a human has verified it end to end. This part is that verification, plus the fixes it turns up.

### A1. The "I shared a song and nothing shows" report (2026-10-24)
What the local workspace says (read-only check, 2026-10-25): one song is marked shared, with a share id, the crew set, its stage settled and nothing pending. So the desktop side believes the push went through, and the row most likely exists on the server. Suspects, in order:
1. **The viewer is on another crew** (the website and the desktop each remember their own active crew).
2. **The other account isn't a member** of that crew, or joined a different one.
3. **Live updates** didn't deliver the row, and the view never reloaded.
4. A refusal the panel didn't show clearly.

Steps: reproduce with two accounts (yours plus a test account added in the Supabase dashboard, since sign-up is closed), and note what each screen shows. Fix whatever it is, plus a clear "shared to *crew name*, visible on the board" confirmation after sharing.

### A2. Human end-to-end test (the checklist that unlocks guardrail 4.1)
| # | Step | Where | Pass when |
|---|---|---|---|
| 1 | Sign in with the email code | desktop + website | code arrives within a minute |
| 2 | Create a crew, make an invite code | desktop | code shown, copyable |
| 3 | Second account joins with the code | website **and** desktop | both see the crew |
| 4 | Share a song | desktop (owner) | appears on the other account's crew board, desktop and website, without a reload |
| 5 | Move its stage on the website | website (member) | owner's desktop applies it |
| 6 | Move it on both sides while one is offline | both | conflict banner, nothing lost |
| 7 | Share a release | desktop | shows in Crew releases on both |
| 8 | Stop sharing | desktop | disappears everywhere |
| 9 | Remove the member | desktop (owner) | they lose access; old invite codes stop working |

### A3. Open crew items found in the code
- **Deleting a crew** and **owner actions on the website**: moved to part C (C1).
- ✅ **Sign-in emails** go through Brevo (custom SMTP); the codes arrived during the test.
- ✅ **A second account** was used for the test (2026-10-25).

### A4. Done when (✅ passed 2026-10-25: the flow works with several accounts; the only finding was the invite copy button being too small, fixed)
All nine checklist steps pass with two real accounts and A1 is fixed. Then part A2.

---

## Part A2: finish the initial brief (after A, before B)

What's left of the original roadmap (see [ROADMAP.md](ROADMAP.md) section 7). Code first, then tests, then the human items.

| # | Item | Who | Notes |
|---|---|---|---|
| 1 | ✅ **Launch Kit hand-off** (audit §3 A1-A4, done 2026-10-25, PR fix/launch-kit-handoff): save the suggested release date on accept/export; stage control and a way back to the song in the kit header; remap the kit after a relink (never show another song); "Render now" / "Open Settings" on the no-mixdown and no-export-folder checks | Claude | The real breaks between "finished" and "released". The rest of §3 (A5-A6, B1-B13) closed 2026-10-27 (PR fix/launch-kit-loose-ends). |
| 2 | **Delete a crew**; **owner actions on the website** | Claude | Moved to part C (C1): the part A test (2026-10-25) didn't need them. |
| 3 | ✅ **Hook detection on real songs** | You | Works on real tracks (2026-10-25). |
| 4 | **Windows installer on a real PC** | You or a crewmate | **Later** (2026-10-27): the Mac build is the reference for now; both builds come from the same code and the same release run. |
| 5 | ✅ **Ship the brief's fixes** | You | Shipped in 0.5.5-0.6.1 (the Launch Kit fixes went out with 0.6.0). |
| 6 | **The crew pitch** (Phase 0) | You, with Claude on the web (outside this repo) | **In progress.** What it solves for them, six months out, what you need from them. November milestone: the crew lives in the board. |
| 7 | ✅ **Git history scrub** (Phase 0) | Done 2026-10-25: rewritten with git-filter-repo, pushed by you, verified clean on GitHub (26 refs) | Old commits in the public repo still contain artist names and a personal email. Rewrites every commit and force-pushes `main`. |

### A2 done when
The roadmap's section 7 has no open box except Phase 2, Google Play and the mobile step 4. Left: the pitch and the Windows test.

---

## Part B: the mobile creation companion (after parts A and A2, on the side)

### B0. What it's for (the user's words, condensed)
Hivo helps you untangle your notes on each beat you pick, and the rest of the writing and creation process: lyrics, ideas, voice memos. You write on the phone; the desktop has it while you work in FL Studio. BandLab projects (and other mobile sketches) can be sent to FL through Hivo for detailed work.

### B-now. BandLab exports (clarified 2026-10-25)
**BandLab import belongs to the phone app**, next to taking notes on the prods stored on the desktop. A desktop "Import from BandLab" button was built by mistake (PR #143, draft, not shipped). What stays from it is the **desktop's receiving side**: a BandLab export sent from the phone is filed as a **sketch song** in a project folder (`<project folder>/<name>/BandLab/`, listed by the scanner, playable, with notes and credits), and **"Continue in FL Studio"** turns it into a new `.flp` from a template next to the audio, with each BandLab file already on its own playlist track (user override 2026-10-27: Hivo writes only new sketch projects, never an existing `.flp`). The desktop Library button is dropped when #143 is reworked for step 4.

### B1. Decisions made (2026-10-25)
- **Nothing written on the phone goes to Hivo's server.** No lyrics, notes, ideas or voice memos in Supabase.
- **The phone and the desktop sync directly over the same Wi-Fi.** That needs a **native app** (browsers block a secure website from talking to a local address), so the mobile app is native (Expo / React Native) and the PWA idea is dropped: without sync it would only be a separate notepad.
- **Timing:** native is "on the side": it starts after part A and isn't promised for November.
- **Distribution (updated 2026-10-25):** Android through a free **APK on the website** (`/download/android`, with an in-app update banner) **and Google Play** (the user has a developer account; the first Play upload is manual). Both from the same release tag as the desktop, version **0.6.0** first. **No iOS distribution for now.** Earlier note, still true when iOS comes back: TestFlight is part of the Apple Developer Program, **99 USD a year**: there's no free TestFlight. A free Apple ID only lets you install your own builds from Xcode on your own phone, and they expire after 7 days. Guardrail 7: decide on the Apple account when the iOS build is ready for the crew.
- **Testing (decided 2026-10-25), all free:** iOS in the **Xcode Simulator** (Xcode 26.6 with iOS 26.0 and 26.5 runtimes is installed on the Mac; no Apple account needed), Android on a **physical phone** over `adb` (installed, with the Android SDK). The Simulator shares the Mac's network, so it pairs with the Hivo desktop app on the same Mac; the Android phone pairs over the studio Wi-Fi. Simulator gaps to check on a real iPhone before the crew beta: the camera (QR pairing: type the pairing code instead in the Simulator), the microphone quality for voice memos, background behaviour.
- **v1 includes** the ideas inbox and voice memos.

### B2. How the direct sync works
- **Opt-in on the desktop:** Settings → Phone sync (off by default). Only while it's on, the desktop app listens on the local network. Turning it off closes the port. (mDNS / Bonjour `_hivo._tcp` announcement: not in v1, the QR carries the addresses; see [PHONE-SYNC.md](PHONE-SYNC.md).)
- **Pairing once:** the desktop shows a QR code holding a random per-phone key, the desktop's addresses and port. The phone scans it, and both keep the device key. Unpaired devices get nothing; Settings lists paired phones with "Forget".
- **Encrypted and authenticated:** ~~TLS pinned to the fingerprint from the QR code~~ **changed 2026-10-25: plain HTTP on the LAN, every body an encrypted envelope (XChaCha20-Poly1305) with the pairing key**, plus a timestamp window and nonce set against replays. Same guarantees (nothing readable or forgeable on the network) without native SSL pinning on the phone. Contract: [PHONE-SYNC.md](PHONE-SYNC.md).
- **Offline first:** the phone keeps everything locally (SQLite) and queues changes; they sync whenever both are on the same Wi-Fi with the desktop app open. The phone shows "Last synced with *desktop name*: 2 h ago".
- **Conflicts:** every note carries a version. If both sides changed the same note since the last sync, both copies are kept (yours, plus "from the desktop" below a marker) for you to merge by hand. No silent overwrite, no clock trusted.
- **Files (voice memos, BandLab exports)** travel over the same paired connection, in chunks, and land in the song's or beat's folder on the desktop.
- **Firewall:** macOS and Windows ask once to allow incoming connections when Phone sync is first turned on; the app says so beforehand.

### B3. Feature list (v1)

**Phone (native)**
1. ✅ **Your prods and songs** (user, 2026-10-25: all three): the Digger's **saved prods** (link and facts), the **beats** in the beats folders, and the **songs** (projects), as the desktop sends them at sync (names, BPM, key, stage). New ideas can be named on the phone (with the ideas inbox, step 4).
2. ✅ **Notes and lyrics per saved prod, beat or song:** plain text with section headers (`[Verse 1]`, `[Hook]`…), a syllable count per line, a bar estimate from the BPM. Works offline.
3. ✅ **Ideas inbox:** punchlines, titles, concepts without a beat; attach them later.
4. ✅ **Voice memos:** record a flow or melody, attached to a beat or a song (up to 15 min).
5. **Receive BandLab exports (and other sketches):** "Share to Hivo" from BandLab's export (mixdown or stems) through the system share sheet; it's attached to a beat or kept as a new sketch, and goes to the desktop at the next sync. ✅ (Android; no iOS share target yet.)
6. ✅ **Sync status** and the paired desktop's name.

**Desktop**
1. ✅ **Notes on saved prods and beats** in the Digger (stored in the workspace, not in the lead files, so re-saving a prod never wipes them; side panel with preview), and the song's existing notes in its drawer. When a beat becomes a song (a new FL project: "Start a song" in the beat's notes panel), its notes move with it, the phone memos linked to it are copied into the song's `Voice memos/`, and a producer credit is offered; the beat file stays where it is. The desktop holds every note; the phone syncs to it.
2. ✅ **Phone sync** in Settings: on/off, pairing QR code, paired phones, last sync.
3. ✅ **Inbox:** what came from the phone and isn't attached yet (ideas, memos, sketches), to assign to a beat or a song.
4. ✅ **Session view (teleprompter):** a window kept on top of FL Studio, showing the lyrics large, section by section; arrow keys or auto-scroll at the BPM.
5. ✅ **Sketch → FL:** a BandLab export from the phone becomes a sketch song in a project folder, exactly like "Import a BandLab export" (B-now), then "Continue in FL Studio".

**Later (each needs a yes):** rhyme suggestions, lyrics in the Launch Kit, sharing one song's lyrics with a featured artist, sync away from home (would need a relay: the server question again).

**Out:** recording or mixing on the phone, chat, a social feed, AI-written lyrics.

### B4. Rough timeline (starts when part A is done)
| Step | Work |
|---|---|
| 1 | ✅ **Shipped in 0.6.0** (#148 for the side panel): desktop notes on saved prods and beats (songs already had notes). Order confirmed 2026-10-25: notes → sync → Android APK. |
| 2 | ✅ **Shipped in 0.6.0** (#146): phone sync server (pairing QR, encrypted envelope with the pairing key instead of pinned TLS, replay protection, snapshot + notes), with tests. mDNS left out of v1. |
| 3 | ✅ **Shipped in 0.6.0-0.6.1** (#147, #150): phone (Expo) pairing, saved prods / beats / songs lists, offline notes editor, sync. Android APK on the website; iOS in the Simulator. Pairing verified on a real Android phone (2026-10-27); the Android 11+ Play-services fix (#152) is on `main` and ships with 0.7.0. |
| 4 | ✅ **Built 2026-10-27, ships as 0.7.0** (branch `feature/phase-b-step4`): "Share to Hivo" on Android (audio, `.zip` stems, text → an idea) and "Add a file", resumable chunked uploads, voice memos (15 min), ideas with a target, the phone's Inbox tab; the desktop's Phone inbox page (idea → note, memo → song's `Voice memos/` or a beat/prod, export → sketch song with Continue in FL), the session view window. Error states decided up front in PHONE-SYNC.md v1.1. Tested: unit tests both sides, the real Rust server against the phone's real client (`scripts/e2e-phone-sync.sh`), and the APK on an Android emulator against that server (share from the Files app, recording, idea; bytes identical on arrival). |
| 5 | Distribution (decided 2026-10-25): Android **APK on the website** ✅ + **Google Play** (AAB from the release workflow, uploaded by hand; internal testing first; **Play Console setup in progress**); privacy policy at `/en/privacy` and `/fr/privacy` ✅. **iOS not now.** |

Steps 1 to 3 took about two days; step 4 is the largest (file transfer and the share target are new on both sides). Native isn't a November promise.

### B5. Done when
You write a verse on the phone for a beat, walk into the studio, the phone syncs over Wi-Fi, and the session view shows it next to FL; a BandLab export becomes a new song folder with its stems; nothing touched Hivo's server.

---

## Part C: the backlog (added 2026-10-27, after part B step 4)

Asked for on 2026-10-27. Audit §3 (the Launch Kit loose ends) was closed first, as asked. Each item says what it needs first; the plan below orders them.

| # | Item | What it means | Needs first |
|---|---|---|---|
| C1 | **Delete a crew; owner actions on the website** | The owner can delete the crew (every member loses access, shared rows go, nothing local is touched). The website gets the owner's tools: invite code (make, copy, revoke), remove a member, rename, columns. | A security-definer function + pgTAP tests for the delete; the website reuses the desktop's calls. |
| C2 | **Stems** | Export stems from the app (today they're detected and shown, not created). FL Studio only at first, like render. | A check of what FL's command line can export per mixer track. |
| C3 | **Per-distributor export formats** | The Launch Kit writes the sheet in each distributor's own layout (fields, order, limits) instead of one universal sheet. | The list of distributors the crew actually uses. |
| C4 | **The Pace tendency block** | How long your songs stay in each stage, and where they stall. | A log of stage changes (when each song entered each stage), kept in the workspace from now on: no history exists before it. |
| C5 | **"In your prods" for every prod** | Today a saved prod is marked "In your prods" only when a WAV or MP3 with a matching name sits in a beats folder from Settings. It should also confirm prods in other audio formats (FLAC, AIFF, M4A, OGG) and prods saved in another folder (Downloads, a converter's folder), and say where the file was found, with "Move to beats folder" when it's outside. Hivo still never downloads. | Which extra folders to look in: a "Downloads" toggle plus folders picked in Settings (path scoping stays in Rust). |

### The plan (2026-10-27)

Order: what's cheap and unblocked first, what needs an answer from you last. One release (0.8.0) when C1, C4 and C5 are in; C2 and C3 can follow in the next one.

| Order | Item | Size | Steps | Done when |
|---|---|---|---|---|
| 1 | **C4 stage log** (log ✅ 2026-10-27, `src/lib/stageLog.ts`; the block comes later) | S now, M for the block | 1. `SongMeta.stageLog: {stage, atMs}[]`, appended by every stage change (drawer, board drag, kit, crew pull), capped (last 50). 2. Workspace migration adds an empty log; a song's first entry is today, never a guess. 3. Later: `pace()` in `src/lib/tendencies.ts` (median days per stage, the stage where songs stall) and a hidden-by-default **Pace** block. Personal only, never shared, no release stats (guardrail 6). | Every stage change lands in the log (unit tests); the block appears once a few weeks of history exist. |
| 2 | ✅ **C1 delete a crew** (desktop, 2026-10-27: `delete_crew`, Crew settings → Delete this crew) | M | 1. Migration: `delete_crew(crew_id)` security definer, owner only, `set search_path = ''`; deletes the crew (songs, releases, columns, invites, members cascade) with the `after_member_left` trigger skipped during the cascade (session flag), so it doesn't try to hand the crew over mid-delete. 2. Drop the direct `crews_delete` policy: the function is the only way. 3. pgTAP: owner deletes; member, outsider and anon can't; nothing of another crew is touched; trigger doesn't fire. 4. Desktop: "Delete crew" in Crew settings (owner), typed-name confirm, says what goes (shared rows) and what stays (everything local); sync stops, the app goes solo. | `supabase test db` green; deleting from one computer sends every member to solo mode on their next pull. |
| 3 | ✅ **C1 owner actions on the website** (2026-10-27: invites, remove, rename, leave, delete; columns stay in the app) | M | Reuse the desktop's calls (`src/lib/crewSync.ts`, the RPCs): invite code make/copy/revoke, remove a member, rename, columns, delete. Fix the web's dead-end texts (audit §6 A4, §7 B2-B3). Data still goes browser → Supabase, never through Vercel. | An owner can run the crew from the website alone. |
| 4 | **C5 "In your prods" everywhere** | M | 1. `matchBeat` accepts every format `is_beat_file` knows (wav, mp3, ogg, flac) plus aiff and m4a. 2. Settings → Saved prods: a "Downloads" toggle and picked folders (`Settings.prodMatchFolders`, picked in Rust; `Scope::prod_match`, read-only). 3. A Rust command lists those folders' audio names (no content read, depth-limited). 4. The lead shows where the file was found; when it's outside the beats folders, "Move to beats folder" (a Rust move into the first beats folder, never overwrite). Still never downloads. | A prod converted to FLAC into Downloads shows "In your prods (Downloads)" and moves in one click. |
| 5 | **C2 stems, guided** | S | FL's command line renders the master only (checked), so Hivo can't export stems itself. Instead: a "Export stems" helper in the drawer opens the project and shows the 4 clicks in FL (File → Export → Split mixer tracks) with the song's stems folder ready; Hivo then detects the stems as it does today. | The helper gets a song from "no stems" to stems detected without leaving Hivo's instructions. |
| 6 | **C3 per-distributor formats** | M per distributor | `src/lib/distributors.ts`: per distributor the fields, order, limits (title length, genres list, ISRC/UPC rules) and the file layout; the Launch Kit export gets a distributor picker; checks warn on a field that breaks a limit. Generic stays the default. | Needs your answer first (below). |

**Open questions for you**
- **C3:** which distributors does the crew actually use (DistroKid, TuneCore, CD Baby, Amuse, Spinnup, Believe/TuneCore, Ditto, other)? Nothing starts on C3 before the list.
- **C1:** should a member see "your crew was deleted by the owner" once, or just land in solo mode? Default: one line, once.
- **C5:** is Downloads enough as the default extra place, or do converters drop files somewhere else for you? Default: Downloads plus folders you pick.

