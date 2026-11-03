# Google Play: putting Hivo on the Play Store

The app already exists in the Play Console: **Hi-Vo**, package `fr.hivo.mobile`
(developer account "WeSplit"). Every release builds the bundle Play wants:
`Hivo-<version>-android.aab`, attached to the GitHub Release draft (see the
`release` skill). Play uploads are by hand; nothing uploads automatically.

Do the steps once, in order. After that, each release is only step 4.

## 1. App signing: use your own key (once, before the first upload)

Play installs and the website APK must be signed by the same key, or a phone
can't move from one to the other. So Play signs with **your** upload key.

1. Play Console → Hi-Vo → **Test and release → Setup → App signing**.
2. Choose **Use a different key**, then **Export and upload a key from Java
   keystore**.
3. Follow Google's instructions. They give a small tool (PEPK) and a command.
   The keystore is `~/.hivo/android-upload.jks`, the alias is `hivo-upload`,
   and the password is in `~/.hivo/android-upload.password`. (A copy of all of
   it is in the encrypted `Hivo-signing-keys.dmg`, Desktop and iCloud Drive;
   its password is in the Keychain item "Hivo signing keys backup".)
4. Upload the encrypted file the tool makes. Play shows the key's SHA-256:
   it must be
   `A9:59:C0:09:8C:33:C5:5B:81:CB:8C:66:E1:A2:2A:2F:8B:76:00:8A:7C:87:AD:75:90:14:51:AA:67:AD:C7:02`.

## 2. App content (once; Policy → App content)

| Section | Answer |
|---|---|
| Privacy policy | `https://www.hi-vo.fr/en/privacy` |
| App access | All functionality is available without special access |
| Ads | No ads |
| Content rating | Take the questionnaire: category **Utility, productivity, communication or other**; no violence, no sexual content, no gambling, no user-to-user chat, no location sharing → rated for everyone |
| Target audience | **18 and over** (the crew; not designed for children) |
| News app | No |
| Data safety | See below |
| Government apps / Financial features / Health | No / None / No |

**Data safety** (what Play calls "collected" means sent off the device to you
or a third party; sending to the user's own computer on their Wi-Fi isn't
that):
- Does the app collect or share user data? **Yes**, but only through Google's
  SDK: the pairing QR is scanned with Google Play services' code scanner (ML
  Kit, `CameraView.launchScanner` in `mobile/src/screens/PairScreen.tsx`).
  Google's ML Kit data disclosure
  (https://developers.google.com/ml-kit/android-data-disclosure) says it sends
  device information (manufacturer, model, OS version and build), package
  name and app version, performance metrics (latency) and error codes, plus
  device or other identifiers, "for diagnostics and usage analytics",
  encrypted over HTTPS, not transferred to third parties. Declare:
  - **App info and performance → Diagnostics** and **Device or other IDs**:
    collected, not shared, purpose **Analytics** (and App functionality if
    Play asks), not optional (scanning needs it), encrypted in transit.
  - Re-read that Google page before each Data safety review: it's Google's
    wording, and its list can change.
- Hivo's own data: the microphone (voice memos), the camera (pairing QR),
  notes, ideas and shared files stay on the phone and go only to the user's
  own computer over the local Wi-Fi, end-to-end encrypted, no Hivo server.
  Nothing goes to Hivo or anyone else, so none of it is declared.
- **To recheck (mini player, 2026-11-03):** a tap on "Play here" loads
  YouTube's embedded player (youtube-nocookie.com, inside hi-vo.fr/embed.html)
  in a WebView: YouTube and Vercel see the request (video id, IP address,
  user agent). It is user-initiated content from a third party, not data
  Hivo collects, but the owner decides whether Data safety needs a line for
  it; re-read Play's guidance on WebViews and embedded third-party content
  before the next review.
- Is data encrypted in transit? **Yes** (XChaCha20-Poly1305 with the pairing
  key; ML Kit's diagnostics over HTTPS).
- Can users ask for deletion? Everything is on their devices: removing the
  app (and Forget on the computer) deletes it.

The privacy policy says the same (`web/src/privacyCopy.ts`, kept true when what
the app sends changes).

**Data safety and background recording:** recording with the screen off
changes nothing above. The audio is still written only to the phone, and it
goes only to the paired computer over the local Wi-Fi (end-to-end encrypted,
no Hivo server), so the microphone stays undeclared.

### Foreground service (Policy → App content → Foreground service permissions)

Since 0.7.0 the app declares `FOREGROUND_SERVICE` and
`FOREGROUND_SERVICE_MICROPHONE` (plus `POST_NOTIFICATIONS`): a voice memo
keeps recording with the screen off or in another app. The service is
expo-audio's `AudioRecordingService` (`enableBackgroundRecording` in
`mobile/app.json`). It is the **only** foreground service type in the app:
`enableBackgroundPlayback` is off, so there's no `mediaPlayback` to declare.
Play asks for this declaration before it accepts the first bundle that has the
permission:

| Field | Answer |
|---|---|
| Foreground service type | **Microphone** |
| Use case / task | **User-started voice memo recording.** The user taps Record on the Voice memo screen; the service runs only while that take records and stops on Stop, at the 15-minute cap, on a call, or from the notification's Stop button. An ongoing notification ("Hivo is recording · Tap to return", with Stop) shows the whole time. |
| Impact if the task is deferred or interrupted | The user's take (a flow, a melody) would be cut when the screen turns off or they switch apps. It can't be resumed later: it's a live recording. |
| Video | A link to a short screen recording (unlisted YouTube or Drive), filmed as below. |

**Video to film** (about 30 seconds, on a phone with the release build):
1. Open Hivo → Inbox → Record. On the first take, show the short rationale
   and Android's notification prompt, tap Allow.
2. Tap Record; the clock runs.
3. Press the power button (screen off), wait a few seconds, turn it back on:
   the ongoing "Hivo is recording" notification is on the shade.
4. Go to the home screen, open the notification shade, show the
   notification, tap it: back in Hivo, the clock has kept running.
5. Tap Stop: the notification disappears; play the take back.

If the user denies notifications, the app doesn't start the service: it
records with the screen kept on and stops (keeping the take) when it leaves
the screen, and the Record screen says so.

## 3. Store listing (once; Grow → Store presence → Main store listing)

- **App name:** Hivo
- **Short description (80 max):** Write lyrics and ideas on your phone, send them and BandLab exports to FL Studio.
- **Full description:** what the app does (notes and lyrics on your prods,
  beats and songs; ideas; voice memos; Share to Hivo from BandLab; everything
  syncs to the Hivo desktop app over your Wi-Fi, nothing through a server),
  that it needs the Hivo desktop app (Mac or Windows, free, hi-vo.fr), and
  that it's for a crew already making music.
- **Graphics:** the icon (512×512, `mobile/assets/icon.png` scaled), a feature
  graphic (1024×500), at least 2 phone screenshots (Library, a note, the Inbox
  tab, the share screen).
- **Category:** Music & Audio. **Contact email:** the crew's.

## 4. Each release (internal testing first)

1. When the release run is done, download `Hivo-<version>-android.aab` from
   the GitHub Release draft.
2. **Test and release → Testing → Internal testing → Create new release**,
   upload the bundle. Release name: the version (`0.7.0`). Notes: a line or
   two of what changed.
3. **Testers** tab (first time): an email list with your Google account and
   the crew's; copy the **opt-in link** and send it to them.
4. **Review release → Start rollout to Internal testing.**
5. On a phone: open the opt-in link, accept, install from Play. A phone that
   has the website APK installs over it (same key) without losing notes.

## 5. Going public (later, your call)

Closed testing → production needs Google's review, and new personal
developer accounts must run a closed test with testers for 14 days first.
When the listing is public, set `PLAY_URL` in `web/src/Landing.tsx` so the
website shows the Google Play button, and deploy the website.

## Things that change what you declare

- A new permission or anything new leaving the phone → update **Data safety**
  and the privacy policy before uploading that version.
- 0.7.0 adds the **microphone** (voice memos) and **shared files** (Share to
  Hivo): both stay on the phone and the user's computer, so they add nothing to
  Data safety (only the ML Kit diagnostics above are declared), but Play asks about the microphone permission's use:
  answer "voice memos the user records, kept on the device and sent to the
  user's own computer".
- The **foreground service** (microphone) for recording with the screen off:
  fill the declaration in section 2 before uploading the first bundle that
  has it, or Play rejects the upload.
