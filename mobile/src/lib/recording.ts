// Voice memos with the screen off (RecordScreen.tsx): when the recording may
// go on in the background, and what ends it. The foreground service itself is
// expo-audio's (`enableBackgroundRecording` in app.json, a service of type
// `microphone` with an ongoing notification); call detection and the
// notification's wording are in modules/hivo-share (HivoShareModule.kt).

/** The notification permission (Android 13+, POST_NOTIFICATIONS), as far as recording cares. */
export type NoticePermission = "not-needed" | "granted" | "unasked" | "denied";

/** Android 13 (API 33) is the first to ask for notifications. */
export const NOTICE_PERMISSION_API = 33;

export function noticePermission(apiLevel: number, granted: boolean, asked: boolean): NoticePermission {
  if (apiLevel < NOTICE_PERMISSION_API) return "not-needed";
  if (granted) return "granted";
  return asked ? "denied" : "unasked";
}

/** Asked once, at the first recording, after a short rationale. */
export const shouldAskNotice = (p: NoticePermission): boolean => p === "unasked";

/** The recording runs in the foreground service only when its notification can show:
 * without it Hivo would record with nothing on screen saying so. Otherwise it
 * keeps the screen on and stops (keeping the take) when Hivo leaves the screen. */
export const recordsInBackground = (p: NoticePermission): boolean => p === "granted" || p === "not-needed";

/** What `setAudioModeAsync` gets when a take starts. */
export function recordingAudioMode(background: boolean) {
  return { allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: background, shouldPlayInBackground: false };
}

/** Whether a take still has to be stopped (which writes the file's index:
 * until then the .m4a doesn't play). Not only while it records: without the
 * foreground service, expo-audio pauses the recorder as soon as Hivo leaves
 * the screen (`isRecording` false, still prepared), and resumes it when Hivo
 * comes back. Skipping the stop then left a file the player refused ("Source
 * error") and the microphone recording again with nothing on screen.
 * `canRecord` is expo-audio's "prepared": true until the take is stopped. */
export const takeIsOpen = (status: { isRecording: boolean; canRecord: boolean }): boolean => status.isRecording || status.canRecord;

/** Hivo left the screen during a take. */
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
