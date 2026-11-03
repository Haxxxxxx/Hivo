import { describe, expect, it } from "vitest";
import { BIND_HOLD_MS, isCallMode, noticePermission, recordingAudioMode, recordsInBackground, screenOnGuardMode, shouldAskNotice, showBackgroundHint, stopOnBackground, stopReason, takeIsOpen } from "./recording";

describe("noticePermission", () => {
  it("is not needed before Android 13", () => {
    expect(noticePermission(32, false, false)).toBe("not-needed");
    expect(noticePermission(24, false, true)).toBe("not-needed");
  });
  it("on Android 13+: granted, not asked yet, or denied", () => {
    expect(noticePermission(33, true, false)).toBe("granted");
    expect(noticePermission(34, true, true)).toBe("granted");
    expect(noticePermission(33, false, false)).toBe("unasked");
    expect(noticePermission(35, false, true)).toBe("denied");
  });
  it("is asked only when it was never asked", () => {
    expect(shouldAskNotice("unasked")).toBe(true);
    for (const p of ["granted", "denied", "not-needed"] as const) expect(shouldAskNotice(p)).toBe(false);
  });
});

describe("background recording", () => {
  it("every Android take runs in the foreground service, whatever the notification permission", () => {
    // The permission isn't an input any more: denied, unasked, granted or not needed, same service.
    expect(recordsInBackground(true)).toBe(true);
    expect(recordsInBackground(true, false)).toBe(true);
  });
  it("records screen-on only when the service didn't start, and never on iOS", () => {
    expect(recordsInBackground(true, true)).toBe(false);
    expect(recordsInBackground(false)).toBe(false);
    expect(recordsInBackground(false, true)).toBe(false);
  });
  it("holds the main thread a short moment for the bind, under the native cap", () => {
    expect(BIND_HOLD_MS).toBeGreaterThan(0);
    expect(BIND_HOLD_MS).toBeLessThanOrEqual(500); // MAX_HOLD_MS in HivoRecordingModule.kt
  });
  it("asks expo-audio for the service on a service take only", () => {
    expect(recordingAudioMode(true)).toMatchObject({ allowsRecording: true, allowsBackgroundRecording: true, shouldPlayInBackground: false });
    expect(recordingAudioMode(false).allowsBackgroundRecording).toBe(false);
  });
  it("a screen-on take switches expo-audio's pause/resume off once it records", () => {
    // allowsBackgroundRecording is what gates expo-audio's lifecycle pause (expoAudioNames.test.ts).
    expect(screenOnGuardMode()).toMatchObject({ allowsRecording: true, allowsBackgroundRecording: true, shouldPlayInBackground: false });
  });
  it("stops on background only a screen-on take", () => {
    expect(stopOnBackground(recordsInBackground(true))).toBe(false);
    expect(stopOnBackground(recordsInBackground(true, true))).toBe(true);
  });
  it("shows the hint once, and only with the service", () => {
    expect(showBackgroundHint(true, false)).toBe(true);
    expect(showBackgroundHint(true, true)).toBe(false);
    expect(showBackgroundHint(false, false)).toBe(false);
  });
});

describe("what ends a take", () => {
  it("a call (phone or VoIP) has the microphone; ringing alone doesn't", () => {
    expect(isCallMode(0)).toBe(false); // normal
    expect(isCallMode(1)).toBe(false); // ringtone
    for (const m of [2, 3, 4, 5, 6]) expect(isCallMode(m)).toBe(true);
    expect(isCallMode(-2)).toBe(false); // invalid
  });
  it("a call first, then the cap, else something else stopped it", () => {
    const cap = 15 * 60_000;
    expect(stopReason(true, cap, cap)).toBe("call");
    expect(stopReason(false, cap - 500, cap)).toBe("max");
    expect(stopReason(false, 30_000, cap)).toBe("stopped");
  });
});

describe("takeIsOpen", () => {
  it("stops a take that records", () => {
    expect(takeIsOpen({ isRecording: true, canRecord: true })).toBe(true);
  });
  it("stops a take expo-audio paused when Hivo left the screen (else the file never gets its index)", () => {
    expect(takeIsOpen({ isRecording: false, canRecord: true })).toBe(true);
  });
  it("leaves a take that is already stopped (by the cap, the notification's Stop, a call)", () => {
    expect(takeIsOpen({ isRecording: false, canRecord: false })).toBe(false);
  });
});
