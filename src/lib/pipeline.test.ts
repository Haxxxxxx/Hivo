import { describe, expect, it } from "vitest";
import type { ProjectInfo, SongMeta, Workspace } from "../types";
import {
  DEFAULT_BOARD_ID,
  columnTint,
  activeBoard,
  addBoard,
  COLUMN_COLORS,
  addColumn,
  boardOfSong,
  moveSongToBoard,
  removeBoard,
  renameBoard,
  resolveBoards,
  setActiveBoard,
  canRemoveColumn,
  cardMoves,
  columnColor,
  recolorColumn,
  stageColor,
  columnOf,
  defaultPipeline,
  filterSongs,
  flatRows,
  groupSongs,
  moveCard,
  moveColumn,
  removeColumn,
  renameColumn,
  resolvePipeline,
  sortRows,
} from "./pipeline";

const NOW = Date.UTC(2026, 9, 14);
const song = (name: string, daysAgo = 1, bpm: number | null = null) =>
  ({ path: `/p/${name}.flp`, name, modifiedAtMs: NOW - daysAgo * 864e5, backups: [], tempoBpm: bpm }) as unknown as ProjectInfo;
const ws = (songs: Workspace["songs"] = {}, pipeline?: Workspace["pipeline"]): Workspace => ({ version: 2, songs, albums: [], people: [], pipeline });
const names = (w: Workspace, list: ProjectInfo[]) => groupSongs(list, w).map((g) => [g.column.name, g.songs.map((s) => s.name)]);

const A = song("A", 1);
const B = song("B", 2);
const C = song("C", 3);
const all = [A, B, C];

describe("pipeline model", () => {
  it("defaults to one column per stage, songs most recently saved first", () => {
    const w = ws({ "/p/A.flp": { status: "creation" }, "/p/B.flp": { status: "creation" } });
    expect(names(w, all)).toEqual([
      ["Unsorted", ["C"]],
      ["Creation", ["A", "B"]],
      ["Production", []],
      ["Prep", []],
      ["Release", []],
      ["Promotion", []],
    ]);
  });

  it("repairs a broken config: every stage keeps a column, bad entries dropped", () => {
    const cfg = resolvePipeline(
      ws({}, {
        columns: [
          { id: "x", name: "  Mixing   room ", stage: "production" },
          { id: "x", name: "dup", stage: "prep" },
          { id: "y", name: "Bad", stage: "nope" as never },
        ],
        order: { x: ["/p/A.flp", 3 as never], gone: ["/p/B.flp"] },
      }),
    );
    expect(cfg.columns.map((c) => [c.name, c.stage])).toEqual([
      ["Unsorted", null],
      ["Creation", "creation"],
      ["Mixing room", "production"],
      ["Prep", "prep"],
      ["Release", "release"],
      ["Promotion", "promotion"],
    ]);
    expect(cfg.order).toEqual({ x: ["/p/A.flp"] });
  });

  it("a rename shows in every view (one model)", () => {
    const w = renameColumn(ws({ "/p/A.flp": { status: "production" } }), "production", "Studio");
    const groups = groupSongs(all, w);
    expect(groups[2].column.name).toBe("Studio");
    expect(flatRows(groups).find((r) => r.song.name === "A")!.column.name).toBe("Studio");
    expect(renameColumn(w, "production", "   ")).toBe(w);
  });

  it("adds a column after its stage's last column; moving a card into it sets that stage", () => {
    let w = addColumn(ws(), "Mixing", "production", "mix");
    expect(resolvePipeline(w).columns.map((c) => c.id)).toEqual(["unsorted", "creation", "production", "mix", "prep", "release", "promotion"]);
    w = moveCard(w, all, "/p/A.flp", "mix", null, NOW);
    expect(w.songs["/p/A.flp"]).toMatchObject({ status: "production", column: "mix", stagePending: true, stageUpdatedAtMs: NOW });
    expect(columnOf(w.songs["/p/A.flp"], resolvePipeline(w)).name).toBe("Mixing");
  });

  it("reordering within a stage never marks a stage change for the crew", () => {
    let w = addColumn(ws({ "/p/A.flp": { status: "production", stageBaseAt: "v1" } }), "Mixing", "production", "mix");
    w = moveCard(w, all, "/p/A.flp", "mix", null, NOW);
    expect(w.songs["/p/A.flp"]).toEqual({ status: "production", stageBaseAt: "v1", column: "mix" });
  });

  it("hand-sorted card order is kept per column", () => {
    let w = ws({ "/p/A.flp": { status: "creation" }, "/p/B.flp": { status: "creation" }, "/p/C.flp": { status: "creation" } });
    expect(names(w, all)[1]).toEqual(["Creation", ["A", "B", "C"]]);
    w = moveCard(w, all, "/p/C.flp", "creation", "/p/A.flp");
    expect(names(w, all)[1]).toEqual(["Creation", ["C", "A", "B"]]);
    w = moveCard(w, all, "/p/C.flp", "creation", null);
    expect(names(w, all)[1]).toEqual(["Creation", ["A", "B", "C"]]);
    // A new song (not hand-sorted yet) goes after the sorted ones.
    const D = song("D", 0);
    w = { ...w, songs: { ...w.songs, "/p/D.flp": { status: "creation" } } };
    expect(names(w, [...all, D])[1]).toEqual(["Creation", ["A", "B", "C", "D"]]);
  });

  it("a drop that changes nothing leaves the workspace alone (no column pinned, no hand-sort)", () => {
    const w = ws({ "/p/A.flp": { status: "creation" }, "/p/B.flp": { status: "creation" } });
    expect(names(w, all)[1]).toEqual(["Creation", ["A", "B"]]);
    // On itself, before its own follower, or at the end when it's already last.
    expect(moveCard(w, all, "/p/A.flp", "creation", "/p/A.flp")).toBe(w);
    expect(moveCard(w, all, "/p/A.flp", "creation", "/p/B.flp")).toBe(w);
    expect(moveCard(w, all, "/p/B.flp", "creation", null)).toBe(w);
    // A real move still lands.
    expect(names(moveCard(w, all, "/p/B.flp", "creation", "/p/A.flp"), all)[1]).toEqual(["Creation", ["B", "A"]]);
    // Same spot in another column of the same stage is a move (the pin changes).
    const two = addColumn(w, "Mixing", "creation", "mix");
    expect(moveCard(two, all, "/p/A.flp", "mix", null)).not.toBe(two);
  });

  it("a stage changed elsewhere (drawer, crewmate) moves the song to that stage's first column", () => {
    let w = addColumn(ws(), "Mixing", "production", "mix");
    w = moveCard(w, all, "/p/A.flp", "mix", null, NOW);
    w = { ...w, songs: { ...w.songs, "/p/A.flp": { ...w.songs["/p/A.flp"], status: "prep" } } };
    expect(columnOf(w.songs["/p/A.flp"], resolvePipeline(w)).id).toBe("prep");
  });

  it("removing a column: songs keep their stage and move to the stage's other column; the last column of a stage stays", () => {
    let w = addColumn(ws(), "Mixing", "production", "mix");
    w = moveCard(w, all, "/p/A.flp", "mix", null, NOW);
    const cfg = resolvePipeline(w);
    expect(canRemoveColumn(cfg, "mix")).toBe(true);
    expect(canRemoveColumn(cfg, "creation")).toBe(false);
    expect(removeColumn(w, "creation")).toBe(w);
    const after = removeColumn(w, "mix");
    expect(after.songs["/p/A.flp"]).toMatchObject({ status: "production", column: "production" });
    expect(names(after, all)[2]).toEqual(["Production", ["A"]]);
    expect(resolvePipeline(after).order.mix).toBeUndefined();
  });

  it("hand-sorted lists only keep songs still in that column", () => {
    let w = ws({ "/p/A.flp": { status: "creation" }, "/p/B.flp": { status: "creation" } });
    w = moveCard(w, all, "/p/B.flp", "creation", "/p/A.flp");
    expect(resolvePipeline(w).order.creation).toEqual(["/p/B.flp", "/p/A.flp"]);
    // B moves to Prep elsewhere (drawer, crewmate); the next board edit drops it from Creation's list.
    w = { ...w, songs: { ...w.songs, "/p/B.flp": { status: "prep" } } };
    w = moveCard(w, all, "/p/C.flp", "prep", null);
    expect(resolvePipeline(w).order.creation).toEqual(["/p/A.flp"]);
    // A song no longer on the board (archived, deleted) is dropped too.
    w = moveCard(w, [B, C], "/p/C.flp", "prep", "/p/B.flp");
    expect(resolvePipeline(w).order.creation).toBeUndefined();
  });

  it("columns can be reordered", () => {
    const w = moveColumn(ws(), "promotion", 0);
    expect(resolvePipeline(w).columns[0].id).toBe("promotion");
    expect(moveColumn(w, "nope", 1)).toBe(w);
  });

  it("one filter and one sort for every view; a view's sort never touches the board", () => {
    const w = ws({ "/p/A.flp": { status: "creation", tags: ["dark"] }, "/p/B.flp": { status: "prep", key: "Am" } });
    expect(filterSongs(all, w, "#dark").map((s) => s.name)).toEqual(["A"]);
    expect(filterSongs(all, w, "am").map((s) => s.name)).toEqual(["B"]);
    const rows = flatRows(groupSongs(all, w));
    expect(rows.map((r) => r.song.name)).toEqual(["C", "A", "B"]);
    expect(sortRows(rows, "name", -1, w).map((r) => r.song.name)).toEqual(["C", "B", "A"]);
    expect(sortRows(rows, "saved", -1, w).map((r) => r.song.name)).toEqual(["A", "B", "C"]);
    expect(groupSongs(all, w).map((g) => g.songs.map((s) => s.name)).flat()).toEqual(["C", "A", "B"]);
  });

  it("default ids match the stages, so an untouched workspace needs no stored config", () => {
    expect(defaultPipeline().columns.map((c) => c.id)).toEqual(["unsorted", "creation", "production", "prep", "release", "promotion"]);
  });

  it("default column names follow the language; renamed ones stay", async () => {
    const { applyLang } = await import("../i18n");
    const w = ws({}, { columns: [{ id: "a", name: "Création", stage: "creation" }, { id: "b", name: "Studio", stage: "production" }], order: {} });
    applyLang("en");
    expect(resolvePipeline(w).columns.find((c) => c.id === "a")!.name).toBe("Creation");
    expect(resolvePipeline(w).columns.find((c) => c.id === "b")!.name).toBe("Studio");
    applyLang("fr");
    expect(resolvePipeline(w).columns.find((c) => c.id === "a")!.name).toBe("Création");
    applyLang("en");
  });
});

describe("cardMoves", () => {
  const groups = [
    { column: { id: "a", name: "Ideas" }, items: [{ key: "1" }, { key: "2" }, { key: "3" }] },
    { column: { id: "b", name: "Mix" }, items: [{ key: "4" }] },
    { column: { id: "c", name: "Out" }, items: [] },
  ];

  it("offers up, down and every other column", () => {
    expect(cardMoves(groups, "2")).toEqual([
      { id: "up", kind: "up", columnId: "a", beforeKey: "1" },
      { id: "down", kind: "down", columnId: "a", beforeKey: null },
      { id: "column:b", kind: "column", columnId: "b", name: "Mix", beforeKey: null },
      { id: "column:c", kind: "column", columnId: "c", name: "Out", beforeKey: null },
    ]);
  });

  it("moves down before the card after the next one", () => {
    expect(cardMoves(groups, "1").find((m) => m.kind === "down")?.beforeKey).toBe("3");
  });

  it("has no up for the first card, no down for the last, neither for a lone card", () => {
    expect(cardMoves(groups, "1").some((m) => m.kind === "up")).toBe(false);
    expect(cardMoves(groups, "3").some((m) => m.kind === "down")).toBe(false);
    expect(cardMoves(groups, "4").map((m) => m.id)).toEqual(["column:a", "column:c"]);
  });

  it("offers only other columns while reordering is off", () => {
    expect(cardMoves(groups, "2", false).map((m) => m.id)).toEqual(["column:b", "column:c"]);
  });

  it("knows nothing about a card that isn't on the board", () => {
    expect(cardMoves(groups, "nope")).toEqual([]);
  });
});

describe("separate pipelines", () => {
  const w = (over: Partial<Workspace> = {}): Workspace => ({ ...ws(), ...over }) as Workspace;

  it("migrates a workspace from before pipelines existed", () => {
    // The single pipeline the user already arranged becomes board one —
    // losing their columns on upgrade would be unforgivable.
    const legacy = renameColumn(ws(), "production", "Studio");
    const { active, boards } = resolveBoards(legacy);
    expect(boards).toHaveLength(1);
    expect(boards[0].id).toBe(DEFAULT_BOARD_ID);
    expect(active).toBe(DEFAULT_BOARD_ID);
    expect(boards[0].config.columns.find((c) => c.stage === "production")!.name).toBe("Studio");
  });

  it("never returns an empty set, or an active id that isn't there", () => {
    const broken = w({ pipelines: { active: "ghost", boards: [] } });
    const { active, boards } = resolveBoards(broken);
    expect(boards.length).toBeGreaterThan(0);
    expect(boards.some((b) => b.id === active)).toBe(true);
  });

  it("adds, renames and switches", () => {
    let x = addBoard(ws(), "Beats", "beats");
    expect(resolveBoards(x).boards.map((b) => b.name)).toContain("Beats");
    x = renameBoard(x, "beats", "Instrus");
    expect(resolveBoards(x).boards.find((b) => b.id === "beats")!.name).toBe("Instrus");
    x = setActiveBoard(x, "beats");
    expect(activeBoard(x).id).toBe("beats");
  });

  it("edits columns on the ACTIVE pipeline only", () => {
    // The whole seam: every column mutator goes through resolvePipeline and
    // withPipeline, so it must land on the board being looked at.
    let x = addBoard(ws(), "Beats", "beats");
    x = setActiveBoard(x, "beats");
    x = renameColumn(x, "production", "Drums");
    const boards = resolveBoards(x).boards;
    expect(boards.find((b) => b.id === "beats")!.config.columns.find((c) => c.stage === "production")!.name).toBe("Drums");
    expect(boards.find((b) => b.id === DEFAULT_BOARD_ID)!.config.columns.find((c) => c.stage === "production")!.name).not.toBe("Drums");
  });

  it("puts songs from before pipelines on the first board", () => {
    const boards = resolveBoards(ws()).boards;
    expect(boardOfSong(undefined, boards)).toBe(boards[0].id);
    expect(boardOfSong({ pipeline: "ghost" } as SongMeta, boards)).toBe(boards[0].id);
  });

  it("moves a song to another pipeline and drops its column pin", () => {
    // Column ids belong to the board it left; keeping the pin would point
    // at a column that doesn't exist on the new board.
    let x = addBoard(w({ songs: { "/p/A.flp": { status: "production", column: "production" } } }), "Beats", "beats");
    x = moveSongToBoard(x, "/p/A.flp", "beats");
    expect(x.songs["/p/A.flp"].pipeline).toBe("beats");
    expect(x.songs["/p/A.flp"].column).toBeUndefined();
  });

  it("keeps the last pipeline, and rehomes songs when one goes", () => {
    let x = addBoard(w({ songs: { "/p/A.flp": { status: "production" } } }), "Beats", "beats");
    x = moveSongToBoard(x, "/p/A.flp", "beats");
    x = removeBoard(x, "beats");
    // The song came back rather than vanishing with its board.
    expect(resolveBoards(x).boards).toHaveLength(1);
    expect(x.songs["/p/A.flp"].pipeline).toBe(DEFAULT_BOARD_ID);
    // And the one remaining board cannot be removed.
    expect(removeBoard(x, DEFAULT_BOARD_ID)).toBe(x);
  });

  it("still writes the legacy field, so an older build opens fine", () => {
    const x = renameColumn(addBoard(ws(), "Beats", "beats"), "production", "Studio");
    expect(x.pipeline?.columns.find((c) => c.stage === "production")!.name).toBe("Studio");
  });
});

describe("a new pipeline's columns", () => {
  it("starts with the default column per stage", () => {
    let x = addBoard(ws(), "Prods", "prods");
    x = setActiveBoard(x, "prods");
    const cfg = resolvePipeline(x);
    expect(cfg.columns.map((c) => c.stage)).toEqual(defaultPipeline().columns.map((c) => c.stage));
    expect(cfg.columns.map((c) => c.name)).toEqual(defaultPipeline().columns.map((c) => c.name));
  });

  it("switches to the pipeline it just created", () => {
    // Being left on the old board reads as nothing having happened.
    const x = addBoard(ws(), "Prods", "prods");
    expect(activeBoard(x).id).toBe("prods");
  });

  it("does not inherit another pipeline's renamed columns", () => {
    let x = renameColumn(ws(), "production", "Studio");
    x = addBoard(x, "Prods", "prods");
    x = setActiveBoard(x, "prods");
    expect(resolvePipeline(x).columns.map((c) => c.name)).not.toContain("Studio");
  });
});

describe("column colours", () => {
  const ws = (): Workspace => ({ songs: {}, albums: [], people: [] }) as unknown as Workspace;

  it("falls back to the stage ramp until a colour is set", () => {
    const cfg = resolvePipeline(ws());
    const first = cfg.columns[0];
    expect(columnColor(first)).toBe(stageColor(first.stage));
    expect(columnColor({ ...first, color: COLUMN_COLORS[0] })).toBe(COLUMN_COLORS[0]);
  });

  it("stores and clears a colour", () => {
    const base = ws();
    const id = resolvePipeline(base).columns[0].id;
    const painted = recolorColumn(base, id, COLUMN_COLORS[2]);
    expect(resolvePipeline(painted).columns[0].color).toBe(COLUMN_COLORS[2]);
    const cleared = recolorColumn(painted, id, null);
    expect(resolvePipeline(cleared).columns[0].color).toBeUndefined();
  });

  it("refuses a colour that is not on the palette", () => {
    // An arbitrary hex on a dark panel is one bad pick from unreadable, and
    // a stage colour would let a column impersonate a lifecycle stage.
    const base = ws();
    const id = resolvePipeline(base).columns[0].id;
    expect(recolorColumn(base, id, "#ff0000")).toBe(base);
    expect(recolorColumn(base, id, stageColor("prep"))).toBe(base);
  });

  it("changes nothing when there is nothing to change", () => {
    const base = ws();
    const id = resolvePipeline(base).columns[0].id;
    expect(recolorColumn(base, id, null)).toBe(base);
    expect(recolorColumn(base, "nope", COLUMN_COLORS[0])).toBe(base);
  });
});

describe("columnTint", () => {
  it("washes a palette colour at the given strength", () => {
    // #E8732A -> 232, 115, 42
    expect(columnTint(COLUMN_COLORS[0], 0.18)).toBe("rgba(232, 115, 42, 0.18)");
  });

  it("is transparent for a column with no colour of its own", () => {
    // An uncustomised column keeps the plain panel it has today.
    expect(columnTint(undefined, 0.18)).toBe("transparent");
  });

  it("is transparent for anything off the palette", () => {
    // Same guard as recolorColumn: no arbitrary hex reaches the UI.
    expect(columnTint("#ff0000", 0.18)).toBe("transparent");
    expect(columnTint(stageColor("prep"), 0.18)).toBe("transparent");
  });
});
