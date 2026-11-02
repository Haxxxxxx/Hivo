---
name: supabase-hivo
description: Hivo's Supabase conventions (crew backend, EU project): migrations, RLS and security-definer functions, pgTAP tests, local stack, linking, db push safety, auth sign-up rules, realtime, the releases bucket. Use before touching anything under supabase/ or the crew sync code.
---

# Supabase in Hivo

Project: `FL-Client`, eu-west-1, ref pinned in `src-tauri/tauri.conf.json` (CSP)
and `web/vercel.json`. Design: `docs/ARCHITECTURE.md`. Only metadata is shared
(never audio, paths, samples, notes, track names). Only the anon key ships in
the apps; the service-role key lives in one GitHub secret for the release upload.
Use the generic `supabase` skill for API/SQL knowledge; this file is what's
specific here.

## Layout
- `supabase/migrations/<YYYYMMDD><HHMMSS>_<topic>.sql`, one topic per file, in
  order: crew → hardening → quota upsert → closed signup invites → stage versions
  → crew columns → member update columns → releases bucket → feedback (`…120000`)
  → feedback global cap → delete crew → crew rename → place crew cards → transfer
  crew ownership → mixdown freshness.
- `supabase/tests/database/<topic>.test.sql`: pgTAP, one file per migration
  topic, same style as the existing ones (plan, helper setup, `is`/`ok`/`throws_ok`,
  finish). A migration without a test is not done.
- `supabase/config.toml`: local stack; auth OTP length 6, expiry 10 min, email
  template carries `{{ .Token }}` (code only; clients use `detectSessionInUrl: false`).

## Where this overrides the generic `supabase` skill
- **Every schema change is a migration file plus a pgTAP test.** Never run SQL
  directly on the hosted project (`supabase db query`, MCP `execute_sql`, the
  dashboard editor), even for "a quick fix": it leaves the migration history
  and local stack out of sync.
- Migration files are hand-named `<YYYYMMDD><HHMMSS>_<topic>.sql`, ordered by
  day then time (`000000` for the day's first, a later time such as `120000`
  for a second topic the same day), not `supabase migration new` timestamps,
  so the order reads.
- The apps ship the legacy anon key on purpose (pinned in the CSPs and
  `web/vercel.json`); switching to a publishable key is a deliberate change
  of all three places plus `.env.local`, not a drive-by.

## Rules that every migration follows
- RLS on every table; `revoke … from public, anon`; grants to `authenticated` only
  for what the client needs; writes go through `security definer` functions with
  explicit checks (`is_crew_member`, owner checks) rather than broad policies.
- Stage moves are version-checked (`stage_updated_at`, `move_song_stage`,
  `move_crew_card`): the earlier move wins, never the clock.
- A remote song/release row is deleted only on explicit unshare, never because a
  scan missed it.
- No path, note, audio or track-name column may ever exist on a shared table.
- Sign-up is closed (`shouldCreateUser: false` in both clients): accounts exist
  only if created in the dashboard (or, if the email-invite feature lands, if the
  email is on a crew's allowed list). Invite codes: 8 chars, 7 days, 10 uses,
  no oracle on wrong codes, 5 tries then a 10-minute lock.
- Realtime: `songs`, `releases`, `crew_columns`, `crew_members` are in the
  publication; DELETE events are unfiltered by design.

## Local stack
```
supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor
supabase db reset        # local only, re-applies every migration
supabase test db         # pgTAP
```
Sign-in emails land in Mailpit: http://127.0.0.1:54324. CI runs the same in
`.github/workflows/ci.yml` (job `database`); a `supabase start` container error
there is a runner flake: re-run the job.

## Hosted project
- Linking is per checkout (`supabase/.temp/`, gitignored). A worktree can copy
  the main checkout's `supabase/.temp/` to be linked (flatten, don't nest).
- `supabase migration list` must show local = remote before any push. A stale
  checkout (behind `origin/main`) shows "remote-only" migrations: pull first,
  that is not a server problem.
- `supabase db push --dry-run` first, always; then `supabase db push`
  (production: the owner runs it).
- Buckets: `releases` is public, created by migration; only CI writes to it.

## Clients
- Desktop: `src/lib/supabase.ts` (null client without env), `src/lib/crewSync.ts`
  (pure payloads/merge), `src/store/useCrewStore.ts` (debounced push 1.5 s,
  realtime pull, never syncs demo data, conflict banner in the song drawer).
- Web: `web/src/store.ts` (own storage keys `flm-crew-web*`, so sessions are
  separate from the desktop), refetch on visibility/online/5 min, `live` flag on
  channel errors. Reuse `@shared` modules (`isFinished`, `crewPipeline`,
  `crewMessages`) instead of re-implementing stage logic.
- Error texts for the user come from `src/lib/crewMessages.ts` (en/fr); map new
  server messages there.
