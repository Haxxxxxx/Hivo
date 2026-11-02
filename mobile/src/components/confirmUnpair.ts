import * as Clipboard from "expo-clipboard";
import { Alert } from "react-native";
import { tr } from "../lib/i18n";
import { getState, unpair, unsyncedNotes } from "../store";
import { T } from "../strings";

/** "Unpair?" with, when notes aren't on the computer yet, a way to copy them
 * first (they also stay on the phone and go to the next computer paired). */
export function confirmUnpair(): void {
  const t = tr(T);
  const pending = Object.keys(getState().sync.pending).length;
  const buttons: Parameters<typeof Alert.alert>[2] = [{ text: t.cancel, style: "cancel" }];
  if (pending > 0) {
    buttons.push({
      text: t.copyUnsynced,
      onPress: () =>
        void Clipboard.setStringAsync(unsyncedNotes())
          .then(() => Alert.alert(t.forgetTitle, t.copiedUnsynced, [
            { text: t.cancel, style: "cancel" },
            { text: t.confirmForget, style: "destructive", onPress: () => void unpair() },
          ]))
          .catch((e) => console.warn("Hivo: could not copy the notes", e)),
    });
  }
  buttons.push({ text: t.confirmForget, style: "destructive", onPress: () => void unpair() });
  Alert.alert(t.forgetTitle, pending > 0 ? `${t.forgetBody}\n\n${t.forgetBodyPending(pending)}` : t.forgetBody, buttons);
}
