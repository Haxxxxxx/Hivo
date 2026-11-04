import Constants from "expo-constants";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { c } from "../captureStrings";
import { confirmUnpair } from "../components/confirmUnpair";
import { ScreenHeader } from "../components/ScreenHeader";
import { Button, Engrave, Led, Spinner } from "../components/ui";
import { UpdateCheck } from "../components/UpdateCheck";
import type { LookResult } from "../lib/discover";
import { tr } from "../lib/i18n";
import { hasUpdateRow } from "../lib/update";
import { appVersion, cancelLook, lookForComputer, phoneName, useApp } from "../store";
import { T } from "../strings";
import { C, FONT, RADIUS, S } from "../theme";

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const pairing = useApp((s) => s.pairing);
  const looking = useApp((s) => s.rediscovering);
  const progress = useApp((s) => s.lookProgress);
  const storage = useApp((s) => s.storage);
  const [result, setResult] = useState<LookResult["kind"] | null>(null);
  const t = tr(T);

  async function look() {
    setResult(null);
    const r = await lookForComputer();
    if (live.current) setResult(r);
  }
  // Leaving Settings stops a search (it keeps the screen on, and its result shows here only).
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
      cancelLook();
    },
    [],
  );

  const resultText = result ? { usual: c().usualAgain, found: c().foundAgain, "not-found": c().notFoundAgain, cancelled: c().lookCancelled }[result] : null;
  const progressText = !progress || progress.phase === "usual" ? c().lookingUsual : c().lookingScan(progress.done, progress.total);

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
          // The computer's address changed (a new router, DHCP): sealed hellos find it. Only when tapped.
          <View style={{ marginTop: S.xl }}>
            {looking ? (
              <View style={styles.looking} accessibilityLiveRegion="polite">
                <Spinner />
                <Text style={[styles.result, { marginTop: 0, flex: 1 }]}>{progressText}</Text>
                <Button label={c().lookCancel} variant="quiet" size="compact" onPress={cancelLook} />
              </View>
            ) : (
              <Button label={c().lookAgain} onPress={() => void look()} />
            )}
            {resultText && !looking ? <Text style={styles.result}>{resultText}</Text> : null}
            <Text style={styles.note}>{c().lookHint}</Text>
          </View>
        ) : null}

        {/* Website APK: check; Play: open Play; a dev build: neither. */}
        {hasUpdateRow(Constants.expoConfig?.extra?.distribution) ? <UpdateCheck style={{ marginTop: S.xl }} /> : null}

        {/* Nothing to unpair from when no computer is paired. */}
        {pairing ? <Button label={t.forget} variant="danger" onPress={confirmUnpair} style={{ marginTop: S.xl }} /> : null}
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
  looking: { flexDirection: "row", alignItems: "center", gap: S.sm, minHeight: 48, paddingHorizontal: S.md, borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel },
  warnBox: { flexDirection: "row", alignItems: "center", gap: S.sm, marginBottom: S.lg, padding: 10, borderWidth: 1, borderColor: C.warn, borderRadius: RADIUS, backgroundColor: C.panel },
  warnText: { color: C.cream, flex: 1, fontSize: 13, lineHeight: 18 },
});
