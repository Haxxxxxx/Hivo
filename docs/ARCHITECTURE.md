# Crew architecture (Phase 1a: shared dashboard)

How Hivo goes from a personal monitor to a crew tool, with **all crew data stored in the EU**.

## The pieces

```
 Desktop app (Tauri, each member's computer)        Web dashboard (static site on Vercel)
   reads FL projects locally                          phones and laptops without FL Studio
   shares chosen songs' metadata ──┐          ┌── reads/updates the crew board
                                   ▼          ▼
                         Supabase (EU region: Ireland, eu-west-1)
                         Postgres + Auth (email code) + Realtime
                         row-level security: only your crew sees your crew's data
```

- **Supabase** (Ireland, `eu-west-1`) holds everything the crew shares: the database, sign-in, and live updates. You choose the region when the project is created, and it can't change afterwards.
- **Web dashboard** is a **static app** (Vite + React, reusing the desktop app's code) hosted on Vercel. The browser talks **directly** to Supabase in Ireland, so **crew data never passes through Vercel's servers**. Vercel only serves the app's code, from its global CDN, like any static website.
- **Server-side code**, if a later feature needs it (social publishing webhooks, distributor APIs), runs as Vercel Functions **pinned to Dublin (`dub1`)**, next to the database, in `vercel.json`. Functions default to the US (`iad1`) otherwise.
- **Desktop app** stays the source of truth for each member's own projects. FL files, audio and file paths never leave the computer. The optional AI features (Gemini text, Cloudflare cover concepts) are separate from crew sharing and send song facts and kit text to those providers, never audio, paths or track names; notes only if the user turns that on.

## What is shared, and what never is

Sharing is **opt-in per song** (and per release). For a shared song the crew sees:

| Shared | Never shared |
|---|---|
| Title (editable for the crew), stage, BPM, key, tags | Audio, mixdowns, stems, snippets |
| Credits (who's on it, role, split) | File paths, folder names, usernames |
| Release date, release membership | Sample and plugin lists |
| "Has a mixdown" and whether it's up to date (`mixdown_fresh`), "Launch Kit accepted" | Notes (private by default) |
| Last FL save date | Mixer track names |
| Crew and display names (sign-in email stays in Supabase Auth) | |

## Accounts and crews

- Sign-in uses an **email code** (6 digits) on desktop and web. It needs no password and no deep-link setup.
- **Sign-up is closed.** Accounts are created by the crew admin in the Supabase dashboard; an email that isn't on the list gets "ask whoever runs Hivo for your crew to add you". This keeps strangers from filling the free project.
- A member **creates a crew** (becoming its owner; at most 3 owned crews per person) and shares an **invite code** (8 characters, expires after 7 days, limited uses). Others **join with the code**.
- **Removing a member revokes the crew's open invite codes**, so they can't come straight back with a code they still have. The owner makes a fresh code for the next person. Leaving on your own revokes nothing.
- Limits per person: 10 crews, 1000 shared songs per crew and 2000 in total.
- Everyone in a crew can see the crew's shared songs and releases, and **move songs between stages**: the board is shared. Only a song's owner can change its other details or stop sharing it.

## Sync rules

- **Push:** when you share a song, or its local data changes, the desktop app upserts that song's shared fields. Every shared song has a stable id stored in the local workspace.
- **Pull and live updates:** the desktop app and the web app subscribe to the crew's songs. If someone moves *your* song to another stage on the board, your desktop app applies it.
- **Conflicts:** a stage move carries the version it was made on (`move_song_stage`, compared with `stage_updated_at`); no computer's clock is trusted. If a crewmate moved the song since, the move isn't applied: on the board the crewmate's move stands and the app says so; for a move waiting on the owner's computer (offline, or sent late), the owner sees "X moved it to Y meanwhile: keep theirs or yours?". Every other field is owner-only, so there's nothing to merge.
- **Offline:** the desktop app works fully offline, as today. Sharing catches up the next time it's online.

## Security

- Only the Supabase **public anon key** and the project URL ship in the apps (from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`). They're safe to publish because **row-level security** enforces every rule in the database itself. The service-role key is never in any app or repo.
- Writes that need extra checks (create crew, invite, join, move a song's stage) go through Postgres functions that check membership.
- Covered by database tests (`supabase test db`, pgTAP): outsiders see nothing, members can't edit others' songs, invites expire and run out, ids can't be reassigned.

## Email

Supabase sends the sign-in codes. Its built-in mailer is rate-limited and meant for testing. Before inviting the crew, set a custom SMTP sender (an EU provider such as Brevo) in the Supabase dashboard.

## Repo layout

```
src/, src-tauri/         desktop app (unchanged structure)
supabase/                config.toml, migrations/, tests/ (local dev: `supabase start`)
web/                     web dashboard (Vite + React), deployed to Vercel
docs/ARCHITECTURE.md     this file
```
