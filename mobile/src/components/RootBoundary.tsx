import { reloadAppAsync } from "expo";
import { Component, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { c } from "../captureStrings";
import { resetLocalCache } from "../store";
import { C, S, TYPE } from "../theme";
import { Button } from "./ui";

/** A render that throws shows this instead of a white screen or a crash
 * loop: Reload, or reset the phone's library cache (a bad cache was the
 * likeliest cause) and reload. The phone's text and captures stay. An
 * error boundary has to be a class: React has no hook for it. */
export class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn("Hivo: a screen failed", error);
  }

  render(): ReactNode {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}

async function reload(): Promise<void> {
  try {
    await reloadAppAsync("error screen");
  } catch (e) {
    console.warn("Hivo: could not reload", e);
  }
}

function Fallback() {
  const [busy, setBusy] = useState(false);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.chassis }} contentContainerStyle={styles.wrap}>
      <Text style={TYPE.title}>{c().crashTitle}</Text>
      <Text style={styles.body}>{c().crashBody}</Text>
      <Button label={c().reload} variant="primary" onPress={() => void reload()} />
      <View style={{ gap: S.xs }}>
        <Button
          label={busy ? c().resetting : c().resetCache}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void resetLocalCache().finally(() => void reload());
          }}
        />
        <Text style={styles.note}>{c().resetCacheNote}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: S.xl, paddingTop: 64, gap: S.lg },
  body: { color: C.cream, fontSize: 15, lineHeight: 21 },
  note: { color: C.engrave, fontSize: 13, lineHeight: 18 },
});
