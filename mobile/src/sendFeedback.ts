// Settings → Send feedback: the I/O around lib/feedback.ts (the install id
// kept on the phone, the POST). Nothing is sent until the user taps Send.
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import { Platform } from "react-native";
import { feedbackConfig, feedbackRequest, feedbackResult, isUuid, uuidFromBytes, type FeedbackDraft, type FeedbackError } from "./lib/feedback";
import { lang } from "./lib/i18n";
import { appVersion } from "./store";

/** A random id made once per install: the server's 10-a-day limit counts on it.
 * Not tied to the phone or the person; removing the app forgets it. */
const INSTALL_KEY = "hivo-feedback-install-id";
const TIMEOUT_MS = 15_000;

async function installId(): Promise<string> {
  const saved = await AsyncStorage.getItem(INSTALL_KEY).catch(() => null);
  if (isUuid(saved)) return saved;
  const id = uuidFromBytes(getRandomBytes(16));
  await AsyncStorage.setItem(INSTALL_KEY, id).catch(() => {});
  return id;
}

/** True when this build can send feedback at all (dev builds have no server). */
export const canSendFeedback = (): boolean => feedbackConfig(Constants.expoConfig?.extra) !== null;

export async function sendFeedback(draft: FeedbackDraft): Promise<{ ok: true } | { ok: false; error: FeedbackError }> {
  const req = feedbackRequest(feedbackConfig(Constants.expoConfig?.extra), draft, {
    installId: await installId(),
    appVersion: appVersion(),
    os: `${Platform.OS} ${String(Platform.Version)}`,
    lang: lang(),
  });
  if (!req.ok) return req;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(req.url, { ...req.init, signal: ctrl.signal });
    return feedbackResult(res.status, await res.text().catch(() => ""));
  } catch {
    return { ok: false, error: "offline" };
  } finally {
    clearTimeout(timer);
  }
}
