import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { ago, tr } from "../lib/i18n";
import { sync, unpair, useApp } from "../store";
import { errorText, pairAgainText, T } from "../strings";
import { C, FONT } from "../theme";
import { Button, Engrave, Led } from "./ui";

/** Desktop name, "Synced N min ago", the Sync button, Settings, and the last error. */
export function SyncHeader({ onSettings }: { onSettings: () => void }) {
  const desktopName = useApp((s) => s.pairing?.desktopName ?? "Hivo");
  const lastSyncAt = useApp((s) => s.sync.lastSyncAt);
  const pendingMap = useApp((s) => s.sync.pending);
  const syncing = useApp((s) => s.syncing);
  const error = useApp((s) => s.error);
  const [now, setNow] = useState(Date.now());
  const t = tr(T);
  const pending = Object.keys(pendingMap).length;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const led = error ? C.missing : pending > 0 ? C.warn : lastSyncAt ? C.ok : C.engrave;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{desktopName}</Text>
          <View style={styles.statusRow}>
            <Led color={led} size={7} />
            <Engrave style={{ marginLeft: 6 }}>
              {syncing ? t.syncing : lastSyncAt ? t.syncedAgo(ago(lastSyncAt, now)) : t.neverSynced}
              {pending > 0 && !syncing ? ` · ${t.unsynced(pending)}` : ""}
            </Engrave>
          </View>
        </View>
        <Pressable onPress={onSettings} accessibilityRole="button" accessibilityLabel={t.settings} hitSlop={10} style={styles.gear}>
          <Text style={styles.gearText}>⋯</Text>
        </Pressable>
        <Button label={syncing ? t.syncing : t.sync} variant="primary" onPress={() => void sync()} disabled={syncing} />
      </View>
      {error ? (
        <View style={styles.error}>
          <Led color={C.missing} size={7} />
          <Text style={styles.errorText}>{errorText(error)}</Text>
          {error === "forgotten" ? (
            <Button
              label={pairAgainText()}
              // Same warning as Settings: unpairing drops note edits the computer never got.
              onPress={() =>
                Alert.alert(t.forgetTitle, pending > 0 ? `${t.forgetBody}\n\n${t.forgetBodyPending(pending)}` : t.forgetBody, [
                  { text: t.cancel, style: "cancel" },
                  { text: t.confirmForget, style: "destructive", onPress: () => void unpair() },
                ])
              }
              style={{ marginLeft: 8, paddingVertical: 5 }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 3, borderBottomColor: C.rule, backgroundColor: C.chassis },
  row: { flexDirection: "row", alignItems: "center" },
  name: { fontFamily: FONT.display, fontSize: 26, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  statusRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  gear: { paddingHorizontal: 12, paddingVertical: 6 },
  gearText: { color: C.body, fontSize: 22, fontWeight: "700" },
  error: { flexDirection: "row", alignItems: "center", marginTop: 10, padding: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: 4 },
  errorText: { color: C.cream, marginLeft: 8, flex: 1, fontSize: 14 },
});
