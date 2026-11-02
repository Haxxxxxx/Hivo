import { describe, expect, it } from "vitest";
import { confirmNext, type ConfirmState } from "./confirmArm";

const idle: ConfirmState = { armed: false, focused: false };

describe("confirmNext", () => {
  it("arms on the first click and fires on the second", () => {
    const one = confirmNext(idle, "click");
    expect(one).toEqual({ state: { armed: true, focused: false }, fire: false });
    const two = confirmNext(one.state, "click");
    expect(two).toEqual({ state: { armed: false, focused: false }, fire: true });
  });

  it("disarms on timeout when it doesn't have focus", () => {
    expect(confirmNext({ armed: true, focused: false }, "timeout").state.armed).toBe(false);
  });

  it("stays armed on timeout while focused", () => {
    expect(confirmNext({ armed: true, focused: true }, "timeout").state.armed).toBe(true);
  });

  it("keeps the armed state across focus and blur", () => {
    let s = confirmNext({ armed: true, focused: false }, "focus").state;
    expect(s).toEqual({ armed: true, focused: true });
    s = confirmNext(s, "blur").state;
    expect(s).toEqual({ armed: true, focused: false });
  });

  it("never fires without a click", () => {
    for (const e of ["focus", "blur", "timeout"] as const) {
      expect(confirmNext({ armed: true, focused: false }, e).fire).toBe(false);
    }
  });
});
