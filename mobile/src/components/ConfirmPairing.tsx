import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { remaining } from "../lib/captures";
import { CONFIRM_TTL_MS } from "../lib/confirm";
import { spacedCode } from "../lib/handshake";
import { tr } from "../lib/i18n";
import { cancelConfirmation, useApp } from "../store";
import { T } from "../strings";
import { C, FONT } from "../theme";
import { Button, Engrave } from "./ui";

/** After scanning: the code to compare with the computer's, until the user
 * confirms it there (docs/PHONE-SYNC.md, confirmation code). Back (on
 * screen or the hardware one, App.tsx) cancels: nothing is saved. */
export function ConfirmPairing({ onCancel = cancelConfirmation }: { onCancel?: () => void }) {
  const t = tr(T);
  const confirming = useApp((s) => s.confirming);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!confirming) return null;
  return (
    <View style={styles.wrap}>
      <Pressable onPress={onCancel} accessibilityRole="button" style={styles.back}>
        <Text style={styles.backText}>‹ {t.back}</Text>
      </Pressable>
      <Text style={styles.title}>{t.confirmTitle}</Text>
      <Text style={styles.code} accessibilityLabel={confirming.code.split("").join(" ")}>
        {spacedCode(confirming.code)}
      </Text>
      <Engrave style={{ textAlign: "center", marginTop: 8 }}>{t.confirmValid(remaining(confirming.startedAt, now, CONFIRM_TTL_MS))}</Engrave>
      <Text style={styles.body}>{t.confirmBody(confirming.desktopName)}</Text>
      <View style={styles.waiting}>
        <ActivityIndicator color={C.body} size="small" />
        <Text style={styles.status}>{t.confirmWaiting}</Text>
      </View>
      <Button label={t.confirmCancel} variant="secondary" onPress={onCancel} style={{ marginTop: 24 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 20, paddingTop: 8, backgroundColor: C.chassis },
  back: { minHeight: 48, justifyContent: "center", alignSelf: "flex-start", paddingRight: 16 },
  backText: { color: C.body, fontSize: 15 },
  title: { fontFamily: FONT.display, fontSize: 24, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  code: { fontFamily: FONT.mono, fontSize: 44, color: C.cream, letterSpacing: 6, marginTop: 24, textAlign: "center" },
  body: { color: C.body, fontSize: 15, lineHeight: 21, marginTop: 24 },
  waiting: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 },
  status: { color: C.cream, fontSize: 14 },
});
