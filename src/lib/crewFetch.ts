// Reading the crew's rows without silent truncation (desktop and website).
// The API returns at most `max_rows` rows per request (1000, supabase/config.toml),
// with no error past that, so a big crew's board, or your own songs past the
// cut, would quietly go missing. Every list is read page by page.

/** Rows per request: the server's max_rows. */
export const PAGE_ROWS = 1000;
/** A hard stop, far above the quotas (1000 songs per person per crew, 10 people per invite…). */
const MAX_PAGES = 100;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Every row of a query, read with `.range(from, to)` until a short page.
 * The query must have a stable order (end it with the primary key). Rows
 * that moved between pages while reading are kept once (by id). */
export async function fetchAllPages<T extends { id?: string }>(page: (from: number, to: number) => Page<T>, size = PAGE_ROWS): Promise<{ data: T[]; error: unknown }> {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * size, (i + 1) * size - 1);
    if (error) return { data: out, error };
    const rows = data ?? [];
    for (const r of rows) {
      const id = r.id;
      if (id === undefined) out.push(r);
      else if (!seen.has(id)) {
        seen.add(id);
        out.push(r);
      }
    }
    if (rows.length < size) break;
  }
  return { data: out, error: null };
}

/** A table or function the server doesn't have yet (a crew server older
 * than this app). Only that means "no columns" or "no releases"; any other
 * error is a real failure and is shown. */
export function isMissingOnServer(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  // 42P01: undefined table; 42883: undefined function; PGRST202/205: not in the API's schema cache.
  return err.code === "42P01" || err.code === "42883" || err.code === "PGRST202" || err.code === "PGRST205";
}
