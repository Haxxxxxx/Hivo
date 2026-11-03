import { useEffect, useSyncExternalStore } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { tr } from "../lib/i18n";
import { T } from "../strings";
import { C } from "../theme";
import { checkForUpdate, dismissUpdate, updateOffer } from "../update";
import { Button, Led } from "./ui";

/** "Hivo 0.6.1 is available" with Download / Later. Never blocks the app.
 * The found update is kept for the whole run (`updateOffer`): this banner
 * remounts after every pushed screen, and Settings has its own. */
export function UpdateBanner() {
  const update = useSyncExternalStore(updateOffer.subscribe, updateOffer.get);
  const t = tr(T);

  useEffect(() => {
    updateOffer.ensureChecked(() => checkForUpdate()).catch((e: unknown) => console.warn("update check failed:", e instanceof Error ? e.message : String(e)));
  }, []);

  if (!update) return null;
  const close = () => void updateOffer.dismiss(dismissUpdate).catch(() => {});
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <View style={styles.row}>
        <Led color={C.ok} size={7} />
        <Text style={styles.text}>{t.updateAvailable(update.version)}</Text>
      </View>
      <View style={styles.actions}>
        <Button label={t.updateLater} variant="quiet" onPress={close} style={styles.btn} />
        <Button
          label={t.updateDownload}
          onPress={() => {
            void Linking.openURL(update.apk);
            close();
          }}
          style={styles.btn}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 12, marginBottom: 8, padding: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.rule, borderRadius: 4 },
  row: { flexDirection: "row", alignItems: "center" },
  text: { color: C.cream, marginLeft: 8, flex: 1, fontSize: 14 },
  actions: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8, gap: 8 },
  btn: { paddingVertical: 5 },
});
