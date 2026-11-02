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

  it("the notification channel and id", () => {
    expect(constant(ours, "EXPO_CHANNEL_ID")).toBe(constant(theirs, "CHANNEL_ID"));
    expect(constant(ours, "EXPO_NOTIFICATION_ID")).toBe(constant(theirs, "NOTIFICATION_ID"));
  });
});
