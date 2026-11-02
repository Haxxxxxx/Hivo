import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Engrave } from "../components/ui";
import { UpdateCheck } from "../components/UpdateCheck";
import { tr } from "../lib/i18n";
import { confirmUnpair } from "../components/confirmUnpair";
import { appVersion, phoneName, useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS } from "../theme";

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const pairing = useApp((s) => s.pairing);
  const t = tr(T);

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" style={{ paddingVertical: 4 }}>
        <Text style={styles.back}>‹ {t.back}</Text>
      </Pressable>
      <Text style={styles.title}>{t.settings}</Text>

      <View style={styles.panel}>
        <Fact label={t.computer} value={pairing?.desktopName ?? "—"} />
        <Fact label={t.addresses} value={pairing ? `${pairing.hosts.join(", ")} · ${pairing.port}` : "—"} mono />
        <Fact label={t.thisPhone} value={phoneName()} />
        <Fact label={t.version} value={appVersion()} mono />
      </View>
      <Text style={styles.note}>{t.language}</Text>

      <UpdateCheck style={{ marginTop: 20 }} />

      <Button label={t.forget} variant="danger" onPress={confirmUnpair} style={{ marginTop: 24 }} />
    </ScrollView>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ paddingVertical: 8 }}>
      <Engrave>{label}</Engrave>
      <Text style={[styles.value, mono && { fontFamily: FONT.mono, fontSize: 13 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { color: C.body, fontSize: 15 },
  title: { fontFamily: FONT.display, fontSize: 28, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6, marginBottom: 12 },
  panel: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, paddingHorizontal: 14, paddingVertical: 6 },
  value: { color: C.cream, fontSize: 15, marginTop: 2 },
  note: { color: C.engrave, fontSize: 13, marginTop: 10 },
});
