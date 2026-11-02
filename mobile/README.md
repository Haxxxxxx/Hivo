# Hivo for the phone

The phone half of phase B (docs/NOVEMBER-PLAN.md): an Expo (React Native,
TypeScript strict) app that pairs with the Hivo desktop app over the local
Wi-Fi and lets you read and write notes on the desktop's **saved prods**,
**beats** and **songs**. Nothing goes through a server: the phone talks to the
desktop directly, every body encrypted with the key from the pairing QR code
(XChaCha20-Poly1305, see the phone sync contract).

This folder is its own project (own `package.json` and lockfile). The root
`npm test` / `npm run build` ignore it.

## Layout

| Path | What |
|---|---|
| `App.tsx` | Fonts, locale, the tiny router (Pair → Library → Note / Settings), sync on launch and on return, `hivo://pair` links |
| `src/lib/` | Pure logic with Vitest tests: `bytes` (base64url, UTF-8, fnv1a), `pairing` (QR URL parser), `envelope` (crypto), `client` (hosts in order, typed errors), `sync` (offline queue, conflicts, snapshot), `i18n` |
| `src/store.ts` | App state; pairing in `expo-secure-store`, library cache + queued edits in AsyncStorage |
| `src/screens/`, `src/components/` | UI (System 02 tokens in `src/theme.ts`, copied from `../src/theme.css`) |
| `src/strings.ts` | Every visible string, English + French (`dict(en, fr)`, follows the phone's language) |
| `app.json`, `app.config.js` | Expo config; the second derives the Android versionCode and the build's distribution (website or Play) |
| `plugins/` | Config plugins (release signing) and the versionCode helper, with tests |
| `src/update.ts`, `src/components/UpdateBanner.tsx` | Update check and banner (website builds only) |
| `scripts/fake-desktop.mjs` | A stand-in desktop server with sample data, to try the app without the desktop |
| `scripts/make-icons.py` | Redraws the app icons (Pillow) |

## Setup

```sh
cd mobile
npm ci
npm test          # Vitest, src/lib
npm run typecheck # tsc --noEmit
```

`ios/` and `android/` are generated (`expo prebuild`, Continuous Native
Generation) and git-ignored: change native settings in `app.json`, never in
those folders.

## iOS Simulator

Needs Xcode (with an iOS Simulator runtime) and CocoaPods. No Apple account.

```sh
cd mobile
npx expo run:ios --device "iPhone 17 Pro"
```

This prebuilds `ios/`, installs the pods, builds a debug app, starts Metro and
opens it in the Simulator. The Simulator shares the Mac's network, so it
reaches a Hivo desktop running on the same Mac.

The Simulator has no camera: paste the pairing link instead, or open it from
the Mac's terminal:

```sh
xcrun simctl openurl booted "hivo://pair?v=1&d=…"
```

## Android APK (local, free)

Needs JDK 17 and the Android SDK.

```sh
cd mobile
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME="$HOME/Library/Android/sdk"   # macOS default
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/release/app-release.apk
```

**Signing:** `plugins/withReleaseSigning.js` (registered in `app.config.js`)
makes the generated `android/app/build.gradle` sign `release` with the upload
keystore when these environment variables are set at Gradle time:

| Variable | What |
|---|---|
| `HIVO_UPLOAD_STORE_FILE` | absolute path to the upload `.jks` (never in the repo) |
| `HIVO_UPLOAD_STORE_PASSWORD` | keystore password |
| `HIVO_UPLOAD_KEY_ALIAS` | key alias |
| `HIVO_UPLOAD_KEY_PASSWORD` | key password (the same as the store password; defaults to it) |

With `HIVO_UNSIGNED=1` instead, `release` comes out unsigned (the release
workflow builds that way and signs in a later step that never runs Gradle).
With neither, `release` is signed with the debug keystore
(`android/app/debug.keystore`, created by prebuild): fine for test builds you
sideload, never for the crew, because Android refuses to update an app signed
with a different key. On CI (`CI` set) that case fails the build instead.
Gradle reads the variables when it runs, so no path or password lands in the
generated files.

```sh
export HIVO_UPLOAD_STORE_FILE=/path/outside/the/repo/upload.jks
export HIVO_UPLOAD_STORE_PASSWORD=…  HIVO_UPLOAD_KEY_PASSWORD=…  HIVO_UPLOAD_KEY_ALIAS=…
cd android
HIVO_DISTRIBUTION=direct ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon  # website APK
HIVO_DISTRIBUTION=play ./gradlew bundleRelease --no-daemon                                           # Play AAB
```

**Version:** `version` in `app.json` (same as the desktop since 0.6.0);
`android.versionCode` is derived from it in `app.config.js`
(major*10000 + minor*100 + patch, `plugins/versionCode.js`).

**Releases** are built by the `android` job of `.github/workflows/release.yml`
on the same tag as the desktop: the APK goes to the public `releases` bucket
(`latest/Hivo.apk`, behind hi-vo.fr/download/android) with
`mobile-latest.json`; the AAB is attached to the draft GitHub Release and
uploaded to Google Play by hand. See the `release` skill.

**Updates:** website builds (`HIVO_DISTRIBUTION=direct` when Gradle runs,
`extra.distribution = "direct"`) read
`mobile-latest.json` at launch, at most once a day (`src/update.ts`, rules in
`src/lib/update.ts`), and show a banner with Download / Later when it's newer.
Play builds (`HIVO_DISTRIBUTION=play` when Gradle runs) never check: Play
updates them. Neither does a build without the flag (`dev`): the check fails
closed.

Android allows plain HTTP to the computer through
`expo-build-properties` → `usesCleartextTraffic` (the bodies are encrypted
anyway). iOS uses `NSAllowsLocalNetworking` and asks for local network access
the first time.

## Pairing

1. On the computer: Hivo → **Settings → Phone sync** → turn it on → **Pair a
   phone**. A QR code appears, with the link under it.
2. On the phone: **Scan the QR code** (or paste the link, or scan it with the
   system camera app, which opens Hivo).
3. The phone says hello to the computer, then syncs. The computer lists the
   phone under paired phones; **Forget** there unpairs it (the phone then shows
   "This phone was forgotten on the desktop: pair again").

Both must be on the same Wi-Fi. If the computer's firewall asks, allow Hivo's
incoming connections.

## Without the desktop

```sh
cd mobile
node scripts/fake-desktop.mjs              # Simulator on this Mac (127.0.0.1)
node scripts/fake-desktop.mjs 192.168.1.20 # a phone: use the Mac's Wi-Fi address
```

It prints a pairing link and serves sample prods, beats and songs. Type
`edit some text` in its terminal to change a note "on the desktop" and try the
conflict banner.

## How sync works

- **Offline first.** The library and notes are cached on the phone. Editing a
  note saves it on the phone right away and queues it with the hash of the
  desktop's note it started from (`baseHash`).
- **Sync** (button, app launch, coming back to the app, leaving a note) =
  `/v1/hello` the first time, push the queue to `/v1/notes`, then pull
  `/v1/snapshot`. The hosts from the pairing link are tried in order.
  Pushes go in batches (≤ 500 changes and about 600 KB of text each, the
  desktop refuses bodies over 1 MB).
- **Conflicts:** if the note changed on the desktop since, the desktop keeps
  both texts (`--- from <phone> ---`); the phone takes the merged text and
  shows a banner on that note.
- **Deleted on the desktop** (`missing`): the phone keeps your text, marks the
  item "Gone from the computer" (red LED), and lets you remove it once you've
  copied it somewhere.
- **Errors:** "Not on the same Wi-Fi as your computer" (no host answered),
  "Phone sync is off on the desktop" (the connection was refused), "This phone
  was forgotten on the desktop: pair again" (401), busy (429 / 503 / `busy`:
  retry in a few seconds), too long (413 or the desktop's limits), demo data,
  and "update both apps" (404 / `bad request`).
