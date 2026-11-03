import { describe, expect, it } from "vitest";
import { createOfferStore } from "./updateOffer";

const update = { version: "0.7.1", apk: "https://example.invalid/Hivo.apk" };

describe("the update offer (review #1)", () => {
  it("keeps a found update for every banner mounted later (a remount, the Settings one)", async () => {
    const store = createOfferStore();
    let checks = 0;
    // The real check answers once a day: a second call would find nothing.
    const check = async () => (checks++ === 0 ? update : null);
    await store.ensureChecked(check);
    expect(store.get()).toEqual(update);
    // The banner after a pushed screen, and the one in Settings.
    await store.ensureChecked(check);
    await store.ensureChecked(check);
    expect(checks).toBe(1);
    expect(store.get()).toEqual(update);
  });

  it("checks once when two banners mount together", async () => {
    const store = createOfferStore();
    let checks = 0;
    const check = () => new Promise<typeof update>((r) => setTimeout(() => (checks++, r(update)), 5));
    await Promise.all([store.ensureChecked(check), store.ensureChecked(check)]);
    expect(checks).toBe(1);
  });

  it("Later hides it everywhere, for the rest of the run, and saves the version", async () => {
    const store = createOfferStore();
    const seen: (string | null)[] = [];
    store.subscribe(() => seen.push(store.get()?.version ?? null));
    await store.ensureChecked(async () => update);
    const saved: string[] = [];
    await store.dismiss(async (v) => void saved.push(v));
    expect(store.get()).toBeNull();
    expect(saved).toEqual(["0.7.1"]);
    expect(seen).toEqual(["0.7.1", null]);
    await store.ensureChecked(async () => update);
    expect(store.get()).toBeNull();
    // Nothing offered: nothing to save.
    await store.dismiss(async (v) => void saved.push(v));
    expect(saved).toEqual(["0.7.1"]);
  });

  it("a check that failed can run again on the next mount", async () => {
    const store = createOfferStore();
    await expect(store.ensureChecked(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    await store.ensureChecked(async () => update);
    expect(store.get()).toEqual(update);
  });

  it("a banner that unsubscribes no longer hears changes", async () => {
    const store = createOfferStore();
    let n = 0;
    const off = store.subscribe(() => n++);
    off();
    await store.ensureChecked(async () => update);
    expect(n).toBe(0);
  });
});
