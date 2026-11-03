// Fetching side of the update check (pure rules in lib/update.ts). Only
// builds for the website (HIVO_DISTRIBUTION=direct, see app.config.js)
// check: the Play build leaves updates to Google Play, as Play's policy
// requires, and a build without the flag never checks (fail closed).
// Nothing is sent but a plain GET of a public file.
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { checkDue, checksForDistribution, manualCheck, MANIFEST_URL, pickUpdate, type ManualCheck, type Update } from "./lib/update";
import { createOfferStore } from "./lib/updateOffer";
import { appVersion } from "./store";

/** The update found this run, shared by every banner until dismissed. */
export const updateOffer = createOfferStore();

const LAST_CHECK_KEY = "hivo.update.lastCheck.v1";
const DISMISSED_KEY = "hivo.update.dismissed.v1";
const TIMEOUT_MS = 8000;

export function checksForUpdates(): boolean {
  return checksForDistribution(Constants.expoConfig?.extra?.distribution);
}

/**
 * A plain GET of the public manifest; never throws. An HTTP error (404
 * before the first phone release) is a real answer: `manifest: null`.
 * Only a network failure or a timeout is `ok: false`.
 */
async function fetchManifest(): Promise<{ ok: true; manifest: unknown } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MANIFEST_URL, { signal: ctrl.signal, cache: "no-store" });
    return { ok: true, manifest: res.ok ? await res.json() : null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The update to offer now, or null (Play build, checked today, offline, nothing newer, dismissed). */
export async function checkForUpdate(now = Date.now()): Promise<Update | null> {
  if (!checksForUpdates()) return null;
  const [last, dismissed] = await Promise.all([AsyncStorage.getItem(LAST_CHECK_KEY), AsyncStorage.getItem(DISMISSED_KEY)]);
  if (!checkDue(last === null ? null : Number(last), now)) return null;
  const got = await fetchManifest();
  if (!got.ok) {
    // Offline or timed out: try again on the next launch, say nothing.
    console.warn("update check failed:", got.error);
    return null;
  }
  await AsyncStorage.setItem(LAST_CHECK_KEY, String(now));
  return pickUpdate(got.manifest, appVersion(), dismissed);
}

/**
 * "Check for updates" (Settings and the pairing screen, website builds):
 * always asks, and offers a version even if "Later" was tapped on it.
 */
export async function checkForUpdateNow(now = Date.now()): Promise<ManualCheck> {
  const got = await fetchManifest();
  if (!got.ok) return { kind: "offline" };
  await AsyncStorage.setItem(LAST_CHECK_KEY, String(now));
  return manualCheck(got.manifest, appVersion());
}

/** "Later": this version isn't offered again; a newer one will be. */
export async function dismissUpdate(version: string): Promise<void> {
  await AsyncStorage.setItem(DISMISSED_KEY, version);
}
