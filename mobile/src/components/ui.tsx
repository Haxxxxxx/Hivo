import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type Insets,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { C, engrave, FONT, RADIUS, SIZE, TAP } from "../theme";
import { buttonColors, resolveSize, slopTo, type ButtonSize, type ButtonVariant } from "./buttonStyle";

export type { ButtonSize, ButtonVariant } from "./buttonStyle";

/** Status is a lit LED, never a tinted pill. Pass `label` when no word sits
 * next to it, so its meaning isn't colour alone. */
export function Led({ color, size = 8, label }: { color: string; size?: number; label?: string }) {
  return (
    <View
      accessible={label ? true : undefined}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, shadowColor: color, shadowOpacity: 0.8, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } }}
    />
  );
}

export function Engrave({ children, style, numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return (
    <Text style={[engrave, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

/** "120 BPM · F#m" in the engraved label style, the musical key in its own
 * case: the caps style would turn F#m (minor) into F#M (smoke F2). */
export function Facts({ bpm, musicalKey, style, numberOfLines }: { bpm: number | null | undefined; musicalKey: string | null | undefined; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const tempo = bpm != null && bpm > 0 ? `${Math.round(bpm)} BPM` : null;
  const key = musicalKey?.trim() || null;
  if (!tempo && !key) return null;
  return (
    <Text style={[engrave, style]} numberOfLines={numberOfLines}>
      {tempo}
      {tempo && key ? " · " : null}
      {key ? <Text style={styles.ownCase}>{key}</Text> : null}
    </Text>
  );
}

/** Waiting, loading, sending: a neutral spinner. Orange is for the main action. */
export function Spinner({ size = "small" }: { size?: "small" | "large" }) {
  return <ActivityIndicator color={C.busy} size={size} />;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** regular (default): 48 dp tall at least. compact: small, touch area grown
   * to 48 dp. A button given its own `hitSlop` is compact unless `size` says. */
  size?: ButtonSize;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Extra touch area; a compact button always gets at least 48 dp. */
  hitSlop?: Insets;
  accessibilityLabel?: string;
};

/** Orange (`primary`) only for the one main action per screen; `danger` for
 * anything that deletes or forgets; `quiet` for Cancel. */
export function Button({ label, onPress, variant = "secondary", size, disabled, style, hitSlop, accessibilityLabel }: ButtonProps) {
  const compact = resolveSize(size, hitSlop) === "compact";
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = compact
    ? (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height }));
      }
    : undefined;
  // Before the first layout, assume the compact button's usual size (~32 dp).
  const slop = compact ? slopTo(box?.w ?? TAP, box?.h ?? 32, hitSlop) : hitSlop;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { disabled: true } : undefined}
      hitSlop={slop}
      onLayout={onLayout}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => {
        const c = buttonColors(variant, pressed, !!disabled);
        return [compact ? styles.compact : styles.regular, { backgroundColor: c.background, borderColor: c.border }, style];
      }}
    >
      {({ pressed }) => (
        <Text style={[styles.text, compact && styles.textCompact, { color: buttonColors(variant, pressed, !!disabled).text }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  regular: {
    minHeight: TAP,
    borderWidth: 1,
    borderRadius: RADIUS,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  compact: {
    borderWidth: 1,
    borderRadius: RADIUS,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { fontFamily: FONT.display, fontSize: SIZE.button, letterSpacing: 0.6, textTransform: "uppercase", textAlign: "center" },
  textCompact: { fontSize: SIZE.buttonCompact },
  ownCase: { textTransform: "none", letterSpacing: 0.4 },
});
