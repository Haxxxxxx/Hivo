// Capture safety and reliability (0.7.1): drafts, shares that survive a kill,
// storage trouble, finding the computer again, the error screen. Kept apart
// from strings.ts / inboxStrings.ts so parallel work doesn't collide.
import { dict, plural, tr } from "./lib/i18n";
import type { Kind } from "./lib/sync";

const NB = " "; // narrow no-break space before : ; ? ! in French

const C = dict(
  {
    // Record
    recStopFirst: "Stop the recording first.",
    recDraftRestored: "This take was recorded before Hivo closed. Keep it or discard it.",
    draftState: "Not kept yet: open it to keep or discard",
    // Share
    shareAsNew: "New song named",
    shareToExisting: "Add to an existing song",
    shareSendUnpaired: "Keep, send when paired",
    shareMoreWaiting: (n: number) => plural(n, "1 more share waiting", `${n} more shares waiting`),
    unnamedFile: "Unnamed file",
    sharedFile: "Shared file",
    leaveShareTitle: "Leave this share?",
    leaveShareBody: "What was shared isn't kept anywhere yet.",
    leaveShareYes: "Leave",
    // Target picker
    pickTitle: (kinds: Kind[]) => (kinds.length === 1 ? { prod: "Pick a prod", beat: "Pick a beat", song: "Pick a song" }[kinds[0]] : "Pick a prod, beat or song"),
    noTargetFor: (kinds: Kind[]) => (kinds.length === 1 ? { prod: "No prod picked", beat: "No beat picked", song: "No song picked" }[kinds[0]] : "Not for a beat or song yet"),
    pickerEmpty: "Nothing here yet: sync to load your computer's library.",
    pickerSync: "Sync",
    pickerSyncing: "Syncing…",
    // Note
    recordFor: (k: Kind) => ({ prod: "Record for this prod", beat: "Record for this beat", song: "Record for this song" })[k],
    ideaFor: (k: Kind) => ({ prod: "Idea for this prod", beat: "Idea for this beat", song: "Idea for this song" })[k],
    conflictMarked: "Edited on both sides: the computer kept its text and added your lines under a “--- from <phone> ---” line. Tidy it up, then tap OK.",
    conflictShow: "Show",
    // Settings
    lookAgain: "Look for my computer again",
    lookingAgain: "Looking on this Wi-Fi…",
    foundAgain: "Found it at its new address. Syncing.",
    notFoundAgain: "Not found on this Wi-Fi. Check that the computer is on, with Hivo open and Phone sync on, or pair again.",
    storageBlocked: "Some of what this phone saved couldn't be read just now. Hivo keeps it as it is and reads it again before each save: nothing is written over it.",
    storageFull: "This phone's storage is full: new changes stay in memory until there's room again. Free some space.",
    // Pairing that can't be read
    pairingUnreadable: "This phone's pairing couldn't be read (the phone's secure storage didn't answer). It's still saved: try again.",
    retry: "Try again",
    // Error screen
    crashTitle: "Hivo hit a problem",
    crashBody: "Something on this screen failed. Reload Hivo. If it happens again, reset this phone's cache: the library is loaded again from the computer at the next sync.",
    reload: "Reload",
    resetCache: "Reset this phone's cache",
    resetCacheNote: "Keeps your notes' text, your ideas, memos and shares, and the pairing.",
    resetting: "Resetting…",
  },
  {
    recStopFirst: "Arrête d'abord l'enregistrement.",
    recDraftRestored: "Cette prise a été enregistrée avant que Hivo se ferme. Garde-la ou jette-la.",
    draftState: `Pas encore gardé${NB}: ouvre-le pour le garder ou le jeter`,
    shareAsNew: "Nouveau son nommé",
    shareToExisting: "Ajouter à un son existant",
    shareSendUnpaired: "Garder, envoyer une fois associé",
    shareMoreWaiting: (n: number) => plural(n, `${n} autre partage en attente`, `${n} autres partages en attente`),
    unnamedFile: "Fichier sans nom",
    sharedFile: "Fichier partagé",
    leaveShareTitle: `Laisser ce partage${NB}?`,
    leaveShareBody: "Ce qui a été partagé n'est encore gardé nulle part.",
    leaveShareYes: "Laisser",
    pickTitle: (kinds: Kind[]) => (kinds.length === 1 ? { prod: "Choisis une prod", beat: "Choisis un beat", song: "Choisis un son" }[kinds[0]] : "Choisis une prod, un beat ou un son"),
    noTargetFor: (kinds: Kind[]) => (kinds.length === 1 ? { prod: "Aucune prod choisie", beat: "Aucun beat choisi", song: "Aucun son choisi" }[kinds[0]] : "Pas encore pour un beat ou un son"),
    pickerEmpty: `Rien pour l'instant${NB}: synchronise pour charger la bibliothèque de ton ordi.`,
    pickerSync: "Synchro",
    pickerSyncing: "Synchro…",
    recordFor: (k: Kind) => ({ prod: "Enregistrer pour cette prod", beat: "Enregistrer pour ce beat", song: "Enregistrer pour ce son" })[k],
    ideaFor: (k: Kind) => ({ prod: "Idée pour cette prod", beat: "Idée pour ce beat", song: "Idée pour ce son" })[k],
    conflictMarked: `Modifiée des deux côtés${NB}: l'ordi a gardé son texte et ajouté tes lignes sous une ligne «${NB}--- from <téléphone> ---${NB}». Fais le tri, puis touche OK.`,
    conflictShow: "Voir",
    lookAgain: "Rechercher mon ordi",
    lookingAgain: "Recherche sur ce Wi-Fi…",
    foundAgain: "Trouvé à sa nouvelle adresse. Synchro en cours.",
    notFoundAgain: "Introuvable sur ce Wi-Fi. Vérifie que l'ordi est allumé, Hivo ouvert et la sync téléphone activée, ou associe à nouveau.",
    storageBlocked: `Une partie de ce que ce téléphone a gardé n'a pas pu être lue pour l'instant. Hivo la garde telle quelle et la relit avant chaque enregistrement${NB}: rien n'est écrit par-dessus.`,
    storageFull: `Le stockage du téléphone est plein${NB}: les nouvelles modifications restent en mémoire jusqu'à ce qu'il y ait de la place. Libère de l'espace.`,
    pairingUnreadable: `L'association de ce téléphone n'a pas pu être lue (le stockage sécurisé du téléphone n'a pas répondu). Elle est toujours enregistrée${NB}: réessaie.`,
    retry: "Réessayer",
    crashTitle: "Hivo a rencontré un problème",
    crashBody: `Quelque chose a échoué sur cet écran. Recharge Hivo. Si ça recommence, réinitialise le cache du téléphone${NB}: la bibliothèque revient de l'ordi à la prochaine synchro.`,
    reload: "Recharger",
    resetCache: "Réinitialiser le cache du téléphone",
    resetCacheNote: "Garde le texte de tes notes, tes idées, mémos et partages, et l'association.",
    resetting: "Réinitialisation…",
  },
);

export const c = () => tr(C);
