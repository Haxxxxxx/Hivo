// Voice memos with the screen off (android/…/HivoRecordingModule.kt): Hivo's
// words on expo-audio's recording notification, the call watch, and the
// length of a finished take. Without the module (iOS) everything is a no-op.
import { requireOptionalNativeModule, type EventSubscription } from "expo";

export type NoticeLabels = { title: string; text: string; stop: string; channel: string };

type Native = {
  startWatch(background: boolean, labels: NoticeLabels): Promise<void>;
  stopWatch(): Promise<void>;
  takeCallStop(): boolean;
  fileDurationMs(uri: string): Promise<number | null>;
  addListener(event: "onCall", listener: () => void): EventSubscription;
};

const native = requireOptionalNativeModule<Native>("HivoRecording");

/** A take started; `background`: it runs in expo-audio's foreground service. */
export async function startRecordingWatch(background: boolean, labels: NoticeLabels): Promise<void> {
  if (native) await native.startWatch(background, labels).catch(() => {});
}

/** The take ended, whatever ended it. */
export async function stopRecordingWatch(): Promise<void> {
  if (native) await native.stopWatch().catch(() => {});
}

/** Whether the last take was stopped by a call (read once). */
export function takeCallStop(): boolean {
  return native ? native.takeCallStop() : false;
}

/** A call took the microphone during a take. */
export function onCall(listener: () => void): { remove: () => void } {
  if (!native) return { remove: () => {} };
  const sub = native.addListener("onCall", listener);
  return { remove: () => sub.remove() };
}

/** A recorded file's length in ms, null when unknown. */
export async function fileDurationMs(uri: string): Promise<number | null> {
  return native ? native.fileDurationMs(uri).catch(() => null) : null;
}
