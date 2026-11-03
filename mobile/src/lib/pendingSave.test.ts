import { describe, expect, it } from "vitest";
import { createPendingSaves } from "./pendingSave";

describe("pending editor saves (review #7)", () => {
  it("runs every open editor's save, not the ones that closed", () => {
    const p = createPendingSaves();
    const ran: string[] = [];
    const offIdea = p.register(() => ran.push("idea"));
    p.register(() => ran.push("note"));
    p.runAll();
    expect(ran).toEqual(["idea", "note"]);
    offIdea();
    p.runAll();
    expect(ran).toEqual(["idea", "note", "note"]);
  });

  it("one save that throws doesn't stop the others", () => {
    const errors: unknown[] = [];
    const p = createPendingSaves((e) => errors.push(e));
    const ran: string[] = [];
    p.register(() => {
      throw new Error("boom");
    });
    p.register(() => ran.push("note"));
    p.runAll();
    expect(ran).toEqual(["note"]);
    expect(errors).toHaveLength(1);
  });

  it("a save that unregisters itself while running is fine", () => {
    const p = createPendingSaves();
    let n = 0;
    const off = p.register(() => {
      n++;
      off();
    });
    p.runAll();
    p.runAll();
    expect(n).toBe(1);
  });
});
