import { describe, expect, it } from "vitest";
import { addPending, MAX_PENDING_SHARES, PENDING_SHARE_MS, pendingDirs, removePending, restorable } from "./pendingShares";

const share = (uris: string[], text: string | null = null) => ({ files: uris.map((uri) => ({ uri })), text });

describe("pending shares (survive a kill)", () => {
  it("are remembered once each, capped, and old ones let go", () => {
    let list = addPending([], "d1", share(["a"]), 0);
    list = addPending(list, "d1", share(["a"]), 1);
    expect(pendingDirs(list)).toEqual(["d1"]);
    list = addPending(list, "d2", share(["b"]), PENDING_SHARE_MS + 5);
    expect(pendingDirs(list)).toEqual(["d2"]);
    for (let i = 0; i < 20; i++) list = addPending(list, `x${i}`, share([]), PENDING_SHARE_MS + 10 + i);
    expect(list).toHaveLength(MAX_PENDING_SHARES);
    expect(pendingDirs(removePending(list, "x19"))).not.toContain("x19");
  });

  it("restores the oldest not shown yet, with only the files still there", () => {
    const list = [
      { dir: "new", at: 5, share: share(["n"]) },
      { dir: "old", at: 1, share: share(["o1", "o2"]) },
    ];
    expect(restorable(list, new Set(), (u) => u !== "o2")).toEqual({ dir: "old", share: share(["o1"]) });
    expect(restorable(list, new Set(["old"]), () => true)?.dir).toBe("new");
    expect(restorable(list, new Set(["old", "new"]), () => true)).toBeNull();
  });

  it("skips one with nothing left to show, keeps one with text", () => {
    expect(restorable([{ dir: "a", at: 1, share: share(["gone"]) }], new Set(), () => false)).toBeNull();
    expect(restorable([{ dir: "a", at: 1, share: share(["gone"], "lyrics") }], new Set(), () => false)?.share.files).toEqual([]);
  });
});
