// The "Me" dashboard is a grid of blocks the user can reorder, hide, resize
// and (for some) switch between two looks. The registry below is the one
// list of blocks; the layout stored in the workspace (`Workspace.dashboard`)
// only says how they're arranged. Everything here is pure, so a stored
// layout from any version normalizes to something the dashboard can draw.

export const DASHBOARD_BLOCK_IDS = [
  "stats",
  "pickUp",
  "nextRelease",
  "stalled",
  "crewWho",
  "activity",
  "pipeline",
  "openCleanly",
  "attention",
  "storage",
  "pitches",
  "releases",
  // Tendencies (src/lib/tendencies.ts): off the dashboard until added from the tray.
  "tempoKey",
  "workingHours",
  "yourSound",
  "collaborators",
  "songShape",
  "pace",
] as const;

export type DashboardBlockId = (typeof DASHBOARD_BLOCK_IDS)[number];

/** Blocks that start hidden: they only appear through Edit layout → Add
 * block, and a stored layout that doesn't know them gets them in `hidden`. */
export const BLOCK_DEFAULT_HIDDEN: Partial<Record<DashboardBlockId, true>> = {
  tempoKey: true,
  workingHours: true,
  yourSound: true,
  collaborators: true,
  songShape: true,
  pace: true,
};

export function isDefaultHidden(id: DashboardBlockId): boolean {
  return BLOCK_DEFAULT_HIDDEN[id] === true;
}

export const BLOCK_SIZES = ["full", "half", "third"] as const;
export type BlockSize = (typeof BLOCK_SIZES)[number];

/** The looks a block can switch between (the first one is its default).
 * One entry = no switch. */
export const BLOCK_VARIANTS: Record<DashboardBlockId, readonly string[]> = {
  stats: ["tiles", "hero"],
  pickUp: ["cards"],
  nextRelease: ["card", "countdown"],
  stalled: ["list"],
  crewWho: ["list"],
  activity: ["curve", "heatmap"],
  pipeline: ["bars", "counts"],
  openCleanly: ["health"],
  attention: ["carousel"],
  storage: ["bar"],
  pitches: ["cards"],
  releases: ["list"],
  tempoKey: ["bars", "list"],
  workingHours: ["grid", "summary"],
  yourSound: ["top", "shifts"],
  collaborators: ["top", "recent"],
  songShape: ["numbers", "starts"],
  pace: ["stages", "now"],
};

export interface DashboardLayout {
  /** Visible blocks, top to bottom. */
  order: DashboardBlockId[];
  /** Blocks the user took off the dashboard (never in `order`). */
  hidden: DashboardBlockId[];
  /** Chosen look per block; missing = the block's first variant. */
  variants: Partial<Record<DashboardBlockId, string>>;
  /** Width per block; missing = `DEFAULT_LAYOUT`'s. */
  sizes: Partial<Record<DashboardBlockId, BlockSize>>;
}

/** Today's dashboard, top to bottom, with the widths it has always had. The
 * tendency blocks wait in `hidden`. */
export const DEFAULT_LAYOUT: DashboardLayout = {
  order: DASHBOARD_BLOCK_IDS.filter((id) => !isDefaultHidden(id)),
  hidden: DASHBOARD_BLOCK_IDS.filter(isDefaultHidden),
  variants: {},
  sizes: {
    nextRelease: "half",
    stalled: "half",
    crewWho: "half",
    pipeline: "half",
    openCleanly: "half",
    tempoKey: "half",
    workingHours: "half",
    yourSound: "half",
    collaborators: "half",
    songShape: "half",
    pace: "half",
  },
};

/** The default arrangement for someone in a crew: the three crew cards
 * (next release, stalled, who's on what) share one row, as they always did. */
export function defaultLayout(inCrew: boolean): DashboardLayout {
  if (!inCrew) return DEFAULT_LAYOUT;
  return { ...DEFAULT_LAYOUT, sizes: { ...DEFAULT_LAYOUT.sizes, nextRelease: "third", stalled: "third", crewWho: "third" } };
}

export function isBlockId(x: unknown): x is DashboardBlockId {
  return typeof x === "string" && (DASHBOARD_BLOCK_IDS as readonly string[]).includes(x);
}

export function isBlockSize(x: unknown): x is BlockSize {
  return typeof x === "string" && (BLOCK_SIZES as readonly string[]).includes(x);
}

/** The size a block is drawn at. */
export function sizeOf(layout: DashboardLayout, id: DashboardBlockId): BlockSize {
  return layout.sizes[id] ?? DEFAULT_LAYOUT.sizes[id] ?? "full";
}

/** The look a block is drawn with. */
export function variantOf(layout: DashboardLayout, id: DashboardBlockId): string {
  return layout.variants[id] ?? BLOCK_VARIANTS[id][0];
}

/** Known ids only, each once, in the order given. */
function cleanIds(raw: unknown, taken: Set<DashboardBlockId>): DashboardBlockId[] {
  const out: DashboardBlockId[] = [];
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    if (isBlockId(x) && !taken.has(x)) {
      taken.add(x);
      out.push(x);
    }
  }
  return out;
}

/** A stored layout (from any version, or anything at all) made drawable:
 * unknown ids dropped, duplicates removed, blocks the stored layout doesn't
 * know (added since) appended to the visible order so they show up (or to
 * `hidden` when the registry says they start hidden), and variants and
 * sizes checked against the registry. `defaults` fills the sizes the stored
 * layout doesn't set. */
export function normalizeLayout(raw: unknown, defaults: DashboardLayout = DEFAULT_LAYOUT): DashboardLayout {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const taken = new Set<DashboardBlockId>();
  const order = cleanIds(r.order, taken);
  const hidden = cleanIds(r.hidden, taken);
  for (const id of DASHBOARD_BLOCK_IDS) if (!taken.has(id)) (isDefaultHidden(id) ? hidden : order).push(id);

  const variants: DashboardLayout["variants"] = {};
  const rv = (r.variants && typeof r.variants === "object" ? r.variants : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(rv)) {
    if (isBlockId(id) && typeof v === "string" && BLOCK_VARIANTS[id].includes(v) && v !== BLOCK_VARIANTS[id][0]) variants[id] = v;
  }

  const sizes: DashboardLayout["sizes"] = { ...defaults.sizes };
  const rs = (r.sizes && typeof r.sizes === "object" ? r.sizes : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(rs)) if (isBlockId(id) && isBlockSize(v)) sizes[id] = v;

  return { order, hidden, variants, sizes };
}

/** The blocks to draw, top to bottom. */
export function visibleBlocks(layout: DashboardLayout): DashboardBlockId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

/** Moves a visible block to index `to` of the visible order (clamped). */
export function moveBlock(layout: DashboardLayout, id: DashboardBlockId, to: number): DashboardLayout {
  const from = layout.order.indexOf(id);
  if (from < 0) return layout;
  const order = [...layout.order];
  const [block] = order.splice(from, 1);
  order.splice(Math.max(0, Math.min(to, order.length)), 0, block);
  return { ...layout, order };
}

export function hideBlock(layout: DashboardLayout, id: DashboardBlockId): DashboardLayout {
  if (layout.hidden.includes(id)) return layout;
  return { ...layout, order: layout.order.filter((x) => x !== id), hidden: [...layout.hidden, id] };
}

/** Puts a hidden block back, at the bottom. */
export function showBlock(layout: DashboardLayout, id: DashboardBlockId): DashboardLayout {
  if (!layout.hidden.includes(id)) return layout;
  return { ...layout, hidden: layout.hidden.filter((x) => x !== id), order: [...layout.order.filter((x) => x !== id), id] };
}

/** Picks a look; an unknown one is ignored. */
export function setVariant(layout: DashboardLayout, id: DashboardBlockId, variant: string): DashboardLayout {
  if (!BLOCK_VARIANTS[id].includes(variant)) return layout;
  const variants = { ...layout.variants };
  if (variant === BLOCK_VARIANTS[id][0]) delete variants[id];
  else variants[id] = variant;
  return { ...layout, variants };
}

export function setSize(layout: DashboardLayout, id: DashboardBlockId, size: BlockSize): DashboardLayout {
  return { ...layout, sizes: { ...layout.sizes, [id]: size } };
}

/** full → half → third → full. */
export function nextSize(size: BlockSize): BlockSize {
  return BLOCK_SIZES[(BLOCK_SIZES.indexOf(size) + 1) % BLOCK_SIZES.length];
}
