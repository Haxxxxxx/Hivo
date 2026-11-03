import { Pressable, StyleSheet, Text, View } from "react-native";
import { tr } from "../lib/i18n";
import type { Tab } from "../lib/nav";
import { T } from "../strings";
import { C, FONT } from "../theme";

/** Capture | Library at the bottom. The badge counts only what needs the user. */
export function TabBar({ tab, onTab, badge }: { tab: Tab; onTab: (t: Tab) => void; badge: number }) {
  const t = tr(T);
  const tabs: { id: Tab; label: string }[] = [
    { id: "capture", label: t.tabCapture },
    { id: "library", label: t.tabLibrary },
  ];
  return (
    <View style={styles.bar} accessibilityRole="tablist">
      {tabs.map(({ id, label }) => {
        const on = tab === id;
        return (
          <Pressable
            key={id}
            onPress={() => onTab(id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={id === "capture" && badge > 0 ? `${label}, ${badge}` : label}
            style={({ pressed }) => [styles.tab, pressed && !on && { backgroundColor: C.raised }]}
          >
            <View style={[styles.mark, on && { backgroundColor: C.cream }]} />
            <View style={styles.labelRow}>
              <Text style={[styles.label, on && { color: C.cream }]} numberOfLines={1}>{label}</Text>
              {id === "capture" && badge > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: C.ruleStrong, backgroundColor: C.panel },
  tab: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", paddingBottom: 4 },
  // Selection is cream (never orange): a bar on top of the selected tab.
  mark: { position: "absolute", top: 0, left: 24, right: 24, height: 3, backgroundColor: "transparent" },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { fontFamily: FONT.display, fontSize: 17, letterSpacing: 0.6, textTransform: "uppercase", color: C.engrave },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: C.hot, alignItems: "center", justifyContent: "center" },
  badgeText: { color: C.chassis, fontSize: 12, fontWeight: "700" },
});
