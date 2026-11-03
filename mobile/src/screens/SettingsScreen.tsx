import Constants from "expo-constants";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { c } from "../captureStrings";
import { confirmUnpair } from "../components/confirmUnpair";
import { ScreenHeader } from "../components/ScreenHeader";
import { Button, Engrave, Led } from "../components/ui";
import { UpdateCheck } from "../components/UpdateCheck";
import { tr } from "../lib/i18n";
import { hasUpdateRow } from "../lib/update";
import { appVersion, lookForComputer, phoneName, useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS, S } from "../theme";

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const pairing = useApp((s) => s.pairing);
  const looking = useApp((s) => s.rediscovering);
  const storage = useApp((s) => s.storage);
  const [found, setFound] = useState<boolean | null>(null);
  const t = tr(T);

  async function look() {
    setFound(null);
    setFound(await lookForComputer());
  }

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title={t.settings} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: S.lg }}>
        {storage.blocked.length > 0 || storage.saveFailed ? (
          <View style={styles.warnBox}>
            <Led color={C.warn} size={7} />
            <Text style={styles.warnText}>{storage.blocked.length > 0 ? c().storageBlocked : c().storageFull}</Text>
          </View>
        ) : null}

        <View style={styles.panel}>
          <Fact label={t.computer} value={pairing?.desktopName ?? "—"} />
          <Fact label={t.addresses} value={pairing ? `${pairing.hosts.join(", ")} · ${pairing.port}` : "—"} mono />
          <Fact label={t.thisPhone} value={phoneName()} />
          <Fact label={t.version} value={appVersion()} mono />
        </View>
        <Text style={styles.note}>{t.language}</Text>

        {pairing ? (
          // The computer's address changed (a new router, DHCP): sealed hellos on this Wi-Fi find it.
          <View style={{ marginTop: S.xl }}>
            <Button label={looking ? c().lookingAgain : c().lookAgain} disabled={looking} onPress={() => void look()} />
            {found !== null && !looking ? <Text style={styles.result}>{found ? c().foundAgain : c().notFoundAgain}</Text> : null}
          </View>
        ) : null}

        {/* Website APK: check; Play: open Play; a dev build: neither. */}
        {hasUpdateRow(Constants.expoConfig?.extra?.distribution) ? <UpdateCheck style={{ marginTop: S.xl }} /> : null}

        <Button label={t.forget} variant="danger" onPress={confirmUnpair} style={{ marginTop: S.xl }} />
      </ScrollView>
    </View>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ paddingVertical: S.sm }}>
      <Engrave>{label}</Engrave>
      <Text style={[styles.value, mono && { fontFamily: FONT.mono, fontSize: 13 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, paddingHorizontal: 14, paddingVertical: 6 },
  value: { color: C.cream, fontSize: 15, marginTop: 2 },
  note: { color: C.engrave, fontSize: 13, marginTop: 10 },
  result: { color: C.body, fontSize: 14, lineHeight: 20, marginTop: S.sm },
  warnBox: { flexDirection: "row", alignItems: "center", gap: S.sm, marginBottom: S.lg, padding: 10, borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, backgroundColor: C.panel },
  warnText: { color: C.cream, flex: 1, fontSize: 13, lineHeight: 18 },
});
