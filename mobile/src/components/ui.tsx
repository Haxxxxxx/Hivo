import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { C, engrave, FONT, RADIUS } from "../theme";

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

export function Engrave({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[engrave, style]}>{children}</Text>;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Grow the touch area of a compact button to 48 dp without growing it. */
  hitSlop?: Insets;
};

/** Orange only for the one main action per screen. */
export function Button({ label, onPress, variant = "secondary", disabled, style, hitSlop }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={hitSlop}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        variant === "primary" && { backgroundColor: pressed ? C.hotHover : C.hot, borderColor: C.hot },
        variant === "secondary" && { backgroundColor: pressed ? C.raised : C.panel },
        variant === "quiet" && { backgroundColor: "transparent", borderColor: "transparent" },
        variant === "danger" && { backgroundColor: pressed ? C.raised : C.panel, borderColor: C.missing },
        disabled && { opacity: 0.5 },
        style,
      ]}
    >
      <Text style={[styles.btnText, variant === "primary" && { color: C.chassis }, variant === "danger" && { color: C.missing }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    borderWidth: 1,
    borderColor: C.ruleStrong,
    borderRadius: RADIUS,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { fontFamily: FONT.display, fontSize: 16, letterSpacing: 0.6, textTransform: "uppercase", color: C.cream },
});
