// Hivo's UI library: the presentational building blocks every screen
// uses. Props only, no store access, so they render anywhere (and sync to
// Claude Design as the app's design system). Styling is System 02 ("built
// like a rack unit"): solid warm-grey panels, engraved mono labels, LED
// status, condensed caps on buttons, one hot orange. Tokens: src/theme.css.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { STATUSES, UNSORTED, statusInfo } from "../lib/songs";
import type { SongStatus } from "../types";
import { dict, tr } from "../i18n";
import { confirmNext, CONFIRM_DISARM_MS, type ConfirmEvent, type ConfirmState } from "../lib/confirmArm";

const T = dict(
  { remove: (tag: string) => `Remove ${tag}`, addTag: "Add tag…", close: "Close" },
  { remove: (tag: string) => `Retirer ${tag}`, addTag: "Ajouter un tag…", close: "Fermer" },
);

/** Small mono caps label, the "engraving" on every panel and field. */
export const engrave = "font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave";

/** LED + stage name (never color alone), backed by a native select. */
export function StatusSelect({
  value,
  onChange,
  compact = false,
}: {
  value: SongStatus | undefined;
  onChange: (status: SongStatus | undefined) => void;
  compact?: boolean;
}) {
  const info = statusInfo(value);
  return (
    <label
      className={`relative inline-flex cursor-pointer items-center gap-2 rounded border border-rule-strong bg-chassis text-cream hover:border-[#5a5850] ${
        compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      <StatusDot color={info.color} />
      <span className="font-medium">{info.label}</span>
      <span className="font-mono text-engrave" aria-hidden>
        ▾
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange((e.target.value || undefined) as SongStatus | undefined)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">{UNSORTED.label}</option>
        {STATUSES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A lit LED. `glow={false}` for an unlit or dense one. Pass `label` when no
 * word sits next to the dot, so its meaning isn't colour alone. */
export function StatusDot({ color, size = 8, glow = true, label }: { color: string; size?: number; glow?: boolean; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color, boxShadow: glow ? `0 0 ${size}px ${color}` : undefined }}
    />
  );
}

export function TagEditor({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setDraft("");
  };
  const unused = suggestions.filter((s) => !tags.includes(s)).slice(0, 8);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 rounded border border-rule-strong bg-chassis p-1.5 shadow-[inset_0_2px_3px_rgb(0_0_0/0.5)]">
        {tags.map((t) => (
          <span key={t} className="flex items-center gap-1.5 rounded border border-rule-strong bg-raised px-2 py-0.5 text-xs text-cream">
            {t}
            <button onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={tr(T).remove(t)} className="text-engrave hover:text-cream">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && tags.length) {
              onChange(tags.slice(0, -1));
            }
          }}
          placeholder={tr(T).addTag}
          className="min-w-[80px] flex-1 bg-transparent px-1 py-0.5 text-xs text-cream placeholder:text-engrave focus:outline-none"
        />
      </div>
      {unused.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {unused.map((s) => (
            <button
              key={s}
              onClick={() => add(s)}
              className="rounded border border-dashed border-rule-strong px-2 py-0.5 text-[11px] text-engrave hover:border-engrave hover:text-body"
            >
              +{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Open dialogs, oldest first (the last one is on top). */
const MODAL_STACK: symbol[] = [];
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  width = "max-w-lg",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Open dialogs stack: only the top one answers Escape and keeps the focus;
  // closing it hands the focus back to what had it before.
  useEffect(() => {
    const id = Symbol("modal");
    MODAL_STACK.push(id);
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (MODAL_STACK[MODAL_STACK.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const focusable = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return e.preventDefault();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = box.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = MODAL_STACK.indexOf(id);
      if (at >= 0) MODAL_STACK.splice(at, 1);
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={onClose}>
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-full w-full ${width} flex-col rounded border border-rule-strong bg-raised shadow-[0_24px_48px_rgb(0_0_0/0.6)] outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-5 pb-1 pt-5">
          <h2 className="font-display text-2xl font-bold uppercase leading-none text-cream">{title}</h2>
          <button onClick={onClose} aria-label={tr(T).close} className="rounded p-1 text-engrave hover:bg-rule hover:text-cream">
            <X size={15} />
          </button>
        </div>
        <div className="overflow-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/** Two-step button for anything destructive: first click arms, second acts.
 * It disarms on its own after a few seconds, but never while it has focus,
 * and the armed state is announced to screen readers. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "",
  disabled = false,
}: {
  label: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<ConfirmState>({ armed: false, focused: false });
  const current = useRef(state);
  const step = (event: ConfirmEvent) => {
    const next = confirmNext(current.current, event);
    current.current = next.state;
    setState(next.state);
    if (next.fire) onConfirm();
  };
  const { armed, focused } = state;
  useEffect(() => {
    if (!armed || focused) return;
    const t = setTimeout(() => step("timeout"), CONFIRM_DISARM_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, focused]);
  return (
    <>
      <button
        disabled={disabled}
        onClick={() => step("click")}
        onFocus={() => step("focus")}
        onBlur={() => step("blur")}
        className={`${className} ${armed ? "!border-missing !bg-missing !font-bold !text-chassis" : ""}`}
      >
        {armed ? confirmLabel : label}
      </button>
      <span role="status" className="sr-only">
        {armed ? confirmLabel : ""}
      </span>
    </>
  );
}

const btnBase =
  "flex items-center gap-1.5 rounded px-3.5 py-1.5 font-display text-[15px] uppercase leading-tight tracking-[0.06em] disabled:cursor-not-allowed disabled:opacity-50";
export const btn = `${btnBase} border border-rule-strong font-semibold text-cream hover:border-[#5a5850] hover:bg-raised`;
export const btnPrimary = `${btnBase} border border-hot bg-hot font-bold text-chassis hover:border-hot-hover hover:bg-hot-hover`;
/** Text-only button for Cancel and other quiet exits. */
export const btnQuiet = `${btnBase} font-semibold text-body hover:text-cream`;
export const input =
  "w-full rounded border border-rule-strong bg-chassis px-3 py-2 text-sm text-cream shadow-[inset_0_2px_3px_rgb(0_0_0/0.5)] placeholder:text-engrave focus:border-hot focus:outline-none";
export const sectionLabel = engrave;

/** The app's chassis: background, text color and font (the same values as
 * <body> in src/index.css). Every component is designed for it. Wrap a
 * screen in it. */
export function Theme({ children, className = "", padded = false }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div
      className={className}
      style={{
        background: "#0d0d0c",
        color: "#c9c5bb",
        colorScheme: "dark",
        fontFamily: '"IBM Plex Sans", -apple-system, "Segoe UI", sans-serif',
        fontSize: 14,
        padding: padded ? 16 : undefined,
      }}
    >
      {children}
    </div>
  );
}

/** The app's button. Secondary (outlined) by default; primary for the one main action on a screen; quiet for Cancel. */
export function Button({
  variant = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  const look = variant === "primary" ? btnPrimary : variant === "quiet" ? btnQuiet : btn;
  return <button {...props} className={`${look} ${className}`} />;
}

/** Text input with the app's recessed field styling. */
export function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${input} ${className}`} />;
}

/** A panel with an engraved title. `action` sits at the right of the title row. */
export function Card({ title, action, className = "", children }: { title: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded border border-rule bg-panel p-5 shadow-panel ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className={engrave}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Big figure with an icon and an engraved label. */
export function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded border border-rule bg-panel px-5 py-4 shadow-panel">
      <div className={`flex items-center gap-1.5 ${engrave}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 font-display text-5xl font-semibold leading-[0.9] tabular-nums text-cream">{value}</div>
    </div>
  );
}

/** Compact figure over an engraved label, for a row of hero figures. */
export function HeroStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="font-display text-4xl font-semibold leading-none tabular-nums text-cream">{value}</div>
      <div className={`mt-1 ${engrave}`}>{label}</div>
    </div>
  );
}

/** Boxed label/value pair. */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-rule bg-panel px-3 py-2 shadow-panel">
      <div className={engrave}>{label}</div>
      <div className="mt-1 text-[15px] font-medium text-cream">{value}</div>
    </div>
  );
}

/** Labelled block inside a side panel. */
export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <div className={`${sectionLabel} mb-2`}>{label}</div>
      {children}
    </section>
  );
}

/** Definition-list label/value (use inside a <dl>). */
export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className={engrave}>{label}</dt>
      <dd className="mt-1 text-cream">{value}</dd>
    </div>
  );
}

/** Filter chip. Selected is cream on black, never orange. */
export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.08em] ${
        active ? "border-cream bg-cream font-medium text-chassis" : "border-rule-strong text-body hover:bg-raised"
      }`}
    >
      {children}
    </button>
  );
}

/** On/off switch with an LED: lit orange when on. */
export function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2.5 rounded border border-rule-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] ${
        active ? "bg-raised text-cream" : "text-engrave hover:bg-raised"
      }`}
    >
      <StatusDot color={active ? "#ff5a1f" : "#3d3c37"} glow={active} />
      {children}
    </button>
  );
}

/** Initials on a small square key. */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded border border-rule-strong bg-raised font-display font-bold text-cream"
      style={{ width: size, height: size, fontSize: size * 0.46 }}
    >
      {initials}
    </span>
  );
}

/** Label, value/total and a segmented LED bar (green when complete). */
export function Meter({ label, value, total }: { label: string; value: number; total: number }) {
  // One segment per item up to 20, then scaled so the bar stays readable.
  const segments = Math.max(1, Math.min(total, 20));
  const lit = total ? Math.round((value / total) * segments) : 0;
  const color = total > 0 && value >= total ? "#3ddc84" : "#ff5a1f";
  return (
    <div>
      <div className="flex justify-between">
        <span className="text-body">{label}</span>
        <span className="font-mono tabular-nums text-cream">
          {value}/{total}
        </span>
      </div>
      <div
        className="mt-1.5 grid h-2 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${segments}, 1fr)` }}
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className="rounded-[1px]" style={{ background: i < lit ? color : "#2c2b27" }} />
        ))}
      </div>
    </div>
  );
}

/** Hexagon corners in a 100 × 86.6 box, scaled by `k` around the centre. */
function hex(k: number): string {
  const corners = [
    [25, 0],
    [75, 0],
    [100, 43.3],
    [75, 86.6],
    [25, 86.6],
    [0, 43.3],
  ];
  return corners.map(([x, y]) => `${50 + (x - 50) * k},${43.3 + (y - 43.3) * k}`).join(" L");
}

/** The Hivo mark: one hive cell with a lit LED (a song that's live).
 * `tone="light"` is for cream grounds: black outline, orange LED. At 32px
 * and below the outline gets heavier and the glow drops; at 16px it's a
 * solid cell with a dark centre so it still reads in a tab. `full` keeps
 * the large-size drawing at any size (the wordmark's cell). */
export function LogoMark({ size = 32, tone = "dark", full = false }: { size?: number; tone?: "dark" | "light"; full?: boolean }) {
  const ring = tone === "light" ? "#0d0d0c" : "#ff5a1f";
  if (size <= 16 && !full) {
    return (
      <svg aria-hidden width={size} height={size * 0.866} viewBox="0 0 100 86.6" className="shrink-0">
        <path d={`M${hex(1)}Z`} fill={ring} />
        <circle cx="50" cy="43.3" r="17" fill={tone === "light" ? "#f2efe8" : "#0d0d0c"} />
      </svg>
    );
  }
  const small = size <= 32 && !full;
  const led = small ? 12 : 8.5;
  return (
    <svg aria-hidden width={size} height={size * 0.866} viewBox="0 0 100 86.6" className="shrink-0 overflow-visible">
      <path d={`M${hex(1)}Z M${hex(small ? 0.68 : 0.8)}Z`} fill={ring} fillRule="evenodd" />
      <circle cx="50" cy="43.3" r={led} fill="#ff5a1f" style={small ? undefined : { filter: `drop-shadow(0 0 ${size * 0.08}px #ff5a1f)` }} />
    </svg>
  );
}

/** The wordmark: "Hiv" in Oswald with the hive cell standing in for the
 * "o". `size` is the cap height's font size in px. */
export function Wordmark({ size = 28, tone = "dark" }: { size?: number; tone?: "dark" | "light" }) {
  return (
    <span
      role="img"
      aria-label="Hivo"
      className="inline-flex shrink-0 items-end whitespace-nowrap font-semibold leading-none"
      style={{ fontFamily: '"Oswald", "Barlow Condensed", sans-serif', fontSize: size, letterSpacing: "-0.01em", color: tone === "light" ? "#0d0d0c" : "#f2efe8" }}
    >
      <span aria-hidden>Hiv</span>
      <span aria-hidden style={{ marginLeft: size * 0.04, marginBottom: size * 0.047 }}>
        <LogoMark size={size * 0.6} tone={tone} full />
      </span>
    </span>
  );
}
