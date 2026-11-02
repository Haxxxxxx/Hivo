import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { s } from "../inboxStrings";
import { tr } from "../lib/i18n";
import type { IdeaTarget } from "../lib/ideas";
import { allItems, KINDS, type Kind } from "../lib/sync";
import { useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS } from "../theme";
import { Button, Engrave } from "./ui";

/** "For: <prod / beat / song>" with a picker over the synced library.
 * `kinds` limits what can be picked (an export can only go to a song). */
export function TargetPicker({ value, onChange, disabled, kinds = KINDS }: { value: IdeaTarget | null; onChange: (t: IdeaTarget | null) => void; disabled?: boolean; kinds?: Kind[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(value && kinds.includes(value.kind) ? value.kind : kinds.includes("beat") ? "beat" : kinds[0]);
  const [query, setQuery] = useState("");
  const sync = useApp((st) => st.sync);
  const t = tr(T);
  const label: Record<Kind, string> = { prod: t.tabProd, beat: t.tabBeat, song: t.tabSong };
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems(sync).filter((i) => i.kind === kind && (!q || `${i.title} ${i.subtitle}`.toLowerCase().includes(q)));
  }, [sync, kind, query]);

  return (
    <View>
      <Engrave>{s().forTarget}</Engrave>
      <Pressable
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.field, pressed && { backgroundColor: C.raised }, disabled && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={value ? `${s().forTarget}: ${label[value.kind]} · ${value.title}` : `${s().forTarget}: ${s().noTarget}`}
      >
        <Text style={[styles.value, !value && { color: C.engrave }]} numberOfLines={1}>
          {value ? `${label[value.kind]} · ${value.title}` : s().noTarget}
        </Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modal}>
          <Text style={styles.title}>{s().pickTarget}</Text>
          <View style={styles.tabs}>
            {kinds.length > 1 && kinds.map((k) => (
              <Pressable key={k} onPress={() => setKind(k)} style={[styles.tab, kind === k && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: kind === k }}>
                <Text style={[styles.tabText, kind === k && { color: C.chassis }]}>{label[k]}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput value={query} onChangeText={setQuery} placeholder={t.search} placeholderTextColor={C.engrave} accessibilityLabel={t.searchLabel} style={styles.search} autoCorrect={false} />
          <FlatList
            data={list}
            keyExtractor={(i) => `${i.kind}:${i.id}`}
            keyboardShouldPersistTaps="handled"
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: C.rule }} />}
            ListEmptyComponent={<Text style={styles.empty}>{t.emptyTab}</Text>}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onChange({ kind: item.kind, id: item.id, title: item.title });
                  setOpen(false);
                }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}
              >
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                {item.subtitle ? <Text style={styles.rowSub} numberOfLines={1}>{item.subtitle}</Text> : null}
              </Pressable>
            )}
          />
          <View style={{ flexDirection: "row", gap: 8, padding: 12 }}>
            {value ? (
              <Button
                label={s().clearTarget}
                variant="quiet"
                onPress={() => {
                  onChange(null);
                  setOpen(false);
                }}
              />
            ) : null}
            <View style={{ flex: 1 }} />
            <Button label={s().cancel} onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginTop: 6, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.chassis, paddingHorizontal: 10, paddingVertical: 10 },
  value: { color: C.cream, fontSize: 15 },
  modal: { flex: 1, backgroundColor: C.chassis, paddingTop: 24 },
  title: { fontFamily: FONT.display, fontSize: 24, color: C.cream, textTransform: "uppercase", marginHorizontal: 16 },
  tabs: { flexDirection: "row", marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: C.ruleStrong, borderRadius: RADIUS, overflow: "hidden" },
  tab: { flex: 1, minHeight: 48, paddingVertical: 8, alignItems: "center", justifyContent: "center", backgroundColor: C.panel },
  tabOn: { backgroundColor: C.cream },
  tabText: { fontFamily: FONT.display, fontSize: 15, color: C.body, textTransform: "uppercase" },
  search: { marginHorizontal: 16, marginVertical: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, color: C.cream, fontSize: 15 },
  row: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: C.panel },
  rowTitle: { color: C.cream, fontSize: 16, fontWeight: "600" },
  rowSub: { color: C.body, fontSize: 13, marginTop: 2 },
  empty: { color: C.engrave, textAlign: "center", padding: 32 },
});
