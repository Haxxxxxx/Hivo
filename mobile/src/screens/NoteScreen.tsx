import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Linking, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from "react-native";
import { c } from "../captureStrings";
import { analyzeLyrics, lineAt } from "../lib/lyrics";
import { MiniPlayer } from "../components/MiniPlayer";
import { ScreenHeader } from "../components/ScreenHeader";
import { Button, Engrave, Facts, Led } from "../components/ui";
import { canonicalUrl, youtubeId } from "../lib/youtube";
import { tr } from "../lib/i18n";
import { findItem, isGone, itemKey, MAX_NOTE_CHARS, noteFor, type Kind } from "../lib/sync";
import { clearConflict, flush, pendingSaves, removeGone, setNote, useApp } from "../store";
import { T } from "../strings";
import type { IdeaTarget } from "../lib/ideas";
import { C, FONT, RADIUS, S } from "../theme";

/** Where the computer put the phone's lines after a conflict (its marker line). */
export const CONFLICT_MARKER = /^--- from .+ ---$/m;

export function NoteScreen({ kind, id, onBack, onRecord, onIdea }: { kind: Kind; id: string; onBack: () => void; onRecord: (t: IdeaTarget) => void; onIdea: (t: IdeaTarget) => void }) {
  const item = useApp((s) => s.sync.gone[itemKey(kind, id)] ?? findItem(s.sync, kind, id));
  const gone = useApp((s) => isGone(s.sync, kind, id));
  const stored = useApp((s) => noteFor(s.sync, kind, id));
  const pending = useApp((s) => !!s.sync.pending[itemKey(kind, id)]);
  const conflictAt = useApp((s) => s.sync.conflicts[itemKey(kind, id)]);
  const tooLongAt = useApp((s) => s.sync.tooLong?.[itemKey(kind, id)]);
  const [text, setText] = useState(stored);
  const written = useRef(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  const input = useRef<TextInputInstance>(null);
  const [cursor, setCursor] = useState(0);
  const [counts, setCounts] = useState(false);
  /** The keyboard is up: the header shrinks to Back + title so the cursor stays in view. */
  const [typing, setTyping] = useState(false);
  const t = tr(T);
  const bpm = item?.bpm != null && item.bpm > 0 ? Math.round(item.bpm) : null;
  const stats = useMemo(() => analyzeLyrics(text, bpm), [text, bpm]);
  const curLine = lineAt(text, cursor);
  const curCount = stats.lines[curLine]?.syllables ?? 0;
  const videoId = item?.url ? youtubeId(item.url) : null;
  /** The video in the docked player; one at a time, gone with the screen. */
  const [playing, setPlaying] = useState<string | null>(null);
  const closePlayer = useCallback(() => setPlaying(null), []);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setTyping(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setTyping(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // A sync replaced the note (merge, or edited on the computer): show it,
  // unless an autosave is about to land.
  useEffect(() => {
    if (stored !== written.current && !timer.current) {
      written.current = stored;
      latest.current = stored;
      setText(stored);
    }
  }, [stored]);

  function remove() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    written.current = latest.current; // nothing left to save
    removeGone(kind, id);
    onBack();
  }

  function save() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (latest.current !== written.current) {
      written.current = latest.current;
      setNote(kind, id, latest.current);
    }
  }

  function onChange(next: string) {
    setText(next);
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, 400);
  }

  /** "Show": the cursor on the computer's marker line, the editor scrolled to it. */
  function showConflict() {
    const at = CONFLICT_MARKER.exec(text)?.index ?? -1;
    if (at < 0) return;
    setCounts(false);
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelection(at, at);
      setCursor(at);
    }, 50);
  }

  // Save when leaving the screen, and before the app goes to the background
  // (the last keystrokes wait 400 ms, or for the blur: review #7).
  useEffect(() => {
    const off = pendingSaves.register(save);
    return () => {
      off();
      save();
      void flush();
    };
  }, []);

  const title = item?.title ?? id;
  const facts = (item?.bpm != null && item.bpm > 0) || !!item?.key?.trim();
  return (
    // Android 15+ draws edge to edge: the window no longer shrinks for the keyboard, so pad on both.
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScreenHeader title={title} onBack={onBack} titleLines={typing ? 1 : 2}>
        {!typing ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: S.xs, flexWrap: "wrap" }}>
              {item?.subtitle ? <Text style={styles.sub} numberOfLines={1}>{item.kind === "song" && item.stage ? t.stage[item.stage] ?? item.subtitle : item.subtitle}</Text> : null}
              {facts ? <Facts bpm={item?.bpm} musicalKey={item?.key} style={{ marginLeft: item?.subtitle ? 10 : 0 }} /> : null}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm, marginTop: S.sm, paddingVertical: S.xs }}>
              {item?.url && videoId ? (
                // While it plays, the player has its own "Open in YouTube".
                playing !== videoId ? (
                  <>
                    <Button label={t.playHere} onPress={() => setPlaying(videoId)} size="compact" />
                    <Button label={t.openInYoutube} onPress={() => void Linking.openURL(canonicalUrl(item.url as string)).catch(() => {})} size="compact" />
                  </>
                ) : null
              ) : item?.url ? (
                <Button label={t.openLink} onPress={() => void Linking.openURL(item.url as string).catch(() => {})} size="compact" />
              ) : null}
              {item && !gone ? (
                <>
                  <Button label={c().recordFor(kind)} onPress={() => onRecord({ kind, id, title: item.title })} size="compact" />
                  <Button label={c().ideaFor(kind)} onPress={() => onIdea({ kind, id, title: item.title })} size="compact" />
                </>
              ) : null}
            </View>
          </>
        ) : null}
      </ScreenHeader>

      {playing ? <MiniPlayer videoId={playing} onClose={closePlayer} /> : null}

      {gone ? (
        <View style={[styles.conflict, { borderColor: C.missing }]}>
          <Led color={C.missing} size={7} />
          <Text style={styles.conflictText}>{t.goneBanner}</Text>
          <Button label={t.removeFromPhone} variant="danger" onPress={remove} size="compact" style={{ marginLeft: 6 }} />
        </View>
      ) : null}

      {tooLongAt ? (
        <View style={[styles.conflict, { borderColor: C.missing }]}>
          <Led color={C.missing} size={7} />
          <Text style={styles.conflictText}>{t.noteTooLong}</Text>
        </View>
      ) : null}

      {conflictAt ? (
        <View style={styles.conflict}>
          <Led color={C.warn} size={7} />
          <Text style={styles.conflictText}>{c().conflictMarked}</Text>
          {CONFLICT_MARKER.test(text) ? <Button label={c().conflictShow} onPress={showConflict} size="compact" /> : null}
          <Button label={t.dismiss} variant="quiet" onPress={() => clearConflict(kind, id)} size="compact" />
        </View>
      ) : null}

      {counts ? (
        // Read-only: each line with its syllables (headers set apart).
        <ScrollView style={styles.editor} contentContainerStyle={{ paddingBottom: S.md }}>
          {stats.lines.map((l, i) => (
            <View key={i} style={styles.countRow}>
              <Text style={[styles.countText, l.header && { color: C.body }]}>{l.text || " "}</Text>
              {l.syllables > 0 ? <Text style={styles.countNum}>{l.syllables}</Text> : null}
            </View>
          ))}
        </ScrollView>
      ) : (
        <TextInput
          ref={input}
          value={text}
          onChangeText={onChange}
          onBlur={save}
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.start)}
          accessibilityLabel={t.noteLabel}
          multiline
          maxLength={MAX_NOTE_CHARS}
          placeholder={t.notePlaceholder}
          placeholderTextColor={C.engrave}
          style={styles.editor}
          textAlignVertical="top"
          autoCapitalize="sentences"
          scrollEnabled
        />
      )}
      <View style={styles.stats}>
        <Engrave style={{ flex: 1 }}>
          {[!counts && text ? t.lineCount(curLine + 1, curCount) : null, stats.bars !== null && bpm !== null ? t.barsAt(stats.bars, bpm) : stats.syllables > 0 ? t.syllables(stats.syllables) : null].filter(Boolean).join("  ·  ")}
        </Engrave>
        {text.trim() ? <Button label={counts ? t.hideCounts : t.showCounts} variant="quiet" onPress={() => setCounts((v) => !v)} size="compact" /> : null}
      </View>
      <View style={styles.footer}>
        <Led color={gone ? C.missing : pending || text !== written.current ? C.warn : C.ok} size={7} />
        <Engrave style={{ marginLeft: 6, flex: 1 }}>{gone ? t.gone : pending || text !== written.current ? t.savedLocal : t.savedSynced}</Engrave>
        {text.length >= MAX_NOTE_CHARS ? <Text style={{ color: C.warn, fontSize: 12 }}>{t.tooLong(MAX_NOTE_CHARS)}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sub: { color: C.body, fontSize: 14, flexShrink: 1 },
  conflict: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, margin: S.md, marginBottom: 0, padding: 10, borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, backgroundColor: C.panel },
  conflictText: { color: C.cream, flex: 1, minWidth: 180, marginLeft: S.sm, fontSize: 13, lineHeight: 18 },
  editor: { flex: 1, margin: S.md, padding: S.md, backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, color: C.cream, fontSize: 16, lineHeight: 23 },
  stats: { flexDirection: "row", alignItems: "center", paddingHorizontal: S.lg, paddingBottom: S.xs, minHeight: 32 },
  countRow: { flexDirection: "row", alignItems: "flex-start", gap: S.sm },
  countText: { flex: 1, color: C.cream, fontSize: 16, lineHeight: 23 },
  countNum: { color: C.engrave, fontFamily: FONT.mono, fontSize: 12, lineHeight: 23, minWidth: 20, textAlign: "right" },
  footer: { flexDirection: "row", alignItems: "center", paddingHorizontal: S.lg, paddingBottom: 10 },
});
