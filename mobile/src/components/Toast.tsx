import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { C, RADIUS } from "../theme";
import { Led } from "./ui";

// One short message at a time ("Memo kept · sending now"), shown over the
// bottom of the screen for a few seconds. It never moves the layout.
type Toast = { text: string; at: number };
let current: Toast | null = null;
const listeners = new Set<(t: Toast | null) => void>();

export function showToast(text: string): void {
  current = { text, at: Date.now() };
  for (const l of listeners) l(current);
}

const SHOW_MS = 3500;

export function ToastHost({ bottom = 16 }: { bottom?: number }) {
  const [toast, setToast] = useState<Toast | null>(current);
  useEffect(() => {
    listeners.add(setToast);
    return () => {
      listeners.delete(setToast);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const left = SHOW_MS - (Date.now() - toast.at);
    const timer = setTimeout(() => {
      if (current === toast) current = null;
      setToast(null);
    }, Math.max(0, left));
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <View style={styles.box}>
        <Led color={C.ok} size={7} />
        <Text style={styles.text}>{toast.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  box: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: C.raised, borderWidth: 1, borderColor: C.ruleStrong, borderRadius: RADIUS, maxWidth: "100%" },
  text: { color: C.cream, fontSize: 14, lineHeight: 19, flexShrink: 1 },
});
