// System 02 tokens, mirrored from the desktop's src/theme.css. Keep in sync.
// Plain values only (no React Native import), so tests and config plugins can
// read them. theme.ts re-exports all of this with the fonts and text styles.

export const C = {
  chassis: "#0d0d0c",
  panel: "#161614",
  raised: "#1f1f1c",
  rule: "#2c2b27",
  ruleStrong: "#3d3c37",
  cream: "#f2efe8",
  body: "#c9c5bb",
  engrave: "#8d897f",
  hot: "#ff5a1f",
  hotHover: "#ff7a47",
  ok: "#3ddc84",
  warn: "#ffc233",
  missing: "#ff4040",
  /** Spinners and progress ("waiting", "sending"): neutral, never orange. */
  busy: "#c9c5bb",
} as const;

/** Stage LEDs: one blue ramp (conventions.md). */
export const STAGE_COLOR: Record<string, string> = {
  creation: "#1C5CAB",
  production: "#2A78D6",
  prep: "#5598E7",
  release: "#86B6EF",
  promotion: "#B7D3F6",
};
export const UNSORTED_COLOR = "#5B5B63";

export const RADIUS = 4;

/** The smallest touch area, in dp (Material's 48dp). */
export const TAP = 48;

/** Spacing, in dp: the steps the screens already use. */
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Font sizes, in sp (see `T` in theme.ts for the full text styles). */
export const SIZE = { title: 28, heading: 22, body: 15, small: 13, engrave: 12, button: 16, buttonCompact: 15 } as const;
