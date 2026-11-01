import { useEffect, useState } from "react";
import { useWeb } from "./store";
import { W } from "./dashboardCopy";
import { locale, tr } from "@shared/i18n";

// The crew owner's tools on the website (the same calls as the desktop app;
// the server checks the owner again): invite codes, rename, delete. Leave
// and remove-member buttons are used from the Crew tab too.

const field =
  "rounded-lg border border-rule-strong bg-chassis px-3 py-2 text-sm text-cream placeholder:text-engrave focus:border-hot focus:outline-none";
const quiet = "rounded border border-rule-strong px-3 py-1.5 text-sm text-body hover:bg-raised hover:text-cream disabled:opacity-40";
const alertBox = "rounded-md border border-missing/30 bg-missing/10 px-3 py-2 text-sm text-cream";

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** A button that asks "click again" first (and forgets after 4 s). */
function TwoClick({ label, armedLabel, onConfirm, disabled }: { label: string; armedLabel: string; onConfirm: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      disabled={disabled}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      className={`text-xs disabled:opacity-40 ${armed ? "text-missing" : "text-engrave hover:text-cream"}`}
    >
      {armed ? armedLabel : label}
    </button>
  );
}

/** Owner: remove a crewmate (their shared songs leave with them). */
export function RemoveMember({ userId, name }: { userId: string; name: string }) {
  const removeMember = useWeb((s) => s.removeMember);
  const { busy, error, run } = useRun();
  return (
    <span className="flex flex-col items-end gap-1">
      <TwoClick label={tr(W).remove} armedLabel={tr(W).removeConfirm(name)} disabled={busy} onConfirm={() => void run(() => removeMember(userId))} />
      {error && <span className="text-xs text-missing">{error}</span>}
    </span>
  );
}

/** Owner: make a crewmate the owner (you become a member). */
export function MakeOwner({ userId, name }: { userId: string; name: string }) {
  const transferOwnership = useWeb((s) => s.transferOwnership);
  const { busy, error, run } = useRun();
  return (
    <span className="flex flex-col items-end gap-1">
      <TwoClick label={tr(W).makeOwner} armedLabel={tr(W).makeOwnerConfirm(name)} disabled={busy} onConfirm={() => void run(() => transferOwnership(userId))} />
      {error && <span className="text-xs text-red-300">{error}</span>}
    </span>
  );
}

/** Anyone: leave the active crew. */
export function LeaveCrew() {
  const leaveCrew = useWeb((s) => s.leaveCrew);
  const { busy, error, run } = useRun();
  return (
    <div className="flex flex-col items-start gap-1">
      <TwoClick label={tr(W).leave} armedLabel={tr(W).leaveConfirm} disabled={busy} onConfirm={() => void run(leaveCrew)} />
      <span className="text-xs text-engrave">{tr(W).leaveNote}</span>
      {error && <div role="alert" className={alertBox}>{error}</div>}
    </div>
  );
}

function InviteCodes() {
  const { invites, loadInvites, createInvite, revokeInvite, activeCrewId } = useWeb();
  const { busy, error, run } = useRun();
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void run(loadInvites);
    // Reload when the crew changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCrewId]);
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 2000);
    } catch {
      /* the code is on screen to copy by hand */
    }
  };
  const until = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short" });
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-cream">{tr(W).invitesTitle}</h3>
      <p className="text-xs text-engrave">{tr(W).invitesHelp}</p>
      {invites.length === 0 ? (
        <p className="text-xs text-body">{tr(W).noInvites}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {invites.map((i) => (
            <li key={i.code} className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-raised px-3 py-2">
              <span className="font-mono text-base tracking-[0.2em] text-cream">{i.code}</span>
              <span className="text-xs text-engrave">{tr(W).inviteLine(i.uses, i.max_uses, until(i.expires_at))}</span>
              <span className="ml-auto flex items-center gap-3">
                <button onClick={() => void copy(i.code)} className="text-xs text-body hover:text-cream">
                  {copied === i.code ? tr(W).copied : tr(W).copy}
                </button>
                <button onClick={() => void run(() => revokeInvite(i.code))} disabled={busy} className="text-xs text-engrave hover:text-cream disabled:opacity-40">
                  {tr(W).revoke}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => void run(createInvite)} disabled={busy} className={`${quiet} self-start`}>
        {tr(W).newInvite}
      </button>
      {error && <div role="alert" className={alertBox}>{error}</div>}
    </section>
  );
}

function RenameCrew({ current }: { current: string }) {
  const renameCrew = useWeb((s) => s.renameCrew);
  const [name, setName] = useState(current);
  const { busy, error, run } = useRun();
  useEffect(() => setName(current), [current]);
  const changed = name.trim() && name.trim() !== current;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-cream">{tr(W).renameTitle}</h3>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void run(() => renameCrew(name));
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label={tr(W).renameTitle} className={`${field} w-64`} />
        <button type="submit" disabled={!changed || busy} className={quiet}>
          {tr(W).save}
        </button>
      </form>
      {error && <div role="alert" className={alertBox}>{error}</div>}
    </section>
  );
}

function DeleteCrew({ name }: { name: string }) {
  const deleteCrew = useWeb((s) => s.deleteCrew);
  const members = useWeb((s) => s.members.length);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const { busy, error, run } = useRun();
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  return (
    <section className="flex flex-col gap-2 rounded-md border border-missing/40 p-4">
      <h3 className="text-sm font-medium text-cream">{tr(W).deleteTitle}</h3>
      <p className="text-xs text-body">{tr(W).deleteWhat(name, Math.max(members, 1))}</p>
      {!open ? (
        <button onClick={() => setOpen(true)} className={`${quiet} self-start`}>
          {tr(W).deleteStart}
        </button>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) void run(() => deleteCrew(typed));
          }}
        >
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={tr(W).deleteType(name)}
            aria-label={tr(W).deleteType(name)}
            disabled={busy}
            className={`${field} w-64`}
          />
          <button type="submit" disabled={!matches || busy} className="rounded border border-missing/60 bg-missing/15 px-3 py-1.5 text-sm text-cream hover:bg-missing/25 disabled:opacity-40">
            {busy ? tr(W).deleting : tr(W).deleteConfirm}
          </button>
          <button type="button" disabled={busy} onClick={() => (setOpen(false), setTyped(""))} className="text-xs text-engrave hover:text-cream">
            {tr(W).cancel}
          </button>
        </form>
      )}
      {error && <div role="alert" className={alertBox}>{error}</div>}
    </section>
  );
}

/** The owner's section of the Crew tab. */
export function OwnerTools() {
  const crew = useWeb((s) => s.crews.find((c) => c.id === s.activeCrewId));
  if (!crew || crew.role !== "owner") return null;
  return (
    <div className="flex flex-col gap-5 rounded-xl border border-rule bg-panel p-4">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-engrave">{tr(W).ownerTools}</div>
      <InviteCodes />
      <RenameCrew current={crew.name} />
      <DeleteCrew name={crew.name} />
    </div>
  );
}
