import { describe, expect, it } from "vitest";
import { onForeground, RECENT_SYNC_MS, STUCK_SYNC_MS } from "./syncGate";

describe("onForeground", () => {
  const base = { paired: true, syncing: false, startedAt: null, finishedAt: null };

  it("syncs when nothing ran yet, or the last one is old", () => {
    expect(onForeground(base, 1000)).toBe("sync");
    expect(onForeground({ ...base, finishedAt: 0 }, RECENT_SYNC_MS + 1)).toBe("sync");
  });

  it("skips right after a sync finished (F12) and when unpaired", () => {
    expect(onForeground({ ...base, finishedAt: 1000 }, 1000 + RECENT_SYNC_MS - 1)).toBe("skip");
    expect(onForeground({ ...base, paired: false }, 0)).toBe("skip");
  });

  it("leaves a running sync alone, restarts one stuck over a minute (B3)", () => {
    expect(onForeground({ ...base, syncing: true, startedAt: 0 }, STUCK_SYNC_MS)).toBe("skip");
    expect(onForeground({ ...base, syncing: true, startedAt: 0 }, STUCK_SYNC_MS + 1)).toBe("restart");
  });
});
