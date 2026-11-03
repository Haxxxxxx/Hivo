// The app's navigation, by hand (no navigation library): two tabs at the
// base (Capture, Library), always mounted so the Library keeps its search
// and scroll, and a stack of full-screen routes pushed over them. Pure, so
// the Back rules are tested.

export type Tab = "capture" | "library";

export type Nav<R extends { name: string }> = { tab: Tab; stack: R[] };

export const top = <R extends { name: string }>(nav: Nav<R>): R | null => nav.stack[nav.stack.length - 1] ?? null;

export const push = <R extends { name: string }>(nav: Nav<R>, r: R): Nav<R> => ({ ...nav, stack: [...nav.stack, r] });

/** Removes the top route (nothing to remove: unchanged). */
export const pop = <R extends { name: string }>(nav: Nav<R>): Nav<R> => (nav.stack.length === 0 ? nav : { ...nav, stack: nav.stack.slice(0, -1) });

/** Replaces the top route (a share kept as an idea becomes that idea). */
export const replaceTop = <R extends { name: string }>(nav: Nav<R>, r: R): Nav<R> => ({ ...nav, stack: [...nav.stack.slice(0, -1), r] });

/** Back to a tab, with nothing pushed over it. */
export const toTab = <R extends { name: string }>(nav: Nav<R>, tab: Tab): Nav<R> => ({ tab, stack: [] });

/** Removes every route `keep` says no to (unpairing drops the note and settings screens). */
export const filterStack = <R extends { name: string }>(nav: Nav<R>, keep: (r: R) => boolean): Nav<R> => ({ ...nav, stack: nav.stack.filter(keep) });

/** Screens whose Back has their own rule (never lose a take, clean up a share). */
const OWN_BACK = new Set(["record", "share"]);

export type BackAction = "cancel-pairing" | "screen" | "pop" | "to-capture" | "exit";

/** What the hardware Back does. */
export function backAction<R extends { name: string }>(nav: Nav<R>, opts: { confirming: boolean }): BackAction {
  if (opts.confirming) return "cancel-pairing";
  const t = top(nav);
  if (t) return OWN_BACK.has(t.name) ? "screen" : "pop";
  return nav.tab === "library" ? "to-capture" : "exit";
}

/** A share that arrives waits while a take, another share or the pairing is on screen. */
export function canShowShare<R extends { name: string }>(nav: Nav<R>, opts: { confirming: boolean }): boolean {
  if (opts.confirming) return false;
  const t = top(nav)?.name;
  return t !== "record" && t !== "share" && t !== "pair";
}

/** The update banner shows on the tabs and in Settings, never over a take or an editor. */
export function showsUpdateBanner<R extends { name: string }>(nav: Nav<R>, opts: { confirming: boolean }): boolean {
  if (opts.confirming) return false;
  const t = top(nav)?.name;
  return t === undefined || t === "settings";
}
