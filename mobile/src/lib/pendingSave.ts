// Text typed in an editor waits a moment before it's saved (the idea and
// note editors debounce every keystroke). When the app goes to the
// background, those last keystrokes must reach the store before it's saved
// to disk, or a kill loses them (review #7). Each open editor registers how
// to save what it holds; App.tsx runs them all, then flushes the store.

export type PendingSaves = {
  /** Adds an editor's save; returns its removal (the editor unmounts). */
  register(save: () => void): () => void;
  /** Runs every registered save (one that throws doesn't stop the others). */
  runAll(): void;
};

export function createPendingSaves(onError: (e: unknown) => void = () => {}): PendingSaves {
  const saves = new Set<() => void>();
  return {
    register(save) {
      saves.add(save);
      return () => {
        saves.delete(save);
      };
    },
    runAll() {
      for (const save of [...saves]) {
        try {
          save();
        } catch (e) {
          onError(e);
        }
      }
    },
  };
}
