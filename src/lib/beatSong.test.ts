import { describe, expect, it } from "vitest";
import type { BeatFile, InboxItem, Person, SavedLead, Workspace } from "../types";
import { EMPTY_WORKSPACE } from "./songs";
import { beatMemos, beatProducer, beatSongName, moveBeatToSong, producerInName } from "./beatSong";

const beat = (name: string, folder = "/beats"): BeatFile => ({ path: `${folder}/${name}.mp3`, name, folder, sizeBytes: 1, modifiedAtMs: 0 });
const person = (id: string, name: string, aliases: string[] = []): Person => ({ id, name, aliases, contact: "", notes: "" });

describe("start a song from a beat", () => {
  it("names the song from the beat, without the upload noise", () => {
    expect(beatSongName('[FREE] Night Drive - Dark Trap Type Beat (prod. Someone) 140bpm')).toBe("Night Drive Dark Trap");
    expect(beatSongName("Cold Room")).toBe("Cold Room");
    expect(beatSongName("[FREE]")).toBe("[FREE]");
  });

  it("finds the producer: the saved prod, else the name, else a folder named after someone", () => {
    expect(producerInName("Night (prod. Some One)")).toBe("Some One");
    expect(producerInName("Night prod. by Some One")).toBe("Some One");
    expect(producerInName("Night")).toBeNull();
    const b = beat("Night Drive");
    const lead = { hash: "h1", title: "Night Drive", producer: "Lead Producer" } as SavedLead;
    expect(beatProducer(b, [lead], undefined, [])).toBe("Lead Producer");
    // The user said that prod isn't this beat: not its producer.
    expect(beatProducer(b, [lead], { h1: null }, [])).toBeNull();
    expect(beatProducer(beat("Night (prod. Name)"), [], undefined, [])).toBe("Name");
    const people = [person("p1", "Crew Producer", ["CP"])];
    expect(beatProducer(beat("Untitled", "/beats/cp"), [], undefined, people)).toBe("Crew Producer");
    expect(beatProducer(beat("Untitled", "/beats/downloads"), [], undefined, people)).toBeNull();
  });

  it("moves the beat's note to the song and credits the producer once", () => {
    const ws: Workspace = { ...EMPTY_WORKSPACE, beatNotes: { "/beats/a.mp3": "[Hook]\nline", "/beats/b.mp3": "other" }, songs: { "/p/A/A.flp": { notes: "song idea" } } };
    const next = moveBeatToSong(ws, "/beats/a.mp3", "/p/A/A.flp", "p1");
    expect(next.beatNotes).toEqual({ "/beats/b.mp3": "other" });
    expect(next.songs["/p/A/A.flp"].notes).toBe("song idea\n\n[Hook]\nline");
    expect(next.songs["/p/A/A.flp"].credits).toEqual([{ personId: "p1", role: "Producer" }]);
    expect(moveBeatToSong(next, "/beats/a.mp3", "/p/A/A.flp", "p1").songs["/p/A/A.flp"].credits).toHaveLength(1);
    // No note, no producer: the new song only.
    const bare = moveBeatToSong({ ...EMPTY_WORKSPACE }, "/beats/c.mp3", "/p/C/C.flp", null);
    expect(bare.songs["/p/C/C.flp"]).toEqual({});
  });

  it("picks the memos filed on that beat, and only those", () => {
    const memo = (id: string, filedTo: string | null, itemType: InboxItem["itemType"] = "memo", status: InboxItem["status"] = "filed") => ({ id, filedTo, itemType, status }) as InboxItem;
    const items = [memo("1", "beat:/beats/a.mp3"), memo("2", "beat:/beats/b.mp3"), memo("3", "beat:/beats/a.mp3", "idea"), memo("4", "beat:/beats/a.mp3", "memo", "new"), memo("5", "prod:/beats/a.mp3")];
    expect(beatMemos(items, "/beats/a.mp3").map((i) => i.id)).toEqual(["1"]);
  });
});
