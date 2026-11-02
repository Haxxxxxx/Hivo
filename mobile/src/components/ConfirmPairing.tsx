import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { spacedCode } from "../lib/handshake";
import { tr } from "../lib/i18n";
import { cancelConfirmation, useApp } from "../store";
import { T } from "../strings";
import { C, FONT } from "../theme";
import { Button } from "./ui";

/** After scanning: the code to compare with the computer's, until the user
 * confirms it there (docs/PHONE-SYNC.md, confirmation code). */
export function ConfirmPairing() {
  const t = tr(T);
  const confirming = useApp((s) => s.confirming);
  if (!confirming) return null;
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{t.confirmTitle}</Text>
      <Text style={styles.code} accessibilityLabel={confirming.code.split("").join(" ")}>
        {spacedCode(confirming.code)}
      </Text>
      <Text style={styles.body}>{t.confirmBody(confirming.desktopName)}</Text>
      <View style={styles.waiting}>
        <ActivityIndicator color={C.hot} size="small" />
        <Text style={styles.status}>{t.confirmWaiting}</Text>
      </View>
      <Button label={t.confirmCancel} variant="secondary" onPress={cancelConfirmation} style={{ marginTop: 24 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 20, paddingTop: 48 },
  title: { fontFamily: FONT.display, fontSize: 24, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  code: { fontFamily: FONT.mono, fontSize: 44, color: C.cream, letterSpacing: 6, marginTop: 24, textAlign: "center" },
  body: { color: C.body, fontSize: 15, lineHeight: 21, marginTop: 24 },
  waiting: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 },
  status: { color: C.cream, fontSize: 14 },
});
