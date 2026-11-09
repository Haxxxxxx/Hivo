import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import * as api from "../lib/tauri";
import { formatDateTime } from "../lib/format";
import type { FirewallState, PhoneConfirming, PhonePairing, PhoneSyncStatus } from "../types";
import { btnPrimary } from "../ui";
import { usePhoneInbox } from "../store/usePhoneInbox";
import { dict, tr } from "../i18n";
import { errorText, errorReason } from "../lib/errors";

const T = dict(
  {
    title: "Phone sync",
    intro:
      "Lets the Hivo phone app read your saved prods, beats and songs and write notes on them, over your local Wi-Fi only. Nothing goes through Hivo's server or any cloud.",
    toggle: "Let paired phones sync over this network",
    off: "Off: no port is open.",
    on: (port: number) => `On: listening on port ${port}.`,
    addresses: (list: string) => `This computer on the network: ${list}`,
    noAddress: "No local network address found. Connect this computer to Wi-Fi (or a local network) first.",
    firewall:
      "The first time it's on, macOS or Windows asks whether Hivo may accept incoming connections: allow it (private networks only on Windows), or the phone can't reach it.",
    pair: "Pair a phone",
    scan: "Scan this code with the Hivo phone app. It works once, for 5 minutes: show it only to your own phone.",
    expired: "This code expired (or was used). Show a new one if the phone didn't pair.",
    newCode: "Show a new code",
    pasteHint: "No camera (iOS Simulator)? Paste this link in the app instead:",
    copy: "Copy link",
    copied: "Copied",
    waiting: "Waiting for the phone…",
    connected: (name: string) => `Paired with ${name}.`,
    done: "Done",
    phones: "Paired phones",
    none: "No phone paired yet.",
    neverSeen: "Never connected",
    lastSeen: (when: string) => `Last seen ${when}`,
    forget: "Forget",
    repair: "Re-pair this phone",
    repairHint: "Shows a new QR for this phone: scan it with the Hivo phone app. Its old key stops working once the phone used it.",
    upgrade: "Paired with an older Hivo: re-pair it to upgrade its security (Hivo on the phone must be up to date).",
    needsQr: "This computer listens on a new port now: this phone needs the new QR. Re-pair it.",
    unnamed: "Phone",
    security:
      "Each phone gets its own key, made by the phone and this computer together when it pairs: the QR code only holds a one-time code, so a photo of it is useless afterwards. The key is kept on this computer in an owner-only file. Every request and answer is encrypted and signed with it; Forget deletes the key, and that phone can't sync any more. After the scan, the phone and this computer show the same 6-digit code: it works only once you confirm it here.",
    phoneOutdated: "Update Hivo on this phone: it's older than this computer's.",
    openFirewall: "Open the firewall settings",
    firewallWindows: "Phone says it's not on the same Wi-Fi? Windows Firewall may be blocking Hivo: allow it on private networks.",
    confirmTitle: "Check the code",
    confirmBody: (name: string) => `${name} scanned the code. Confirm only if your phone shows this same code: until then it can't sync.`,
    confirmRepair: "Once you confirm, this phone's old key stops working.",
    confirmYes: "Confirm",
    confirmNo: "Not my phone",
    confirmDropped: "Not confirmed within 5 minutes, the pairing is dropped.",
    fwTitle: "Windows is blocking your phone",
    fwBlocked: "Windows Firewall has a rule blocking Hivo, so your phone can't reach this computer.",
    fwNotAllowed: "Windows Firewall doesn't let Hivo accept connections on this network, so your phone can't reach this computer.",
    fwPublic: "This Wi-Fi is also marked Public: Fix it marks it Private (a home network). Do that only on your own Wi-Fi.",
    fwFix: "Fix it",
    fwFixing: "Fixing…",
    fwFixHint: "Windows asks for admin rights once.",
    fwFixed: "Fixed: your phone can reach Hivo now. Scan the code again if it gave up.",
    fwStill: "Still blocked after the fix: another firewall (antivirus) may be blocking Hivo. Allow it there, or in the firewall settings.",
    notFound: "No phone yet? Check that it's on the same Wi-Fi as this computer (not a guest network), and that the phone has no VPN on.",
  },
  {
    title: "Synchro téléphone",
    intro:
      "Permet à l'appli Hivo sur téléphone de lire tes prods enregistrées, les prods de tes dossiers et tes sons et d'y écrire des notes, uniquement par ton Wi-Fi local. Rien ne passe par le serveur de Hivo ni par un cloud.",
    toggle: "Autoriser les téléphones appairés à synchroniser sur ce réseau",
    off: "Désactivée : aucun port n'est ouvert.",
    on: (port: number) => `Activée : à l'écoute sur le port ${port}.`,
    addresses: (list: string) => `Cet ordi sur le réseau : ${list}`,
    noAddress: "Aucune adresse sur le réseau local. Connecte d'abord cet ordi au Wi-Fi (ou à un réseau local).",
    firewall:
      "La première fois, macOS ou Windows demande si Hivo peut accepter les connexions entrantes : autorise-le (réseaux privés seulement sous Windows), sinon le téléphone ne peut pas le joindre.",
    pair: "Appairer un téléphone",
    scan: "Scanne ce code avec l'appli Hivo sur ton téléphone. Il ne sert qu'une fois, pendant 5 minutes : ne le montre qu'à ton propre téléphone.",
    expired: "Ce code a expiré (ou a déjà servi). Affiches-en un nouveau si le téléphone n'est pas appairé.",
    newCode: "Afficher un nouveau code",
    pasteHint: "Pas de caméra (simulateur iOS) ? Colle plutôt ce lien dans l'appli :",
    copy: "Copier le lien",
    copied: "Copié",
    waiting: "En attente du téléphone…",
    connected: (name: string) => `Appairé avec ${name}.`,
    done: "Terminé",
    phones: "Téléphones appairés",
    none: "Aucun téléphone appairé.",
    neverSeen: "Jamais connecté",
    lastSeen: (when: string) => `Vu ${when}`,
    forget: "Oublier",
    repair: "Réappairer ce téléphone",
    repairHint: "Affiche un nouveau QR pour ce téléphone : scanne-le avec l'appli Hivo. Son ancienne clé ne marche plus dès que le téléphone l'a utilisé.",
    upgrade: "Appairé avec une ancienne version de Hivo : réappaire-le pour renforcer sa sécurité (Hivo doit être à jour sur le téléphone).",
    needsQr: "Cet ordi écoute maintenant sur un autre port : ce téléphone a besoin du nouveau QR. Réappaire-le.",
    unnamed: "Téléphone",
    security:
      "Chaque téléphone a sa propre clé, créée par le téléphone et cet ordi ensemble à l'appairage : le QR code ne contient qu'un code à usage unique, donc une photo ne sert plus à rien ensuite. La clé est gardée sur cet ordi dans un fichier réservé à ton compte. Chaque requête et chaque réponse sont chiffrées et signées avec ; Oublier supprime la clé, et ce téléphone ne peut plus synchroniser. Après le scan, le téléphone et cet ordi affichent le même code à 6 chiffres\u202f: il ne marche qu'une fois confirmé ici.",
    phoneOutdated: "Mets Hivo à jour sur ce téléphone : il est plus ancien que celui de cet ordi.",
    openFirewall: "Ouvrir les réglages du pare-feu",
    firewallWindows: "Le téléphone dit qu'il n'est pas sur le même Wi-Fi ? Le pare-feu Windows bloque peut-être Hivo : autorise-le sur les réseaux privés.",
    confirmTitle: "Vérifie le code",
    confirmBody: (name: string) => `${name} a scanné le code. Ne confirme que si ton téléphone affiche ce même code\u202f: d'ici là, il ne peut pas synchroniser.`,
    confirmRepair: "Dès que tu confirmes, l'ancienne clé de ce téléphone ne marche plus.",
    confirmYes: "Confirmer",
    confirmNo: "Pas mon téléphone",
    confirmDropped: "Sans confirmation dans les 5 minutes, l'appairage est abandonné.",
    fwTitle: "Windows bloque ton téléphone",
    fwBlocked: "Le pare-feu Windows a une règle qui bloque Hivo, donc ton téléphone ne peut pas joindre cet ordi.",
    fwNotAllowed: "Le pare-feu Windows n'autorise pas Hivo à recevoir des connexions sur ce réseau, donc ton téléphone ne peut pas joindre cet ordi.",
    fwPublic: "Ce Wi-Fi est aussi marqué Public\u202f: Réparer le marque Privé (un réseau domestique). Fais-le seulement sur ton propre Wi-Fi.",
    fwFix: "Réparer",
    fwFixing: "Réparation…",
    fwFixHint: "Windows demande les droits administrateur une fois.",
    fwFixed: "Réparé\u202f: ton téléphone peut joindre Hivo. Rescanne le code s'il a abandonné.",
    fwStill: "Toujours bloqué après la réparation\u202f: un autre pare-feu (antivirus) bloque peut-être Hivo. Autorise-le là-bas, ou dans les réglages du pare-feu.",
    notFound: "Toujours pas de téléphone\u202f? Vérifie qu'il est sur le même Wi-Fi que cet ordi (pas un réseau invité) et qu'il n'a pas de VPN activé.",
  },
);

/** Settings → Phone sync: on/off, pairing QR, paired phones (docs/PHONE-SYNC.md). */
export function PhoneSyncSettings() {
  const t = tr(T);
  const [status, setStatus] = useState<PhoneSyncStatus | null>(null);
  const [pairing, setPairing] = useState<(PhonePairing & { qr: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const windows = navigator.userAgent.includes("Windows");
  // Windows Firewall vs phone sync: checked when sync is on, and again when a QR gets no phone.
  const [fw, setFw] = useState<FirewallState | null>(null);
  const [fwBusy, setFwBusy] = useState(false);
  const [fwResult, setFwResult] = useState<"fixed" | "still" | null>(null);

  useEffect(() => {
    let live = true;
    api.phoneSyncStatus().then((s) => live && setStatus(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const confirming = status?.confirming ?? [];
  const waitingConfirm = confirming.length > 0;
  // While the QR is up or a phone waits for "Confirm", watch for the phone (and the timeout).
  useEffect(() => {
    if (!pairing && !waitingConfirm) return;
    const id = setInterval(() => {
      setNow(Date.now());
      api.phoneSyncStatus().then(setStatus).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [pairing, waitingConfirm]);

  const checkFirewall = useCallback(() => {
    if (!windows) return;
    api.phoneSyncFirewallCheck().then(setFw).catch(() => {});
  }, [windows]);

  async function fixFirewall() {
    setFwBusy(true);
    setError(null);
    setFwResult(null);
    try {
      const s = await api.phoneSyncFirewallFix();
      setFw(s);
      setFwResult(s.needsFix ? "still" : "fixed");
    } catch (e) {
      const msg = errorText(e);
      // "No" in the dialog or the admin prompt: nothing to say.
      if (msg !== api.PAIR_CANCELLED) setError(msg);
    } finally {
      setFwBusy(false);
    }
  }

  async function run(fn: () => Promise<PhoneSyncStatus>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      // The menu's Phone inbox entry follows phone sync being on / paired.
      void usePhoneInbox.getState().refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /** A new pairing, or (deviceId) a new QR for a paired phone, in place. */
  async function pair(deviceId?: string) {
    if (!status?.addresses.length) {
      setError(t.noAddress);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const p = deviceId ? await api.phoneSyncRepair(deviceId) : await api.phoneSyncPair();
      // Low error correction keeps the modules big; a 4-module quiet zone and a
      // 2x bitmap shown at 320 px (no smoothing) are what phone scanners need.
      const qr = await QRCode.toDataURL(p.url, { errorCorrectionLevel: "L", margin: 4, width: 640 });
      setPairing({ ...p, qr });
      setNow(Date.now());
      setCopied(false);
      setStatus(await api.phoneSyncStatus());
    } catch (e) {
      const msg = errorText(e);
      // "No" in the native confirmation: nothing to say.
      if (msg !== api.PAIR_CANCELLED) setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const on = !!status?.on;
  const paired = status?.devices ?? [];
  // Paired with this QR: stored (again, for a re-pair) since it was shown.
  const justPaired = pairing ? paired.find((d) => d.id === pairing.deviceId && d.lastSeenMs && d.pairedAtMs >= pairing.issuedAtMs) : undefined;
  // The phone of this QR scanned it and waits for "Confirm" (the QR is burnt).
  const waitingThis = pairing ? confirming.find((c) => c.id === pairing.deviceId) : undefined;
  const expired = !!pairing && !justPaired && !waitingThis && now > pairing.expiresAtMs;
  const others = confirming.filter((c) => c.id !== waitingThis?.id);
  // The QR has been up 20 s and no phone got through.
  const quiet = !!pairing && !justPaired && !waitingThis && !expired && now - pairing.issuedAtMs >= 20_000;

  useEffect(() => {
    if (on) checkFirewall();
    else setFw(null);
  }, [on, checkFirewall]);
  useEffect(() => {
    if (quiet) checkFirewall();
  }, [quiet, checkFirewall]);

  const confirmBlock = (c: PhoneConfirming) => (
    <div key={c.id} className="mt-3 rounded-lg border border-rule bg-raised p-4">
      <div className="text-xs font-semibold text-cream">{t.confirmTitle}</div>
      <p className="mt-1 text-xs leading-relaxed text-body">{t.confirmBody(c.name ?? t.unnamed)}</p>
      <div className="mt-3 font-mono text-3xl tracking-[0.2em] text-cream" aria-live="polite">
        {c.code.length === 6 ? `${c.code.slice(0, 3)} ${c.code.slice(3)}` : c.code}
      </div>
      {c.repair && <p className="mt-2 text-[11px] text-engrave">{t.confirmRepair}</p>}
      <p className="mt-2 text-[11px] text-engrave">{t.confirmDropped}</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void run(() => api.phoneSyncConfirm(c.id, true))}
          disabled={busy}
          className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40"
        >
          {t.confirmYes}
        </button>
        <button
          onClick={() => {
            // Its QR is burnt: nothing left to show in the pairing panel.
            if (pairing?.deviceId === c.id) setPairing(null);
            void run(() => api.phoneSyncConfirm(c.id, false));
          }}
          disabled={busy}
          className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised disabled:opacity-40"
        >
          {t.confirmNo}
        </button>
      </div>
    </div>
  );

  return (
    <section id="phone-sync">
      <h2 className="text-sm font-semibold text-cream">{t.title}</h2>
      <p className="mt-1 text-xs leading-relaxed text-engrave">{t.intro}</p>

      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-body">
        <input
          type="checkbox"
          checked={on}
          disabled={busy || !status}
          onChange={(e) => {
            setPairing(null);
            void run(() => api.phoneSyncEnable(e.target.checked));
          }}
          className="mt-0.5 accent-orange-500"
        />
        <span>{t.toggle}</span>
      </label>
      <div className={`mt-2 text-xs ${on ? "text-emerald-300" : "text-engrave"}`}>{on && status?.port ? t.on(status.port) : t.off}</div>
      {on && <div className="mt-1 font-mono text-[11px] text-engrave">{status?.addresses.length ? t.addresses(status.addresses.join(", ")) : t.noAddress}</div>}
      {status?.error && <div className="mt-2 text-xs text-red-300">{errorReason(status.error)}</div>}
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">{t.firewall}</p>
      {windows && on && fw?.needsFix ? (
        <div className="mt-3 rounded-lg border border-hot bg-panel p-3">
          <div className="text-xs font-semibold text-cream">{t.fwTitle}</div>
          <p className="mt-1 text-xs leading-relaxed text-body">
            {fw.blocked ? t.fwBlocked : t.fwNotAllowed}
            {fw.publicNetwork ? ` ${t.fwPublic}` : ""}
          </p>
          {fwResult === "still" && <p className="mt-1 text-xs leading-relaxed text-warn">{t.fwStill}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button onClick={() => void fixFirewall()} disabled={fwBusy} className={`${btnPrimary} disabled:opacity-40`}>
              {fwBusy ? t.fwFixing : t.fwFix}
            </button>
            <span className="text-[11px] text-engrave">{t.fwFixHint}</span>
            <button onClick={() => void api.phoneSyncOpenFirewall().catch((e) => setError(errorText(e)))} className="text-[11px] text-body underline hover:text-cream">
              {t.openFirewall}
            </button>
          </div>
        </div>
      ) : (
        windows &&
        on && (
          <p className="mt-1 text-[11px] leading-relaxed text-engrave">
            {t.firewallWindows}{" "}
            <button onClick={() => void api.phoneSyncOpenFirewall().catch((e) => setError(errorText(e)))} className="text-body underline hover:text-cream">
              {t.openFirewall}
            </button>
          </p>
        )
      )}
      {fwResult === "fixed" && on && <div className="mt-2 text-xs text-ok">{t.fwFixed}</div>}

      {on && !pairing && (
        <button onClick={() => void pair()} disabled={busy} className="mt-3 rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400 disabled:opacity-40">
          {t.pair}
        </button>
      )}

      {pairing && (
        <div className="mt-3 rounded-lg border border-rule bg-panel p-4">
          <p className="text-xs leading-relaxed text-body">{t.scan}</p>
          {waitingThis ? (
            confirmBlock(waitingThis)
          ) : expired ? (
            <div className="mt-3 text-xs text-warn">
              {t.expired}{" "}
              <button
                onClick={() => void pair(paired.some((d) => d.id === pairing.deviceId) ? pairing.deviceId : undefined)}
                disabled={busy}
                className="text-body underline hover:text-cream"
              >
                {t.newCode}
              </button>
            </div>
          ) : (
            <>
              <img src={pairing.qr} alt={t.pair} width={320} height={320} style={{ imageRendering: "pixelated" }} className="mt-3 rounded bg-white" />
              <p className="mt-3 text-[11px] text-engrave">{t.pasteHint}</p>
              <div className="mt-1 select-all break-all rounded border border-rule bg-raised p-2 font-mono text-[11px] text-body">{pairing.url}</div>
            </>
          )}
          <div className={`mt-2 text-xs ${justPaired ? "text-emerald-300" : "text-engrave"}`}>
            {justPaired ? t.connected(justPaired.name ?? t.unnamed) : expired || waitingThis ? null : t.waiting}
          </div>
          {quiet && !fw?.needsFix && <p className="mt-1 text-[11px] leading-relaxed text-engrave">{t.notFound}</p>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(pairing.url).then(() => setCopied(true));
              }}
              className="rounded-md border border-rule-strong px-3 py-2 text-sm text-body hover:bg-raised"
            >
              {copied ? t.copied : t.copy}
            </button>
            <button onClick={() => setPairing(null)} className="rounded-md bg-orange-500 px-3 py-2 text-sm font-medium text-chassis hover:bg-orange-400">
              {t.done}
            </button>
          </div>
        </div>
      )}

      {others.map(confirmBlock)}

      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}

      <h3 className="mt-4 text-xs font-semibold text-cream">{t.phones}</h3>
      {paired.length === 0 ? (
        <p className="mt-1 text-xs text-engrave">{t.none}</p>
      ) : (
        <ul className="mt-1 divide-y divide-rule rounded-lg border border-rule">
          {paired.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-cream">{d.name ?? t.waiting}</div>
                <div className="text-[11px] text-engrave">
                  {d.lastSeenMs ? t.lastSeen(formatDateTime(d.lastSeenMs)) : t.neverSeen}
                  {d.appVersion ? ` · ${d.appVersion}` : ""}
                </div>
                {d.needsNewQr && <div className="mt-0.5 text-[11px] text-warn">{t.needsQr}</div>}
                {d.phoneOutdated && <div className="mt-0.5 text-[11px] text-warn">{t.phoneOutdated}</div>}
                {d.legacyPairing && <div className="mt-0.5 text-[11px] text-warn">{t.upgrade}</div>}
              </div>
              {on && (
                <button
                  onClick={() => void pair(d.id)}
                  disabled={busy}
                  title={t.repairHint}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-xs disabled:opacity-40 ${d.needsNewQr || d.legacyPairing ? "bg-orange-500 font-medium text-chassis hover:bg-orange-400" : "border border-rule-strong text-body hover:bg-raised"}`}
                >
                  {t.repair}
                </button>
              )}
              <button
                onClick={() => {
                  if (pairing?.deviceId === d.id) setPairing(null);
                  void run(() => api.phoneSyncForget(d.id));
                }}
                disabled={busy}
                className="shrink-0 rounded-md border border-rule-strong px-3 py-1.5 text-xs text-body hover:bg-raised disabled:opacity-40"
              >
                {t.forget}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-engrave">{t.security}</p>
    </section>
  );
}
