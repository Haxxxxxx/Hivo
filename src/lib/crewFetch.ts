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

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** A card's place after place_crew_cards. */
export interface PlacedCard {
  id: string;
  column_id: string | null;
  board_order: number | null;
}

/** Place a column's other cards (same stage) in one request. A crew server
 * without place_crew_cards gets the old way: one move_crew_card per card
 * (`expectedAt`: the card's stage version; unknown cards are skipped). */
export async function placeCards(rpc: Rpc, columnId: string, cards: { songId: string; order: number }[], expectedAt: (songId: string) => string | undefined): Promise<PlacedCard[]> {
  if (!cards.length) return [];
  const { data, error } = await rpc("place_crew_cards", { p_column: columnId, p_cards: cards.map((c) => ({ id: c.songId, order: c.order })) });
  if (!error) return (data ?? []) as PlacedCard[];
  if (!isMissingOnServer(error)) throw error;
  const out: PlacedCard[] = [];
  for (const c of cards) {
    const at = expectedAt(c.songId);
    if (at === undefined) continue;
    const r = await rpc("move_crew_card", { p_song: c.songId, p_column: columnId, p_order: c.order, p_expected_at: at });
    if (r.error) throw r.error;
    const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { column_id: string | null; board_order: number | null };
    out.push({ id: c.songId, column_id: row.column_id, board_order: row.board_order });
  }
  return out;
}

/** Cards back from placeCards, applied to the board. */
export function applyPlaced<T extends { id: string; column_id?: string | null; board_order?: number | null }>(songs: T[], placed: PlacedCard[]): T[] {
  const byId = new Map(placed.map((p) => [p.id, p]));
  return songs.map((s) => {
    const p = byId.get(s.id);
    return p ? { ...s, column_id: p.column_id, board_order: p.board_order } : s;
  });
}
