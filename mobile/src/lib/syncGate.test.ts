import { describe, expect, it } from "vitest";
import { onForeground, RECENT_SYNC_MS, STUCK_SYNC_MS } from "./syncGate";

describe("onForeground", () => {
  const base = { paired: true, syncing: false, progressAt: null, finishedAt: null };

  it("syncs when nothing ran yet, or the last one is old", () => {
    expect(onForeground(base, 1000)).toBe("sync");
    expect(onForeground({ ...base, finishedAt: 0 }, RECENT_SYNC_MS + 1)).toBe("sync");
  });

  it("skips right after a sync finished (F12) and when unpaired", () => {
    expect(onForeground({ ...base, finishedAt: 1000 }, 1000 + RECENT_SYNC_MS - 1)).toBe("skip");
    expect(onForeground({ ...base, paired: false }, 0)).toBe("skip");
  });

  it("leaves a running sync alone, restarts one that hasn't moved for over a minute (B3)", () => {
    expect(onForeground({ ...base, syncing: true, progressAt: 0 }, STUCK_SYNC_MS)).toBe("skip");
    expect(onForeground({ ...base, syncing: true, progressAt: 0 }, STUCK_SYNC_MS + 1)).toBe("restart");
  });

  it("a long upload that keeps moving is never cut on a return (review #10)", () => {
    // Started 10 minutes ago, a chunk went 5 s ago.
    const startedAt = 0;
    const now = 10 * 60_000;
    expect(onForeground({ ...base, syncing: true, progressAt: now - 5000 }, now)).toBe("skip");
    expect(onForeground({ ...base, syncing: true, progressAt: startedAt }, now)).toBe("restart");
  });
});
