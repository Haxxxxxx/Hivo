import { Mic } from "lucide-react";
import { audioSrc } from "../lib/tauri";
import { formatDateTime } from "../lib/format";
import { duration } from "../lib/phoneInbox";
import { isSketchAudioName } from "../lib/sketch";
import type { InboxItem } from "../types";
import { engrave } from "../ui";
import { dict, tr } from "../i18n";

// Voice memos from the phone, where they were filed: a song's drawer (the
// copies in its "Voice memos" folder) or a beat's / saved prod's notes panel.
// Plays the inbox's copy (the asset protocol allows the inbox folder).

const T = dict(
  { title: "Voice memos from the phone", missing: "file missing" },
  { title: "Mémos vocaux du téléphone", missing: "fichier manquant" },
);

export function PhoneMemos({ memos }: { memos: InboxItem[] }) {
  const t = tr(T);
  if (memos.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className={`flex items-center gap-1.5 ${engrave}`}>
        <Mic size={12} /> {t.title}
      </div>
      {memos.map((m) => {
        const inInbox = m.files.find((f) => isSketchAudioName(f.name));
        // The inbox's file, else the durable copy of a memo linked to a beat/prod.
        const file = inInbox && !inInbox.missing ? inInbox : m.copiedTo ? { path: m.copiedTo, name: inInbox?.name ?? "", missing: false } : inInbox;
        return (
          <div key={m.id} className="flex flex-col gap-1 rounded border border-rule bg-chassis px-2.5 py-2">
            <div className="flex items-baseline gap-2 text-sm">
              <span className="truncate text-cream">{m.title || file?.name || "Memo"}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-engrave">
                {duration(m.durationMs)} {formatDateTime(m.createdAt)}
              </span>
            </div>
            {file && !file.missing ? (
              <audio controls preload="none" src={audioSrc(file.path)} className="h-8 w-full" />
            ) : (
              <span className="text-xs text-missing">{t.missing}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
