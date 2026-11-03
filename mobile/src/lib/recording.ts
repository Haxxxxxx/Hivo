// Voice memos with the screen off (RecordScreen.tsx): every Android take runs
// in the foreground service (screen-on only when it didn't start), and what
// ends it. The foreground service itself is
// expo-audio's (`enableBackgroundRecording` in app.json, a service of type
// `microphone`; its ongoing notification shows when notifications are
// allowed); call detection and the notification's wording are in
// modules/hivo-share (HivoRecordingModule.kt).

/** The notification permission (Android 13+, POST_NOTIFICATIONS), as far as recording cares. */
export type NoticePermission = "not-needed" | "granted" | "unasked" | "denied";

/** Android 13 (API 33) is the first to ask for notifications. */
export const NOTICE_PERMISSION_API = 33;

export function noticePermission(apiLevel: number, granted: boolean, asked: boolean): NoticePermission {
  if (apiLevel < NOTICE_PERMISSION_API) return "not-needed";
  if (granted) return "granted";
  return asked ? "denied" : "unasked";
}

/** Asked once, at the first recording, after a short rationale. Optional:
 * it only decides whether Recording + Stop show in the shade. */
export const shouldAskNotice = (p: NoticePermission): boolean => p === "unasked";

/** Every Android take records in the foreground service, whatever the
 * notification permission: Android 13+ starts it without POST_NOTIFICATIONS
 * (the notification just doesn't show in the shade; the app is still listed
 * in the system's active-apps panel), and below 13 nothing is needed. Only a
 * service that didn't start (`serviceFailed`) records screen-on. iOS: never. */
export const recordsInBackground = (android: boolean, serviceFailed = false): boolean => android && !serviceFailed;

/** How long Android's main thread is held while expo-audio binds its service
 * (`holdMainForBind`, its race in HivoRecordingModule.kt): covers the prepare
 * up to the bind call; the native side caps it at 500 ms. */
export const BIND_HOLD_MS = 300;

/** What `setAudioModeAsync` gets when a take starts. */
export function recordingAudioMode(background: boolean) {
  return { allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: background, shouldPlayInBackground: false };
}

/** Set once a screen-on take (the fallback) has started. expo-audio 58 pauses a
 * recorder on every Activity pause and resumes it on resume unless
 * `allowsBackgroundRecording` is on; a pairing link or a share reaching Hivo
 * mid-take is such a pause/resume, and the resume threw inside expo-audio
 * (IllegalStateException: the app was killed, the take lost) before JS could
 * stop anything. The flag only switches those lifecycle hooks off here: the
 * recorder was prepared without the service, so none is bound, and the take
 * still ends on background (`stopOnBackground`), when Android would silence
 * the microphone anyway. Guarded by expoAudioNames.test.ts. */
export const screenOnGuardMode = () => recordingAudioMode(true);

/** Whether a take still has to be stopped (which writes the file's index:
 * until then the .m4a doesn't play). Not only while it records: without the
 * foreground service, expo-audio pauses the recorder as soon as Hivo leaves
 * the screen (`isRecording` false, still prepared), and resumes it when Hivo
 * comes back. Skipping the stop then left a file the player refused ("Source
 * error") and the microphone recording again with nothing on screen.
 * `canRecord` is expo-audio's "prepared": true until the take is stopped. */
export const takeIsOpen = (status: { isRecording: boolean; canRecord: boolean }): boolean => status.isRecording || status.canRecord;

/** Hivo left the screen during a take: only a screen-on take (the service
 * didn't start) stops, keeping what was recorded. Android only reports
 * "active" and "background" (no "inactive"), both after the native pause. */
export const stopOnBackground = (background: boolean): boolean => !background;

/** "Recording continues in the background" shows during one take, then never again. */
export const showBackgroundHint = (background: boolean, seen: boolean): boolean => background && !seen;

/** AudioManager modes that mean a call (phone or VoIP) has the microphone.
 * Ringing (1) doesn't: the take goes on unless the call is answered. */
const CALL_MODES = new Set([
  2, // MODE_IN_CALL
  3, // MODE_IN_COMMUNICATION (VoIP)
  4, // MODE_CALL_SCREENING
  5, // MODE_CALL_REDIRECT
  6, // MODE_COMMUNICATION_REDIRECT
]);
export const isCallMode = (mode: number): boolean => CALL_MODES.has(mode);

export type StopReason = "call" | "max" | "stopped";

/** Why a take ended without the Stop button (the cap, a call, the notification's
 * Stop, another app taking the microphone). `capMs` is the 15-minute cap. */
export function stopReason(byCall: boolean, durationMs: number, capMs: number): StopReason {
  if (byCall) return "call";
  return durationMs >= capMs - 1000 ? "max" : "stopped";
}
