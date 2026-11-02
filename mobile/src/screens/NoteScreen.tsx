import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { analyzeLyrics, lineAt } from "../lib/lyrics";
import { Button, Engrave, Led } from "../components/ui";
import { tr } from "../lib/i18n";
import { findItem, isGone, itemKey, MAX_NOTE_CHARS, noteFor, type Kind } from "../lib/sync";
import { clearConflict, flush, removeGone, setNote, useApp } from "../store";
import { T } from "../strings";
import { s } from "../inboxStrings";
import type { IdeaTarget } from "../lib/ideas";
import { C, FONT, RADIUS } from "../theme";

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
  const [cursor, setCursor] = useState(0);
  const [counts, setCounts] = useState(false);
  const t = tr(T);
  const bpm = item?.bpm != null && item.bpm > 0 ? Math.round(item.bpm) : null;
  const stats = useMemo(() => analyzeLyrics(text, bpm), [text, bpm]);
  const curLine = lineAt(text, cursor);
  const curCount = stats.lines[curLine]?.syllables ?? 0;

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

  // Save when leaving the screen.
  useEffect(
    () => () => {
      save();
      void flush();
    },
    [],
  );

  const title = item?.title ?? id;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" style={{ paddingVertical: 4 }}>
          <Text style={styles.back}>‹ {t.back}</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
          {item?.subtitle ? <Text style={styles.sub} numberOfLines={1}>{item.kind === "song" && item.stage ? t.stage[item.stage] ?? item.subtitle : item.subtitle}</Text> : null}
          {item?.bpm != null || item?.key ? (
            <Engrave style={{ marginLeft: item?.subtitle ? 10 : 0 }}>{[item?.bpm != null ? `${Math.round(item.bpm)} BPM` : null, item?.key].filter(Boolean).join(" · ")}</Engrave>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {item?.kind === "prod" && item.url ? (
            <Button label={t.openLink} onPress={() => void Linking.openURL(item.url as string)} style={{ paddingVertical: 6 }} />
          ) : null}
          {item && !gone ? (
            <>
              <Button label={s().recordForThis} onPress={() => onRecord({ kind, id, title: item.title })} style={{ paddingVertical: 6 }} />
              <Button label={s().ideaForThis} onPress={() => onIdea({ kind, id, title: item.title })} style={{ paddingVertical: 6 }} />
            </>
          ) : null}
        </View>
      </View>

      {gone ? (
        <View style={[styles.conflict, { borderColor: C.missing }]}>
          <Led color={C.missing} size={7} />
          <Text style={styles.conflictText}>{t.goneBanner}</Text>
          <Button label={t.removeFromPhone} variant="danger" onPress={remove} style={{ paddingVertical: 4, paddingHorizontal: 8, marginLeft: 6 }} hitSlop={SLOP_4} />
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
          <Text style={styles.conflictText}>{t.conflict}</Text>
          <Button label={t.dismiss} variant="quiet" onPress={() => clearConflict(kind, id)} style={{ paddingVertical: 4, paddingHorizontal: 8 }} hitSlop={SLOP_4} />
        </View>
      ) : null}

      {counts ? (
        // Read-only: each line with its syllables (headers set apart).
        <ScrollView style={styles.editor} contentContainerStyle={{ paddingBottom: 12 }}>
          {stats.lines.map((l, i) => (
            <View key={i} style={styles.countRow}>
              <Text style={[styles.countText, l.header && { color: C.body }]}>{l.text || " "}</Text>
              {l.syllables > 0 ? <Text style={styles.countNum}>{l.syllables}</Text> : null}
            </View>
          ))}
        </ScrollView>
      ) : (
        <TextInput
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
        {text.trim() ? <Button label={counts ? t.hideCounts : t.showCounts} variant="quiet" onPress={() => setCounts((c) => !c)} style={{ paddingVertical: 2, paddingHorizontal: 8 }} hitSlop={SLOP_2} /> : null}
      </View>
      <View style={styles.footer}>
        <Led color={gone ? C.missing : pending || text !== written.current ? C.warn : C.ok} size={7} />
        <Engrave style={{ marginLeft: 6, flex: 1 }}>{gone ? t.gone : pending || text !== written.current ? t.savedLocal : t.savedSynced}</Engrave>
        {text.length >= MAX_NOTE_CHARS ? <Text style={{ color: C.warn, fontSize: 12 }}>{t.tooLong(MAX_NOTE_CHARS)}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

// Compact buttons keep their look; the touch area grows to 48 dp
// (about 30 dp tall with 4 dp padding, 26 dp with 2 dp).
const SLOP_4 = { top: 9, bottom: 9, left: 4, right: 4 };
const SLOP_2 = { top: 11, bottom: 11, left: 4, right: 4 };

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 3, borderBottomColor: C.rule },
  back: { color: C.body, fontSize: 15 },
  title: { fontFamily: FONT.display, fontSize: 28, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6 },
  sub: { color: C.body, fontSize: 14, flexShrink: 1 },
  conflict: { flexDirection: "row", alignItems: "center", margin: 12, marginBottom: 0, padding: 10, borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, backgroundColor: C.panel },
  conflictText: { color: C.cream, flex: 1, marginLeft: 8, fontSize: 13, lineHeight: 18 },
  editor: { flex: 1, margin: 12, padding: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, color: C.cream, fontSize: 16, lineHeight: 23 },
  stats: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 4 },
  countRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  countText: { flex: 1, color: C.cream, fontSize: 16, lineHeight: 23 },
  countNum: { color: C.engrave, fontFamily: FONT.mono, fontSize: 12, lineHeight: 23, minWidth: 20, textAlign: "right" },
  footer: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 10 },
});
