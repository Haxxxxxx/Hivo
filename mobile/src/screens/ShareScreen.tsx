import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { clearShareCache } from "../../modules/hivo-share";
import { c } from "../captureStrings";
import { ScreenHeader } from "../components/ScreenHeader";
import { TargetPicker } from "../components/TargetPicker";
import { Button, Engrave } from "../components/ui";
import { adoptAll, SpaceError } from "../files";
import { s } from "../inboxStrings";
import { sizeText } from "../lib/i18n";
import type { IdeaTarget } from "../lib/ideas";
import { checkShared, isZip, sharedName, type OutFile } from "../lib/outbox";
import { fileNameFor, isBandlabShare, shareText, skippedLabel, titleFromShare } from "../lib/shareMeta";
import type { Kind } from "../lib/sync";
import { addIdea, addOutItem, flushExtras, newOutId, requestSync, useApp } from "../store";
import { C, FONT, RADIUS, S } from "../theme";

export type IncomingShare = {
  /** `mime`: the type the sharing app sent (fills in a missing or odd extension). */
  files: { uri: string; name: string; size: number | null; mime?: string | null; named?: boolean }[];
  skipped: { name: string; reason: string; named?: boolean }[];
  text: string | null;
  subject: string | null;
  /** Picked in Hivo (copy the files) rather than shared from another app (already copies: move them). */
  picked: boolean;
  /** The native share's own cache folder (cleared when this share is done). */
  dir?: string | null;
};

const SONGS_ONLY: Kind[] = ["song"];

/** What another app shared with Hivo (or files picked here): send it to the
 * computer. `waiting` (optional): how many more shares wait their turn. */
export function ShareScreen({ share, onDone, onIdea, backRef, waiting = 0 }: { share: IncomingShare; onDone: () => void; onIdea: (id: string) => void; backRef: MutableRefObject<(() => void) | null>; waiting?: number }) {
  const paired = useApp((st) => st.pairing !== null);
  // Names as the files are (BandLab's M4A may come without an extension, or as .mp4).
  const files = useMemo(() => share.files.map((f) => ({ ...f, name: sharedName(f.name, f.mime), named: f.named !== false })), [share.files]);
  const check = useMemo(() => checkShared(files), [files]);
  const typeOf = (name: string) => files.find((f) => f.name === name)?.mime ?? null;
  const firstLine = (share.text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  const bandlab = isBandlabShare(share.text, share.subject);
  // BandLab's subject, a line of its text, else a file's own name; never a link or an id.
  const [title, setTitle] = useState(() => titleFromShare({ subject: share.subject, text: share.text, fileNames: check.ok.map((f) => f.name) }).slice(0, 200));
  // A file named by its id ("msf_1000032969.m4a") takes the song's name; a
  // real name stays as it is ("BandLab export" only for a BandLab share).
  const fallback = bandlab ? s().sketchLabel : c().sharedFile;
  /** Files: a new song with this name, or added to a song the computer has. */
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [target, setTarget] = useState<IdeaTarget | null>(null);
  const nameBase = mode === "existing" && target ? target.title : title;
  const finalName = (f: (typeof check.ok)[number], i: number) => fileNameFor(f.name, f.named, nameBase, i, check.ok.length, fallback);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skipped = [...share.skipped, ...check.refused];
  const hasFiles = check.ok.length > 0;
  const hasText = !!share.text?.trim();
  const songTarget = mode === "existing" ? target : null;
  const needsSong = mode === "existing" && !target;

  async function send() {
    setBusy(true);
    setError(null);
    const id = newOutId();
    try {
      // All of the item's files or none (a failure puts back what was moved).
      const files: OutFile[] = await adoptAll(id, check.ok.map((f, i) => ({ uri: f.uri, name: finalName(f, i) })), share.picked);
      // The shared words and BandLab link go with it (the computer keeps the link on the song).
      addOutItem(id, "sketch", files, { title: (mode === "existing" && songTarget ? songTarget.title : title).trim(), target: songTarget, text: shareText(share.text, share.subject) });
      // The share is forgotten only once its outbox row is on disk: a kill in
      // between must not lose both (review #8). Not saved (storage full):
      // the share stays remembered and comes back at the next launch.
      if ((await flushExtras()) && !share.picked) await clearShareCache(share.dir);
      requestSync();
      onDone();
    } catch (e) {
      setError(e instanceof SpaceError ? s().noSpace : s().copyFailed);
      setBusy(false);
    }
  }

  async function keepIdea() {
    if (busy) return;
    setBusy(true);
    // A first line becomes the title only when more follows (else it would show twice).
    const lines = (share.text ?? "").split("\n").filter((l) => l.trim());
    const ideaTitle = share.subject?.trim() || (lines.length > 1 && firstLine.length <= 80 ? firstLine : "");
    const id = addIdea({ title: ideaTitle, text: share.text ?? "", target });
    // Same as Send: the share goes once the idea is on disk (review #8).
    if ((await flushExtras()) && !share.picked) await clearShareCache(share.dir);
    requestSync();
    onIdea(id);
  }

  // Leaving without sending: asked first (nothing is kept yet), then the
  // copies (up to 20 files) go from the cache.
  const drop = () => {
    if (!share.picked) void clearShareCache(share.dir);
    onDone();
  };
  const leave = () => {
    if (busy) return;
    if (!hasFiles && !hasText) return drop();
    Alert.alert(c().leaveShareTitle, c().leaveShareBody, [
      { text: s().cancel, style: "cancel" },
      { text: c().leaveShareYes, style: "destructive", onPress: drop },
    ]);
  };
  // The hardware Back does the same (App.tsx calls it).
  useEffect(() => {
    backRef.current = leave;
    return () => {
      backRef.current = null;
    };
  });

  const sendLabel = paired ? s().shareSend : c().shareSendUnpaired;
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title={s().shareTitle} onBack={leave}>
        {waiting > 0 ? <Engrave style={{ marginTop: S.xs }}>{c().shareMoreWaiting(waiting)}</Engrave> : null}
      </ScreenHeader>
      <ScrollView contentContainerStyle={{ padding: S.lg, gap: 14 }} keyboardShouldPersistTaps="handled">
        {!paired ? <Text style={styles.note}>{s().shareNotPaired}</Text> : null}

        {hasFiles ? (
          <View style={styles.box}>
            <Engrave>{`${bandlab ? s().sketchLabel : c().sharedFile} · ${s().shareFiles(check.ok.length)}`}</Engrave>
            {check.ok.map((f, i) => (
              <Text key={f.uri} style={styles.file} numberOfLines={2}>
                {finalName(f, i)}
                {f.size !== null ? `  ·  ${sizeText(f.size)}` : ""}
                {isZip(f.name) ? `  ·  ${s().zipNote}` : ""}
              </Text>
            ))}
            {check.dropped > 0 ? <Text style={styles.warn}>{s().shareDropped(check.dropped)}</Text> : null}
          </View>
        ) : null}

        {skipped.length > 0 ? (
          <View style={[styles.box, { borderColor: C.warn }]}>
            <Engrave>{s().skipped}</Engrave>
            {skipped.map((k, i) => (
              <Text key={`${k.name}-${i}`} style={styles.file} numberOfLines={2}>
                {skippedLabel(k.name, "named" in k ? k.named : undefined, c().unnamedFile)} · {s().skip[k.reason] ?? k.reason}
                {k.reason === "type" && typeOf(k.name) ? ` (${typeOf(k.name)})` : ""}
              </Text>
            ))}
          </View>
        ) : null}

        {!hasFiles && hasText ? (
          <View style={styles.box}>
            <Engrave>{s().shareTextHint}</Engrave>
            <Text style={styles.text} numberOfLines={8}>{share.text}</Text>
          </View>
        ) : null}

        {!hasFiles && !hasText ? <Text style={styles.warn}>{s().shareNothing}</Text> : null}

        {hasFiles ? (
          // An export becomes a new song, or joins one the computer has: one choice, said plainly.
          <View style={{ gap: S.sm }} accessibilityRole="radiogroup">
            <Choice on={mode === "new"} label={c().shareAsNew} onPress={() => setMode("new")} />
            {mode === "new" ? (
              <TextInput value={title} onChangeText={setTitle} accessibilityLabel={c().shareAsNew} maxLength={200} placeholder={s().shareNamePlaceholder} placeholderTextColor={C.engrave} style={styles.input} />
            ) : null}
            <Choice on={mode === "existing"} label={c().shareToExisting} onPress={() => setMode("existing")} />
            {mode === "existing" ? <TargetPicker value={target} onChange={setTarget} kinds={SONGS_ONLY} label={c().shareToExisting} /> : null}
          </View>
        ) : null}
        {/* An idea can go anywhere. */}
        {!hasFiles && hasText ? <TargetPicker value={target} onChange={setTarget} /> : null}

        {error ? <Text style={styles.warn}>{error}</Text> : null}
        {/* "Add to an existing song" with none picked: say what's missing instead of a dead button. */}
        {hasFiles && needsSong ? <Text style={styles.note}>{c().pickSongFirst}</Text> : null}
        {hasFiles ? <Button label={sendLabel} variant="primary" disabled={busy || needsSong} onPress={() => void send()} /> : null}
        {!hasFiles && hasText ? <Button label={s().shareSaveIdea} variant="primary" disabled={busy} onPress={() => void keepIdea()} /> : null}
      </ScrollView>
    </View>
  );
}

function Choice({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on }} style={({ pressed }) => [styles.choice, pressed && { backgroundColor: C.raised }]}>
      <View style={[styles.dot, on && styles.dotOn]} />
      <Text style={styles.choiceText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  note: { color: C.body, fontSize: 14, lineHeight: 20 },
  box: { borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, padding: S.md, gap: 6 },
  file: { color: C.cream, fontSize: 14, lineHeight: 20 },
  text: { color: C.cream, fontSize: 15, lineHeight: 21 },
  warn: { color: C.warn, fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis, color: C.cream, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15 },
  choice: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 4, borderRadius: RADIUS },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: C.ruleStrong },
  dotOn: { borderColor: C.cream, backgroundColor: C.cream },
  choiceText: { color: C.cream, fontSize: 15, fontFamily: FONT.display, textTransform: "uppercase", letterSpacing: 0.4 },
});
