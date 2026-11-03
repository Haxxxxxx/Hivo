import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// HivoRecordingModule.kt relabels expo-audio's recording notification and stops
// a take on a call through names private to expo-audio's AudioRecordingService.
// An expo-audio upgrade that renames one fails here, not silently on a phone.
const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const ours = readFileSync(root("modules/hivo-share/android/src/main/java/expo/modules/hivoshare/HivoRecordingModule.kt"), "utf8");
const theirs = readFileSync(root("node_modules/expo-audio/android/src/main/java/expo/modules/audio/service/AudioRecordingService.kt"), "utf8");

const constant = (src: string, name: string): string => {
  const m = src.match(new RegExp(`const val ${name}\\s*=\\s*("[^"]*"|\\d+)`));
  if (!m) throw new Error(`no ${name}`);
  return m[1].replace(/"/g, "");
};

describe("expo-audio names HivoRecordingModule relies on", () => {
  it("the service class", () => {
    const pkg = theirs.match(/^package (\S+)/m)?.[1];
    expect(theirs).toMatch(/class AudioRecordingService\b/);
    expect(constant(ours, "EXPO_SERVICE")).toBe(`${pkg}.AudioRecordingService`);
  });

  it("the stop action", () => {
    expect(constant(ours, "EXPO_STOP_ACTION")).toBe(constant(theirs, "ACTION_STOP_RECORDING"));
  });

  it("a screen-on take escapes the pause/resume on Activity pause with allowsBackgroundRecording (screenOnGuardMode)", () => {
    const mod = readFileSync(root("node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt"), "utf8");
    const hook = (name: string) => {
      const at = mod.indexOf(`${name} {`);
      if (at < 0) throw new Error(`no ${name}`);
      return mod.slice(at, mod.indexOf("\n    }\n", at));
    };
    expect(hook("OnActivityEntersBackground")).toMatch(/if \(!allowsBackgroundRecording\) \{\s*recorders\.values\.forEach \{ recorder ->\s*recorder\.pauseForSystem\(\)/);
    expect(hook("OnActivityEntersForeground")).toMatch(/if \(!allowsBackgroundRecording\) \{\s*recorders\.values\.forEach \{ recorder ->\s*recorder\.resumeAfterSystemPause\(\)/);
    // Switching it on after prepare binds no service: only prepareRecording binds.
    const rec = readFileSync(root("node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioRecorder.kt"), "utf8");
    expect(rec.match(/bindWithService\(\)/g)?.length).toBe(1);
    expect(rec).toMatch(/suspend fun prepareRecording[\s\S]*?if \(useForegroundService\) \{\s*serviceConnection\.bindWithService\(\)/);
  });

  it("the bind race holdMainForBind works around is still there (fixed upstream: drop the hold)", () => {
    const conn = readFileSync(root("node_modules/expo-audio/android/src/main/java/expo/modules/audio/service/AudioRecordingServiceConnection.kt"), "utf8");
    const bind = conn.indexOf("startServiceAndBind(");
    const store = conn.indexOf("bindingContinuation = continuation");
    expect(bind).toBeGreaterThan(0);
    // The continuation is stored only after bindService returned: a fast onServiceConnected finds none.
    expect(store).toBeGreaterThan(bind);
    // And the callback runs on the main thread (a ServiceConnection's default), which the hold delays.
    expect(conn).toMatch(/override fun onServiceConnected[\s\S]*?takeBindingContinuation\(\)\?\.resume\(Unit\)/);
  });

  it("the notification channel and id", () => {
    expect(constant(ours, "EXPO_CHANNEL_ID")).toBe(constant(theirs, "CHANNEL_ID"));
    expect(constant(ours, "EXPO_NOTIFICATION_ID")).toBe(constant(theirs, "NOTIFICATION_ID"));
  });
});
