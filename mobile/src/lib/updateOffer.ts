// The update the banner offers, remembered for the whole app run (review #1):
// the banner is mounted twice (the tabs and Settings) and remounts after any
// pushed screen, while the check itself runs at most once a day. So the
// found update lives here, not in the banner, until "Later" or "Download".
// Pure (the check and the "Later" save are injected), so it's tested.
import type { Update } from "./update";

export type OfferStore = {
  /** The update to show now, or null. */
  get(): Update | null;
  subscribe(listener: () => void): () => void;
  /** Runs `check` once per app run (later calls share it); a failed check may run again. */
  ensureChecked(check: () => Promise<Update | null>): Promise<void>;
  /** "Later" or "Download": gone from every banner, and `persist` remembers the version. */
  dismiss(persist: (version: string) => Promise<void>): Promise<void>;
};

export function createOfferStore(): OfferStore {
  let offer: Update | null = null;
  let checking: Promise<void> | null = null;
  let checked = false;
  const listeners = new Set<() => void>();
  const set = (u: Update | null) => {
    offer = u;
    for (const l of listeners) l();
  };
  return {
    get: () => offer,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensureChecked(check) {
      if (checked) return Promise.resolve();
      if (checking) return checking;
      checking = check()
        .then((u) => {
          checked = true;
          if (u) set(u);
        })
        .finally(() => {
          checking = null;
        });
      return checking;
    },
    async dismiss(persist) {
      const u = offer;
      if (!u) return;
      set(null);
      await persist(u.version);
    },
  };
}
