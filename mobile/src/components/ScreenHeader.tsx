import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { dict, tr } from "../lib/i18n";
import { C, S, T, TAP } from "../theme";

const L = dict({ back: "Back" }, { back: "Retour" });

type Props = {
  title: string;
  /** Omit for a screen with no way back (the header is then just the title). */
  onBack?: () => void;
  /** Defaults to "Back" / "Retour". */
  backLabel?: string;
  /** One control on the right of the Back row (a compact Button, an icon). */
  right?: ReactNode;
  /** Lines under the title (subtitle, facts, actions). */
  children?: ReactNode;
  titleLines?: number;
};

/** A screen's top: Back (48 dp tall, only as wide as its label), the title in
 * condensed caps, then the 3px section rule. */
export function ScreenHeader({ title, onBack, backLabel, right, children, titleLines = 2 }: Props) {
  const back = backLabel ?? tr(L).back;
  return (
    <View style={styles.wrap}>
      {onBack || right ? (
        <View style={styles.row}>
          {onBack ? (
            <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={back} hitSlop={{ left: S.sm, right: S.sm }} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
              <Text style={styles.backText}>‹ {back}</Text>
            </Pressable>
          ) : null}
          <View style={styles.spacer} />
          {right}
        </View>
      ) : null}
      <Text style={T.title} numberOfLines={titleLines} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: S.lg, paddingTop: S.xs, paddingBottom: S.md, borderBottomWidth: 3, borderBottomColor: C.rule },
  row: { flexDirection: "row", alignItems: "center", minHeight: TAP },
  back: { minHeight: TAP, justifyContent: "center", paddingRight: S.md, borderRadius: 4 },
  pressed: { backgroundColor: C.raised },
  backText: { color: C.body, fontSize: 15 },
  spacer: { flex: 1 },
});
