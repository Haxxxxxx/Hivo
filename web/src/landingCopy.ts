import type { Lang } from "./lang";

// Every word of the landing page, in English and French. Same structure in
// both, so a section can't exist in one language only. Every claim has to be
// true of the shipped app: change both languages together.

type Pair = [title: string, body: string];

export interface LandingCopy {
  meta: { title: string; description: string };
  nav: { features: string; launchKit: string; privacy: string; status: string; faq: string; signIn: string; home: string; switchTo: string };
  hero: { q1: string; q2: string; q3: string; lead: string; cta: string; secondary: string; facts: string[]; glance: string; shotCaption: string; shotAlt: string };
  shot: { fullSize: string };
  daws: { kicker: string; title: string; lead: string; insideTitle: string; insideBody: string; trackedTitle: string; trackedBody: string };
  stages: { title: string; lead: string; names: Record<string, string>; lines: Record<string, string> };
  library: { name: string; title: string; body: string; points: string[]; caption: string; alt: string };
  board: { name: string; title: string; body: string; points: string[]; caption: string; alt: string };
  kit: { name: string; title: string; lead: string; caption: string; alt: string; parts: Pair[]; aiTitle: string; aiBody: string };
  crew: { name: string; title: string; items: Pair[] };
  privacy: { title: string; lead: string; travels: string; travelItems: string[]; stays: string; stayItems: string[]; note: string };
  status: { kicker: string; title: string; lead: string; ready: string; readyItems: string[]; limits: string; limitItems: string[]; next: string; nextItems: string[]; labels: [string, string, string] };
  faq: { title: string; items: Pair[] };
  signin: { title: string; lead: string; app: string; mac: string; windows: string; firstRun: string; phone: string; android: string; play: string; androidTip: string };
  footer: { tagline: string; data: string; nav: string; privacyPolicy: string };
}

const en: LandingCopy = {
  meta: {
    title: "Hivo · The crew's studio app",
    description: "Hivo reads your DAW project folders and gives the crew one board: every song's stage, where its files live, and a release kit for your distributor.",
  },
  nav: { features: "Features", launchKit: "Launch Kit", privacy: "Privacy", status: "Status", faq: "FAQ", signIn: "Sign in", home: "Hivo, back to top", switchTo: "Language" },
  hero: {
    q1: "Who's got the hook?",
    q2: "Where's the mixdown?",
    q3: "When does it drop?",
    lead: "Hivo is the crew's studio app. It reads the project folders you already have (FL Studio, Ableton Live, REAPER, Studio One and more) and answers all three: every song's stage, where its files live, and a release kit ready for your distributor.",
    cta: "Sign in to your crew",
    secondary: "See what it does",
    facts: ["Mac + Windows", "works offline", "free", "your audio stays on your laptop", "crew data in the EU"],
    glance: "At a glance",
    shotCaption: "fig. 00 · the crew's studio · sample data",
    shotAlt: "Hivo's dashboard: songs, stalled tracks, next release, crew activity and a year of studio sessions",
  },
  shot: { fullSize: "full size" },
  daws: {
    kicker: "Works with",
    title: "Whatever you make it in.",
    lead: "Hivo finds each DAW's usual projects folder on your computer and proposes it; you choose what to link. Nothing is ever written into your project files.",
    insideTitle: "Read inside",
    insideBody: "Tempo, time signature, plugins, samples and track names.",
    trackedTitle: "Tracked",
    trackedBody: "Closed formats: stages, backups, mixdowns and crew sharing, but nothing read from inside.",
  },
  stages: {
    title: "Every song has a stage.",
    lead: "The whole crew sees it. Nobody has to ask.",
    names: { creation: "Creation", production: "Production", prep: "Prep", release: "Release", promotion: "Promotion" },
    lines: {
      creation: "Beat's down, bars coming",
      production: "Recording, mix, master",
      prep: "Cover, credits, distro",
      release: "It's out",
      promotion: "Clips, reels, keep it moving",
    },
  },
  library: {
    name: "Library",
    title: "Every project. Every file.",
    body: "Point Hivo at your projects folders once. Each song gets one card with its project, backups, takes, stems and mixdowns, and what it needs to open on this computer.",
    points: [
      "Backups, renders and recorded takes grouped under their song",
      "Missing samples and plugins flagged before you open the project (most complete for FL Studio)",
      "Rename or move a folder: stage, notes and credits follow it",
      "Clean up old backups to the Trash, and nothing is ever deleted for good without asking",
      "Package a song for a collaborator: the project and its samples in one zip, the file list shown first (FL Studio)",
    ],
    caption: "fig. 01 · song panel · sample data",
    alt: "The song panel: stage, key, release, tags, notes, backups and project facts",
  },
  board: {
    name: "Board",
    title: "Know what everyone's cooking.",
    body: "Every song sits in one stage. Drag it from Creation to Prep and the whole crew sees it, on the desktop app or from a phone between sessions.",
    points: [
      "A shared crew board: moves sync live",
      "Two people move the same song? The first move stands and the other person is told; for your own songs, Hivo asks which to keep. Nothing is overwritten silently",
      "Release calendar with readiness: finished tracks, accepted kits, Friday drops",
      "Stalled tracks (no save in 21 days) and who's on what, on the dashboard",
    ],
    caption: "fig. 02 · pipeline · sample data",
    alt: "The pipeline board: songs grouped by stage, with BPM, tags and mixdown status",
  },
  kit: {
    name: "Launch Kit",
    title: "Bounce it. We'll pack it.",
    lead: 'Everything a release needs, built from the song itself. Review it, fix what Hivo flags ("N need you" takes you there), then export one folder: the distributor sheet, metadata, snippets, captions, cover brief, and a README that says what each file is for.',
    caption: "fig. 03 · launch kit · sample data",
    alt: "The Launch Kit: metadata with source badges, snippets on the waveform, and a 9:16 short",
    parts: [
      ["Metadata", "Title, artists, BPM, key, duration and credits from the project, each marked detected, suggested or needs you."],
      ["Snippets", "The hook found in your mixdown (the part that comes back most), a teaser and an alt. Drag them on the waveform, 7 to 60 seconds."],
      ["Shorts", "9:16 videos with a waveform for Reels, TikTok and Shorts, rendered on your computer with free ffmpeg."],
      ["Captions", "Announce, teaser and release-day posts, in French or English, never mixed."],
      ["Cover", "A brief for your designer, plus optional cover concepts (free, with your own Cloudflare account)."],
      ["Checks", "Master format (WAV, 44.1 kHz, no clipping), release date on a Friday that dodges the crew's other drops, splits that add up."],
    ],
    aiTitle: "AI is optional.",
    aiBody: "With your own free Gemini key, Hivo drafts the captions and cover brief and double-checks every field. Without one, everything above still works.",
  },
  crew: {
    name: "Crew",
    title: "The crew, on the same page.",
    items: [
      ["One board, every screen", "The desktop app and the crew website show the same board (in the crew's columns), releases, calendar and crew. The website works on a phone."],
      ["Share song by song, or a whole release", "Nothing is shared until you tick it. Choose the title the crew sees, so it doesn't have to be the file name. A release shares in one click, with its tracks."],
      ["Invite only", "Your crew lead adds you and sends an invite code. Owners can revoke codes and remove members."],
      ["No passwords", "Sign in with a 6-digit code from your email, on the app or the website."],
    ],
  },
  privacy: {
    title: "Share titles, not tracks.",
    lead: "Your beats don't leave your laptop. The crew sees the facts you choose to share. That's it.",
    travels: "What travels (songs you share)",
    travelItems: ["title", "stage", "bpm · key · tags", "credits · splits", "release date", "mixdown: yes / no", "kit accepted · last saved", "shared releases: title, date, tracklist"],
    stays: "What stays on your machine",
    stayItems: ["audio", "project files and paths", "samples", "notes", "track names"],
    note: "Crew data is stored in the EU (Ireland). Optional AI, with your own free Gemini key: the song name, tags, tempo, key, credits and Launch Kit text go to Google, and on the free tier Google may use them. Your notes only if you turn that on. Never audio, files or track names.",
  },
  status: {
    kicker: "Version {version} · October 2026",
    title: "Where it's at.",
    lead: "Built with and for one crew. Here's what works, what doesn't yet, and what's next.",
    ready: "Ready",
    readyItems: [
      "Library and scanning for 7 DAWs",
      "Pipeline, release calendar, crew board and website",
      "Launch Kit: metadata, snippets, shorts, captions, cover concepts, export",
      "Download for Mac (Apple Silicon and Intel) and Windows, with in-app updates",
    ],
    limits: "Known limits",
    limitItems: [
      "Pro Tools, Cubase and Bitwig projects are tracked, not read inside",
      "Rendering and packaging from the app work with FL Studio only",
      "The missing-plugin check is most complete for FL Studio projects",
      "The app isn't code-signed yet: a one-time security prompt on first launch",
    ],
    next: "On the list",
    nextItems: ["Plugin checks for every DAW", "The release calendar in Google or Apple Calendar", "Posting snippets and captions to socials from the Launch Kit"],
    labels: ["Ready", "Limit", "Next"],
  },
  faq: {
    title: "Questions.",
    items: [
      ["Is it free?", "Yes. The optional AI and cover concepts use free tiers with your own keys, and everything works without them."],
      ["Does my audio go anywhere?", "No. Audio, project files, samples, notes and track names stay on your computer. Only the facts of songs you choose to share reach the crew."],
      ["Do I need internet?", "No. The app works fully offline; crew sharing catches up the next time you're online."],
      ["Mac or Windows?", "Both: Mac (Apple Silicon and Intel) and Windows 10/11, and crew members can mix the two."],
      ["How do I get the app?", "Download it below, for Mac or Windows. It's crew-only for now: your crew lead adds your email and sends you an invite code."],
      ["Is it in French?", "Yes: the app, this website and the crew dashboard are in French and English (pick in the app's Settings, or FR | EN here). Captions and the kit README can be either, per kit."],
      ["Can I use it on my own?", "Yes. The library, pipeline and Launch Kit work without a crew; sharing is optional."],
    ],
  },
  signin: {
    title: "Crew only.",
    lead: "Hivo is invite-only for now. Your crew lead adds your email, then you sign in here with a 6-digit code (no password) and enter your crew's invite code.",
    app: "The desktop app is free, for Mac and Windows. It updates itself.",
    mac: "Download for Mac",
    windows: "Download for Windows",
    firstRun: "Mac: if it says it can't verify the developer, go to System Settings → Privacy & Security and click Open Anyway. Windows: More info → Run anyway.",
    phone: "The phone app (Android) keeps your notes and lyrics on your prods, beats and songs, and syncs them with the desktop app over your Wi-Fi.",
    android: "Download for Android",
    play: "Get it on Google Play",
    androidTip: "Android: allow installs from your browser when Android asks.",
  },
  footer: { tagline: "made with and for the crew", data: "crew data: EU (Ireland) · audio: never leaves your machine", nav: "Footer", privacyPolicy: "Privacy policy" },
};

const fr: LandingCopy = {
  meta: {
    title: "Hivo · L'appli studio du crew",
    description: "Hivo lit les dossiers de projets de ton DAW et donne au crew un seul tableau : l'étape de chaque son, où sont ses fichiers, et un kit de sortie prêt pour ton distributeur.",
  },
  nav: { features: "Fonctions", launchKit: "Launch Kit", privacy: "Confidentialité", status: "État", faq: "FAQ", signIn: "Connexion", home: "Hivo, retour en haut", switchTo: "Langue" },
  hero: {
    q1: "Qui a le refrain ?",
    q2: "Où est le mixdown ?",
    q3: "Ça sort quand ?",
    lead: "Hivo, c'est l'appli studio du crew. Elle lit les dossiers de projets que tu as déjà (FL Studio, Ableton Live, REAPER, Studio One et d'autres) et répond aux trois : l'étape de chaque son, où sont ses fichiers, et un kit de sortie prêt pour ton distributeur.",
    cta: "Rejoindre ton crew",
    secondary: "Voir ce que ça fait",
    facts: ["Mac + Windows", "marche hors ligne", "gratuit", "ton audio reste sur ton ordi", "données du crew dans l'UE"],
    glance: "En bref",
    shotCaption: "fig. 00 · le studio du crew · données d'exemple",
    shotAlt: "Le tableau de bord de Hivo : les sons, les morceaux à l'arrêt, la prochaine sortie, l'activité du crew et une année de sessions",
  },
  shot: { fullSize: "taille réelle" },
  daws: {
    kicker: "Compatible avec",
    title: "Peu importe ton DAW.",
    lead: "Hivo trouve le dossier de projets habituel de chaque DAW sur ton ordi et te le propose ; c'est toi qui choisis quoi lier. Rien n'est jamais écrit dans tes fichiers de projet.",
    insideTitle: "Lu de l'intérieur",
    insideBody: "Tempo, signature rythmique, plugins, samples et noms de pistes.",
    trackedTitle: "Suivi",
    trackedBody: "Formats fermés : étapes, sauvegardes, mixdowns et partage avec le crew, mais rien n'est lu à l'intérieur.",
  },
  stages: {
    title: "Chaque son a son étape.",
    lead: "Tout le crew la voit. Plus besoin de demander.",
    names: { creation: "Création", production: "Production", prep: "Prépa", release: "Sortie", promotion: "Promo" },
    lines: {
      creation: "La prod est posée, les couplets arrivent",
      production: "Enregistrement, mix, master",
      prep: "Cover, crédits, distrib",
      release: "C'est sorti",
      promotion: "Extraits, reels, on fait tourner",
    },
  },
  library: {
    name: "Bibliothèque",
    title: "Chaque projet. Chaque fichier.",
    body: "Indique tes dossiers de projets une fois. Chaque son a sa fiche : le projet, les sauvegardes, les prises, les stems, les mixdowns, et ce qu'il lui faut pour s'ouvrir sur cet ordi.",
    points: [
      "Sauvegardes, rendus et prises regroupés sous leur son",
      "Samples et plugins manquants signalés avant d'ouvrir le projet (le plus complet pour FL Studio)",
      "Tu renommes ou déplaces un dossier : l'étape, les notes et les crédits suivent",
      "Les vieilles sauvegardes partent à la corbeille, et rien n'est supprimé définitivement sans te demander",
      "Prépare un son pour un collab : le projet et ses samples dans un zip, avec la liste des fichiers avant (FL Studio)",
    ],
    caption: "fig. 01 · fiche d'un son · données d'exemple",
    alt: "La fiche d'un son : étape, tonalité, sortie, tags, notes, sauvegardes et infos du projet",
  },
  board: {
    name: "Tableau",
    title: "Sache ce que chacun prépare.",
    body: "Chaque son est à une étape. Fais-le glisser de Création à Prépa et tout le crew le voit, sur l'appli ou sur un téléphone entre deux sessions.",
    points: [
      "Un tableau partagé par le crew : les déplacements se synchronisent en direct",
      "Deux personnes déplacent le même son ? Le premier déplacement compte et l'autre est prévenu ; pour tes propres sons, Hivo te demande lequel garder. Rien n'est écrasé en douce",
      "Calendrier des sorties avec l'avancement : morceaux finis, kits validés, sorties le vendredi",
      "Les morceaux à l'arrêt (pas de sauvegarde depuis 21 jours) et qui bosse sur quoi, sur le tableau de bord",
    ],
    caption: "fig. 02 · pipeline · données d'exemple",
    alt: "Le tableau des étapes : les sons rangés par étape, avec BPM, tags et état du mixdown",
  },
  kit: {
    name: "Launch Kit",
    title: "Tu bounces. On emballe.",
    lead: "Tout ce qu'il faut pour une sortie, construit à partir du son lui-même. Relis, corrige ce que Hivo signale (« N need you » t'y emmène), puis exporte un seul dossier : la fiche distributeur, les métadonnées, les extraits, les textes des posts, le brief de cover, et un README qui explique chaque fichier.",
    caption: "fig. 03 · launch kit · données d'exemple",
    alt: "Le Launch Kit : métadonnées avec leur source, extraits sur la forme d'onde, et une vidéo 9:16",
    parts: [
      ["Métadonnées", "Titre, artistes, BPM, tonalité, durée et crédits tirés du projet, chacun marqué détecté, suggéré ou à remplir."],
      ["Extraits", "Le refrain trouvé dans ton mixdown (le passage qui revient le plus), un teaser et un extrait bonus. Fais-les glisser sur la forme d'onde, de 7 à 60 secondes."],
      ["Shorts", "Des vidéos 9:16 avec forme d'onde pour Reels, TikTok et Shorts, rendues sur ton ordi avec ffmpeg (gratuit)."],
      ["Textes", "Les posts d'annonce, de teaser et du jour de sortie, en français ou en anglais, jamais mélangés."],
      ["Cover", "Un brief pour ton graphiste, plus des idées de cover en option (gratuit, avec ton propre compte Cloudflare)."],
      ["Vérifications", "Format du master (WAV, 44,1 kHz, pas de saturation), date de sortie un vendredi qui évite les autres sorties du crew, répartitions qui font 100 %."],
    ],
    aiTitle: "L'IA est optionnelle.",
    aiBody: "Avec ta propre clé Gemini gratuite, Hivo rédige les textes et le brief de cover, et revérifie chaque champ. Sans clé, tout le reste marche quand même.",
  },
  crew: {
    name: "Crew",
    title: "Tout le crew sur la même page.",
    items: [
      ["Un tableau, tous les écrans", "L'appli et le site du crew montrent le même tableau (dans les colonnes du crew), les mêmes sorties, le même calendrier et le même crew. Le site marche sur téléphone."],
      ["Partage son par son, ou une sortie entière", "Rien n'est partagé tant que tu ne coches pas. Choisis le titre que voit le crew, pas forcément le nom du fichier. Une sortie se partage en un clic, avec ses morceaux."],
      ["Sur invitation", "Le responsable du crew t'ajoute et t'envoie un code d'invitation. Les propriétaires peuvent révoquer les codes et retirer des membres."],
      ["Pas de mot de passe", "Tu te connectes avec un code à 6 chiffres reçu par email, sur l'appli ou sur le site."],
    ],
  },
  privacy: {
    title: "Partage les titres, pas les sons.",
    lead: "Tes prods ne quittent pas ton ordi. Le crew voit les infos que tu choisis de partager. C'est tout.",
    travels: "Ce qui est partagé (les sons que tu partages)",
    travelItems: ["titre", "étape", "bpm · tonalité · tags", "crédits · répartitions", "date de sortie", "mixdown : oui / non", "kit validé · dernière sauvegarde", "sorties partagées : titre, date, morceaux"],
    stays: "Ce qui reste sur ton ordi",
    stayItems: ["audio", "fichiers et chemins de projet", "samples", "notes", "noms de pistes"],
    note: "Les données du crew sont stockées dans l'UE (Irlande). IA optionnelle, avec ta propre clé Gemini gratuite : le nom du son, les tags, le tempo, la tonalité, les crédits et les textes du Launch Kit partent chez Google, qui peut les utiliser sur l'offre gratuite. Tes notes seulement si tu l'actives. Jamais l'audio, les fichiers ni les noms de pistes.",
  },
  status: {
    kicker: "Version {version} · octobre 2026",
    title: "Où on en est.",
    lead: "Fait avec et pour un crew. Voici ce qui marche, ce qui ne marche pas encore, et la suite.",
    ready: "Prêt",
    readyItems: [
      "Bibliothèque et scan de 7 DAWs",
      "Pipeline, calendrier des sorties, tableau du crew et site",
      "Launch Kit : métadonnées, extraits, shorts, textes, idées de cover, export",
      "Téléchargement pour Mac (Apple Silicon et Intel) et Windows, avec mises à jour depuis l'appli",
    ],
    limits: "Limites connues",
    limitItems: [
      "Les projets Pro Tools, Cubase et Bitwig sont suivis, pas lus à l'intérieur",
      "Le rendu et l'emballage depuis l'appli marchent seulement avec FL Studio",
      "La vérification des plugins manquants est la plus complète pour FL Studio",
      "L'appli n'est pas encore signée : un avertissement de sécurité la première fois",
    ],
    next: "Prévu",
    nextItems: ["Vérifier les plugins pour tous les DAWs", "Le calendrier des sorties dans Google ou Apple Calendar", "Publier les extraits et les textes sur les réseaux depuis le Launch Kit"],
    labels: ["Prêt", "Limite", "Prévu"],
  },
  faq: {
    title: "Questions.",
    items: [
      ["C'est gratuit ?", "Oui. L'IA et les idées de cover, optionnelles, utilisent des offres gratuites avec tes propres clés, et tout marche sans."],
      ["Mon audio part quelque part ?", "Non. L'audio, les fichiers de projet, les samples, les notes et les noms de pistes restent sur ton ordi. Seules les infos des sons que tu choisis de partager arrivent au crew."],
      ["Il faut internet ?", "Non. L'appli marche entièrement hors ligne ; le partage avec le crew se rattrape à ta prochaine connexion."],
      ["Mac ou Windows ?", "Les deux : Mac (Apple Silicon et Intel) et Windows 10/11, et le crew peut mélanger les deux."],
      ["Comment j'ai l'appli ?", "Télécharge-la plus bas, pour Mac ou Windows. Pour l'instant c'est réservé au crew : le responsable ajoute ton email et t'envoie un code d'invitation."],
      ["C'est en français ?", "Oui : l'appli, ce site et le tableau du crew sont en français et en anglais (au choix dans les Réglages de l'appli, ou FR | EN ici). Les textes des posts et le README du kit, l'un ou l'autre, kit par kit."],
      ["Je peux l'utiliser seul ?", "Oui. La bibliothèque, le pipeline et le Launch Kit marchent sans crew ; le partage est optionnel."],
    ],
  },
  signin: {
    title: "Réservé au crew.",
    lead: "Hivo fonctionne sur invitation pour l'instant. Le responsable du crew ajoute ton email, puis tu te connectes ici avec un code à 6 chiffres (sans mot de passe) et tu entres le code d'invitation du crew.",
    app: "L'appli est gratuite, pour Mac et Windows. Elle se met à jour toute seule.",
    mac: "Télécharger pour Mac",
    windows: "Télécharger pour Windows",
    firstRun: "Mac : s'il dit ne pas pouvoir vérifier le développeur, va dans Réglages Système → Confidentialité et sécurité et clique Ouvrir quand même. Windows : Informations complémentaires → Exécuter quand même.",
    phone: "L'appli téléphone (Android) garde tes notes et tes textes sur tes prods, tes beats et tes sons, et les synchronise avec l'appli de l'ordi par ton Wi-Fi.",
    android: "Télécharger pour Android",
    play: "Disponible sur Google Play",
    androidTip: "Android : autorise les installations depuis ton navigateur quand Android le demande.",
  },
  footer: { tagline: "fait avec et pour le crew", data: "données du crew : UE (Irlande) · audio : ne quitte jamais ton ordi", nav: "Pied de page", privacyPolicy: "Politique de confidentialité" },
};

export const LANDING: Record<Lang, LandingCopy> = { en, fr };

/** The sign-in card's own words (the card lives in App.tsx). */
export const SIGN_IN: Record<Lang, { title: string; email: string; send: string; sending: string; enterCode: string; code: string; signIn: string; checking: string; other: string; haveCode: string }> = {
  en: {
    title: "Sign in to your crew",
    email: "Your email",
    send: "Email me a code",
    sending: "Sending…",
    enterCode: "Enter the code sent to",
    code: "Sign-in code",
    signIn: "Sign in",
    checking: "Checking…",
    other: "Use another email",
    haveCode: "Have a code? Enter it",
  },
  fr: {
    title: "Connexion au crew",
    email: "Ton email",
    send: "Recevoir un code",
    sending: "Envoi…",
    enterCode: "Entre le code envoyé à",
    code: "Code de connexion",
    signIn: "Se connecter",
    checking: "Vérification…",
    other: "Utiliser un autre email",
    haveCode: "Tu as déjà un code\u202f? Entre-le",
  },
};
