import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { clearShareCache } from "../../modules/hivo-share";
import { TargetPicker } from "../components/TargetPicker";
import { Button, Engrave } from "../components/ui";
import { adopt, SpaceError } from "../files";
import { s } from "../inboxStrings";
import { tr } from "../lib/i18n";
import type { IdeaTarget } from "../lib/ideas";
import { checkShared, isZip, sharedName, type OutFile } from "../lib/outbox";
import { fileNameFor, shareText, titleFromShare } from "../lib/shareMeta";
import { addIdea, addOutItem, newOutId, requestSync, useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS } from "../theme";

export type IncomingShare = {
  /** `mime`: the type the sharing app sent (fills in a missing or odd extension). */
  files: { uri: string; name: string; size: number | null; mime?: string | null; named?: boolean }[];
  skipped: { name: string; reason: string }[];
  text: string | null;
  subject: string | null;
  /** Picked in Hivo (copy the files) rather than shared from another app (already copies: move them). */
  picked: boolean;
};

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What another app shared with Hivo (or files picked here): send it to the computer. */
export function ShareScreen({ share, onDone, onIdea }: { share: IncomingShare; onDone: () => void; onIdea: (id: string) => void }) {
  const paired = useApp((st) => st.pairing !== null);
  // Names as the files are (BandLab's M4A may come without an extension, or as .mp4).
  const files = useMemo(() => share.files.map((f) => ({ ...f, name: sharedName(f.name, f.mime), named: f.named !== false })), [share.files]);
  const check = useMemo(() => checkShared(files), [files]);
  const typeOf = (name: string) => files.find((f) => f.name === name)?.mime ?? null;
  const firstLine = (share.text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  // BandLab's subject, a line of its text, else a file's own name; never a link or an id.
  const [title, setTitle] = useState(() => titleFromShare({ subject: share.subject, text: share.text, fileNames: check.ok.map((f) => f.name) }).slice(0, 200));
  // A file named by its id ("msf_1000032969.m4a") takes the song's name.
  const finalName = (f: (typeof check.ok)[number], i: number) => fileNameFor(f.name, f.named, title, i, check.ok.length);
  const [target, setTarget] = useState<IdeaTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = tr(T);

  const skipped = [...share.skipped, ...check.refused];
  const hasFiles = check.ok.length > 0;
  const hasText = !!share.text?.trim();

  async function send() {
    setBusy(true);
    setError(null);
    const id = newOutId();
    const files: OutFile[] = [];
    try {
      for (const [i, f] of check.ok.entries()) files.push(await adopt(id, { ...f, name: finalName(f, i) }, share.picked));
      // The shared words and BandLab link go with it (the computer keeps the link on the song).
      addOutItem(id, "sketch", files, { title: title.trim(), target, text: shareText(share.text, share.subject) });
      void clearShareCache();
      requestSync();
      onDone();
    } catch (e) {
      setError(e instanceof SpaceError ? s().noSpace : s().copyFailed);
      setBusy(false);
    }
  }

  function keepIdea() {
    // A first line becomes the title only when more follows (else it would show twice).
    const lines = (share.text ?? "").split("\n").filter((l) => l.trim());
    const title = share.subject?.trim() || (lines.length > 1 && firstLine.length <= 80 ? firstLine : "");
    const id = addIdea({ title, text: share.text ?? "", target });
    void clearShareCache();
    requestSync();
    onIdea(id);
  }

  // Leaving without sending: drop the copies (up to 20 files) from the cache.
  const leave = () => {
    if (!share.picked) void clearShareCache();
    onDone();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
      <Pressable onPress={leave} hitSlop={10} accessibilityRole="button" style={{ paddingVertical: 4 }}>
        <Text style={styles.back}>‹ {t.back}</Text>
      </Pressable>
      <Text style={styles.title}>{s().shareTitle}</Text>
      {!paired ? <Text style={styles.note}>{s().shareNotPaired}</Text> : null}

      {hasFiles ? (
        <View style={styles.box}>
          <Engrave>{`${s().sketchLabel} · ${s().shareFiles(check.ok.length)}`}</Engrave>
          {check.ok.map((f, i) => (
            <Text key={f.uri} style={styles.file} numberOfLines={1}>
              {finalName(f, i)}
              {f.size !== null ? `  ·  ${mb(f.size)}` : ""}
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
            <Text key={`${k.name}-${i}`} style={styles.file}>
              {k.name} · {s().skip[k.reason] ?? k.reason}
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
        <View>
          <Engrave>{s().shareName}</Engrave>
          <TextInput value={title} onChangeText={setTitle} maxLength={200} placeholder={s().shareNamePlaceholder} placeholderTextColor={C.engrave} style={styles.input} />
        </View>
      ) : null}
      {hasFiles || hasText ? <TargetPicker value={target} onChange={setTarget} /> : null}

      {error ? <Text style={styles.warn}>{error}</Text> : null}
      {hasFiles ? <Button label={s().shareSend} variant="primary" disabled={busy} onPress={() => void send()} /> : null}
      {!hasFiles && hasText ? <Button label={s().shareSaveIdea} variant="primary" onPress={keepIdea} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { color: C.body, fontSize: 15 },
  title: { fontFamily: FONT.display, fontSize: 28, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  note: { color: C.body, fontSize: 14, lineHeight: 20 },
  box: { borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, padding: 12, gap: 6 },
  file: { color: C.cream, fontSize: 14 },
  text: { color: C.cream, fontSize: 15, lineHeight: 21 },
  warn: { color: C.warn, fontSize: 14, lineHeight: 20 },
  input: { marginTop: 6, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis, color: C.cream, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15 },
});
