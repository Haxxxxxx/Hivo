import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { TargetPicker } from "../components/TargetPicker";
import { Button, Engrave, Led } from "../components/ui";
import { s } from "../inboxStrings";
import { tr } from "../lib/i18n";
import { filedTitle } from "../lib/filedTo";
import { findItem } from "../lib/sync";
import { isEmptyIdea, isLocked, MAX_IDEA_CHARS, MAX_TITLE_CHARS } from "../lib/ideas";
import { flushExtras, removeIdea, requestSync, updateIdea, useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS } from "../theme";

/** Writing an idea: a title, the text, what it's for. Autosaves; sent at the next sync. */
export function IdeaScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const idea = useApp((st) => st.ideas.find((i) => i.id === id));
  const library = useApp((st) => st.sync);
  const [title, setTitle] = useState(idea?.title ?? "");
  const [text, setText] = useState(idea?.text ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title, text });
  const t = tr(T);
  const locked = idea ? isLocked(idea) : false;

  function save() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!locked) updateIdea(id, latest.current);
  }

  function edit(patch: Partial<{ title: string; text: string }>) {
    latest.current = { ...latest.current, ...patch };
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.text !== undefined) setText(patch.text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, 400);
  }

  // Leaving: save, drop it if it's empty, and send.
  useEffect(
    () => () => {
      save();
      if (isEmptyIdea(latest.current)) removeIdea(id);
      void flushExtras();
      requestSync();
    },
    [],
  );

  function confirmDelete() {
    Alert.alert(s().deleteConfirmTitle, s().deleteConfirmBody, [
      { text: s().cancel, style: "cancel" },
      {
        text: s().del,
        style: "destructive",
        onPress: () => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
          latest.current = { title: "", text: "" };
          removeIdea(id);
          onBack();
        },
      },
    ]);
  }

  if (!idea) {
    return (
      <View style={{ padding: 16 }}>
        <Pressable onPress={onBack} accessibilityRole="button">
          <Text style={styles.back}>‹ {t.back}</Text>
        </Pressable>
      </View>
    );
  }

  const filedWhere = idea.status === "filed" ? filedTitle(idea.filedTo, (k, i) => findItem(library, k, i)) : null;
  const status = idea.status === "filed" ? (filedWhere ? s().filedTo(filedWhere) : s().filedOnComputer) : idea.status === "dismissed" ? s().dismissedOnComputer : idea.status === "stored" && idea.sentAt !== null && idea.updatedAt <= idea.sentAt ? s().onComputer : s().notSent;
  const led = idea.status === "filed" || (idea.status === "stored" && idea.sentAt !== null && idea.updatedAt <= idea.sentAt) ? C.ok : idea.status === "dismissed" ? C.engrave : C.warn;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" style={{ paddingVertical: 4 }}>
          <Text style={styles.back}>‹ {t.back}</Text>
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
          <Led color={led} size={7} />
          <Engrave style={{ marginLeft: 6 }}>{status}</Engrave>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        {locked ? <Text style={styles.locked}>{idea.status === "filed" ? s().lockedFiled : s().lockedDismissed}</Text> : null}
        <View>
          <Engrave>{s().ideaTitle}</Engrave>
          <TextInput value={title} onChangeText={(v) => edit({ title: v })} editable={!locked} accessibilityLabel={s().ideaTitle} maxLength={MAX_TITLE_CHARS} placeholder={s().ideaTitlePlaceholder} placeholderTextColor={C.engrave} style={styles.title} />
        </View>
        <View>
          <Engrave>{s().ideaText}</Engrave>
          <TextInput value={text} onChangeText={(v) => edit({ text: v })} editable={!locked} accessibilityLabel={s().ideaText} multiline maxLength={MAX_IDEA_CHARS} placeholder={s().ideaTextPlaceholder} placeholderTextColor={C.engrave} style={styles.text} textAlignVertical="top" />
        </View>
        <TargetPicker value={idea.target} disabled={locked} onChange={(target) => updateIdea(id, { target })} />
        {isEmptyIdea({ title, text }) ? <Text style={styles.hint}>{s().emptyIdea}</Text> : null}
        <Button label={s().deleteIdea} variant="danger" onPress={confirmDelete} style={{ alignSelf: "flex-start", marginTop: 8 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 3, borderBottomColor: C.rule },
  back: { color: C.body, fontSize: 15 },
  title: { marginTop: 6, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, color: C.cream, paddingHorizontal: 10, paddingVertical: 10, fontFamily: FONT.display, fontSize: 22, textTransform: "uppercase" },
  text: { marginTop: 6, minHeight: 200, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, color: C.cream, padding: 12, fontSize: 16, lineHeight: 23 },
  locked: { color: C.cream, borderWidth: 1, borderColor: C.ok, borderRadius: RADIUS, padding: 10, fontSize: 13, lineHeight: 18 },
  hint: { color: C.engrave, fontSize: 13 },
});
