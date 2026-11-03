import { describe, expect, it } from "vitest";
import { isCallMode, noticePermission, recordingAudioMode, recordsInBackground, shouldAskNotice, showBackgroundHint, stopOnBackground, stopReason, takeIsOpen } from "./recording";

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
  it("runs in the foreground service only when its notification can show", () => {
    expect(recordsInBackground("granted")).toBe(true);
    expect(recordsInBackground("not-needed")).toBe(true);
    expect(recordsInBackground("denied")).toBe(false);
    expect(recordsInBackground("unasked")).toBe(false);
  });
  it("asks expo-audio for the service only then", () => {
    expect(recordingAudioMode(true)).toMatchObject({ allowsRecording: true, allowsBackgroundRecording: true, shouldPlayInBackground: false });
    expect(recordingAudioMode(false).allowsBackgroundRecording).toBe(false);
  });
  it("stops on background only without the service", () => {
    expect(stopOnBackground(true)).toBe(false);
    expect(stopOnBackground(false)).toBe(true);
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
