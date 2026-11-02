import { currentLang, dict, locale, plural, tr } from "../i18n";

const T = dict(
  {
    trash: navigator.userAgent.includes("Mac") ? "Trash" : "Recycle Bin",
    units: "B KB MB GB",
    today: "today",
    yesterday: "yesterday",
    tomorrow: "tomorrow",
    todayAt: (time: string) => `Today ${time}`,
    ago: (n: number, unit: "day" | "week" | "month") => `${n} ${unit}${plural(n, "", "s")} ago`,
    inTime: (n: number, unit: "day" | "week" | "month") => `in ${n} ${unit}${plural(n, "", "s")}`,
  },
  {
    trash: "Corbeille",
    units: "o Ko Mo Go",
    today: "aujourd'hui",
    yesterday: "hier",
    tomorrow: "demain",
    todayAt: (time: string) => `Aujourd'hui ${time}`,
    ago: (n: number, unit: "day" | "week" | "month") => `il y a ${n} ${frUnit(n, unit)}`,
    inTime: (n: number, unit: "day" | "week" | "month") => `dans ${n} ${frUnit(n, unit)}`,
  },
);

function frUnit(n: number, unit: "day" | "week" | "month"): string {
  if (unit === "month") return "mois";
  const word = unit === "day" ? "jour" : "semaine";
  return plural(n, word, `${word}s`, "fr");
}

/** What the OS calls the place deleted files go. */
export function trashName(): string {
  return tr(T).trash;
}

export function formatBytes(bytes: number): string {
  const units = tr(T).units.split(" ");
  if (bytes === 0) return `0 ${units[0]}`;
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const n = value.toFixed(i === 0 ? 0 : 1);
  return `${currentLang() === "fr" ? n.replace(".", ",") : n} ${units[i]}`;
}

export function formatDateTime(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const time = date.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? tr(T).todayAt(time) : `${formatDate(ms)}, ${time}`;
}

/** "3 days ago", "in 5 weeks" (or French): release countdowns and recency. */
export function formatRelative(ms: number, now = Date.now()): string {
  // Calendar days, not 24-hour blocks: 23:50 yesterday is "yesterday" at 00:10.
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;
  };
  const days = Math.round(day(ms) - day(now));
  const abs = Math.abs(days);
  if (abs < 1) return tr(T).today;
  if (days === -1) return tr(T).yesterday;
  if (days === 1) return tr(T).tomorrow;
  const [n, unit]: [number, "day" | "week" | "month"] =
    abs < 14 ? [abs, "day"] : abs < 60 ? [Math.round(abs / 7), "week"] : [Math.round(abs / 30), "month"];
  return days < 0 ? tr(T).ago(n, unit) : tr(T).inTime(n, unit);
}

export function formatDate(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(locale(), {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(locale(), {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
