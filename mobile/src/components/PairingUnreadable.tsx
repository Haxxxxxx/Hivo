import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { c } from "../captureStrings";
import { retryPairingRead } from "../store";
import { C, S } from "../theme";
import { Button, Led } from "./ui";

/** The pairing couldn't be read (`pairingUnreadable`): not "not paired".
 * App.tsx shows this instead of the pairing screen; Retry reads it again. */
export function PairingUnreadable() {
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Led color={C.warn} size={8} />
        <Text style={styles.text}>{c().pairingUnreadable}</Text>
      </View>
      <Button
        label={c().retry}
        variant="primary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void retryPairingRead().finally(() => setBusy(false));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", padding: S.xl, gap: S.lg },
  row: { flexDirection: "row", alignItems: "flex-start", gap: S.sm },
  text: { color: C.cream, flex: 1, fontSize: 15, lineHeight: 21 },
});
