import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { c } from "../captureStrings";
import { s } from "../inboxStrings";
import { tr } from "../lib/i18n";
import type { IdeaTarget } from "../lib/ideas";
import { allItems, KINDS, type Kind } from "../lib/sync";
import { requestSync, useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS, S } from "../theme";
import { Button, Engrave } from "./ui";

/** "For: <prod / beat / song>" with a picker over the synced library.
 * `kinds` limits what can be picked (an export can only go to a song), and
 * the words follow ("Pick a song", "No song picked"). `label`: the field's
 * caption (defaults to "For"). */
export function TargetPicker({ value, onChange, disabled, kinds = KINDS, label: caption }: { value: IdeaTarget | null; onChange: (t: IdeaTarget | null) => void; disabled?: boolean; kinds?: Kind[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(value && kinds.includes(value.kind) ? value.kind : kinds.includes("beat") ? "beat" : kinds[0]);
  const [query, setQuery] = useState("");
  const sync = useApp((st) => st.sync);
  const paired = useApp((st) => st.pairing !== null);
  const syncing = useApp((st) => st.syncing);
  const t = tr(T);
  const label: Record<Kind, string> = { prod: t.tabProd, beat: t.tabBeat, song: t.tabSong };
  const all = allItems(sync);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((i) => i.kind === kind && (!q || `${i.title} ${i.subtitle}`.toLowerCase().includes(q)));
  }, [all, kind, query]);
  const shown = value ? (kinds.length === 1 ? value.title : `${label[value.kind]} · ${value.title}`) : c().noTargetFor(kinds);
  const libraryEmpty = !all.some((i) => kinds.includes(i.kind));

  return (
    <View>
      <Engrave>{caption ?? s().forTarget}</Engrave>
      <Pressable
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.field, pressed && { backgroundColor: C.raised }, disabled && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={s().forTargetLabel(shown)}
      >
        <Text style={[styles.value, !value && { color: C.engrave }]} numberOfLines={2}>
          {shown}
        </Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modal}>
          <Text style={styles.title}>{c().pickTitle(kinds)}</Text>
          {kinds.length > 1 ? (
            <View style={styles.tabs}>
              {kinds.map((k) => (
                <Pressable key={k} onPress={() => setKind(k)} style={[styles.tab, kind === k && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: kind === k }}>
                  <Text style={[styles.tabText, kind === k && { color: C.chassis }]}>{label[k]}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <TextInput value={query} onChangeText={setQuery} placeholder={t.search} placeholderTextColor={C.engrave} accessibilityLabel={t.searchLabel} style={styles.search} autoCorrect={false} />
          <FlatList
            data={list}
            keyExtractor={(i) => `${i.kind}:${i.id}`}
            keyboardShouldPersistTaps="handled"
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: C.rule }} />}
            ListEmptyComponent={
              libraryEmpty && !query.trim() ? (
                // Nothing synced yet: offer the sync right here.
                <View style={styles.emptyBox}>
                  <Text style={styles.empty}>{c().pickerEmpty}</Text>
                  {paired ? <Button label={syncing ? c().pickerSyncing : c().pickerSync} disabled={syncing} onPress={requestSync} style={{ alignSelf: "center" }} /> : null}
                </View>
              ) : (
                <Text style={styles.empty}>{query.trim() ? t.noMatch : t.emptyTab}</Text>
              )
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onChange({ kind: item.kind, id: item.id, title: item.title });
                  setOpen(false);
                }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.raised }]}
              >
                <Text style={styles.rowTitle} numberOfLines={2}>{item.title}</Text>
                {item.subtitle ? <Text style={styles.rowSub} numberOfLines={1}>{item.subtitle}</Text> : null}
              </Pressable>
            )}
          />
          <View style={{ flexDirection: "row", gap: S.sm, padding: S.md }}>
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
  modal: { flex: 1, backgroundColor: C.chassis, paddingTop: S.xl },
  title: { fontFamily: FONT.display, fontSize: 24, color: C.cream, textTransform: "uppercase", marginHorizontal: S.lg },
  tabs: { flexDirection: "row", marginHorizontal: S.lg, marginTop: S.md, borderWidth: 1, borderColor: C.ruleStrong, borderRadius: RADIUS, overflow: "hidden" },
  tab: { flex: 1, minHeight: 48, paddingVertical: 8, alignItems: "center", justifyContent: "center", backgroundColor: C.panel },
  tabOn: { backgroundColor: C.cream },
  tabText: { fontFamily: FONT.display, fontSize: 15, color: C.body, textTransform: "uppercase" },
  search: { marginHorizontal: S.lg, marginVertical: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, color: C.cream, fontSize: 15 },
  row: { paddingHorizontal: S.lg, paddingVertical: S.md, backgroundColor: C.panel },
  rowTitle: { color: C.cream, fontSize: 16, fontWeight: "600" },
  rowSub: { color: C.body, fontSize: 13, marginTop: 2 },
  emptyBox: { padding: S.xl, gap: S.md },
  empty: { color: C.engrave, textAlign: "center", padding: S.xl, fontSize: 14, lineHeight: 20 },
});
