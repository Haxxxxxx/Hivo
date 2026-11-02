import type { Lang } from "./lang";

// The privacy policy (/privacy, /en/privacy, /fr/privacy), linked from the
// landing footer and from the Google Play listing. Every sentence has to be
// true of the shipped code: when what an app sends changes, change this page
// in both languages.

export interface PrivacyCopy {
  title: string;
  updated: string;
  lead: string;
  sections: { title: string; body: string[] }[];
  back: string;
  /** The language switch's accessible name. */
  language: string;
}

/** Bump when the text changes. */
export const PRIVACY_UPDATED = "2026-11-02";

/** The owner sets VITE_CONTACT_EMAIL in Vercel; never a hardcoded address. */
const CONTACT = (import.meta.env.VITE_CONTACT_EMAIL ?? "").trim();
/** Who runs Hivo (the GDPR data controller), set in Vercel like the contact:
 * VITE_OPERATOR_NAME, and optionally VITE_OPERATOR_ADDRESS. Never hardcoded.
 * Without a name, the page keeps its unnamed wording. */
const OPERATOR = (import.meta.env.VITE_OPERATOR_NAME ?? "").trim();
const OPERATOR_ADDRESS = (import.meta.env.VITE_OPERATOR_ADDRESS ?? "").trim();
const operatorAt = OPERATOR_ADDRESS ? `, ${OPERATOR_ADDRESS}` : "";

const en: PrivacyCopy = {
  title: "Privacy policy",
  updated: "Last updated: 2 November 2026",
  lead: "Hivo is a free app for a music crew: a desktop app (Mac, Windows), a phone app (Android) and this website. This page says what each part sends, where, and why. The short version: your music and your notes stay on your own devices unless you turn on a feature that sends them, and each of those is listed below.",
  sections: [
    {
      title: "Who runs Hivo",
      body: [
        OPERATOR
          ? `Hivo is run by ${OPERATOR}${operatorAt}, who is responsible for the data described here (the data controller under the GDPR). It's made for one rap crew and has no business model: nothing is sold, and no data is sold or shared for advertising.`
          : "Hivo is made and run by its developer, an individual, for one rap crew. It isn't a company and has no business model: nothing is sold, and no data is sold or shared for advertising.",
        CONTACT ? `Contact: ${CONTACT}, or the Feedback button in the desktop app.` : "Contact: use the Feedback button in the desktop app's menu (“Report a bug or send feedback”).",
      ],
    },
    {
      title: "The desktop app",
      body: [
        "It works on your computer. It reads your project folders and keeps what you add (stages, releases, notes, settings) in a file in Hivo's settings folder on that computer. It never changes your project files, and it sends audio only if you turn on the Digger's audio option (below).",
        "When it starts, and when you click Check for updates in Settings, it downloads a public file from Hivo's release storage to see if a new version exists.",
      ],
    },
    {
      title: "Crew sharing (optional)",
      body: [
        "If you join a crew, you sign in with your email address (we email you a one-time code) and pick a display name your crew sees. Accounts are added by Hivo's admin: there is no open sign-up.",
        "Only the songs you choose to share are sent: title, stage, BPM, key, tags, credits (names, roles, splits), dates (the release date, and when the project was last saved: your crew sees it on the song's card, to spot a stalled song or an out-of-date mixdown; Hivo never shows a per-person activity time), whether a mixdown exists and is up to date, and whether an accepted release kit exists. Releases you share send their title, type, colour, date and tracks. Never audio, file paths, notes, samples or track names.",
        "This goes to Hivo's database, hosted by Supabase in the EU (Ireland). Only members of your crew can read it. It stays there until you unshare the song, leave the crew, or ask for your account to be deleted.",
      ],
    },
    {
      title: "Optional AI features",
      body: [
        "They only run if you add your own keys in Settings, and the requests go to those companies under your own account and their terms. On Gemini's free tier, Google may use what you send to improve its products.",
        "Launch Kit (Google Gemini): the song name (the project file's name), its stage, BPM, time signature, key, mixdown length, tags, credits (names, roles and splits), the release it's on (title, type, date), when the project was last saved, and the kit's text. If your track names mention a key or a person from your People list, Hivo sends that key or name, never the track names themselves. Your notes go too only if you turn that option on.",
        "Cover concepts: a text description of the image (no title, no names) goes to Cloudflare Workers AI.",
        "Digger (Google Gemini): facts about the beats you pick (file name, length, tempo, key, loudness); 30-second audio excerpts only if you turn that option on in the Digger (off by default). With a YouTube key, searches go to YouTube.",
      ],
    },
    {
      title: "Digger links and player",
      body: [
        "To find beats, Gemini can search the web with Google (on a dig and with Go deeper). Hivo then checks where each link it found leads: your computer asks those sites for the final address only (HEAD requests, nothing downloaded).",
        "Video thumbnails load from YouTube's servers. The player loads YouTube's own player (youtube-nocookie.com) inside a small page of this website (hi-vo.fr/embed.html), so YouTube and this website's host see that request.",
        "Convert opens the converter site you set yourself in Settings, in your browser, with the video's address. Hivo suggests no converter site, and never downloads audio itself.",
      ],
    },
    {
      title: "Profile lookup (People)",
      body: [
        "When you click Look up profiles, the name you typed is sent to MusicBrainz, Deezer and Apple iTunes (no key needed) and, if you added Spotify keys in Settings, to Spotify. Spotify pictures load from Spotify's servers. What you pick is kept on your computer only, never shared with the crew.",
      ],
    },
    {
      title: "Feedback",
      body: [
        "The feedback form sends your message, its category, the reply address if you type one, the app version, your operating system, the screen you were on, the app language and a random install number (used to limit messages to 10 a day) to Hivo's database. When you're signed in to a crew, it's linked to your crew account.",
        "Feedback is kept until it's deleted on request.",
      ],
    },
    {
      title: "Phone sync and the phone app",
      body: [
        "When you turn on Phone sync in the desktop app's Settings (off by default), the desktop app opens a port on your local network so your paired phone can reach it. It answers only phones you paired; anything else is refused. It's phone ↔ computer only.",
        "The phone app talks only to your own computer, over your local Wi-Fi, and everything it sends is encrypted with the key from the pairing QR code. There is no Hivo server in between, no account, and Hivo adds no analytics, ads or tracking.",
        "To scan the pairing QR code, the Android app uses Google Play services' code scanner (ML Kit). Google says ML Kit sends Google device information (such as model and OS version), the app's name and version, performance metrics and error codes, for diagnostics and usage analytics, encrypted in transit and not shared with third parties.",
        "Your notes, ideas and voice memos are stored on the phone and on your computer. The camera is used only to scan the pairing QR code: no photo is taken or kept. The microphone is used only while you record a voice memo, and the recording goes nowhere but your computer.",
        "Files you share to Hivo from another app (a BandLab export, for example) are copied into Hivo on the phone, then sent to your computer the same way. An export is deleted from the phone once your computer has it.",
        "The version downloaded from this website checks once a day for a new version by downloading a public file from Hivo's release storage. Nothing about you is sent with it (like any web request, it reaches the server from your internet address). The Google Play version gets its updates from Google Play and doesn't do this check.",
      ],
    },
    {
      title: "This website",
      body: [
        "This website is hosted by Vercel (set to its EU region). Like any web host, Vercel sees your IP address when you load a page. No analytics, no ads, no tracking cookies.",
        "Signing in to the crew dashboard uses the same email code; your browser keeps the sign-in and reads crew data straight from Hivo's database at Supabase in the EU, never through Vercel. The home page also reads the latest version number from Hivo's release storage.",
      ],
    },
    {
      title: "Deleting your data",
      body: [
        "Uninstall the apps to remove what they keep on your device. On a computer, also delete Hivo's settings folder if you want your stages and notes gone.",
        "Unsharing a song deletes it from the crew database; leaving a crew deletes the songs you shared with it. To delete your crew account (your email address) or your feedback, ask through the contact above.",
      ],
    },
    {
      title: "Your rights",
      body: [
        "Under the GDPR you can ask to see, correct or delete the data Hivo holds about you (your crew email and display name, the songs you shared, your feedback), and you can complain to your data protection authority (in France, the CNIL). Crew sign-in and sharing rest on providing the service you asked for; feedback and its daily limit rest on Hivo's legitimate interest in fixing the app and preventing abuse. The optional AI and lookup features run under your own accounts with those companies.",
      ],
    },
  ],
  back: "Back to Hivo",
  language: "Language",
};

const fr: PrivacyCopy = {
  title: "Politique de confidentialité",
  updated: "Mise à jour : 2 novembre 2026",
  lead: "Hivo est une appli gratuite pour un crew de musique : une appli pour l'ordi (Mac, Windows), une appli pour le téléphone (Android) et ce site. Cette page dit ce que chaque partie envoie, où et pourquoi. En bref : ta musique et tes notes restent sur tes appareils, sauf si tu actives une fonction qui les envoie, et chacune est listée ci-dessous.",
  sections: [
    {
      title: "Qui fait tourner Hivo",
      body: [
        OPERATOR
          ? `Hivo est géré par ${OPERATOR}${operatorAt}, responsable des données décrites ici (le responsable du traitement au sens du RGPD). Il est fait pour un crew de rap et n'a pas de modèle commercial : rien n'est vendu, et aucune donnée n'est vendue ni partagée pour de la pub.`
          : "Hivo est fait et géré par son développeur, un particulier, pour un crew de rap. Ce n'est pas une entreprise et il n'y a pas de modèle commercial : rien n'est vendu, et aucune donnée n'est vendue ni partagée pour de la pub.",
        CONTACT ? `Contact : ${CONTACT}, ou le bouton de retour dans l'appli de l'ordi.` : "Contact : utilise le bouton de retour dans le menu de l'appli de l'ordi (« Signaler un bug ou donner ton avis »).",
      ],
    },
    {
      title: "L'appli de l'ordi",
      body: [
        "Elle marche sur ton ordi. Elle lit tes dossiers de projets et garde ce que tu ajoutes (étapes, sorties, notes, réglages) dans un fichier du dossier de réglages de Hivo, sur cet ordi. Elle ne modifie jamais tes fichiers de projet, et n'envoie de l'audio que si tu actives l'option audio du Digger (plus bas).",
        "Au démarrage, et quand tu cliques sur Vérifier les mises à jour dans les Réglages, elle télécharge un fichier public sur le stockage des versions de Hivo pour savoir s'il y a une nouvelle version.",
      ],
    },
    {
      title: "Partage avec le crew (optionnel)",
      body: [
        "Si tu rejoins un crew, tu te connectes avec ton adresse email (on t'envoie un code à usage unique) et tu choisis un nom que ton crew voit. Les comptes sont ajoutés par l'admin de Hivo : pas d'inscription libre.",
        "Seuls les sons que tu choisis de partager sont envoyés : titre, étape, BPM, tonalité, tags, crédits (noms, rôles, parts), dates (la date de sortie, et la dernière sauvegarde du projet, que ton crew voit sur la carte du son pour repérer un son à l'arrêt ou un mixdown pas à jour ; Hivo n'affiche jamais d'heure d'activité par personne), s'il existe un mixdown et s'il est à jour, et s'il existe un kit de sortie validé. Les sorties que tu partages envoient leur titre, type, couleur, date et morceaux. Jamais d'audio, de chemins de fichiers, de notes, de samples ni de noms de pistes.",
        "Tout ça va dans la base de données de Hivo, hébergée par Supabase dans l'UE (Irlande). Seuls les membres de ton crew peuvent la lire. Ça y reste jusqu'à ce que tu arrêtes de partager le son, que tu quittes le crew ou que tu demandes la suppression de ton compte.",
      ],
    },
    {
      title: "Fonctions IA optionnelles",
      body: [
        "Elles ne marchent que si tu ajoutes tes propres clés dans les Réglages, et les demandes partent chez ces entreprises sous ton propre compte et selon leurs conditions. Sur l'offre gratuite de Gemini, Google peut utiliser ce que tu envoies pour améliorer ses produits.",
        "Launch Kit (Google Gemini) : le nom du son (celui du fichier projet), son étape, le BPM, la signature rythmique, la tonalité, la durée du mixdown, les tags, les crédits (noms, rôles et parts), la sortie dont il fait partie (titre, type, date), la dernière sauvegarde du projet, et le texte du kit. Si tes noms de pistes mentionnent une tonalité ou une personne de ta liste Personnes, Hivo envoie cette tonalité ou ce nom, jamais les noms de pistes eux-mêmes. Tes notes aussi, seulement si tu actives cette option.",
        "Idées de cover : une description de l'image en texte (sans titre ni noms) va à Cloudflare Workers AI.",
        "Digger (Google Gemini) : les infos des beats que tu choisis (nom du fichier, durée, tempo, tonalité, volume) ; des extraits audio de 30 secondes seulement si tu actives cette option dans le Digger (désactivée par défaut). Avec une clé YouTube, les recherches vont à YouTube.",
      ],
    },
    {
      title: "Liens et lecteur du Digger",
      body: [
        "Pour trouver des beats, Gemini peut chercher sur le web avec Google (pendant une recherche et avec Creuser plus loin). Hivo vérifie ensuite où mène chaque lien trouvé : ton ordi demande à ces sites l'adresse finale seulement (requêtes HEAD, rien n'est téléchargé).",
        "Les miniatures des vidéos se chargent depuis les serveurs de YouTube. Le lecteur charge celui de YouTube (youtube-nocookie.com) dans une petite page de ce site (hi-vo.fr/embed.html) : YouTube et l'hébergeur de ce site voient donc cette requête.",
        "Convertir ouvre dans ton navigateur le site de conversion que tu as toi-même choisi dans les Réglages, avec l'adresse de la vidéo. Hivo ne propose aucun site de conversion et ne télécharge jamais d'audio lui-même.",
      ],
    },
    {
      title: "Recherche de profils (Personnes)",
      body: [
        "Quand tu cliques sur Chercher les profils, le nom que tu as tapé est envoyé à MusicBrainz, Deezer et Apple iTunes (sans clé) et, si tu as ajouté des clés Spotify dans les Réglages, à Spotify. Les photos Spotify se chargent depuis les serveurs de Spotify. Ce que tu choisis reste sur ton ordi, jamais partagé avec le crew.",
      ],
    },
    {
      title: "Retours",
      body: [
        "Le formulaire de retour envoie ton message, sa catégorie, l'adresse de réponse si tu en tapes une, la version de l'appli, ton système, l'écran où tu étais, la langue de l'appli et un numéro d'installation aléatoire (pour limiter à 10 messages par jour) à la base de données de Hivo. Si ta session crew est ouverte, il est relié à ton compte crew.",
        "Les retours sont gardés jusqu'à ce que quelqu'un demande leur suppression.",
      ],
    },
    {
      title: "Synchro téléphone et appli du téléphone",
      body: [
        "Quand tu actives la Synchro téléphone dans les Réglages de l'appli de l'ordi (désactivée par défaut), l'appli ouvre un port sur ton réseau local pour que ton téléphone associé puisse la joindre. Elle ne répond qu'aux téléphones associés ; tout le reste est refusé. Ça se passe seulement entre le téléphone et l'ordi.",
        "L'appli du téléphone ne parle qu'à ton propre ordi, par ton Wi-Fi local, et tout ce qu'elle envoie est chiffré avec la clé du QR code d'association. Pas de serveur Hivo entre les deux, pas de compte, et Hivo n'ajoute ni statistiques, ni pub, ni pistage.",
        "Pour scanner le QR code d'association, l'appli Android utilise le scanner de codes des services Google Play (ML Kit). D'après Google, ML Kit envoie à Google des infos sur l'appareil (comme le modèle et la version du système), le nom et la version de l'appli, des mesures de performance et des codes d'erreur, pour le diagnostic et les statistiques d'usage, chiffrés pendant le transfert et sans les partager avec des tiers.",
        "Tes notes, idées et mémos vocaux sont gardés sur le téléphone et sur ton ordi. La caméra sert uniquement à scanner le QR code d'association : aucune photo n'est prise ni gardée. Le micro sert uniquement pendant que tu enregistres un mémo vocal, et l'enregistrement ne va nulle part ailleurs que sur ton ordi.",
        "Les fichiers que tu partages vers Hivo depuis une autre appli (un export BandLab, par exemple) sont copiés dans Hivo sur le téléphone, puis envoyés à ton ordi de la même façon. Un export est supprimé du téléphone une fois que ton ordi l'a reçu.",
        "La version téléchargée sur ce site vérifie une fois par jour s'il y a une nouvelle version en téléchargeant un fichier public sur le stockage des versions de Hivo. Rien sur toi n'est envoyé avec (comme toute requête web, elle arrive au serveur depuis ton adresse internet). La version Google Play reçoit ses mises à jour par Google Play et ne fait pas cette vérification.",
      ],
    },
    {
      title: "Ce site",
      body: [
        "Ce site est hébergé par Vercel (réglé sur sa région UE). Comme tout hébergeur, Vercel voit ton adresse IP quand tu charges une page. Pas de statistiques, pas de pub, pas de cookies de pistage.",
        "La connexion au tableau du crew utilise le même code par email ; ton navigateur garde la connexion et lit les données du crew directement dans la base de données de Hivo chez Supabase dans l'UE, jamais en passant par Vercel. La page d'accueil lit aussi le dernier numéro de version sur le stockage des versions de Hivo.",
      ],
    },
    {
      title: "Supprimer tes données",
      body: [
        "Désinstalle les applis pour supprimer ce qu'elles gardent sur ton appareil. Sur un ordi, supprime aussi le dossier de réglages de Hivo si tu veux effacer tes étapes et tes notes.",
        "Arrêter de partager un son le supprime de la base du crew ; quitter un crew supprime les sons que tu y partageais. Pour supprimer ton compte crew (ton adresse email) ou tes retours, demande-le par le contact plus haut.",
      ],
    },
    {
      title: "Tes droits",
      body: [
        "Avec le RGPD, tu peux demander à voir, corriger ou supprimer les données que Hivo a sur toi (ton email et ton nom dans le crew, les sons que tu as partagés, tes retours), et tu peux porter plainte auprès de l'autorité de protection des données (en France, la CNIL). La connexion et le partage avec le crew reposent sur le service que tu as demandé ; les retours et leur limite par jour reposent sur l'intérêt légitime de Hivo à corriger l'appli et à éviter les abus. Les fonctions IA et la recherche de profils, optionnelles, passent par tes propres comptes chez ces entreprises.",
      ],
    },
  ],
  back: "Retour à Hivo",
  language: "Langue",
};

export const PRIVACY: Record<Lang, PrivacyCopy> = { en, fr };
