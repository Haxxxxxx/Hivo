import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Alert, AppState, Linking, PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { fileDurationMs, onCall, startRecordingWatch, stopRecordingWatch, takeCallStop } from "../../modules/hivo-share/recording";
import { c } from "../captureStrings";
import { ScreenHeader } from "../components/ScreenHeader";
import { TargetPicker } from "../components/TargetPicker";
import { Button, Engrave, Led } from "../components/ui";
import { adopt, deleteFile, SpaceError } from "../files";
import { s } from "../inboxStrings";
import type { IdeaTarget } from "../lib/ideas";
import { MAX_MEMO_MS, MIN_MEMO_MS } from "../lib/outbox";
import { noticePermission, recordingAudioMode, recordsInBackground, shouldAskNotice, showBackgroundHint, stopOnBackground, stopReason, takeIsOpen, type NoticePermission } from "../lib/recording";
import { addOutItem, getState, keepDraftOut, newOutId, removeOut, requestSync, updateDraft } from "../store";
import { C, FONT, RADIUS, S } from "../theme";

/** `id`: the take's draft in the outbox (adopted at Stop, so a killed app
 * keeps it); null only when that copy failed (then it's only in the cache). */
type Phase = { kind: "idle" } | { kind: "recording" } | { kind: "done"; id: string | null; uri: string; durationMs: number };

const clock = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const KEEP_AWAKE_TAG = "hivo-recording";
const NOTICE_ASKED_KEY = "hivo.rec.noticeAsked";
const HINT_SEEN_KEY = "hivo.rec.backgroundHintSeen";
const android = Platform.OS === "android";

/** Whether the recording notification can show (Android 13+ asks for it). iOS: no background recording. */
async function readNotice(): Promise<NoticePermission> {
  if (!android) return "denied";
  const api = Number(Platform.Version);
  const granted = api >= 33 ? await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => false) : true;
  const asked = (await AsyncStorage.getItem(NOTICE_ASKED_KEY).catch(() => null)) === "1";
  return noticePermission(api, granted, asked);
}

/** At the first recording: a short rationale, then Android's prompt, once. */
async function ensureNotice(): Promise<NoticePermission> {
  const p = await readNotice();
  if (!shouldAskNotice(p)) return p;
  await new Promise<void>((resolve) =>
    Alert.alert(s().noticeAskTitle, s().noticeAskBody, [{ text: s().noticeAskOk, onPress: () => resolve() }], { cancelable: true, onDismiss: () => resolve() }),
  );
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => null);
  await AsyncStorage.setItem(NOTICE_ASKED_KEY, "1").catch(() => {});
  return readNotice();
}

/** How a take ended: Stop, by itself (the cap, the notification's Stop, the
 * microphone taken), a call, or Hivo leaving the screen without the service. */
type End = "user" | "auto" | "call" | "background";

/** The take a killed run left as a draft (`draftId`), back on the "done" step. */
function draftPhase(draftId: string | undefined): Phase {
  const d = draftId ? getState().outbox.find((o) => o.id === draftId && o.state === "draft") : undefined;
  return d && d.files[0] ? { kind: "done", id: d.id, uri: d.files[0].uri, durationMs: d.durationMs ?? 0 } : { kind: "idle" };
}

/** Record a flow or a melody; kept in the outbox, sent at the next sync.
 * `backRef`: what the hardware Back does here (App.tsx calls it).
 * `draftId` (optional): reopen a take that wasn't kept yet (a draft row). */
export function RecordScreen({ target: initialTarget, onDone, backRef, draftId }: { target: IdeaTarget | null; onDone: () => void; backRef: MutableRefObject<(() => void) | null>; draftId?: string }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<Phase>(() => draftPhase(draftId));
  const restored = useRef(phase.kind === "done" ? getState().outbox.find((o) => o.id === draftId) : undefined);
  const [title, setTitle] = useState(restored.current?.title ?? "");
  const [target, setTarget] = useState<IdeaTarget | null>(restored.current?.target ?? initialTarget);
  const [message, setMessage] = useState<string | null>(restored.current ? c().recDraftRestored : null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticePermission | null>(null);
  const [hint, setHint] = useState(false);
  const stoppingByUser = useRef(false);
  /** Start pressed and not settled yet: a second tap does nothing (F11). */
  const starting = useRef(false);
  /** This take runs in expo-audio's foreground service (goes on with the screen off). */
  const background = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const durationRef = useRef(0);
  durationRef.current = rec.durationMillis;
  const targetRef = useRef(target);
  targetRef.current = target;
  const player = useAudioPlayer(phase.kind === "done" ? phase.uri : null);
  const playing = useAudioPlayerStatus(player).playing;

  useEffect(() => {
    void getRecordingPermissionsAsync().then((p) => setDenied(!p.granted && !p.canAskAgain));
    void readNotice().then(setNotice);
    return () => {
      void stopRecordingWatch();
    };
  }, []);

  // Stopped without the Stop button: the 15-minute cap, a call, the
  // notification's Stop, another app. Judged by "it did start", not by the
  // clock: a call in the first second left the screen stuck on "recording" at 0:00.
  const started = useRef(false);
  useEffect(() => {
    if (rec.isRecording) {
      started.current = true;
      return;
    }
    if (phase.kind !== "recording" || stoppingByUser.current || !started.current) return;
    stoppingByUser.current = true;
    void finish("auto");
  }, [rec.isRecording]);

  // A phone or VoIP call took the microphone (watched natively, so also with
  // the screen off): stop and keep the take.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const sub = onCall(() => {
      if (phaseRef.current.kind !== "recording" || stoppingByUser.current) return;
      stoppingByUser.current = true;
      void finish("call");
    });
    return () => sub.remove();
  }, [phase.kind]);

  // The screen stays on while recording, as a fallback: without the
  // notification (denied) a locked screen would cut the microphone.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [phase.kind]);

  // Hivo left the screen while recording without the foreground service
  // (notifications denied): stop and keep what was recorded (Android cuts a
  // background app's microphone anyway). With the service, it goes on.
  // Subscribed once: everything it reads is in refs.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background" && phaseRef.current.kind === "recording" && !stoppingByUser.current && stopOnBackground(background.current)) {
        stoppingByUser.current = true;
        void finish("background");
      }
      // Back from the phone's settings: "Notifications are off" goes once they're allowed (smoke polish).
      if (st === "active") {
        void readNotice().then(setNotice);
        void getRecordingPermissionsAsync()
          .then((p) => setDenied(!p.granted && !p.canAskAgain))
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  /** Drops the take: its draft (and file) from the outbox, or the cache file. */
  function discard() {
    player.pause();
    const p = phaseRef.current;
    if (p.kind === "done") {
      if (p.id) removeOut(p.id);
      else deleteFile(p.uri);
    }
    setPhase({ kind: "idle" });
    setMessage(null);
  }

  function confirmDiscard(then: () => void) {
    Alert.alert(s().discardTitle, s().discardBody, [
      { text: s().cancel, style: "cancel" },
      { text: s().recDiscard, style: "destructive", onPress: then },
    ]);
  }

  /** Back (on screen or hardware): never during a take (it says so); a finished take is confirmed first. */
  function back() {
    if (phaseRef.current.kind === "recording") {
      setMessage(c().recStopFirst);
      return;
    }
    if (busy) return;
    if (phaseRef.current.kind === "done") {
      confirmDiscard(() => {
        discard();
        onDone();
      });
      return;
    }
    onDone();
  }
  useEffect(() => {
    backRef.current = back;
    return () => {
      backRef.current = null;
    };
  });

  async function start() {
    if (starting.current || phaseRef.current.kind !== "idle") return;
    starting.current = true;
    try {
      await startTake();
    } finally {
      starting.current = false;
    }
  }

  async function startTake() {
    started.current = false;
    setMessage(null);
    const p = await requestRecordingPermissionsAsync();
    if (!p.granted) {
      setDenied(true);
      return;
    }
    const n = await ensureNotice();
    setNotice(n);
    const bg = android && recordsInBackground(n);
    stoppingByUser.current = false;
    try {
      await begin(bg);
    } catch (e) {
      // The service didn't come up: record with the screen on, as before.
      if (!bg) {
        console.warn("Hivo: recording didn't start", e);
        setMessage(s().recFailed);
        return;
      }
      console.warn("Hivo: background recording didn't start, screen on instead", e);
      try {
        await begin(false);
      } catch (e2) {
        console.warn("Hivo: recording didn't start", e2);
        setMessage(s().recFailed);
        return;
      }
    }
    setPhase({ kind: "recording" });
    void startRecordingWatch(background.current, { title: s().noticeTitle, text: s().noticeText, stop: s().noticeStop, channel: s().noticeChannel });
    const seen = (await AsyncStorage.getItem(HINT_SEEN_KEY).catch(() => null)) === "1";
    if (showBackgroundHint(background.current, seen)) {
      setHint(true);
      void AsyncStorage.setItem(HINT_SEEN_KEY, "1").catch(() => {});
    }
  }

  /** Starts a take, in the foreground service or not (the mode is set before prepare: that binds the service). */
  async function begin(bg: boolean) {
    background.current = bg;
    await setAudioModeAsync(recordingAudioMode(bg));
    if (!recorder.getStatus().canRecord) await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_MEMO_MS / 1000 });
    if (!recorder.isRecording) throw new Error("the recorder didn't start");
  }

  async function finish(end: End) {
    void stopRecordingWatch();
    setHint(false);
    try {
      // Also a take paused by expo-audio when Hivo left the screen (see takeIsOpen).
      if (takeIsOpen({ isRecording: recorder.isRecording, canRecord: recorder.getStatus().canRecord })) await recorder.stop();
    } catch (e) {
      console.warn("Hivo: stop failed", e);
    }
    await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }).catch(() => {});
    const uri = recorder.uri;
    // The file's own length: the polled state is stale when the take ended in the background.
    const durationMs = (uri ? await fileDurationMs(uri) : null) ?? durationRef.current;
    if (!uri || durationMs < MIN_MEMO_MS) {
      if (uri) deleteFile(uri);
      setPhase({ kind: "idle" });
      setMessage(s().recTooShort);
      return;
    }
    const why = end === "auto" ? stopReason(takeCallStop(), durationMs, MAX_MEMO_MS) : end;
    const reason = why === "user" ? null : why === "background" ? s().recBackground : why === "call" ? s().recCall : why === "max" ? s().recMaxReached : s().recStopped;
    // Into the outbox at once, as a draft: a kill now doesn't lose the take
    // (B2). Not sent until Keep; Discard removes it.
    const id = newOutId();
    try {
      const file = await adopt(id, { uri, name: `${s().memoLabel}.m4a` });
      addOutItem(id, "memo", [file], { durationMs, target: targetRef.current, state: "draft" });
      setPhase({ kind: "done", id, uri: file.uri, durationMs });
      setMessage(reason);
    } catch (e) {
      console.warn("Hivo: could not keep the take as a draft", e);
      setPhase({ kind: "done", id: null, uri, durationMs });
      setMessage(e instanceof SpaceError ? s().noSpace : reason);
    }
  }

  async function stop() {
    stoppingByUser.current = true;
    await finish("user");
  }

  async function keep() {
    if (phase.kind !== "done") return;
    setBusy(true);
    try {
      player.pause();
      if (phase.id && keepDraftOut(phase.id, { title, target, fallbackName: s().memoLabel })) {
        requestSync();
        onDone();
        return;
      }
      // The draft copy had failed (or the draft is gone): adopt now.
      const id = newOutId();
      const file = await adopt(id, { uri: phase.uri, name: `${title.trim() || s().memoLabel}.m4a` });
      addOutItem(id, "memo", [file], { title: title.trim(), target, durationMs: phase.durationMs });
      requestSync();
      onDone();
    } catch (e) {
      setMessage(e instanceof SpaceError ? s().noSpace : s().copyFailed);
      setBusy(false);
    }
  }

  const recording = phase.kind === "recording";
  return (
    <View style={{ flex: 1 }}>
      {/* Back during a take says "Stop the recording first" instead of leaving. */}
      <ScreenHeader title={s().recTitle} onBack={back} />
      <ScrollView contentContainerStyle={{ padding: S.lg, gap: S.lg }} keyboardShouldPersistTaps="handled">
        <View style={styles.meter}>
          <Led color={recording ? C.missing : phase.kind === "done" ? C.ok : C.engrave} size={12} />
          <Text style={styles.clock}>{clock(phase.kind === "done" ? phase.durationMs : rec.durationMillis)}</Text>
        </View>
        <Engrave>{s().recMax(MAX_MEMO_MS / 60000)}</Engrave>
        {recording && hint ? <Text style={styles.msg}>{s().recInBackground}</Text> : null}
        {android && notice === "denied" && phase.kind !== "done" ? (
          <View style={styles.box}>
            <Text style={styles.msg}>{s().noticeDenied}</Text>
            {!recording ? <Button label={s().openSettings} onPress={() => void Linking.openSettings()} style={{ marginTop: S.sm, alignSelf: "flex-start" }} /> : null}
          </View>
        ) : null}

        {denied ? (
          <View style={styles.box}>
            <Text style={styles.msg}>{s().micDenied}</Text>
            <Button label={s().openSettings} onPress={() => void Linking.openSettings()} style={{ marginTop: S.sm, alignSelf: "flex-start" }} />
          </View>
        ) : null}

        {/* Why the take stopped, above the buttons where it's seen (F6). */}
        {message ? (
          <View style={styles.reason}>
            <Text style={styles.msg}>{message}</Text>
          </View>
        ) : null}

        {phase.kind === "idle" ? <Button label={s().recStart} variant="primary" onPress={() => void start()} /> : null}
        {recording ? <Button label={s().recStop} variant="primary" onPress={() => void stop()} /> : null}

        {phase.kind === "done" ? (
          <View style={{ gap: S.md }}>
            <Button label={playing ? s().pause : s().play} onPress={() => (playing ? player.pause() : (player.seekTo(0), player.play()))} />
            <TextInput
              value={title}
              onChangeText={(v) => {
                setTitle(v);
                if (phase.id) updateDraft(phase.id, { title: v });
              }}
              accessibilityLabel={s().titleLabel}
              maxLength={200}
              placeholder={s().recNamePlaceholder}
              placeholderTextColor={C.engrave}
              style={styles.input}
            />
            <TargetPicker
              value={target}
              onChange={(t) => {
                setTarget(t);
                if (phase.id) updateDraft(phase.id, { target: t });
              }}
            />
            <View style={{ flexDirection: "row", gap: S.sm }}>
              <Button label={s().recDiscard} variant="danger" onPress={() => confirmDiscard(discard)} />
              <View style={{ flex: 1 }} />
              <Button label={s().recSave} variant="primary" disabled={busy} onPress={() => void keep()} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { flexDirection: "row", alignItems: "center", gap: S.md, paddingVertical: 18, paddingHorizontal: S.lg, backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS },
  clock: { fontFamily: FONT.mono, fontSize: 40, color: C.cream },
  box: { borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, padding: 10, backgroundColor: C.panel },
  reason: { borderLeftWidth: 3, borderLeftColor: C.warn, paddingLeft: 10 },
  msg: { color: C.cream, fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis, color: C.cream, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15 },
});
