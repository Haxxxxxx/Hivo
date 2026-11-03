import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenHeader } from "../components/ScreenHeader";
import { TargetPicker } from "../components/TargetPicker";
import { Button, Engrave, Led } from "../components/ui";
import { s } from "../inboxStrings";
import { filedTitle } from "../lib/filedTo";
import { findItem } from "../lib/sync";
import { isEmptyIdea, isLocked, MAX_IDEA_CHARS, MAX_TITLE_CHARS } from "../lib/ideas";
import { flushExtras, removeIdea, requestSync, updateIdea, useApp } from "../store";
import { C, RADIUS, S } from "../theme";

/** Writing an idea: the text first (focused), a title, what it's for.
 * Autosaves; sent at the next sync. */
export function IdeaScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const idea = useApp((st) => st.ideas.find((i) => i.id === id));
  const library = useApp((st) => st.sync);
  const [title, setTitle] = useState(idea?.title ?? "");
  const [text, setText] = useState(idea?.text ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title, text });
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

  // Leaving: save, drop it if it's empty, and send. (One left by a kill is
  // dropped at the next launch: store.ts `load`.)
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

  if (!idea) return <ScreenHeader title={s().newIdea} onBack={onBack} />;

  const empty = isEmptyIdea({ title, text });
  const onComputer = idea.status === "stored" && idea.sentAt !== null && idea.updatedAt <= idea.sentAt;
  const filedWhere = idea.status === "filed" ? filedTitle(idea.filedTo, (k, i) => findItem(library, k, i)) : null;
  // An empty idea isn't "not sent yet": it isn't anything until something's written.
  const status = idea.status === "filed" ? (filedWhere ? s().filedTo(filedWhere) : s().filedOnComputer) : idea.status === "dismissed" ? s().dismissedOnComputer : onComputer ? s().onComputer : empty ? s().emptyIdea : s().notSent;
  const led = idea.status === "filed" || onComputer ? C.ok : idea.status === "dismissed" || empty ? C.engrave : C.warn;

  return (
    // Android 15+ draws edge to edge: the window no longer shrinks for the keyboard, so pad on both.
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScreenHeader title={idea.title.trim() || s().newIdea} onBack={onBack} titleLines={1}>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6 }}>
          <Led color={led} size={7} />
          <Engrave style={{ marginLeft: 6, flexShrink: 1 }}>{status}</Engrave>
        </View>
      </ScreenHeader>
      <ScrollView contentContainerStyle={{ padding: S.lg, gap: 14 }} keyboardShouldPersistTaps="handled">
        {locked ? <Text style={styles.locked}>{idea.status === "filed" ? s().lockedFiled : s().lockedDismissed}</Text> : null}
        <View>
          <Engrave>{s().ideaText}</Engrave>
          <TextInput
            value={text}
            onChangeText={(v) => edit({ text: v })}
            editable={!locked}
            autoFocus={!locked && !idea.text}
            accessibilityLabel={s().ideaText}
            multiline
            maxLength={MAX_IDEA_CHARS}
            placeholder={s().ideaTextPlaceholder}
            placeholderTextColor={C.engrave}
            style={styles.text}
            textAlignVertical="top"
          />
        </View>
        <View>
          <Engrave>{s().ideaTitle}</Engrave>
          <TextInput value={title} onChangeText={(v) => edit({ title: v })} editable={!locked} accessibilityLabel={s().ideaTitle} maxLength={MAX_TITLE_CHARS} placeholder={s().ideaTitlePlaceholder} placeholderTextColor={C.engrave} style={styles.title} />
        </View>
        <TargetPicker value={idea.target} disabled={locked} onChange={(target) => updateIdea(id, { target })} />
        <Button label={s().deleteIdea} variant="danger" onPress={confirmDelete} style={{ alignSelf: "flex-start", marginTop: S.sm }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // The body font, as typed (it was condensed caps, and read as shouting).
  title: { marginTop: 6, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, color: C.cream, paddingHorizontal: 10, paddingVertical: 10, fontSize: 16 },
  text: { marginTop: 6, minHeight: 200, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel, color: C.cream, padding: S.md, fontSize: 16, lineHeight: 23 },
  locked: { color: C.cream, borderWidth: 1, borderColor: C.ok, borderRadius: RADIUS, padding: 10, fontSize: 13, lineHeight: 18 },
});
