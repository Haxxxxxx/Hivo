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
- Is data encrypted in transit? **Yes** (XChaCha20-Poly1305 with the pairing
  key; ML Kit's diagnostics over HTTPS).
- Can users ask for deletion? Everything is on their devices: removing the
  app (and Forget on the computer) deletes it.

The privacy policy says the same (`web/src/privacyCopy.ts`, kept true when what
the app sends changes).

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
