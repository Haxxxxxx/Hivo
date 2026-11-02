import { statusInfo } from "../lib/songs";
import { useEffect, useState } from "react";
import { Check, ClipboardCopy, LogOut, RefreshCw, Users } from "lucide-react";
import { useCrewStore, type ShareResult } from "../store/useCrewStore";
import { useAppStore } from "../store/useAppStore";
import { formatRelative } from "../lib/format";
import { canMoveShare, myServerShares, nameOf, orphanedShares, pushLimitNote, releaseSharedHere, shareElsewhere, sharedHere, sharedTitle, shareLimitNote, syncNote, unsharedTracks } from "../lib/crewSync";
import { StatusDot } from "./ui";
import { btn, btnPrimary, ConfirmButton, input } from "../ui";
import { crewText, inviteMessage } from "../lib/crewMessages";
import { cleanCode, isCodeComplete } from "../lib/signInCode";
import { dict, locale, tr } from "../i18n";

const field = input;
const primary = `${btnPrimary} shrink-0 justify-center py-2`;
const secondary = `${btn} shrink-0 justify-center py-2`;

const plural = (n: number) => (n === 1 ? "" : "s");

const T = dict(
  {
    privacy:
      'Share chosen songs with your crew: everyone sees them on the crew board, the calendar and in "who\'s on what". For each shared song the crew sees its title, stage, BPM, key, tags, credits, release date, whether it has a mixdown and whether it\'s up to date, whether its Launch Kit is accepted, and when the project was last saved. They also see your crew and display names (not your email, which only the sign-in service keeps). Never audio, file paths, samples, notes or track names. Stored in the EU (Ireland).',
    notConfigured: "Crew sharing isn't set up in this build (no crew server configured).",
    loading: "Loading…",
    loadFailed: (error: string) => `Couldn't load your crews: ${error}`,
    tryAgain: "Try again",
    yourEmail: "Your email",
    sending: "Sending…",
    sendCode: "Send code",
    sentTo: "We sent a sign-in code to",
    expiresIn: ". It expires in 10 minutes.",
    codeLabel: "Sign-in code",
    checking: "Checking…",
    signIn: "Sign in",
    otherEmail: "Use another email",
    yourName: "Your name in the crew (your artist name)",
    namePlaceholder: "e.g. Milo",
    joinTitle: "Join a crew",
    invitePlaceholder: "INVITE CODE",
    inviteLabel: "Invite code",
    join: "Join",
    createTitle: "Create a crew",
    crewName: "Crew name",
    create: "Create",
    signOut: "Sign out",
    syncing: "Syncing…",
    justNow: "just now",
    synced: (when: string) => `Synced ${when}`,
    refused: (n: number) => ` · ${n} song${plural(n)} refused by the server`,
    notSynced: "Not synced yet",
    owner: "Owner",
    member: "Member",
    syncNow: "Sync now",
    youShare: "You share",
    songsShared: (n: number) => ` song${plural(n)}. Share songs from their panel, or select several in the Library.`,
    orphans: (n: number) =>
      `${n} shared song${n === 1 ? " isn't" : "s aren't"} in your library right now (renamed, moved or on an unplugged drive), so ${n === 1 ? "its" : "their"} crew card is frozen.`,
    stopSharingThem: (n: number) => `Stop sharing ${n === 1 ? "it" : "them"}`,
    members: (n: number) => `Members · ${n}`,
    ownerTag: "· owner",
    youTag: "· you",
    remove: "Remove",
    removeConfirm: (name: string) => `Remove ${name}?`,
    removeNote: "Removing someone takes their shared songs off the crew board.",
    openInvites: (n: number) => `Open invite codes · ${n}`,
    used: (uses: number, max: number) => `${uses}/${max} used`,
    expires: (date: string) => `expires ${date}`,
    revoke: "Revoke",
    revokeConfirm: "Revoke code?",
    newInvite: "New invite code",
    copied: "Copied",
    copy: "Copy",
    copyMessage: "Copy invite message",
    messageCopied: "Message copied",
    inviteValid: "Valid 7 days, up to 10 people.",
    inviteListNote: "They also need their email added to the crew's sign-in list first (Supabase dashboard → Authentication → Users).",
    becomesOwner: (name: string) => ` ${name} becomes the owner.`,
    lastMember: " You're the last member, so the crew is deleted.",
    leaveConfirm: (crew: string, note: string) => `Leave ${crew}? Your shared songs leave the crew board with you.${note}`,
    leaveCrew: "Leave crew",
    another: "Join or create another crew",
    cancel: "Cancel",
    maxCrews: "You're in 10 crews, the most allowed. Leave one first.",
    tracksElsewhere: (n: number) =>
      `${n} track${n === 1 ? " is" : "s are"} shared with another crew, so ${n === 1 ? "it stays" : "they stay"} there.`,
    releaseElsewhere: "Shared with another crew or account.",
    releaseShared: (crew: string, shared: number, total: number) => `Shared with ${crew} · ${shared}/${total} tracks`,
    shareOthers: (n: number) => `Share the ${n} other track${plural(n)}`,
    stopSharing: "Stop sharing",
    stopRelease: "Stop sharing the release?",
    releaseLeft: "The release leaves the crew's list. Its tracks stay shared.",
    shareWith: "Share with",
    sharesRelease: (n: number) => `Shares the release and its ${n} track${plural(n)}.`,
    otherAccount: "Shared from another account on this computer. Sign in with it to change this.",
    sharedWith: "Shared with",
    formerCrew: "a crew you're no longer in",
    moveTo: ". Move it to",
    question: "?",
    moveHere: "Move here",
    takeOff: (crew: string) => `Take it off ${crew}?`,
    moveIt: "Move it?",
    onBoard: "On the crew board",
    onlyYou: "Only you see it",
    shareNote: "Shares title, stage, BPM, key, tags, credits and dates. Never audio, file paths or notes.",
    seesAs: "Crew sees it as",
    titleLabel: "Title the crew sees",
    movedTo: " moved this song to ",
    whileYours: " on the crew board while your move to ",
    whichStands: " was waiting to be sent. Which one stands?",
    keep: (stage: string) => `Keep ${stage}`,
    removedFrom: (crew: string) =>
      `You're no longer in ${crew}: you were removed, or the crew was deleted. Your songs aren't shared with it any more, so rejoining never shares them again by itself.`,
    aCrew: "a crew",
    ok: "OK",
    serverTitle: (n: number) => `Your songs on the server · ${n}`,
    serverHelp:
      "Your rows on this crew's board. The ones this computer doesn't know come from another computer or an earlier install: remove the ones nobody shares any more (a computer that still shares a song puts it back).",
    notHere: (n: number) => ` · ${n} not on this computer`,
    show: "Show",
    hide: "Hide",
    here: "this computer",
    elsewhereRow: "not on this computer",
    duplicate: "same title as another row not on this computer: maybe a duplicate",
    removeRow: "Remove",
    removeRowConfirm: "Remove from the board?",
    nowOwner: (crew: string) => `You now own ${crew}: invites, columns and the crew's settings are yours.`,
    moveShare: "Move the share to…",
    moveShareHelp: "Saved it under a new name (FL Save As, a new version)? Move the crew card to that song: same card, column and place. This song stops being shared.",
    moveShareTo: "Move to",
    moveShareConfirm: "Move the card?",
    moveShareNone: "No other song without a share of its own.",
    pickSong: "Pick a song",
    moveShareOffer: (name: string) => `This song is on the crew board. Move its card to ${name}?`,
    moveShareDone: "Card moved.",
    movedByLine: (stage: string, who: string, when: string) => `Moved to ${stage} by ${who}, ${when}.`,
    makeOwner: "Make owner",
    makeOwnerConfirm: (name: string) => `Make ${name} the owner?`,
    makeOwnerNote: "Making someone the owner hands them invites, columns and the crew's settings; you become a member.",
    crewNameLabel: "Crew name",
    yourNameLabel: "Your name in the crew",
    save: "Save",
  },
  {
    privacy:
      "Partage les sons de ton choix avec ton crew : tout le monde les voit sur le tableau du crew, dans le calendrier et dans « qui bosse sur quoi ». Pour chaque son partagé, le crew voit son titre, son étape, son BPM, sa tonalité, ses tags, ses crédits, sa date de sortie, s'il a un mixdown et s'il est à jour, si son Launch Kit est validé, et quand le projet a été enregistré pour la dernière fois. Il voit aussi le nom du crew et ton nom affiché (pas ton email, que seul le service de connexion garde). Jamais d'audio, de chemins de fichiers, de samples, de notes ni de noms de pistes. Stocké dans l'UE (Irlande).",
    notConfigured: "Le partage en crew n'est pas activé dans cette version (aucun serveur de crew configuré).",
    loading: "Chargement…",
    loadFailed: (error: string) => `Impossible de charger tes crews : ${error}`,
    tryAgain: "Réessayer",
    yourEmail: "Ton email",
    sending: "Envoi…",
    sendCode: "Envoyer le code",
    sentTo: "On a envoyé un code de connexion à",
    expiresIn: ". Il expire dans 10 minutes.",
    codeLabel: "Code de connexion",
    checking: "Vérification…",
    signIn: "Se connecter",
    otherEmail: "Utiliser un autre email",
    yourName: "Ton nom dans le crew (ton nom d'artiste)",
    namePlaceholder: "ex. Milo",
    joinTitle: "Rejoindre un crew",
    invitePlaceholder: "CODE D'INVITATION",
    inviteLabel: "Code d'invitation",
    join: "Rejoindre",
    createTitle: "Créer un crew",
    crewName: "Nom du crew",
    create: "Créer",
    signOut: "Se déconnecter",
    syncing: "Synchro…",
    justNow: "à l'instant",
    synced: (when: string) => `Synchronisé ${when}`,
    refused: (n: number) => ` · ${n} son${plural(n)} refusé${plural(n)} par le serveur`,
    notSynced: "Pas encore synchronisé",
    owner: "Propriétaire",
    member: "Membre",
    syncNow: "Synchroniser maintenant",
    youShare: "Tu partages",
    songsShared: (n: number) => ` son${plural(n)}. Partage des sons depuis leur panneau, ou sélectionnes-en plusieurs dans la Bibliothèque.`,
    orphans: (n: number) =>
      n === 1
        ? "1 son partagé n'est pas dans ta bibliothèque en ce moment (renommé, déplacé ou sur un disque débranché), donc sa carte dans le crew est figée."
        : `${n} sons partagés ne sont pas dans ta bibliothèque en ce moment (renommés, déplacés ou sur un disque débranché), donc leurs cartes dans le crew sont figées.`,
    stopSharingThem: (n: number) => (n === 1 ? "Ne plus le partager" : "Ne plus les partager"),
    members: (n: number) => `Membres · ${n}`,
    ownerTag: "· propriétaire",
    youTag: "· toi",
    remove: "Retirer",
    removeConfirm: (name: string) => `Retirer ${name} ?`,
    removeNote: "Retirer quelqu'un enlève ses sons partagés du tableau du crew.",
    openInvites: (n: number) => `Codes d'invitation actifs · ${n}`,
    used: (uses: number, max: number) => `${uses}/${max} utilisé${plural(uses)}`,
    expires: (date: string) => `expire le ${date}`,
    revoke: "Révoquer",
    revokeConfirm: "Révoquer le code ?",
    newInvite: "Nouveau code d'invitation",
    copied: "Copié",
    copy: "Copier",
    copyMessage: "Copier le message d'invitation",
    messageCopied: "Message copié",
    inviteValid: "Valable 7 jours, jusqu'à 10 personnes.",
    inviteListNote: "Il faut aussi d'abord ajouter leur email à la liste de connexion du crew (tableau de bord Supabase → Authentication → Users).",
    becomesOwner: (name: string) => ` ${name} devient propriétaire.`,
    lastMember: " Tu es le dernier membre, donc le crew sera supprimé.",
    leaveConfirm: (crew: string, note: string) => `Quitter ${crew} ? Tes sons partagés quittent le tableau du crew avec toi.${note}`,
    leaveCrew: "Quitter le crew",
    another: "Rejoindre ou créer un autre crew",
    cancel: "Annuler",
    maxCrews: "Tu es dans 10 crews, le maximum. Quittes-en un d'abord.",
    tracksElsewhere: (n: number) =>
      n === 1
        ? "1 morceau est partagé avec un autre crew, donc il y reste."
        : `${n} morceaux sont partagés avec un autre crew, donc ils y restent.`,
    releaseElsewhere: "Partagée avec un autre crew ou un autre compte.",
    releaseShared: (crew: string, shared: number, total: number) => `Partagée avec ${crew} · ${shared}/${total} morceaux`,
    shareOthers: (n: number) => (n === 1 ? "Partager le morceau restant" : `Partager les ${n} autres morceaux`),
    stopSharing: "Ne plus partager",
    stopRelease: "Ne plus partager la sortie ?",
    releaseLeft: "La sortie quitte la liste du crew. Ses morceaux restent partagés.",
    shareWith: "Partager avec",
    sharesRelease: (n: number) => (n === 1 ? "Partage la sortie et son morceau." : `Partage la sortie et ses ${n} morceaux.`),
    otherAccount: "Partagé depuis un autre compte sur cet ordi. Connecte-toi avec ce compte pour changer ça.",
    sharedWith: "Partagé avec",
    formerCrew: "un crew dont tu ne fais plus partie",
    moveTo: ". Le déplacer vers",
    question: " ?",
    moveHere: "Déplacer ici",
    takeOff: (crew: string) => `Le retirer de ${crew} ?`,
    moveIt: "Le déplacer ?",
    onBoard: "Sur le tableau du crew",
    onlyYou: "Toi seul le vois",
    shareNote: "Partage le titre, l'étape, le BPM, la tonalité, les tags, les crédits et les dates. Jamais d'audio, de chemins de fichiers ni de notes.",
    seesAs: "Le crew le voit comme",
    titleLabel: "Titre que voit le crew",
    movedTo: " a déplacé ce son dans ",
    whileYours: " sur le tableau du crew pendant que ton déplacement vers ",
    whichStands: " attendait d'être envoyé. Lequel on garde ?",
    keep: (stage: string) => `Garder ${stage}`,
    removedFrom: (crew: string) =>
      `Tu ne fais plus partie de ${crew}\u202f: tu as été retiré, ou le crew a été supprimé. Tes sons n'y sont plus partagés, donc rejoindre le crew ne les repartage jamais tout seul.`,
    aCrew: "un crew",
    ok: "OK",
    serverTitle: (n: number) => `Tes sons sur le serveur · ${n}`,
    serverHelp:
      "Tes lignes sur le tableau de ce crew. Celles que cet ordi ne connaît pas viennent d'un autre ordi ou d'une ancienne installation\u202f: retire celles que plus personne ne partage (un ordi qui partage encore un son le remet).",
    notHere: (n: number) => ` · ${n} pas sur cet ordi`,
    show: "Afficher",
    hide: "Masquer",
    here: "cet ordi",
    elsewhereRow: "pas sur cet ordi",
    duplicate: "même titre qu'une autre ligne absente de cet ordi\u202f: peut-être un doublon",
    removeRow: "Retirer",
    removeRowConfirm: "Retirer du tableau\u202f?",
    nowOwner: (crew: string) => `Tu es maintenant propriétaire de ${crew}\u202f: les invitations, les colonnes et les réglages du crew sont à toi.`,
    moveShare: "Déplacer le partage vers…",
    moveShareHelp: "Tu l'as enregistré sous un autre nom (Enregistrer sous dans FL, une nouvelle version)\u202f? Déplace la carte du crew vers ce son\u202f: même carte, même colonne, même place. Ce son n'est plus partagé.",
    moveShareTo: "Déplacer vers",
    moveShareConfirm: "Déplacer la carte\u202f?",
    moveShareNone: "Aucun autre son sans partage à lui.",
    pickSong: "Choisis un son",
    moveShareOffer: (name: string) => `Ce son est sur le tableau du crew. Déplacer sa carte vers ${name}\u202f?`,
    moveShareDone: "Carte déplacée.",
    movedByLine: (stage: string, who: string, when: string) => `Déplacé dans ${stage} par ${who}, ${when}.`,
    makeOwner: "Nommer propriétaire",
    makeOwnerConfirm: (name: string) => `Nommer ${name} propriétaire\u202f?`,
    makeOwnerNote: "Nommer quelqu'un propriétaire lui passe les invitations, les colonnes et les réglages du crew\u202f; tu deviens membre.",
    crewNameLabel: "Nom du crew",
    yourNameLabel: "Ton nom dans le crew",
    save: "Enregistrer",
  },
);

/** Settings → Crew: sign in, create or join a crew, invite, sync. */
export function CrewPanel() {
  const crew = useCrewStore();
  const t = tr(T);
  return (
    <section>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-cream">
        <Users size={15} /> Crew
      </h2>
      <p className="mt-1 text-xs text-engrave">{t.privacy}</p>
      <RemovedNotice />
      <div className="mt-3">
        {!crew.enabled ? (
          <div className="text-xs text-body">{t.notConfigured}</div>
        ) : !crew.ready ? (
          <div className="text-xs text-body">{t.loading}</div>
        ) : !crew.userId ? (
          <SignIn />
        ) : crew.crews.length === 0 && crew.loadError ? (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-red-300">{t.loadFailed(crew.loadError)}</span>
            <button onClick={() => void crew.loadCrews().catch(() => {})} className={secondary}>
              {t.tryAgain}
            </button>
          </div>
        ) : crew.crews.length === 0 ? (
          <CreateOrJoin />
        ) : (
          <CrewHome />
        )}
      </div>
    </section>
  );
}

/** Once: "you're no longer in <crew>" (removed, or the crew was deleted). */
export function RemovedNotice({ floating = false }: { floating?: boolean }) {
  const removedFrom = useCrewStore((s) => s.removedFrom);
  const nowOwnerOf = useCrewStore((s) => s.nowOwnerOf);
  const dismissRemoved = useCrewStore((s) => s.dismissRemoved);
  const dismissOwner = useCrewStore((s) => s.dismissOwnerNotice);
  if (!removedFrom.length && !nowOwnerOf.length) return null;
  const t = tr(T);
  const dismiss = () => (dismissRemoved(), dismissOwner());
  return (
    <div
      role="status"
      className={`flex flex-col gap-1 rounded-md border border-warn/30 px-3 py-2 text-xs text-cream ${floating ? "max-w-sm bg-panel shadow-xl" : "mt-3 bg-warn/10"}`}
    >
      {removedFrom.map((name, i) => (
        <span key={i}>{t.removedFrom(name || t.aCrew)}</span>
      ))}
      {nowOwnerOf.map((name, i) => (
        <span key={`o${i}`}>{t.nowOwner(name)}</span>
      ))}
      <button onClick={dismiss} className="self-start underline hover:text-cream">
        {t.ok}
      </button>
    </div>
  );
}

function useAction() {
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

function SignIn() {
  const sendCode = useCrewStore((s) => s.sendCode);
  const verifyCode = useCrewStore((s) => s.verifyCode);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const t = tr(T);

  return (
    <div className="flex flex-col gap-2">
      {!sentTo ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => sendCode(email)).then((ok) => ok && setSentTo(email.trim()));
          }}
          className="flex gap-2"
        >
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t.yourEmail} autoComplete="email" className={field} />
          <button type="submit" disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())} className={primary}>
            {busy ? t.sending : t.sendCode}
          </button>
        </form>
      ) : null}
      {!sentTo ? (
        <div className="text-[11px] text-engrave">{crewText("signInHint")}</div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => verifyCode(sentTo, code));
          }}
          className="flex flex-col gap-2"
        >
          <div className="text-xs text-engrave">
            {t.sentTo} <b className="text-cream">{sentTo}</b>
            {t.expiresIn}
          </div>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(cleanCode(e.target.value))}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label={t.codeLabel}
              className={`${field} font-mono tracking-[0.3em]`}
            />
            <button type="submit" disabled={busy || !isCodeComplete(code)} className={primary}>
              {busy ? t.checking : t.signIn}
            </button>
          </div>
          <button type="button" onClick={() => (setSentTo(null), setCode(""))} className="self-start text-xs text-engrave hover:text-cream">
            {t.otherEmail}
          </button>
        </form>
      )}
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}

/** Same limits as the database checks (crews.name, crew_members.display_name). */
const CREW_NAME_MAX = 80;
const DISPLAY_NAME_MAX = 60;
/** create_crew / join_crew refuse an 11th crew. */
const MAX_CREWS = 10;

/** First crew, or (`another`) one more next to the crews I'm already in. */
function CreateOrJoin({ another = false, onDone }: { another?: boolean; onDone?: () => void }) {
  const createCrew = useCrewStore((s) => s.createCrew);
  const joinCrew = useCrewStore((s) => s.joinCrew);
  const signOut = useCrewStore((s) => s.signOut);
  const email = useCrewStore((s) => s.email);
  const lastName = useCrewStore((s) => s.crews.find((c) => c.id === s.activeCrewId)?.displayName ?? "");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState(another ? lastName : "");
  const [code, setCode] = useState("");
  const { busy, error, run } = useAction();
  const done = (ok: boolean) => ok && onDone?.();
  const t = tr(T);

  return (
    <div className="flex flex-col gap-3">
      {!another && (
        <div className="flex flex-col gap-1 text-xs text-engrave" role="status">
          <span className="text-body">{crewText("noCrew", undefined, { email: email ?? "" })}</span>
          <span>{crewText("noInviteYet")}</span>
        </div>
      )}
      <label className="text-xs text-engrave">
        {t.yourName}
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={DISPLAY_NAME_MAX}
          placeholder={t.namePlaceholder}
          className={`${field} mt-1`}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => joinCrew(code, displayName)).then(done);
          }}
          className="flex flex-col gap-2 rounded-md border border-rule p-3"
        >
          <span className="text-xs font-medium text-body">{t.joinTitle}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
            placeholder={t.invitePlaceholder}
            aria-label={t.inviteLabel}
            className={`${field} font-mono tracking-widest`}
          />
          <button type="submit" disabled={busy || code.length !== 8 || !displayName.trim()} className={primary}>
            {t.join}
          </button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => createCrew(name, displayName)).then(done);
          }}
          className="flex flex-col gap-2 rounded-md border border-rule p-3"
        >
          <span className="text-xs font-medium text-body">{t.createTitle}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={CREW_NAME_MAX} placeholder={t.crewName} aria-label={t.crewName} className={field} />
          <button type="submit" disabled={busy || !name.trim() || !displayName.trim()} className={secondary}>
            {t.create}
          </button>
        </form>
      </div>
      {error && <div className="text-xs text-red-300">{error}</div>}
      {!another && (
        <button onClick={() => void signOut()} className="self-start text-xs text-engrave hover:text-cream">
          {t.signOut}
        </button>
      )}
    </div>
  );
}

/** The crew you're in, all in one (Settings → Crew). The crew pages in the
 * sidebar use the same pieces. */
export function CrewHome() {
  return (
    <div className="flex flex-col gap-3">
      <CrewStatus />
      <CrewNames />
      <CrewMembers />
      <CrewInvites />
      <CrewAccount />
    </div>
  );
}

function useActiveCrew() {
  const crews = useCrewStore((s) => s.crews);
  const activeCrewId = useCrewStore((s) => s.activeCrewId);
  return crews.find((c) => c.id === activeCrewId) ?? crews[0];
}

/** Which crew (switch if several), your role, sync state, why nothing syncs, what you share. */
export function CrewStatus() {
  const crew = useCrewStore();
  const scope = crew.activeCrewId && crew.userId ? { crewId: crew.activeCrewId, userId: crew.userId } : null;
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const scanning = useAppStore((s) => s.scanning);
  const demoMode = useAppStore((s) => s.demoMode);
  const sharedCount = scope ? Object.values(workspace.songs).filter((m) => sharedHere(m, scope)).length : 0;
  const workspaceWritable = useAppStore((s) => s.workspaceWritable);
  const hasFolders = useAppStore((s) => s.settings.watchedFolders.length > 0);
  const note = syncNote({ demoMode, workspaceWritable, hasFolders, sharedCount });
  // Only meaningful once a scan has found something (an empty list could be a failed scan).
  const orphans = scope && projects.length > 0 && !scanning ? orphanedShares(projects, workspace, scope) : [];
  const active = useActiveCrew();
  const { busy, error, run } = useAction();
  if (!active) return null;
  const t = tr(T);

  // Within the day, formatRelative says "today" (in the app's language): say "just now".
  const syncLine =
    crew.sync.kind === "syncing"
      ? t.syncing
      : crew.sync.kind === "synced"
        ? t.synced(formatRelative(crew.sync.atMs) === formatRelative(Date.now()) ? t.justNow : formatRelative(crew.sync.atMs)) +
          (crew.sync.skipped ? t.refused(crew.sync.skipped) : "") +
          pushLimitNote(crew.sync.overLimit, crew.sync.releasesOverLimit)
        : crew.sync.kind === "error"
          ? crew.sync.message
          : t.notSynced;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {crew.crews.length > 1 ? (
          <select value={active.id} onChange={(e) => void crew.selectCrew(e.target.value)} className={`${field} !w-auto`}>
            {crew.crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-medium text-cream">{active.name}</span>
        )}
        <span className="rounded bg-rule px-1.5 py-px text-[10.5px] text-body">{active.role === "owner" ? t.owner : t.member}</span>
        <span className={`ml-auto text-xs ${crew.sync.kind === "error" ? "text-red-300" : "text-body"}`}>{syncLine}</span>
        <button onClick={() => void run(crew.syncNow)} disabled={busy || demoMode} title={t.syncNow} className="rounded p-1 text-body hover:bg-rule hover:text-cream disabled:opacity-40">
          <RefreshCw size={13} className={crew.sync.kind === "syncing" ? "motion-safe:animate-spin" : ""} />
        </button>
      </div>
      {note && (
        <div role="status" className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-cream">
          {note}
        </div>
      )}
      <div className="text-xs text-engrave">
        {t.youShare} <b className="text-cream">{sharedCount}</b>
        {t.songsShared(sharedCount)}
      </div>
      {orphans.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <span className="flex-1">{t.orphans(orphans.length)}</span>
          <button onClick={() => crew.setShared(orphans, false)} className="shrink-0 underline hover:text-cream">
            {t.stopSharingThem(orphans.length)}
          </button>
        </div>
      )}
      <MyServerShares />
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}

/** My rows on the crew server, the ones this computer doesn't know first,
 * with Remove for those (and for duplicates of a song shared from here). */
function MyServerShares() {
  const songs = useCrewStore((s) => s.songs);
  const crewId = useCrewStore((s) => s.activeCrewId);
  const userId = useCrewStore((s) => s.userId);
  const remove = useCrewStore((s) => s.removeServerShares);
  const workspace = useAppStore((s) => s.workspace);
  const demoMode = useAppStore((s) => s.demoMode);
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  // On sample data the workspace isn't yours: every row would look unknown.
  if (!crewId || !userId || demoMode) return null;
  const rows = myServerShares(songs, workspace, { crewId, userId });
  const unknown = rows.filter((r) => !r.local);
  if (!rows.length) return null;
  const t = tr(T);
  return (
    <div className="rounded-md border border-rule px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">
          {t.serverTitle(rows.length)}
          {unknown.length > 0 && t.notHere(unknown.length)}
        </span>
        <button onClick={() => setOpen(!open)} className="ml-auto text-engrave hover:text-cream">
          {open ? t.hide : t.show}
        </button>
      </div>
      {open && (
        <>
          <p className="mt-1 text-[11px] text-engrave">{t.serverHelp}</p>
          <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <StatusDot color={statusInfo(r.stage ?? undefined).color} size={6} glow={false} label={statusInfo(r.stage ?? undefined).label} />
                <span className="min-w-0 flex-1 truncate text-cream">{r.title}</span>
                <span className="shrink-0 text-engrave">{r.local ? t.here : r.duplicate ? t.duplicate : t.elsewhereRow}</span>
                {!r.local && (
                  <ConfirmButton
                    label={t.removeRow}
                    confirmLabel={t.removeRowConfirm}
                    onConfirm={() => void run(() => remove([r.id]))}
                    disabled={busy}
                    className="shrink-0 rounded border border-transparent px-1 text-engrave hover:text-cream disabled:opacity-40"
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <div className="mt-1 text-red-300">{error}</div>}
    </div>
  );
}

/** The crew's name (owner) and my name in it (everyone). */
export function CrewNames() {
  const active = useActiveCrew();
  const renameCrew = useCrewStore((s) => s.renameCrew);
  const setDisplayName = useCrewStore((s) => s.setDisplayName);
  const [crewName, setCrewName] = useState(active?.name ?? "");
  const [myName, setMyName] = useState(active?.displayName ?? "");
  const { busy, error, run } = useAction();
  useEffect(() => setCrewName(active?.name ?? ""), [active?.name]);
  useEffect(() => setMyName(active?.displayName ?? ""), [active?.displayName]);
  if (!active) return null;
  const t = tr(T);
  const row = (label: string, value: string, set: (v: string) => void, max: number, current: string, save: (v: string) => Promise<void>) => {
    const changed = !!value.trim() && value.trim() !== current;
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void run(() => save(value));
        }}
      >
        <span className="w-40 shrink-0 text-engrave">{label}</span>
        <input value={value} onChange={(e) => set(e.target.value)} maxLength={max} aria-label={label} className={`${field} !w-56`} />
        <button type="submit" disabled={!changed || busy} className={`${secondary} disabled:opacity-40`}>
          {t.save}
        </button>
      </form>
    );
  };
  return (
    <div className="flex flex-col gap-2 text-xs">
      {active.role === "owner" && row(t.crewNameLabel, crewName, setCrewName, 80, active.name, renameCrew)}
      {row(t.yourNameLabel, myName, setMyName, 60, active.displayName, setDisplayName)}
      {error && <div className="text-red-300">{error}</div>}
    </div>
  );
}

/** Members (the owner can remove people). */
export function CrewMembers() {
  const crew = useCrewStore();
  const active = useActiveCrew();
  const { busy, error, run } = useAction();
  if (!active) return null;
  const isOwner = active.role === "owner";
  const t = tr(T);
  return (
    <div>
      <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{t.members(crew.members.length)}</div>
      <div className="flex flex-wrap gap-1.5">
        {crew.members.map((m) => (
          <span key={m.user_id} className="flex items-center rounded-full bg-raised px-2.5 py-1 text-xs text-body">
            {m.display_name}
            {m.role === "owner" && <span className="ml-1 text-engrave">{t.ownerTag}</span>}
            {m.user_id === crew.userId && <span className="ml-1 text-engrave">{t.youTag}</span>}
            {isOwner && m.user_id !== crew.userId && (
              <ConfirmButton
                label={t.makeOwner}
                confirmLabel={t.makeOwnerConfirm(m.display_name)}
                onConfirm={() => void run(() => crew.transferOwnership(m.user_id))}
                disabled={busy}
                className="ml-2 rounded-full border border-transparent px-1.5 text-[11px] text-engrave hover:text-cream disabled:opacity-40"
              />
            )}
            {isOwner && m.user_id !== crew.userId && (
              <ConfirmButton
                label={t.remove}
                confirmLabel={t.removeConfirm(m.display_name)}
                onConfirm={() => void run(() => crew.removeMember(m.user_id))}
                disabled={busy}
                className="ml-2 rounded-full border border-transparent px-1.5 text-[11px] text-engrave hover:text-cream disabled:opacity-40"
              />
            )}
          </span>
        ))}
      </div>
      {isOwner && crew.members.length > 1 && <div className="mt-1 text-[11px] text-engrave">{t.removeNote} {t.makeOwnerNote}</div>}
      {error && <div className="mt-1 text-xs text-red-300">{error}</div>}
    </div>
  );
}

/** Owner: open invite codes, a new code, revoke. Nothing for members. */
export function CrewInvites() {
  const crew = useCrewStore();
  const active = useActiveCrew();
  const [copied, setCopied] = useState<"code" | "message" | null>(null);
  const { busy, error, run } = useAction();
  const isOwner = active?.role === "owner";
  const copy = (what: "code" | "message", text: string) =>
    void navigator.clipboard?.writeText(text).then(() => (setCopied(what), setTimeout(() => setCopied(null), 1200)));
  const { loadInvites } = crew;
  useEffect(() => {
    if (isOwner) void loadInvites().catch(() => {});
  }, [isOwner, active?.id, loadInvites]);
  if (!active || !isOwner) return null;
  const t = tr(T);
  return (
    <div className="flex flex-col gap-3">
      {crew.invites.length > 0 && (
        <div>
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-engrave">{t.openInvites(crew.invites.length)}</div>
          <div className="flex flex-col gap-1">
            {crew.invites.map((i) => (
              <div key={i.code} className="flex items-center gap-3 text-xs text-body">
                <code className="font-mono tracking-widest text-cream">{i.code}</code>
                <span>{t.used(i.uses, i.max_uses)}</span>
                <span>{t.expires(new Date(i.expires_at).toLocaleDateString(locale()))}</span>
                <ConfirmButton
                  label={t.revoke}
                  confirmLabel={t.revokeConfirm}
                  onConfirm={() => void run(() => crew.revokeInvite(i.code))}
                  disabled={busy}
                  className="ml-auto rounded border border-transparent px-1.5 py-0.5 text-engrave hover:text-cream disabled:opacity-40"
                />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => void run(crew.createInvite)} disabled={busy} className={secondary}>
          {t.newInvite}
        </button>
        {crew.invite && (
          <>
            <code className="rounded bg-rule px-2 py-1.5 font-mono text-sm tracking-widest text-cream">{crew.invite}</code>
            <button onClick={() => copy("code", crew.invite!)} className={`${secondary} flex items-center gap-1.5`}>
              {copied === "code" ? <Check size={14} /> : <ClipboardCopy size={14} />} {copied === "code" ? t.copied : t.copy}
            </button>
            <button onClick={() => copy("message", inviteMessage(crew.invite!, active.name))} className={`${secondary} flex items-center gap-1.5`}>
              {copied === "message" ? <Check size={14} /> : <ClipboardCopy size={14} />} {copied === "message" ? t.messageCopied : t.copyMessage}
            </button>
            <span className="text-[11px] text-engrave">{t.inviteValid}</span>
          </>
        )}
      </div>
      <div className="text-[11px] text-engrave">{t.inviteListNote}</div>
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}

/** Leave the active crew (asks first; says who becomes owner). */
export function LeaveCrewButton({ className = "hover:text-cream" }: { className?: string }) {
  const crew = useCrewStore();
  const active = useActiveCrew();
  const { run } = useAction();
  if (!active) return null;
  const t = tr(T);
  return (
    <button
      onClick={() => {
        const others = crew.members.filter((m) => m.user_id !== crew.userId);
        const note =
          active.role === "owner" && others.length
            ? t.becomesOwner(others[0].display_name)
            : !others.length
              ? t.lastMember
              : "";
        if (window.confirm(t.leaveConfirm(active.name, note))) void run(crew.leaveCrew);
      }}
      className={className}
    >
      {t.leaveCrew}
    </button>
  );
}

/** Join or create another crew, your email, leave, sign out. */
export function CrewAccount() {
  const crew = useCrewStore();
  const [adding, setAdding] = useState(false);
  const t = tr(T);
  return (
    <div className="flex flex-col gap-3">
      {adding ? (
        <div className="rounded-md border border-rule p-3">
          <div className="mb-2 flex items-center text-xs font-medium text-body">
            {t.another}
            <button onClick={() => setAdding(false)} className="ml-auto text-engrave hover:text-cream">
              {t.cancel}
            </button>
          </div>
          <CreateOrJoin another onDone={() => setAdding(false)} />
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={crew.crews.length >= MAX_CREWS}
          title={crew.crews.length >= MAX_CREWS ? t.maxCrews : undefined}
          className="self-start text-xs text-engrave hover:text-cream disabled:opacity-40"
        >
          + {t.another}
        </button>
      )}
      <div className="flex gap-3 text-xs text-engrave">
        <span>{crew.email}</span>
        <LeaveCrewButton />
        <button onClick={() => void crew.signOut()} className="flex items-center gap-1 hover:text-cream">
          <LogOut size={11} /> {t.signOut}
        </button>
      </div>
    </div>
  );
}

/** Signed in, with a crew, on real data: sharing controls can show. */
export function useCanShare(): { can: boolean; crewName: string | null } {
  const userId = useCrewStore((s) => s.userId);
  const crews = useCrewStore((s) => s.crews);
  const activeCrewId = useCrewStore((s) => s.activeCrewId);
  const demoMode = useAppStore((s) => s.demoMode);
  const crewName = crews.find((c) => c.id === activeCrewId)?.name ?? null;
  return { can: !!userId && !!activeCrewId && !demoMode, crewName };
}

/** Release page: share the release and all its tracks with the crew at once. */
export function ReleaseShare({ albumId }: { albumId: string }) {
  const { can, crewName } = useCanShare();
  const crewId = useCrewStore((s) => s.activeCrewId);
  const userId = useCrewStore((s) => s.userId);
  const shareRelease = useCrewStore((s) => s.shareRelease);
  const setShared = useCrewStore((s) => s.setShared);
  const workspace = useAppStore((s) => s.workspace);
  const [note, setNote] = useState<string | null>(null);
  const album = workspace.albums.find((a) => a.id === albumId);
  if (!can || !crewId || !userId || !album) return null;
  const t = tr(T);
  const scope = { crewId, userId };
  const here = releaseSharedHere(album, scope);
  const elsewhere = !!album.shared && !!album.shareId && !here;
  const missing = unsharedTracks(album, workspace, scope);
  const say = (r: ShareResult) => setNote([r.elsewhere ? t.tracksElsewhere(r.elsewhere) : null, shareLimitNote(r.overLimit)].filter(Boolean).join(" ") || null);

  if (elsewhere) return <div className="mt-3 text-xs text-engrave">{t.releaseElsewhere}</div>;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      {here ? (
        <>
          <span className="flex items-center gap-1.5 text-body">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
            {t.releaseShared(crewName ?? "", album.trackPaths.length - missing.length, album.trackPaths.length)}
          </span>
          {missing.length > 0 && (
            <button onClick={() => say(setShared(missing, true))} className="underline hover:text-cream">
              {t.shareOthers(missing.length)}
            </button>
          )}
          <ConfirmButton
            label={t.stopSharing}
            confirmLabel={t.stopRelease}
            onConfirm={() => (shareRelease(album.id, false), setNote(t.releaseLeft))}
            className="rounded border border-transparent px-1 text-engrave hover:text-cream"
          />
        </>
      ) : (
        <button onClick={() => say(shareRelease(album.id, true))} className={secondary}>
          {t.shareWith} {crewName}
        </button>
      )}
      {!here && album.trackPaths.length > 0 && <span className="text-engrave">{t.sharesRelease(album.trackPaths.length)}</span>}
      {note && <span className="basis-full text-engrave">{note}</span>}
    </div>
  );
}

/** Song panel: share this song with the crew (opt-in). */
export function ShareToggle({ path }: { path: string }) {
  const { can, crewName } = useCanShare();
  const crewId = useCrewStore((s) => s.activeCrewId);
  const userId = useCrewStore((s) => s.userId);
  const meta = useAppStore((s) => s.workspace.songs[path]);
  const projectName = useAppStore((s) => s.projects.find((p) => p.path === path)?.name ?? "");
  const updateSong = useAppStore((s) => s.updateSong);
  const crews = useCrewStore((s) => s.crews);
  const setShared = useCrewStore((s) => s.setShared);
  const moveShares = useCrewStore((s) => s.moveShares);
  const { busy, error, run } = useAction();
  const [moving, setMoving] = useState(false);
  if (!can || !crewId || !userId) return null;
  const t = tr(T);
  const scope = { crewId, userId };
  const shared = sharedHere(meta, scope);
  const elsewhere = shareElsewhere(meta, scope);

  // Shared with another crew (or from another account): sharing it here as
  // well would strand that row, so it's an explicit move, or nothing.
  if (elsewhere && (elsewhere.shared || !elsewhere.mine)) {
    const other = crews.find((c) => c.id === elsewhere.crewId)?.name;
    return (
      <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-rule bg-panel px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <Users size={13} className="text-body" />
          <span className="flex-1 text-body">
            {!elsewhere.mine ? (
              t.otherAccount
            ) : (
              <>
                {t.sharedWith} <b className="font-medium text-cream">{other ?? t.formerCrew}</b>
                {t.moveTo} <b className="font-medium text-cream">{crewName}</b>
                {t.question}
              </>
            )}
          </span>
          {elsewhere.mine && (
            <ConfirmButton
              label={t.moveHere}
              confirmLabel={other ? t.takeOff(other) : t.moveIt}
              onConfirm={() => void run(() => moveShares([path]))}
              disabled={busy}
              className="shrink-0 rounded border border-rule-strong px-2 py-1 text-body hover:bg-raised disabled:opacity-40"
            />
          )}
        </div>
        {error && <div className="text-red-300">{error}</div>}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-md border border-rule bg-panel text-xs">
      <label className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <input
          type="checkbox"
          checked={shared}
          disabled={busy}
          onChange={(e) =>
            // Still waiting to be removed from another crew: finish that removal now, then share here.
            e.target.checked && elsewhere
              ? void run(() => moveShares([path]))
              : void run(async () => {
                  const note = shareLimitNote(setShared([path], e.target.checked).overLimit);
                  if (note) throw new Error(note);
                })
          }
          className="accent-orange-500"
        />
        <Users size={13} className="text-body" />
        <span className="flex-1 text-body">
          {t.shareWith} <b className="font-medium text-cream">{crewName}</b>
        </span>
        <span className={error ? "text-red-300" : "text-engrave"}>{error ?? (shared ? t.onBoard : t.onlyYou)}</span>
      </label>
      <div className="px-3 pb-2 text-[11px] text-engrave">{t.shareNote}</div>
      {shared && (
        <label className="flex items-center gap-2 border-t border-rule px-3 py-2 text-engrave">
          <span className="shrink-0">{t.seesAs}</span>
          <input
            key={meta?.shareTitle ?? ""}
            defaultValue={meta?.shareTitle ?? ""}
            placeholder={sharedTitle(projectName)}
            maxLength={200}
            aria-label={t.titleLabel}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (meta?.shareTitle ?? "")) updateSong(path, { shareTitle: v || undefined });
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="min-w-0 flex-1 rounded border border-rule bg-chassis px-2 py-1 text-body placeholder:text-engrave"
          />
        </label>
      )}
      {shared && (
        <div className="border-t border-rule px-3 py-2">
          {moving ? (
            <MoveSharePicker from={path} onDone={() => setMoving(false)} />
          ) : (
            <button onClick={() => setMoving(true)} className="text-engrave underline hover:text-cream">
              {t.moveShare}
            </button>
          )}
        </div>
      )}
      </div>
  );
}

/** A crewmate moved this song on the crew board while this computer's move
 * was waiting to be sent: the owner picks which one stands. */
export function StageConflictBanner({ path }: { path: string }) {
  const conflict = useAppStore((s) => s.workspace.songs[path]?.stageConflict);
  const members = useCrewStore((s) => s.members);
  const knownNames = useCrewStore((s) => s.knownNames);
  const resolve = useCrewStore((s) => s.resolveStageConflict);
  if (!conflict) return null;
  const t = tr(T);
  const who = nameOf(conflict.by, members, knownNames) ?? crewText("someone");
  const theirs = statusInfo(conflict.theirs ?? undefined).label;
  const mine = statusInfo(conflict.mine ?? undefined).label;
  return (
    <div role="alert" className="mt-3 flex flex-col gap-2 rounded-md border border-amber-400/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-100">
      <span>
        <b className="font-semibold">{who}</b>
        {t.movedTo}
        <b className="font-semibold">{theirs}</b>
        {t.whileYours}
        <b className="font-semibold">{mine}</b>
        {t.whichStands}
      </span>
      <div className="flex gap-2">
        <button onClick={() => resolve(path, "theirs")} className="rounded border border-rule-strong px-2 py-1 text-body hover:bg-raised">
          {t.keep(theirs)}
        </button>
        <button onClick={() => resolve(path, "mine")} className="rounded border border-rule-strong px-2 py-1 text-body hover:bg-raised">
          {t.keep(mine)}
        </button>
      </div>
    </div>
  );
}

/** Pick the song that takes over this song's crew card (Save As, a new
 * version): only songs with no share of their own. */
function MoveSharePicker({ from, onDone }: { from: string; onDone: () => void }) {
  const crewId = useCrewStore((s) => s.activeCrewId);
  const userId = useCrewStore((s) => s.userId);
  const moveShareTo = useCrewStore((s) => s.moveShareTo);
  const projects = useAppStore((s) => s.projects);
  const workspace = useAppStore((s) => s.workspace);
  const [to, setTo] = useState("");
  if (!crewId || !userId) return null;
  const t = tr(T);
  const scope = { crewId, userId };
  // The same folder first (a Save As or new version usually sits next to it).
  const folder = (p: string) => p.replace(/[/\\][^/\\]*$/, "");
  const options = projects
    .filter((p) => canMoveShare(workspace, from, p.path, scope))
    .sort((a, b) => Number(folder(b.path) === folder(from)) - Number(folder(a.path) === folder(from)) || b.modifiedAtMs - a.modifiedAtMs);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-engrave">{t.moveShareHelp}</span>
      {options.length === 0 ? (
        <span className="text-engrave">{t.moveShareNone}</span>
      ) : (
        <div className="flex items-center gap-2">
          <select value={to} onChange={(e) => setTo(e.target.value)} aria-label={t.moveShareTo} className="min-w-0 flex-1 rounded border border-rule bg-chassis px-2 py-1 text-body">
            <option value="">{t.pickSong}</option>
            {options.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
          <ConfirmButton
            label={t.moveShareTo}
            confirmLabel={t.moveShareConfirm}
            disabled={!to}
            onConfirm={() => (moveShareTo(from, to), onDone())}
            className="shrink-0 rounded border border-rule-strong px-2 py-1 text-body hover:bg-raised disabled:opacity-40"
          />
        </div>
      )}
      <button onClick={onDone} className="self-start text-[11px] text-engrave hover:text-cream">
        {t.cancel}
      </button>
    </div>
  );
}

/** After "Save as new version": offer to move the crew card to the new file. */
export function MoveShareOffer({ from, to, onDone }: { from: string; to: string; onDone: () => void }) {
  const crewId = useCrewStore((s) => s.activeCrewId);
  const userId = useCrewStore((s) => s.userId);
  const moveShareTo = useCrewStore((s) => s.moveShareTo);
  const workspace = useAppStore((s) => s.workspace);
  if (!crewId || !userId || !canMoveShare(workspace, from, to, { crewId, userId })) return null;
  const t = tr(T);
  const name = to.split(/[/\\]/).pop() ?? to;
  return (
    <div role="status" className="mt-2 flex items-center gap-2 rounded-md border border-rule bg-panel px-3 py-2 text-xs text-body">
      <span className="flex-1">{t.moveShareOffer(name)}</span>
      <button onClick={() => (moveShareTo(from, to), onDone())} className="shrink-0 rounded border border-rule-strong px-2 py-1 text-body hover:bg-raised">
        {t.moveShareTo}
      </button>
      <button onClick={onDone} className="shrink-0 text-engrave hover:text-cream">
        {t.cancel}
      </button>
    </div>
  );
}

/** "Moved to <stage> by <name>, <time>": a crewmate's move on the crew
 * board set this song's stage. */
export function CrewMoveNote({ path }: { path: string }) {
  const meta = useAppStore((s) => s.workspace.songs[path]);
  const members = useCrewStore((s) => s.members);
  const knownNames = useCrewStore((s) => s.knownNames);
  if (!meta?.stageMovedBy || meta.stagePending || meta.stageConflict || !meta.shared) return null;
  const t = tr(T);
  const who = nameOf(meta.stageMovedBy, members, knownNames) ?? crewText("someone");
  const when = meta.stageUpdatedAtMs ? formatRelative(meta.stageUpdatedAtMs) : "";
  return <div className="mt-2 text-[11px] text-engrave">{t.movedByLine(statusInfo(meta.status).label, who, when)}</div>;
}
