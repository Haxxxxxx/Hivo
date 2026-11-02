import { parseDate } from "./launchKit";

// The still layer of a 9:16 short, drawn here so ffmpeg needs no fonts:
// generative art for the song, title, artist, release line. ffmpeg adds the
// animated waveform in the free box and the snippet audio (src-tauri/src/shorts.rs).

export const SHORT_W = 1080;
export const SHORT_H = 1920;
/** Must match WAVE_* in shorts.rs. */
const WAVE = { x: (1080 - 920) / 2, y: 1250, w: 920, h: 240 };
const ORANGE = "#E8743B";
const INK = "#15110e";
const LIGHT = "#F4EEE4";

export interface ShortLayoutInput {
  title: string;
  artists: string;
  producers: string;
  key: string;
  releaseDate: string;
  /** The kit's caption language: the short is posted with those captions. */
  lang?: "fr" | "en";
  today?: Date;
}

/** Stable 32-bit hash so a song always gets the same art. */
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function seeded(seed: number) {
  let s = seed || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/** "OUT FRIDAY · DEC 12" before the date, "OUT NOW" from release day on
 * ("SORTIE VENDREDI · 12 DÉC." / "DISPO MAINTENANT" in French): in the kit's
 * caption language, not the app's. */
export function releaseLine(releaseDate: string, today = new Date(), lang: "fr" | "en" = "en"): string {
  const d = parseDate(releaseDate);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const fr = lang === "fr";
  if (!d || d <= t) return fr ? "DISPO MAINTENANT" : "OUT NOW";
  const locale = fr ? "fr-FR" : "en-US";
  const weekday = d.toLocaleDateString(locale, { weekday: "long" }).toLocaleUpperCase(locale);
  const day = d.toLocaleDateString(locale, { month: "short", day: "numeric" }).toLocaleUpperCase(locale);
  return fr ? `SORTIE ${weekday} · ${day}` : `OUT ${weekday} · ${day}`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Abstract art from the title (hue) and key (minor = darker, moodier). */
function drawArt(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, input: ShortLayoutInput) {
  const rand = seeded(hash(input.title + input.artists));
  const hue = hash(input.title) % 360;
  const minor = /m$/.test(input.key);
  const light = minor ? 14 : 22;
  ctx.save();
  roundRect(ctx, x, y, size, size, 40);
  ctx.clip();
  const bg = ctx.createLinearGradient(x, y, x + size, y + size);
  bg.addColorStop(0, `hsl(${hue} 45% ${light + 8}%)`);
  bg.addColorStop(1, `hsl(${(hue + 40) % 360} 55% ${light}%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, size, size);
  // Soft orbs.
  for (let i = 0; i < 7; i++) {
    const cx = x + rand() * size;
    const cy = y + rand() * size;
    const r = size * (0.15 + rand() * 0.45);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const h = (hue + (rand() > 0.5 ? 30 : -30) + rand() * 40) % 360;
    g.addColorStop(0, `hsla(${h} 85% ${minor ? 55 : 65}% / ${0.35 + rand() * 0.35})`);
    g.addColorStop(1, `hsla(${h} 85% 50% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
  }
  // Rings, like a record.
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  for (let r = size * 0.12; r < size * 0.7; r += size * 0.06) {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Grain.
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rand() * 0.05})`;
    ctx.fillRect(x + rand() * size, y + rand() * size, 2, 2);
  }
  ctx.restore();
}

/** The cover concept in the art square, cropped to fill it. */
function drawCover(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, img: CanvasImageSource & { width: number; height: number }) {
  const side = Math.min(img.width, img.height);
  ctx.save();
  roundRect(ctx, x, y, size, size, 40);
  ctx.clip();
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, x, y, size, size);
  ctx.restore();
}

/** The layout as a PNG data URL (also used as the preview in the app).
 * `cover`: the kit's cover concept, drawn instead of the generated art. */
export function drawShortLayout(input: ShortLayoutInput, cover?: (CanvasImageSource & { width: number; height: number }) | null): string {
  const canvas = document.createElement("canvas");
  canvas.width = SHORT_W;
  canvas.height = SHORT_H;
  const ctx = canvas.getContext("2d")!;
  const hue = hash(input.title) % 360;

  const bg = ctx.createLinearGradient(0, 0, 0, SHORT_H);
  bg.addColorStop(0, `hsl(${hue} 30% 9%)`);
  bg.addColorStop(1, INK);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHORT_W, SHORT_H);

  if (cover && cover.width > 0 && cover.height > 0) drawCover(ctx, 120, 170, 840, cover);
  else drawArt(ctx, 120, 170, 840, input);

  const font = (weight: number, size: number) => `${weight} ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = LIGHT;
  ctx.font = font(800, 84);
  const titleLines = wrap(ctx, input.title.toUpperCase(), 940, 2);
  let y = 1110;
  for (const l of titleLines) {
    ctx.fillText(l, SHORT_W / 2, y);
    y += 92;
  }
  if (input.artists) {
    ctx.fillStyle = "#CFC6B8";
    ctx.font = font(500, 46);
    ctx.fillText(wrap(ctx, input.artists, 940, 1)[0], SHORT_W / 2, Math.min(y + 4, 1215));
  }

  // The waveform's box (ffmpeg draws into it).
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  roundRect(ctx, WAVE.x - 20, WAVE.y - 20, WAVE.w + 40, WAVE.h + 40, 28);
  ctx.fill();

  // Release pill.
  const line = releaseLine(input.releaseDate, input.today, input.lang);
  ctx.font = font(800, 44);
  const pillW = ctx.measureText(line).width + 96;
  ctx.fillStyle = ORANGE;
  roundRect(ctx, (SHORT_W - pillW) / 2, 1610, pillW, 96, 48);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.fillText(line, SHORT_W / 2, 1674);

  if (input.producers) {
    ctx.fillStyle = "#8f877b";
    ctx.font = font(500, 32);
    ctx.fillText(wrap(ctx, `prod. ${input.producers}`, 900, 1)[0], SHORT_W / 2, 1820);
  }
  return canvas.toDataURL("image/png");
}
