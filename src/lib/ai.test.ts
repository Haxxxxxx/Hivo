import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person, ProjectInfo, Settings, SongMeta } from "../types";
import { buildKit, type KitInput } from "./launchKit";

/** What reached the Rust side: typed facts, never a prompt. */
const sent: { kind: string; context: object; fields: Record<string, string> }[] = [];
vi.mock("./tauri", () => ({
  aiKit: vi.fn(async (req: { kind: string; context: object; fields: Record<string, string> }) => {
    sent.push(req);
    return {
      model: "test-model",
      data: { announce: "a", teaser: "t", releaseDay: "r", concept: "c", palette: "p", imagery: "i", typography: "ty", avoid: "av", fields: [] },
    };
  }),
}));

const { aiDisclosure, draftCopy, kitContext, reviewKit, reviewPayload, sanitizeReview, withoutNotesLine } = await import("./ai");

const NOTES = "secret lyric draft, deal with a label";
const TRACKS = ["Kick - SomePack_Vol3", "Lead Voices - Ana", "E MAJOR"];
const people: Person[] = [{ id: "a", name: "Ana", aliases: [], contact: "", notes: "" }];
const project = {
  path: "/Users/someone/Music/Night Run v3.flp",
  name: "Night Run v3",
  tempoBpm: 140,
  timeSigNum: 4,
  timeSigDenom: 4,
  genre: null,
  artist: null,
  trackNames: TRACKS,
  samples: ["/Users/someone/Samples/kick.wav"],
  renders: [],
  modifiedAtMs: Date.UTC(2026, 9, 1),
} as unknown as ProjectInfo;
const meta: SongMeta = { notes: NOTES, tags: ["dark"], credits: [{ personId: "a", role: "Lead rap", split: 100 }] };
const input: KitInput = {
  project,
  meta,
  people,
  albums: [],
  analysis: null,
  today: new Date(2026, 9, 13),
  lastLanguage: "English",
  labelName: "Crew",
};
const settings = (aiIncludeNotes: boolean) => ({ aiModel: null, aiLanguage: null, aiIncludeNotes }) as unknown as Settings;

/** Everything a payload carries, as one string, to search for leaks. */
const flat = (x: unknown) => JSON.stringify(x);

beforeEach(() => {
  sent.length = 0;
});

describe("AI payload", () => {
  it("sends exactly these context fields by default", () => {
    expect(Object.keys(kitContext(input)).sort()).toEqual(
      [
        "credits",
        "keySetInApp",
        "keyWrittenInTrackNames",
        "lastSavedInFl",
        "mixdownDurationSec",
        "peopleFoundInTrackNames",
        "pipelineStage",
        "projectName",
        "release",
        "tags",
        "tempoBpm",
        "timeSignature",
        "today",
      ].sort(),
    );
  });

  it("never sends raw track names, sample names or paths", () => {
    const ctx = flat(kitContext(input, { includeNotes: true }));
    for (const t of TRACKS.slice(0, 2)) expect(ctx).not.toContain(t);
    expect(ctx).not.toContain("SomePack");
    expect(ctx).not.toContain("/Users/");
    expect(ctx).not.toContain("kick.wav");
    // What was found in them is still there.
    expect(kitContext(input).keyWrittenInTrackNames).toBe("E");
    expect(kitContext(input).peopleFoundInTrackNames).toEqual(["Ana"]);
  });

  it("leaves notes out unless the user opted in", () => {
    expect(flat(kitContext(input))).not.toContain(NOTES);
    expect(kitContext(input, { includeNotes: true }).notes).toBe(NOTES);
  });

  it("strips the notes line from the cover brief in checks unless opted in", () => {
    const fields = buildKit(input);
    expect(fields.find((f) => f.id === "coverBrief")!.value).toContain(NOTES);
    expect(flat(reviewPayload(input, fields, false))).not.toContain(NOTES);
    expect(flat(reviewPayload(input, fields, true))).toContain(NOTES);
    expect(withoutNotesLine("a\n- Notes: x\nb")).toBe("a\nb");
  });

  it("Check kit sends notes only with the setting on", async () => {
    const fields = buildKit(input);
    await reviewKit(input, fields, settings(false)).catch(() => {});
    await reviewKit(input, fields, settings(true)).catch(() => {});
    expect(sent.map((s) => s.kind)).toEqual(["review", "review"]);
    expect(flat(sent[0])).not.toContain(NOTES);
    expect(flat(sent[1])).toContain(NOTES);
    for (const s of sent) expect(flat(s)).not.toContain("SomePack");
    expect(Object.keys(sent[0]).sort()).toEqual(["context", "fields", "kind", "language", "model"]);
  });

  it("drafts never see the notes, even with the setting on (they feed the FLUX prompt)", async () => {
    await draftCopy(input, buildKit(input), settings(true));
    expect(sent[0].kind).toBe("draft");
    expect(flat(sent[0])).not.toContain(NOTES);
    expect(flat(sent[0])).not.toContain("SomePack");
    // Drafts don't send the long fields (the cover brief quotes the notes).
    expect(Object.keys(sent[0].fields)).not.toContain("coverBrief");
  });

  it("the disclosure matches the setting", () => {
    expect(aiDisclosure(false)).toContain("never your notes");
    expect(aiDisclosure(true)).toContain("plus your notes when checking a kit");
    for (const on of [false, true]) expect(aiDisclosure(on)).toContain("Never audio, file paths, sample names or your track names");
  });
});

describe("sanitizeReview", () => {
  const fields = buildKit(input);
  const review = (id: string, suggestion: string) =>
    sanitizeReview({ fields: [{ id, verdict: "check", confidence: 0.8, reason: "r", suggestion }] }, fields)[id as "key"];

  it("keeps a key suggestion only when it's a real key", () => {
    expect(review("key", "F#m")?.suggestion).toBe("F#m");
    expect(review("key", "F sharp minor")?.suggestion).toBeUndefined();
    expect(review("key", "H")?.suggestion).toBeUndefined();
  });

  it("keeps a release type suggestion only from the list", () => {
    expect(review("releaseType", "EP")?.suggestion).toBe("EP");
    expect(review("releaseType", "LP")?.suggestion).toBeUndefined();
    expect(review("releaseType", "Deluxe single")?.suggestion).toBeUndefined();
    // The verdict itself is kept: the model may still flag the field.
    expect(review("releaseType", "LP")?.verdict).toBe("check");
  });
});
