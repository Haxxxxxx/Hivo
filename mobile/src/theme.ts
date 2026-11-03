// System 02 tokens, mirrored from the desktop's src/theme.css. Keep in sync.
// The plain values live in tokens.ts; this adds the fonts and text styles.
import { Platform, type TextStyle } from "react-native";
import { C, SIZE } from "./tokens";

export { C, RADIUS, S, SIZE, STAGE_COLOR, TAP, UNSORTED_COLOR } from "./tokens";

export const FONT = {
  /** Barlow Condensed SemiBold, loaded in App.tsx; falls back to the system font. */
  display: "BarlowCondensed_600SemiBold",
  mono: Platform.select({ ios: "Menlo", default: "monospace" }),
};

/** The engraved label: small mono caps. 12 sp (was 10.5): it carries real state. */
export const engrave = {
  fontFamily: FONT.mono,
  fontSize: SIZE.engrave,
  lineHeight: 16,
  letterSpacing: 1.2,
  textTransform: "uppercase" as const,
  color: C.engrave,
};

/** The type scale. `title` and `heading` are condensed caps (screen title,
 * section or sheet title), `body` is prose, `small` hints and secondary lines.
 * No fixed heights anywhere, so text grows with the phone's font scale. */
export const T = {
  title: { fontFamily: FONT.display, fontSize: SIZE.title, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  heading: { fontFamily: FONT.display, fontSize: SIZE.heading, color: C.cream, textTransform: "uppercase", letterSpacing: 0.5 },
  body: { fontSize: SIZE.body, lineHeight: 21, color: C.body },
  small: { fontSize: SIZE.small, lineHeight: 18, color: C.engrave },
  engrave,
} satisfies Record<string, TextStyle>;

/** `T` under another name, for files that already import the strings as `T`. */
export const TYPE = T;
