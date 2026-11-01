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
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { TargetPicker } from "../components/TargetPicker";
import { Button, Engrave, Led } from "../components/ui";
import { adopt, SpaceError } from "../files";
import { s } from "../inboxStrings";
import { tr } from "../lib/i18n";
import type { IdeaTarget } from "../lib/ideas";
import { MAX_MEMO_MS, MIN_MEMO_MS } from "../lib/outbox";
import { addOutItem, newOutId, requestSync } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS } from "../theme";

type Phase = { kind: "idle" } | { kind: "recording" } | { kind: "done"; uri: string; durationMs: number };

const clock = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

/** Record a flow or a melody; kept in the outbox, sent at the next sync. */
export function RecordScreen({ target: initialTarget, onDone }: { target: IdeaTarget | null; onDone: () => void }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState<IdeaTarget | null>(initialTarget);
  const [message, setMessage] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const stoppingByUser = useRef(false);
  const t = tr(T);
  const player = useAudioPlayer(phase.kind === "done" ? phase.uri : null);
  const playing = useAudioPlayerStatus(player).playing;

  useEffect(() => {
    void getRecordingPermissionsAsync().then((p) => setDenied(!p.granted && !p.canAskAgain));
  }, []);

  // Stopped without the Stop button: the 15-minute cap, a call, another app.
  // Judged by "it did start", not by the clock: a call in the first second
  // left the screen stuck on "recording" at 0:00.
  const started = useRef(false);
  useEffect(() => {
    if (rec.isRecording) {
      started.current = true;
      return;
    }
    if (phase.kind !== "recording" || stoppingByUser.current || !started.current) return;
    void finish(rec.durationMillis >= MAX_MEMO_MS - 1000 ? s().recMaxReached : s().recStopped);
  }, [rec.isRecording]);

  async function start() {
    started.current = false;
    setMessage(null);
    const p = await requestRecordingPermissionsAsync();
    if (!p.granted) {
      setDenied(true);
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      stoppingByUser.current = false;
      recorder.record({ forDuration: MAX_MEMO_MS / 1000 });
      setPhase({ kind: "recording" });
    } catch (e) {
      console.warn("Hivo: recording didn't start", e);
      setMessage(s().recFailed);
    }
  }

  async function finish(note: string | null) {
    const durationMs = rec.durationMillis;
    try {
      if (recorder.isRecording) await recorder.stop();
    } catch (e) {
      console.warn("Hivo: stop failed", e);
    }
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    const uri = recorder.uri;
    if (!uri || durationMs < MIN_MEMO_MS) {
      setPhase({ kind: "idle" });
      setMessage(s().recTooShort);
      return;
    }
    setPhase({ kind: "done", uri, durationMs });
    setMessage(note);
  }

  async function stop() {
    stoppingByUser.current = true;
    await finish(null);
  }

  async function keep() {
    if (phase.kind !== "done") return;
    setBusy(true);
    try {
      player.pause();
      const id = newOutId();
      const file = await adopt(id, { uri: phase.uri, name: `${title.trim() || "Voice memo"}.m4a` });
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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
      {!recording ? (
        <Pressable onPress={onDone} hitSlop={10} accessibilityRole="button" style={{ paddingVertical: 4 }}>
          <Text style={styles.back}>‹ {t.back}</Text>
        </Pressable>
      ) : (
        <View style={{ height: 26 }} />
      )}
      <Text style={styles.title}>{s().recTitle}</Text>

      <View style={styles.meter}>
        <Led color={recording ? C.missing : phase.kind === "done" ? C.ok : C.engrave} size={12} />
        <Text style={styles.clock}>{clock(phase.kind === "done" ? phase.durationMs : rec.durationMillis)}</Text>
      </View>
      <Engrave>{s().recMax(MAX_MEMO_MS / 60000)}</Engrave>

      {denied ? (
        <View style={styles.box}>
          <Text style={styles.msg}>{s().micDenied}</Text>
          <Button label={s().openSettings} onPress={() => void Linking.openSettings()} style={{ marginTop: 8, alignSelf: "flex-start" }} />
        </View>
      ) : null}

      {phase.kind === "idle" ? <Button label={s().recStart} variant="primary" onPress={() => void start()} /> : null}
      {recording ? <Button label={s().recStop} variant="primary" onPress={() => void stop()} /> : null}

      {phase.kind === "done" ? (
        <View style={{ gap: 12 }}>
          <Button label={playing ? s().pause : s().play} onPress={() => (playing ? player.pause() : (player.seekTo(0), player.play()))} />
          <TextInput value={title} onChangeText={setTitle} maxLength={200} placeholder={s().recNamePlaceholder} placeholderTextColor={C.engrave} style={styles.input} />
          <TargetPicker value={target} onChange={setTarget} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              label={s().recDiscard}
              variant="quiet"
              onPress={() => {
                player.pause();
                setPhase({ kind: "idle" });
                setMessage(null);
              }}
            />
            <View style={{ flex: 1 }} />
            <Button label={s().recSave} variant="primary" disabled={busy} onPress={() => void keep()} />
          </View>
        </View>
      ) : null}

      {message ? <Text style={styles.msg}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { color: C.body, fontSize: 15 },
  title: { fontFamily: FONT.display, fontSize: 28, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  meter: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 18, paddingHorizontal: 16, backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS },
  clock: { fontFamily: FONT.mono, fontSize: 40, color: C.cream },
  box: { borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, padding: 10, backgroundColor: C.panel },
  msg: { color: C.cream, fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis, color: C.cream, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15 },
});
