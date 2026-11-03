import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { s } from "../inboxStrings";
import { isAway, syncTone, waitingOnPhone, type SyncTone } from "../lib/captures";
import { ago, tr } from "../lib/i18n";
import { sync, useApp } from "../store";
import { confirmUnpair } from "./confirmUnpair";
import { errorText, pairAgainText, T, updateDesktopText } from "../strings";
import { C, FONT, RADIUS } from "../theme";
import { Button, Engrave, Led } from "./ui";

const TONE: Record<SyncTone, string> = { ok: C.ok, idle: C.engrave, away: C.engrave, warn: C.warn, fault: C.missing };

/** Notes, ideas, memos and exports still on the phone for the computer. */
export function useWaiting(): number {
  const pendingMap = useApp((st) => st.sync.pending);
  const ideas = useApp((st) => st.ideas);
  const outbox = useApp((st) => st.outbox);
  return useMemo(() => Object.keys(pendingMap).length + waitingOnPhone(ideas, outbox), [pendingMap, ideas, outbox]);
}

/** The computer's name and one status line, always the same height (a sync
 * error never pushes the screen down: its details sit in `SyncStrip`).
 * Unpaired: "Not paired: N items wait on this phone" and Pair. */
export function SyncHeader({ onSettings, onPair }: { onSettings: () => void; onPair: () => void }) {
  const paired = useApp((st) => st.pairing !== null);
  const desktopName = useApp((st) => st.pairing?.desktopName ?? "Hivo");
  const lastSyncAt = useApp((st) => st.sync.lastSyncAt);
  const syncing = useApp((st) => st.syncing);
  const error = useApp((st) => st.error);
  const waiting = useWaiting();
  const [now, setNow] = useState(Date.now());
  const t = tr(T);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const tone = syncTone({ paired, error, waiting, lastSyncAt });
  const status = !paired
    ? t.notPairedStatus
    : syncing
      ? t.syncing
      : error && isAway(error)
        ? t.awayStatus(waiting)
        : [lastSyncAt ? t.syncedAgo(ago(lastSyncAt, now)) : t.neverSynced, waiting > 0 ? t.waitingItems(waiting) : null].filter(Boolean).join(" · ");

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{paired ? desktopName : "Hivo"}</Text>
          <View style={styles.statusRow}>
            <Led color={syncing ? C.body : TONE[tone]} size={7} />
            <Text style={styles.status} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{status}</Text>
          </View>
        </View>
        {paired ? <Button label={syncing ? t.syncing : t.sync} onPress={() => void sync()} disabled={syncing} style={styles.sync} /> : null}
        <Pressable onPress={onSettings} accessibilityRole="button" accessibilityLabel={t.settings} style={({ pressed }) => [styles.gear, pressed && { backgroundColor: C.raised }]}>
          <Text style={styles.gearIcon}>{"⚙︎"}</Text>
        </Pressable>
      </View>
      {!paired ? (
        <View style={styles.pairBanner}>
          <Text style={styles.pairText}>{t.notPairedBanner(waiting)}</Text>
          <Button label={t.pairAction} onPress={onPair} style={{ alignSelf: "flex-end", marginTop: 8 }} />
        </View>
      ) : null}
    </View>
  );
}

/** At the bottom, above the tabs: what's wrong and, where there's one, the
 * action that fixes it. Away from the computer is not in here (it's normal). */
export function SyncStrip({ onSettings }: { onSettings: () => void }) {
  const paired = useApp((st) => st.pairing !== null);
  const error = useApp((st) => st.error);
  const extrasError = useApp((st) => st.extrasError);
  const desktopOutdated = useApp((st) => st.desktopOutdated);
  const lastSyncAt = useApp((st) => st.sync.lastSyncAt);
  const syncing = useApp((st) => st.syncing);
  const t = tr(T);
  if (!paired) return null;

  let text: string | null = null;
  let color: string = C.warn;
  let action: { label: string; run: () => void } | null = null;
  const retry = { label: t.retrySync, run: () => void sync() };
  if (error && !isAway(error)) {
    text = errorText(error, lastSyncAt !== null);
    color = syncTone({ paired, error, waiting: 0, lastSyncAt }) === "fault" ? C.missing : C.warn;
    if (error === "forgotten") action = { label: pairAgainText(), run: confirmUnpair };
    else if (error === "clock") action = { label: t.openDateSettings, run: () => void Linking.sendIntent("android.settings.DATE_SETTINGS").catch(() => Linking.openSettings()) };
    else if (error === "outdated") action = { label: t.openAppSettings, run: onSettings };
    else action = retry;
  } else if (extrasError && !error) {
    text = s().extras[extrasError];
    action = extrasError === "outdated" ? null : retry;
  } else if (desktopOutdated && !error) {
    text = updateDesktopText();
  }
  if (!text) return null;

  return (
    <View style={[styles.strip, { borderColor: color }]} accessibilityLiveRegion="polite">
      <View style={styles.stripRow}>
        <View style={{ marginTop: 6 }}>
          <Led color={color} size={7} />
        </View>
        <Text style={styles.stripText}>{text}</Text>
      </View>
      {action ? <Button label={action.label} onPress={action.run} disabled={syncing && action === retry} style={{ alignSelf: "flex-end", marginTop: 8 }} /> : null}
    </View>
  );
}

/** "Copying what was shared…" while a big share is copied in. */
export function CopyingStrip() {
  return (
    <View style={[styles.strip, { borderColor: C.rule }]}>
      <Engrave>{tr(T).copyingShare}</Engrave>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 3, borderBottomColor: C.rule, backgroundColor: C.chassis },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontFamily: FONT.display, fontSize: 26, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  status: { fontFamily: FONT.mono, fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: C.body, flexShrink: 1 },
  sync: { minHeight: 48 },
  gear: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: RADIUS },
  gearIcon: { color: C.body, fontSize: 24 },
  pairBanner: { marginTop: 10, padding: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.ruleStrong, borderRadius: RADIUS },
  pairText: { color: C.cream, fontSize: 14, lineHeight: 20 },
  strip: { marginHorizontal: 12, marginBottom: 8, padding: 10, backgroundColor: C.panel, borderWidth: 1, borderRadius: RADIUS },
  stripRow: { flexDirection: "row", gap: 8 },
  stripText: { color: C.cream, flex: 1, fontSize: 14, lineHeight: 20 },
});
