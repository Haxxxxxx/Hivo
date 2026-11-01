import type { DawId, FileEntry, ProjectInfo, SongStatus, Workspace } from "../types";
import { ALBUM_COLORS, KEYS } from "./songs";

const ROOT = "C:/Users/you/Documents/Image-Line/FL Studio/Projects";

const ADJECTIVES = [
  "Midnight", "Neon", "Velvet", "Solar", "Ghost", "Crimson",
  "Analog", "Static", "Hollow", "Golden", "Electric", "Silent",
];

const NOUNS = [
  "Drift", "Pulse", "Horizon", "Echo", "Circuit", "Bloom",
  "Tide", "Mirage", "Signal", "Fever", "Orbit", "Static",
];

const STATUSES: (SongStatus | undefined)[] = ["creation", "creation", "production", "production", "prep", "release", "promotion", undefined];
const TAGS = ["dark", "chill", "club", "vocals", "808", "sample-based", "collab"];
const DAY = 24 * 60 * 60 * 1000;
const VOCALISTS = ["Kadence", "Milo", "Nova"];

/** "2026-10-01 143005" (local time), for timestamped backup names. */
function stamp(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Where each DAW keeps a song's backups, named the way it does. */
function backupPath(daw: DawId, folder: string, name: string, s: number, ms: number) {
  switch (daw) {
    case "ableton":
      return `${folder}/Backup/${name} [${stamp(ms)}].als`;
    case "reaper":
      return `${folder}/Backups/${name}-${stamp(ms).replace(" ", "_")}.rpp-bak`;
    case "pro-tools":
      return `${folder}/Session File Backups/${name}.bak.${String(s + 1).padStart(3, "0")}.ptx`;
    default:
      return `${folder}/Backup/${name} (overwritten at ${10 + (s % 12)}h${10 + s}).flp`;
  }
}

const PLUGINS: { name: string; vendor: string | null }[] = [
  { name: "FLEX", vendor: null },
  { name: "Fruity Limiter", vendor: null },
  { name: "Fruity Reeverb 2", vendor: null },
  { name: "Serum", vendor: "Xfer Records" },
  { name: "FabFilter Pro-Q 3", vendor: "FabFilter" },
  { name: "FabFilter Pro-C 2", vendor: "FabFilter" },
  { name: "Auto-Tune Pro", vendor: "Antares" },
  { name: "Kontakt 7", vendor: "Native Instruments" },
];

function seededRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
}

export function generateSampleProjects(count = 28): ProjectInfo[] {
  const rand = seededRandom(42);
  const now = Date.now();
  const projects: ProjectInfo[] = [];
  const used = new Set<string>();

  for (let i = 0; i < count; i++) {
    const adjective = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(rand() * NOUNS.length)];
    let name = `${adjective} ${noun}`;
    if (used.has(name)) name = `${name} v2`;
    used.add(name);
    const folder = `${ROOT}/${name}`;

    // Weight recency: most projects skew toward the last ~60 days, a long tail back to a year.
    const ageDays = Math.floor(-Math.log(1 - rand() * 0.999) * 25);
    const modifiedAtMs = now - Math.min(ageDays, 365) * DAY;

    // A mixed crew: most songs in FL Studio, some in other DAWs.
    const other = ([
      [5, "ableton", "als", "Ableton Live 12.1.5"],
      [7, "reaper", "rpp", "REAPER 7.22"],
      [11, "pro-tools", "ptx", null],
    ] as const).find(([every]) => i % every === every - 1);
    const daw: DawId = other?.[1] ?? "fl-studio";
    // Pro Tools sessions are closed: tempo, plugins, samples and tracks
    // can't be read. The random draws still happen so the rest of the
    // sample library stays the same.
    const readable = daw !== "pro-tools";

    // A song gets a burst of save sessions over the weeks before its last save.
    const backups: FileEntry[] = [];
    const sessions = Math.floor(rand() * 18);
    for (let s = 0; s < sessions; s++) {
      const sizeBytes = Math.floor((60 + rand() * 120) * 1024);
      const backupMs = modifiedAtMs - Math.floor(rand() * 40) * DAY - Math.floor(rand() * DAY);
      backups.push({ path: backupPath(daw, folder, name, s, backupMs), sizeBytes, modifiedAtMs: backupMs });
    }
    backups.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);

    const renderRoll = rand();
    const renders: FileEntry[] =
      renderRoll > 0.45
        ? [{
            path: `${folder}/${name}.wav`,
            sizeBytes: Math.floor((25 + rand() * 30) * 1024 * 1024),
            // Some mixdowns predate the latest save (out of date).
            modifiedAtMs: modifiedAtMs + (renderRoll > 0.7 ? DAY / 4 : -3 * DAY),
          }]
        : [];

    const sizeBytes = Math.floor((60 + rand() * 180) * 1024);
    const tempoBpm = Math.round(80 + rand() * 90);
    projects.push({
      path: `${folder}/${name}.${other?.[2] ?? "flp"}`,
      name,
      folder,
      sizeBytes,
      modifiedAtMs,
      root: ROOT,
      genre: null,
      artist: null,
      tempoBpm: readable ? tempoBpm : null,
      timeSigNum: rand() > 0.9 ? 3 : 4,
      timeSigDenom: 4,
      flVersion: daw === "fl-studio" ? (rand() > 0.5 ? "25.1.6.4997" : "24.2.1.4526") : null,
      daw,
      dawVersion: other?.[3] ?? null,
      isTemplate: false,
      backups,
      renders,
      recordingsCount: Math.floor(rand() * 20),
      recordingsBytes: Math.floor(rand() * 400 * 1024 * 1024),
      stems: null,
      plugins: PLUGINS.filter(() => rand() > 0.55)
        .map((p) => ({
          ...p,
          // One third-party plugin "not installed" on a few songs.
          installed: p.vendor ? !(p.name === "Auto-Tune Pro" && rand() > 0.5) : null,
        }))
        // FL's stock plugins (no vendor) only show up in FL projects.
        .filter((p) => readable && (daw === "fl-studio" || p.vendor !== null)),
      samples: Array.from({ length: 3 + Math.floor(rand() * 12) }, (_, s) => ({
        path: `${folder}/Samples/sample ${s + 1}.wav`,
        status: rand() > 0.96 ? ("missing" as const) : rand() > 0.85 ? ("relocated" as const) : ("ok" as const),
      })).filter(() => readable),
      trackNames: [
        "Instru",
        "Bus Voices",
        ...VOCALISTS.filter(() => rand() > 0.6).map((v) => `Lead Voices - ${v}`),
      ].filter(() => readable),
    });
  }

  return projects.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
}

export function generateSampleWorkspace(projects: ProjectInfo[]): Workspace {
  const rand = seededRandom(7);
  const songs: Workspace["songs"] = {};
  for (const p of projects) {
    const tags = TAGS.filter(() => rand() > 0.78);
    songs[p.path] = {
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      tags,
      notes: rand() > 0.7 ? "Hook needs a second layer. Try the Rhodes preset." : "",
      key: rand() > 0.35 ? KEYS[Math.floor(rand() * KEYS.length)] : undefined,
    };
  }
  const paths = projects.map((p) => p.path);
  const inTwoMonths = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
  const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);

  // Kadence and Milo are known people (Nova is left for the suggestions),
  // plus a label A&R who gets pitched beats.
  const people = [
    { id: "p-kadence", name: "Kadence", aliases: ["KD"], contact: "@kadence", notes: "" },
    { id: "p-milo", name: "Milo", aliases: [], contact: "", notes: "Prefers dark, slow stuff." },
    { id: "p-anr", name: "Sam (Night Owl Records)", aliases: [], contact: "sam@example.com", notes: "" },
  ];
  const outcomes = ["sent", "listened", "interested", "placed", "passed"] as const;
  paths.slice(0, 8).forEach((path, i) => {
    songs[path].pitches = [
      { id: `pitch-${i}`, personId: i % 2 ? "p-anr" : "p-milo", date: daysAgo(3 + i * 6), outcome: outcomes[i % outcomes.length] },
    ];
  });
  songs[paths[0]].credits = [{ personId: "p-kadence", role: "Vocals", split: 50 }];

  return {
    version: 2,
    sample: true,
    songs,
    people,
    albums: [
      {
        id: "demo-album",
        title: "Night Shift",
        kind: "album",
        color: ALBUM_COLORS[0],
        releaseDate: inTwoMonths,
        notes: "Late-night, moody. 10 tracks max.",
        trackPaths: paths.slice(0, 9),
        createdAtMs: Date.now() - 90 * DAY,
      },
      {
        id: "demo-ep",
        title: "Summer Tapes",
        kind: "ep",
        color: ALBUM_COLORS[1],
        releaseDate: null,
        notes: "",
        trackPaths: paths.slice(12, 17),
        createdAtMs: Date.now() - 30 * DAY,
      },
    ],
  };
}
