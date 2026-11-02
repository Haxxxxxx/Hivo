// The two-step ConfirmButton (src/ui/base.tsx) as a pure state machine, so
// its rules can be tested: the first click arms, the second acts; it disarms
// on its own after CONFIRM_DISARM_MS, but never while it has focus (someone
// reading "Delete?" with a screen reader must not lose it mid-sentence).

export const CONFIRM_DISARM_MS = 4000;

export interface ConfirmState {
  armed: boolean;
  focused: boolean;
}

export type ConfirmEvent = "click" | "focus" | "blur" | "timeout";

export function confirmNext(state: ConfirmState, event: ConfirmEvent): { state: ConfirmState; fire: boolean } {
  switch (event) {
    case "click":
      return state.armed ? { state: { ...state, armed: false }, fire: true } : { state: { ...state, armed: true }, fire: false };
    case "focus":
      return { state: { ...state, focused: true }, fire: false };
    case "blur":
      // Leaving the button keeps it armed; the timer starts again from here.
      return { state: { ...state, focused: false }, fire: false };
    case "timeout":
      return { state: state.focused ? state : { ...state, armed: false }, fire: false };
  }
}
