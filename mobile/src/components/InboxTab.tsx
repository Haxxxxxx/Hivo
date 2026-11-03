import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { s } from "../inboxStrings";
import { captureRows, duration, when, type CaptureRow, type CaptureStatus, type Group } from "../lib/captures";
import { filedTitle } from "../lib/filedTo";
import { lang } from "../lib/i18n";
import { findItem, type Item, type Kind } from "../lib/sync";
import { progress, type OutItem } from "../lib/outbox";
import { removeOut, requestSync, retryOut, useApp } from "../store";
import { C } from "../theme";
import { Button, Engrave, Led } from "./ui";

type Props = {
  onIdea: (id: string | null) => void;
  onRecord: () => void;
  onPick: () => void;
};

export type CaptureHandle = { scrollToTop: () => void; stopPlayback: () => void };

type Find = (kind: Kind, id: string) => Item | undefined;

const GROUP_TITLE: Record<Group, () => string> = { needs: () => s().groupNeeds, waiting: () => s().groupWaiting, done: () => s().groupDone };

/** The row's status in plain words, and its LED. Never orange (orange is for the main action). */
function statusLine(st: CaptureStatus, row: CaptureRow, find: Find): { text: string; color: string } {
  switch (st.kind) {
    case "failed": {
      const why = row.kind === "out" && row.out.error ? s().outErrors[row.out.error] : null;
      return { text: why ? s().notSentWhy(why) : s().failed, color: C.missing };
    }
    case "sending":
      return { text: s().sending(st.pct), color: C.body };
    case "waiting": {
      const text = { unpaired: s().waitUnpaired, away: s().waitAway, blocked: s().waitBlocked, held: s().waitHeld, "next-sync": s().waitNext }[st.reason];
      return { text, color: st.reason === "held" || st.reason === "blocked" ? C.warn : C.engrave };
    }
    case "filed": {
      const where = filedTitle(st.filedTo, find);
      return { text: where ? s().addedTo(where) : s().addedOnComputer, color: C.ok };
    }
    case "dismissed":
      return { text: s().skippedOnComputer, color: C.engrave };
    case "received":
      return st.old ? { text: s().receivedOld, color: C.engrave } : { text: row.kind === "idea" ? s().receivedIdea : s().receivedSketch, color: C.ok };
  }
}

/** The Capture home: New idea / Record / Add a file, then every capture grouped by what it needs. */
export const InboxTab = forwardRef<CaptureHandle, Props>(function InboxTab({ onIdea, onRecord, onPick }, ref) {
  // Select the stored arrays (stable) and derive here: a selector that builds
  // a new array on every read makes useSyncExternalStore loop forever.
  const ideas = useApp((st) => st.ideas);
  const outbox = useApp((st) => st.outbox);
  const sending = useApp((st) => st.sending);
  const paired = useApp((st) => st.pairing !== null);
  const error = useApp((st) => st.error);
  const extrasError = useApp((st) => st.extrasError);
  const syncing = useApp((st) => st.syncing);
  const library = useApp((st) => st.sync);
  const find: Find = (kind, id) => findItem(library, kind, id);
  const sendingItem = sending ? outbox.find((o) => o.id === sending) : undefined;
  const groups = useMemo(
    () => captureRows(ideas, outbox, { paired, error, held: extrasError, sending: sendingItem ? { id: sendingItem.id, progress: progress(sendingItem) } : null }),
    [ideas, outbox, paired, error, extrasError, sendingItem],
  );
  const list = useRef<SectionList<CaptureRow>>(null);
  useImperativeHandle(ref, () => ({
    stopPlayback: () => {
      player.pause();
      setPlayingId(null);
    },
    scrollToTop: () => {
      try {
        list.current?.scrollToLocation({ sectionIndex: 0, itemIndex: 0, viewPosition: 0, animated: true });
      } catch {
        // Empty list: nothing to scroll.
      }
    },
  }));
  const now = Date.now();
  const lg = lang();

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

  function confirmRemove(o: OutItem) {
    if (sending === o.id) return;
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

  const sections = groups.map((g) => ({ key: g.group, title: GROUP_TITLE[g.group](), data: g.rows }));
  const hasMemoDone = groups.some((g) => g.group === "done" && g.rows.some((r) => r.kind === "out" && r.out.type === "memo"));

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.actions}>
        <Button label={s().newIdea} variant="primary" onPress={() => onIdea(null)} />
        <View style={styles.actionRow}>
          <Button label={s().record} onPress={onRecord} style={styles.action} />
          <Button label={s().addFile} onPress={onPick} style={styles.action} />
        </View>
      </View>
      <SectionList
        ref={list}
        sections={sections}
        keyExtractor={(row) => `${row.kind}:${row.id}`}
        renderSectionHeader={({ section }) => <Engrave style={styles.section}>{section.title}</Engrave>}
        renderSectionFooter={({ section }) => (section.key === "done" && hasMemoDone ? <Text style={styles.footnote}>{s().keptDays}</Text> : null)}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: C.rule }} />}
        ListEmptyComponent={<Text style={styles.empty}>{s().emptyCapture}</Text>}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={paired ? <RefreshControl refreshing={syncing} onRefresh={requestSync} colors={[C.cream]} progressBackgroundColor={C.raised} tintColor={C.cream} /> : undefined}
        renderItem={({ item: row }) => {
          const st = statusLine(row.status, row, find);
          const status = (
            <View style={styles.sub}>
              <View style={{ marginTop: 6 }}>
                <Led color={st.color} size={7} />
              </View>
              <Text style={[styles.rowStatus, row.status.kind === "failed" && { color: C.cream }]} numberOfLines={3}>{st.text}</Text>
            </View>
          );
          if (row.kind === "idea") {
            const label = row.idea.title.trim() || row.idea.text.trim().split("\n")[0] || "…";
            return (
              <Pressable onPress={() => onIdea(row.idea.id)} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}>
                {status}
                <Text style={styles.rowTitle} numberOfLines={1}>{label}</Text>
                <Engrave style={styles.meta}>{[s().ideaLabel, row.idea.target?.title, when(row.idea.updatedAt, now, lg)].filter(Boolean).join(" · ")}</Engrave>
              </Pressable>
            );
          }
          const o = row.out;
          const playable = o.type === "memo" && !o.purged && o.files.length > 0;
          const kindLabel = o.type === "memo" ? s().memoLabel : s().sketchLabel;
          const meta = [kindLabel, o.target?.title, when(o.createdAt, now, lg), o.durationMs ? duration(o.durationMs) : null].filter(Boolean).join(" · ");
          const title = o.title.trim() || (o.type === "memo" ? meta : o.files[0]?.name || kindLabel);
          return (
            <Pressable
              onLongPress={() => confirmRemove(o)}
              delayLongPress={400}
              accessibilityHint={sending !== o.id ? s().rowActionsHint : undefined}
              accessibilityActions={sending !== o.id ? [{ name: "remove", label: s().remove }] : undefined}
              onAccessibilityAction={(e) => e.nativeEvent.actionName === "remove" && confirmRemove(o)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}
            >
              {status}
              <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
              {o.title.trim() || o.type !== "memo" ? <Engrave style={styles.meta}>{meta}</Engrave> : null}
              {row.status.kind === "sending" ? (
                <View style={styles.bar}>
                  <View style={[styles.fill, { width: `${row.status.pct}%` }]} />
                </View>
              ) : null}
              {playable || o.state === "failed" ? (
                <View style={styles.buttons}>
                  {playable ? <Button label={playingId === o.id ? s().stopMemo : s().playMemo} onPress={() => togglePlay(o)} size="compact" /> : null}
                  {o.state === "failed" ? (
                    <Button
                      label={s().retry}
                      onPress={() => {
                        retryOut(o.id);
                        requestSync();
                      }}
                      size="compact"
                    />
                  ) : null}
                </View>
              ) : null}
            </Pressable>
          );
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  actions: { marginHorizontal: 16, marginTop: 12, marginBottom: 4, gap: 8 },
  actionRow: { flexDirection: "row", gap: 8 },
  action: { flex: 1, paddingHorizontal: 6 },
  section: { marginHorizontal: 16, marginTop: 16, marginBottom: 6 },
  footnote: { color: C.engrave, fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginTop: 8 },
  row: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: C.panel },
  rowTitle: { color: C.cream, fontSize: 16, fontWeight: "600", marginTop: 4 },
  meta: { marginTop: 4 },
  sub: { flexDirection: "row", gap: 6 },
  rowStatus: { color: C.body, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  // Room above and below so the compact buttons' 48 dp touch area fits (Android clips hitSlop to the parent).
  buttons: { flexDirection: "row", gap: 12, marginTop: 4, paddingVertical: 8 },
  bar: { height: 4, backgroundColor: C.rule, borderRadius: 2, marginTop: 8, overflow: "hidden" },
  fill: { height: 4, backgroundColor: C.body },
  empty: { color: C.engrave, textAlign: "center", padding: 32, fontSize: 14, lineHeight: 20 },
});
