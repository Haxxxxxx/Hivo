---
name: release
description: Ship a Hivo release, desktop and Android phone app (tag → self-hosted Mac runner → signed installers, APK and AAB → Supabase releases bucket → draft GitHub Release; Google Play upload by hand) and what to check before and after. Use for any version bump, tag, release failure, updater, Play or download-link question.
---

# Hivo release flow

One tag does everything. **Pushing a `v*` tag ships the update**: the workflow
uploads `latest.json` to the public `releases` bucket before the GitHub Release
draft is even reviewed, and every installed app (0.5.0+) offers it on next launch.
Only tag a commit on `main` that is ready for the crew.

## Before the bump
1. Every PR merged in order and green on CI (`.github/workflows/ci.yml`: tests,
   builds, Rust, audits, pgTAP). CI does **not** run `tauri build`.
2. `npm run check:tauri` passes: every `@tauri-apps/*` npm package and its Rust
   crate share a major.minor, or `tauri build` refuses on the runner
   (this failed the first 0.5.0 run: npm plugin-updater 2.14 vs crate 2.13).
3. Dependabot PRs wait until after the release; majors get their own look.

## The bump (its own PR, merged last)
Same 8 files every time: `package.json`, `web/package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, both lockfiles (only the
root `"version"` lines; regenerate with npm 11 if needed, npm 10.9 crashes with
`edgesOut`), `src-tauri/Cargo.lock` (`cargo update --workspace`),
`web/src/Landing.tsx` (`VERSION`). 10 changed lines, nothing else.

Since 0.6.0 the phone app ships with the same version, so also:
`mobile/app.json` (`expo.version`), `mobile/package.json`, and the two root
`"version"` lines of `mobile/package-lock.json`. The Android `versionCode` is
derived (major*10000 + minor*100 + patch, `mobile/plugins/versionCode.js`):
never set it by hand. The `android` job refuses a tag whose version differs
from `mobile/app.json` or `tauri.conf.json`.

## Tag
```
git checkout main && git pull
git tag v0.5.0 && git push origin v0.5.0
```
Re-tag after a failed run (nothing shipped): `git tag -d vX && git push origin :refs/tags/vX`, then tag again on the new head.

## What the workflow does (`.github/workflows/release.yml`)
Three jobs. The two build jobs run on the self-hosted Mac (`hivo`) with **no
secret at all**; signing and publishing happen on a fresh GitHub-hosted machine.

1. **`build`** (Mac): `Tag is on main` → tag == `tauri.conf.json` version →
   `npm ci --ignore-scripts` → tests → universal macOS build + cross-compiled
   Windows NSIS with `createUpdaterArtifacts` off (no key on the Mac) →
   `Hivo.app.tar.gz` made with `tar` (same `Hivo.app/…` layout tauri makes) →
   artifact `desktop` (tar.gz, dmg, -setup.exe) → draft GitHub Release with the
   dmg and exe.
2. **`android`** (Mac, `needs: build`): phone version == desktop version →
   `cd mobile && npm ci --ignore-scripts`, tests, tsc → `expo prebuild` →
   `assembleRelease -PreactNativeArchitectures=arm64-v8a` with
   `HIVO_DISTRIBUTION=direct` (APK, website) and `bundleRelease` with
   `HIVO_DISTRIBUTION=play` (AAB, Play), both `HIVO_UNSIGNED=1` → artifact
   `android` (unsigned APK + AAB).
3. **`release`** (`ubuntu-latest`, `environment: release`, `needs: [build,
   android]`): signs the updater files with `npx tauri signer sign
   --app-version <ver>` (same version-bound signature tauri build makes), signs
   the APK with `apksigner` and the AAB with `jarsigner` (keystore only inside
   that step), checks both carry the upload certificate (never debug) →
   uploads everything to `v<ver>/` → attaches APK + AAB to the draft → **only
   then** `latest/Hivo.dmg`, `latest/Hivo-setup.exe`, `latest/Hivo.apk`
   (`cache-control: max-age=60`), `latest.json`, `mobile-latest.json` last.
   A failure anywhere before that leaves `latest/` and both manifests as they were.

Watch it: `gh run list --workflow 'Release builds' --limit 1`, `gh run view
<id> --log-failed`. A failed `release` job can be re-run alone (the artifacts
are kept 7 days).

Phone builds: only a build made with `HIVO_DISTRIBUTION=direct` (the website
APK) checks `mobile-latest.json` (at launch, at most once a day); `play` and a
build without the flag (`dev`) never do (fail closed). Signing goes through
`mobile/plugins/withReleaseSigning.js`: `HIVO_UPLOAD_STORE_FILE`,
`HIVO_UPLOAD_STORE_PASSWORD`, `HIVO_UPLOAD_KEY_ALIAS`, `HIVO_UPLOAD_KEY_PASSWORD`
sign it; `HIVO_UNSIGNED=1` leaves it unsigned (the workflow); with neither, a
local release build gets the debug key, and **on CI (`CI` set) the build
fails** instead.

## Owner actions in GitHub settings (one-time; the workflow can't do them)
1. **Environment `release`** (Settings → Environments → New environment):
   add yourself as **required reviewer**, limit deployment branches/tags to
   `v*` tags and `main`, and move the secrets `TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `ANDROID_UPLOAD_KEYSTORE_BASE64`,
   `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and
   `SUPABASE_SERVICE_ROLE_KEY` from repository secrets into it (then delete the
   repository copies). The `release` job then waits for your approval before
   anything is signed or shipped. (Without the environment set up, GitHub
   creates it empty on the first run and repository secrets still work.)
2. **Tag protection**: a ruleset (Settings → Rules → Rulesets → New tag
   ruleset) targeting `v*`, restricting creation, update and deletion to you
   (bypass list), so nobody else with write access can push a release tag.
3. **A password on the Tauri signing key** (it has none today). The key must
   stay the same (installed apps only trust `plugins.updater.pubkey`), so
   re-encrypt it rather than generate a new one: the Tauri key is a base64'd
   minisign secret key, so `base64 --decode < ~/.tauri/hivo.key > k.key`,
   `minisign -C -s k.key` (old password: empty), `base64 < k.key | tr -d '\n'`
   is the new `TAURI_SIGNING_PRIVATE_KEY`, the password goes in
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Check before relying on it: sign a
   test file with `npx tauri signer sign` and the new pair, then delete
   `k.key`. (Not tried here yet.) Empty password secret = no password.

## Google Play (manual, by the user)
The workflow never uploads to Play. After the run: download
`Hivo-<ver>-android.aab` from the draft release and upload it in Play Console
(internal testing first, then promote). The first upload creates the app
(`fr.hivo.mobile`) and enrolls it in Play App Signing; every later upload must
be signed with the same upload key (the GitHub secret). Each upload needs a
higher versionCode, which the version bump gives. Privacy policy URL for the
listing: `https://www.hi-vo.fr/en/privacy` (French: `/fr/privacy`; page in
`web/src/privacyCopy.ts`, keep it true when what an app sends changes). Once
the listing is live, set `PLAY_URL` in `web/src/Landing.tsx` to show the
Google Play button.

## Secrets and places (never print any of them)
All of them are read only by the `release` job (GitHub-hosted), each in the
one step that needs it; never on the self-hosted Mac. They belong in the
`release` environment (see owner actions above).
- `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty
  today): backup at `~/.tauri/hivo.key`. Public half is
  `plugins.updater.pubkey` in `tauri.conf.json`. Never on Vercel.
- `SUPABASE_SERVICE_ROLE_KEY`: used only by the two upload steps. Never in the
  app, never on Vercel.
- `ANDROID_UPLOAD_KEYSTORE_BASE64` (the upload `.jks`, base64),
  `ANDROID_UPLOAD_KEYSTORE_PASSWORD` (store and key password, the same),
  `ANDROID_UPLOAD_KEY_ALIAS`: the phone app's upload key. Keep a
  backup of the keystore and password outside the repo: website APK users can
  only update to an APK signed with the same key. Never commit a keystore
  (`*.jks`, `*.key` are git-ignored in `mobile/`).
- Repo variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_FEEDBACK_EMAIL`.
- Bucket: public `releases` on the Supabase project (migration
  `20261024000000_releases_bucket.sql`). Public read URL:
  `https://<ref>.supabase.co/storage/v1/object/public/releases/<path>`.

## After the run
- `curl -sI https://www.hi-vo.fr/download/mac` → 307 to the bucket, then a 200
  on the target. Same for `/download/windows`. (404 at the bucket = no release
  uploaded yet, normal before the first successful run.)
- `latest.json` exists in the bucket with the new version.
- Phone: `curl -sI https://www.hi-vo.fr/download/android` → 307 to
  `latest/Hivo.apk`; `mobile-latest.json` at the bucket root has the new
  version, the `v<ver>/Hivo-<ver>-android-arm64.apk` URL and its sha256. An
  older website APK shows the update banner on its next launch (a day after its
  last check at most).
- Open the draft on GitHub Releases, check the notes, **Publish**.
- Settings → "Check for updates" on an installed older build finds it.
- First macOS auto-update: watch it by hand once (app is ad-hoc signed, not notarized).
- "Couldn't update: Read-only file system (os error 30)" on macOS = the app runs from
  the mounted .dmg or from Gatekeeper's translocated copy of a downloaded, unnotarized
  app. Fix: move it to Applications with Finder, or `xattr -cr /Applications/Hivo.app`,
  relaunch, retry. Verified on 0.5.0 → 0.5.1 (2026-10-24). The app explains this itself
  since #115; only notarization removes it for good.

## Website (separate, manual)
Vercel project `fl-manager-crew` in the **personal** team (`personnal3`), not
connected to GitHub: `vercel login` (personal account) then
`vercel deploy --prod --scope personnal3` from a linked checkout. Verify the
asset hash changed and the `/download/*` redirects answer 307.

## Local builds
`npm run tauri build` now signs updater artifacts: export
`TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/hivo.key)"` first, or skip them with
`-- --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
