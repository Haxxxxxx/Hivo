import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Led } from "../components/ui";
import { tr } from "../lib/i18n";
import { allItems, filterItems, isGone, itemKey, KINDS, type Item, type Kind } from "../lib/sync";
import { requestSync, useApp } from "../store";
import { T } from "../strings";
import { C, engrave, FONT, RADIUS, STAGE_COLOR, UNSORTED_COLOR } from "../theme";

type Props = {
  kind: Kind;
  onKind: (k: Kind) => void;
  onOpen: (item: Item) => void;
  onPair: () => void;
};

/** Saved prods | Beats | Songs from the computer. Stays mounted under the
 * note screen (App.tsx), so the search and the scroll survive a note. */
export function LibraryScreen({ kind, onKind, onOpen, onPair }: Props) {
  const sync = useApp((st) => st.sync);
  const paired = useApp((st) => st.pairing !== null);
  const syncing = useApp((st) => st.syncing);
  const [query, setQuery] = useState("");
  const t = tr(T);
  const label: Record<Kind, string> = { prod: t.tabProd, beat: t.tabBeat, song: t.tabSong };
  const all = useMemo(() => allItems(sync), [sync]);
  const items = useMemo(() => filterItems(all, kind, query, sync), [all, sync, kind, query]);
  const total = useMemo(() => all.filter((i) => i.kind === kind).length, [all, kind]);

  if (!paired) {
    return (
      <View style={styles.unpaired}>
        <Text style={styles.unpairedText}>{t.libUnpaired}</Text>
        <PairSteps />
        <Button label={t.scan} variant="primary" onPress={onPair} style={{ marginTop: 20 }} />
      </View>
    );
  }

  const empty = total > 0 ? t.noMatch : syncing || sync.lastSyncAt === null ? t.loadingLibrary : t.libEmpty;

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {KINDS.map((k) => (
          <Pressable key={k} onPress={() => onKind(k)} style={[styles.tab, kind === k && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: kind === k }}>
            <Text style={[styles.tabText, kind === k && { color: C.chassis }]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
              {label[k]}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.searchBox}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t.search}
          placeholderTextColor={C.engrave}
          accessibilityLabel={t.searchLabel}
          style={styles.search}
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          // Android has no clear button of its own (clearButtonMode is iOS-only).
          <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel={t.clearSearch} style={styles.clear}>
            <Text style={styles.clearText}>×</Text>
          </Pressable>
        ) : null}
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => itemKey(i.kind, i.id)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: C.rule }} />}
        ListEmptyComponent={<Text style={styles.empty}>{empty}</Text>}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={requestSync} colors={[C.cream]} progressBackgroundColor={C.raised} tintColor={C.cream} />}
        renderItem={({ item }) => {
          const key = itemKey(item.kind, item.id);
          return (
            <Row
              item={item}
              hasNote={(sync.pending[key]?.text ?? sync.gone[key]?.note ?? item.note).trim().length > 0}
              pending={!!sync.pending[key]}
              conflict={key in sync.conflicts}
              gone={isGone(sync, item.kind, item.id)}
              onPress={() => onOpen(item)}
            />
          );
        }}
      />
    </View>
  );
}

/** The three steps to pair, on the computer then here. */
export function PairSteps() {
  const t = tr(T);
  return (
    <View style={{ marginTop: 14, gap: 10 }}>
      {[t.pairStep1, t.pairStep2, t.pairStep3].map((step, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 10 }}>
          <Text style={styles.stepNum}>{i + 1}</Text>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

function Row({ item, hasNote, pending, conflict, gone, onPress }: { item: Item; hasNote: boolean; pending: boolean; conflict: boolean; gone: boolean; onPress: () => void }) {
  const t = tr(T);
  const facts = [item.bpm !== null ? `${Math.round(item.bpm)} BPM` : null, item.key].filter(Boolean).join(" · ");
  const sub = gone ? t.gone : item.kind === "song" && item.stage ? t.stage[item.stage] ?? item.subtitle : item.subtitle;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}>
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
      <View style={styles.right}>
        {facts ? (
          <Text style={[engrave, { textAlign: "right" }]} numberOfLines={1}>{facts}</Text>
        ) : null}
        {conflict || hasNote || pending ? (
          <View style={{ marginTop: 6 }}>
            <Led color={conflict ? C.hot : pending ? C.warn : C.ok} size={8} label={conflict ? t.conflictLed : pending ? t.noteWaiting : t.hasNote} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: C.ruleStrong, borderRadius: RADIUS, overflow: "hidden" },
  // 48 dp: the smallest comfortable tap target.
  tab: { flex: 1, minHeight: 48, paddingVertical: 6, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: C.panel },
  tabOn: { backgroundColor: C.cream },
  tabText: { fontFamily: FONT.display, fontSize: 15, color: C.body, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" },
  searchBox: { marginHorizontal: 16, marginVertical: 10, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis },
  search: { flex: 1, minHeight: 48, paddingHorizontal: 10, paddingVertical: 8, color: C.cream, fontSize: 15 },
  clear: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  clearText: { color: C.body, fontSize: 24, lineHeight: 26 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: C.panel },
  rowTitle: { color: C.cream, fontSize: 16, fontWeight: "600" },
  rowSub: { color: C.body, fontSize: 13, flexShrink: 1 },
  // A long BPM · key never squeezes the title: it's capped and cut instead.
  right: { alignItems: "flex-end", marginLeft: 12, maxWidth: "34%", flexShrink: 0 },
  empty: { color: C.engrave, textAlign: "center", padding: 32, fontSize: 14, lineHeight: 20 },
  unpaired: { padding: 20 },
  unpairedText: { color: C.body, fontSize: 15, lineHeight: 21 },
  stepNum: { fontFamily: FONT.display, fontSize: 20, color: C.cream, width: 18 },
  stepText: { color: C.cream, fontSize: 15, lineHeight: 21, flex: 1 },
});
