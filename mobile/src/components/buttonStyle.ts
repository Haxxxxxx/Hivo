// What a Button looks like, as plain data (no React Native), so it is tested.
import { C, TAP } from "../tokens";

/** primary: the one main action per screen (orange). secondary: everything
 * else (outlined, the default). quiet: Cancel, Later, Dismiss (text only).
 * danger: delete, remove, forget (red outline, filled red while pressed). */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
/** regular: at least 48 dp tall. compact: visually small, touch area grown to 48 dp. */
export type ButtonSize = "regular" | "compact";

export type ButtonColors = { background: string; border: string; text: string };

export function buttonColors(variant: ButtonVariant, pressed: boolean): ButtonColors {
  switch (variant) {
    case "primary":
      return { background: pressed ? C.hotHover : C.hot, border: C.hot, text: C.chassis };
    case "quiet":
      return { background: pressed ? C.raised : "transparent", border: "transparent", text: C.body };
    case "danger":
      return pressed
        ? { background: C.missing, border: C.missing, text: C.chassis }
        : { background: C.panel, border: C.missing, text: C.missing };
    case "secondary":
    default:
      return { background: pressed ? C.raised : C.panel, border: C.ruleStrong, text: C.cream };
  }
}

/** A button given its own `hitSlop` was sized small by its screen: keep it
 * compact unless the size is said. */
export function resolveSize(size: ButtonSize | undefined, hitSlop: unknown): ButtonSize {
  return size ?? (hitSlop ? "compact" : "regular");
}

export type Slop = { top: number; bottom: number; left: number; right: number };

/** The hitSlop that grows a `width` × `height` box to `min` dp each way,
 * never smaller than what the caller already asked for. */
export function slopTo(width: number, height: number, given?: Partial<Slop> | null, min = TAP): Slop {
  const v = Math.max(0, Math.ceil((min - height) / 2));
  const h = Math.max(0, Math.ceil((min - width) / 2));
  return {
    top: Math.max(v, given?.top ?? 0),
    bottom: Math.max(v, given?.bottom ?? 0),
    left: Math.max(h, given?.left ?? 0),
    right: Math.max(h, given?.right ?? 0),
  };
}
