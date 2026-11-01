import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { InboxTab, useInboxPending } from "../components/InboxTab";
import { SyncHeader } from "../components/SyncHeader";
import { s } from "../inboxStrings";
import { Engrave, Led } from "../components/ui";
import { tr } from "../lib/i18n";
import { allItems, filterItems, isGone, itemKey, KINDS, type Item, type Kind } from "../lib/sync";
import { useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS, STAGE_COLOR, UNSORTED_COLOR } from "../theme";

export type Tab = Kind | "inbox";

type Props = {
  tab: Tab;
  onTab: (k: Tab) => void;
  onOpen: (item: Item) => void;
  onSettings: () => void;
  onIdea: (id: string | null) => void;
  onRecord: () => void;
  onPick: () => void;
};

export function LibraryScreen({ tab, onTab, onOpen, onSettings, onIdea, onRecord, onPick }: Props) {
  const sync = useApp((s) => s.sync);
  const [query, setQuery] = useState("");
  const t = tr(T);
  const label: Record<Kind, string> = { prod: t.tabProd, beat: t.tabBeat, song: t.tabSong };
  const all = useMemo(() => allItems(sync), [sync]);
  const kind: Kind = tab === "inbox" ? "prod" : tab;
  const items = useMemo(() => filterItems(all, kind, query, sync), [all, sync, kind, query]);
  const total = useMemo(() => all.filter((i) => i.kind === kind).length, [all, kind]);
  const pending = useInboxPending();

  return (
    <View style={{ flex: 1 }}>
      <SyncHeader onSettings={onSettings} />
      <View style={styles.tabs}>
        {[...KINDS, "inbox" as const].map((k) => (
          <Pressable key={k} onPress={() => onTab(k)} style={[styles.tab, tab === k && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
            <Text style={[styles.tabText, tab === k && { color: C.chassis }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {k === "inbox" ? (pending > 0 ? `${s().tabInbox} ${pending}` : s().tabInbox) : label[k]}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "inbox" ? <InboxTab onIdea={onIdea} onRecord={onRecord} onPick={onPick} /> : null}
      {tab !== "inbox" ? (
      <>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t.search}
        placeholderTextColor={C.engrave}
        accessibilityLabel={t.searchLabel}
        style={styles.search}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <FlatList
        data={items}
        keyExtractor={(i) => itemKey(i.kind, i.id)}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: C.rule }} />}
        ListEmptyComponent={<Text style={styles.empty}>{total === 0 ? t.emptyTab : t.noMatch}</Text>}
        renderItem={({ item }) => <Row item={item} hasNote={(sync.pending[itemKey(item.kind, item.id)]?.text ?? sync.gone[itemKey(item.kind, item.id)]?.note ?? item.note).trim().length > 0} pending={!!sync.pending[itemKey(item.kind, item.id)]} gone={isGone(sync, item.kind, item.id)} onPress={() => onOpen(item)} />}
      />
      </>
      ) : null}
    </View>
  );
}

function Row({ item, hasNote, pending, gone, onPress }: { item: Item; hasNote: boolean; pending: boolean; gone: boolean; onPress: () => void }) {
  const t = tr(T);
  const facts = [item.bpm !== null ? `${Math.round(item.bpm)} BPM` : null, item.key].filter(Boolean).join(" · ");
  const sub = gone ? t.gone : item.kind === "song" && item.stage ? t.stage[item.stage] ?? item.subtitle : item.subtitle;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3 }}>
          {gone ? (
            <View style={{ marginRight: 6 }}>
              <Led color={C.missing} size={7} />
            </View>
          ) : item.kind === "song" ? (
            <View style={{ marginRight: 6 }}>
              <Led color={item.stage ? STAGE_COLOR[item.stage] ?? UNSORTED_COLOR : UNSORTED_COLOR} size={7} />
            </View>
          ) : null}
          <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text>
        </View>
      </View>
      <View style={{ alignItems: "flex-end", marginLeft: 12 }}>
        {facts ? <Engrave>{facts}</Engrave> : null}
        {hasNote || pending ? (
          <View style={{ marginTop: 6 }}>
            <Led color={pending ? C.warn : C.ok} size={8} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: C.ruleStrong, borderRadius: RADIUS, overflow: "hidden" },
  tab: { flex: 1, paddingVertical: 8, paddingHorizontal: 2, alignItems: "center", backgroundColor: C.panel },
  tabOn: { backgroundColor: C.cream },
  tabText: { fontFamily: FONT.display, fontSize: 15, color: C.body, textTransform: "uppercase", letterSpacing: 0.5 },
  search: { marginHorizontal: 16, marginVertical: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis, color: C.cream, fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: C.panel },
  rowTitle: { color: C.cream, fontSize: 16, fontWeight: "600" },
  rowSub: { color: C.body, fontSize: 13, flexShrink: 1 },
  empty: { color: C.engrave, textAlign: "center", padding: 32, fontSize: 14 },
});
