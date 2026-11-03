import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "./ScreenHeader";
import { remaining } from "../lib/captures";
import { CONFIRM_TTL_MS } from "../lib/confirm";
import { spacedCode } from "../lib/handshake";
import { tr } from "../lib/i18n";
import { cancelConfirmation, useApp } from "../store";
import { T } from "../strings";
import { C, FONT } from "../theme";
import { Button, Engrave, Spinner } from "./ui";

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
      <ScreenHeader title={t.confirmTitle} onBack={onCancel} />
      <View style={styles.body0}>
      <Text style={styles.code} accessibilityLabel={confirming.code.split("").join(" ")}>
        {spacedCode(confirming.code)}
      </Text>
      <Engrave style={{ textAlign: "center", marginTop: 8 }}>{t.confirmValid(remaining(confirming.startedAt, now, CONFIRM_TTL_MS))}</Engrave>
      <Text style={styles.body}>{t.confirmBody(confirming.desktopName)}</Text>
      <View style={styles.waiting}>
        <Spinner />
        <Text style={styles.status}>{t.confirmWaiting}</Text>
      </View>
      <Button label={t.confirmCancel} variant="secondary" onPress={onCancel} style={{ marginTop: 24 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.chassis },
  body0: { paddingHorizontal: 20 },
  code: { fontFamily: FONT.mono, fontSize: 44, color: C.cream, letterSpacing: 6, marginTop: 24, textAlign: "center" },
  body: { color: C.body, fontSize: 15, lineHeight: 21, marginTop: 24 },
  waiting: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 },
  status: { color: C.cream, fontSize: 14 },
});
