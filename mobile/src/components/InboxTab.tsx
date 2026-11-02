import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { s } from "../inboxStrings";
import { filedTitle } from "../lib/filedTo";
import { visibleIdeas, type Idea } from "../lib/ideas";
import { findItem, type Item, type Kind } from "../lib/sync";
import { progress, type OutItem } from "../lib/outbox";
import { removeOut, requestSync, retryOut, useApp } from "../store";
import { C, RADIUS } from "../theme";
import { Button, Engrave, Led } from "./ui";

type Props = {
  onIdea: (id: string | null) => void;
  onRecord: () => void;
  onPick: () => void;
};

/** How many things still have to reach the computer (the tab's badge). */
export function useInboxPending(): number {
  const ideas = useApp((st) => st.ideas);
  const outbox = useApp((st) => st.outbox);
  return ideas.filter((i) => !i.deleted && (i.sentAt === null || i.updatedAt > i.sentAt) && (i.title.trim() || i.text.trim())).length + outbox.filter((o) => o.state !== "sent").length;
}

type Find = (kind: Kind, id: string) => Item | undefined;

/** "Filed to <where>", or the plain "Filed on the computer" when it can't say. */
function filedText(filedTo: string | null, find: Find): string {
  const where = filedTitle(filedTo, find);
  return where ? s().filedTo(where) : s().filedOnComputer;
}

function ideaState(i: Idea, find: Find): { text: string; color: string } {
  if (i.status === "filed") return { text: filedText(i.filedTo, find), color: C.ok };
  if (i.status === "dismissed") return { text: s().dismissedOnComputer, color: C.engrave };
  if (i.sentAt !== null && i.updatedAt <= i.sentAt) return { text: s().onComputer, color: C.ok };
  return { text: s().waiting, color: C.warn };
}

function outState(o: OutItem, sending: boolean, find: Find): { text: string; color: string } {
  if (o.state === "failed") return { text: `${s().failed}: ${o.error ? s().outErrors[o.error] : ""}`, color: C.missing };
  if (o.state === "sent") {
    if (o.status === "filed") return { text: filedText(o.filedTo, find), color: C.ok };
    if (o.status === "dismissed") return { text: s().dismissedOnComputer, color: C.engrave };
    return { text: o.type === "sketch" ? s().inInboxSketch : s().onComputer, color: C.ok };
  }
  if (sending) return { text: s().sending(Math.round(progress(o) * 100)), color: C.hot };
  return { text: s().waiting, color: C.warn };
}

export function InboxTab({ onIdea, onRecord, onPick }: Props) {
  // Select the stored array (stable) and derive here: a selector that builds
  // a new array on every read makes useSyncExternalStore loop forever.
  const allIdeas = useApp((st) => st.ideas);
  const ideas = useMemo(() => visibleIdeas(allIdeas), [allIdeas]);
  const outbox = useApp((st) => st.outbox);
  const sending = useApp((st) => st.sending);
  const extrasError = useApp((st) => st.extrasError);
  const library = useApp((st) => st.sync);
  const find: Find = (kind, id) => findItem(library, kind, id);
  // One player for the kept memos (only one plays at a time).
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);
  const [playingId, setPlayingId] = useState<string | null>(null);
  useEffect(() => {
    if (playingId && playerStatus.didJustFinish) setPlayingId(null);
  }, [playerStatus.didJustFinish, playingId]);
  function togglePlay(o: OutItem) {
    if (playingId === o.id) {
      player.pause();
      setPlayingId(null);
      return;
    }
    player.replace({ uri: o.files[0].uri });
    player.play();
    setPlayingId(o.id);
  }

  type Row = { kind: "idea"; idea: Idea } | { kind: "out"; out: OutItem };
  const sections: { key: string; title: string; data: Row[] }[] = [
    { key: "ideas", title: s().ideas, data: ideas.map((idea): Row => ({ kind: "idea", idea })) },
    { key: "out", title: s().sent, data: outbox.map((out): Row => ({ kind: "out", out })) },
  ].filter((sec) => sec.data.length > 0);

  function confirmRemove(o: OutItem) {
    Alert.alert(s().removeConfirmTitle, s().removeConfirmBody, [
      { text: s().cancel, style: "cancel" },
      {
        text: s().remove,
        style: "destructive",
        onPress: () => {
          if (playingId === o.id) {
            player.pause();
            setPlayingId(null);
          }
          removeOut(o.id);
        },
      },
    ]);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.actions}>
        <Button label={s().newIdea} variant="primary" onPress={() => onIdea(null)} style={styles.action} />
        <Button label={s().record} onPress={onRecord} style={styles.action} />
        <Button label={s().addFile} onPress={onPick} style={styles.action} />
      </View>
      {extrasError ? (
        <View style={styles.banner}>
          <Led color={C.warn} size={7} />
          <Text style={styles.bannerText}>{s().extras[extrasError]}</Text>
        </View>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(row) => (row.kind === "idea" ? `i:${row.idea.id}` : `o:${row.out.id}`)}
        renderSectionHeader={({ section }) => <Engrave style={styles.section}>{section.title}</Engrave>}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: C.rule }} />}
        ListEmptyComponent={<Text style={styles.empty}>{s().emptyInbox}</Text>}
        stickySectionHeadersEnabled={false}
        renderItem={({ item: row }) => {
          if (row.kind === "idea") {
            const st = ideaState(row.idea, find);
            const label = row.idea.title.trim() || row.idea.text.trim().split("\n")[0] || "…";
            return (
              <Pressable onPress={() => onIdea(row.idea.id)} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}>
                <Text style={styles.rowTitle} numberOfLines={1}>{label}</Text>
                <View style={styles.sub}>
                  <Led color={st.color} size={7} />
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {row.idea.target ? `${row.idea.target.title} · ` : ""}
                    {st.text}
                  </Text>
                </View>
              </Pressable>
            );
          }
          const o = row.out;
          const st = outState(o, sending === o.id, find);
          const playable = o.type === "memo" && !o.purged && o.files.length > 0;
          const length = o.durationMs ? ` · ${Math.floor(o.durationMs / 60000)}:${String(Math.round(o.durationMs / 1000) % 60).padStart(2, "0")}` : "";
          const label = o.title.trim() || (o.type === "memo" ? `${s().memoLabel}${length}` : o.files[0]?.name || s().sketchLabel);
          return (
            <View style={styles.row}>
              <Engrave>{o.type === "memo" ? s().memoLabel : s().sketchLabel}</Engrave>
              <Text style={styles.rowTitle} numberOfLines={1}>{label}</Text>
              <View style={styles.sub}>
                <Led color={st.color} size={7} />
                <Text style={[styles.rowSub, o.state === "failed" && { color: C.cream }]}>{st.text}</Text>
              </View>
              {sending === o.id ? (
                <View style={styles.bar}>
                  <View style={[styles.fill, { width: `${Math.round(progress(o) * 100)}%` }]} />
                </View>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                {playable ? <Button label={playingId === o.id ? s().stopMemo : s().playMemo} onPress={() => togglePlay(o)} style={styles.small} hitSlop={SMALL_SLOP} /> : null}
                {o.state === "failed" ? (
                  <Button
                    label={s().retry}
                    onPress={() => {
                      retryOut(o.id);
                      requestSync();
                    }}
                    style={styles.small}
                    hitSlop={SMALL_SLOP}
                  />
                ) : null}
                {sending !== o.id ? <Button label={s().remove} variant="quiet" onPress={() => confirmRemove(o)} style={styles.small} hitSlop={SMALL_SLOP} /> : null}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

/** The small buttons are about 30 dp tall: this brings the touch area to 48 dp. */
const SMALL_SLOP = { top: 9, bottom: 9, left: 4, right: 4 };

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 12, marginBottom: 4 },
  action: { flex: 1, paddingHorizontal: 6 },
  banner: { flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginTop: 8, padding: 10, borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, backgroundColor: C.panel },
  bannerText: { color: C.cream, flex: 1, marginLeft: 8, fontSize: 13, lineHeight: 18 },
  section: { marginHorizontal: 16, marginTop: 16, marginBottom: 6 },
  row: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: C.panel },
  rowTitle: { color: C.cream, fontSize: 16, fontWeight: "600", marginTop: 2 },
  sub: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  rowSub: { color: C.body, fontSize: 13, flexShrink: 1 },
  bar: { height: 4, backgroundColor: C.rule, borderRadius: 2, marginTop: 8, overflow: "hidden" },
  fill: { height: 4, backgroundColor: C.hot },
  small: { paddingVertical: 4, paddingHorizontal: 10 },
  empty: { color: C.engrave, textAlign: "center", padding: 32, fontSize: 14, lineHeight: 20 },
});
