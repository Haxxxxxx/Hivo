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
}

/** Bump when the text changes. */
export const PRIVACY_UPDATED = "2026-10-25";

const en: PrivacyCopy = {
  title: "Privacy policy",
  updated: "Last updated: 25 October 2026",
  lead: "Hivo is a free app for a music crew: a desktop app (Mac, Windows), a phone app (Android) and this website. This page says what each part sends, where, and why. The short version: your music and your notes stay on your own devices.",
  sections: [
    {
      title: "The desktop app",
      body: [
        "It works on your computer. It reads your project folders and keeps what you add (stages, releases, notes, settings) in a file in Hivo's settings folder on that computer. It never changes your project files and never uploads audio.",
        "When it starts, and when you click Check for updates in Settings, it downloads a public file from Hivo's release storage to see if a new version exists.",
      ],
    },
    {
      title: "Crew sharing (optional)",
      body: [
        "If you join a crew, you sign in with your email address (we email you a one-time code) and pick a display name your crew sees.",
        "Only the songs you choose to share are sent: title, stage, BPM, key, tags, credits (names, roles, splits), dates, whether a mixdown exists and is up to date, and whether a release kit exists. Releases you share send their title, type, colour, date and tracks. Never audio, file paths, notes, samples or track names.",
        "This goes to Hivo's database, hosted by Supabase in the EU (Ireland). Only members of your crew can read it.",
      ],
    },
    {
      title: "Optional AI features",
      body: [
        "They only run if you add your own keys in Settings, and the requests go to those companies under your own account and their terms.",
        "Launch Kit: song facts (title, BPM, key, tags, credits, dates) and kit text go to Google Gemini. Your notes go too only if you turn that option on.",
        "Cover concepts: a text description of the image (no title, no names) goes to Cloudflare Workers AI.",
        "Digger: facts about the beats you pick (file name, length, tempo, key, loudness) go to Google Gemini; 30-second audio excerpts only if you turn that option on. With a YouTube key, searches go to YouTube.",
      ],
    },
    {
      title: "Feedback",
      body: [
        "The feedback form sends your message, its category, the reply address if you type one, the app version, your operating system, the screen you were on, the app language and a random install number (used to limit messages to 10 a day) to Hivo's database.",
      ],
    },
    {
      title: "The phone app",
      body: [
        "It talks only to your own computer, over your local Wi-Fi, and everything it sends is encrypted with the key from the pairing QR code. There is no Hivo server in between, no account, no analytics, no ads and no tracking.",
        "Your notes, ideas and voice memos are stored on the phone and on your computer. The camera is used only to scan the pairing QR code: no photo is taken or kept. The microphone is used only while you record a voice memo, and the recording goes nowhere but your computer.",
        "Files you share to Hivo from another app (a BandLab export, for example) are copied into Hivo on the phone, then sent to your computer the same way. An export is deleted from the phone once your computer has it.",
        "The version downloaded from this website checks once a day for a new version by downloading a public file from Hivo's release storage. Nothing about you is sent with it (like any web request, it reaches the server from your internet address). The Google Play version gets its updates from Google Play and doesn't do this check.",
      ],
    },
    {
      title: "This website",
      body: [
        "No analytics, no ads, no tracking cookies. Signing in to the crew dashboard uses the same email code; your browser keeps the sign-in and reads crew data straight from the database in the EU.",
      ],
    },
    {
      title: "Deleting your data",
      body: [
        "Uninstall the apps to remove what they keep on your device. On a computer, also delete Hivo's settings folder if you want your stages and notes gone.",
        "Unsharing a song deletes it from the crew database; leaving a crew deletes the songs you shared with it. To delete your crew account (your email address), ask through the feedback form.",
      ],
    },
    {
      title: "Contact",
      body: ["Use the feedback button in the desktop app's menu (“Report a bug or send feedback”)."],
    },
  ],
  back: "Back to Hivo",
};

const fr: PrivacyCopy = {
  title: "Politique de confidentialité",
  updated: "Mise à jour : 25 octobre 2026",
  lead: "Hivo est une appli gratuite pour un crew de musique : une appli pour l'ordi (Mac, Windows), une appli pour le téléphone (Android) et ce site. Cette page dit ce que chaque partie envoie, où et pourquoi. En bref : ta musique et tes notes restent sur tes appareils.",
  sections: [
    {
      title: "L'appli de l'ordi",
      body: [
        "Elle marche sur ton ordi. Elle lit tes dossiers de projets et garde ce que tu ajoutes (étapes, sorties, notes, réglages) dans un fichier du dossier de réglages de Hivo, sur cet ordi. Elle ne modifie jamais tes fichiers de projet et n'envoie jamais d'audio.",
        "Au démarrage, et quand tu cliques sur Vérifier les mises à jour dans les Réglages, elle télécharge un fichier public sur le stockage des versions de Hivo pour savoir s'il y a une nouvelle version.",
      ],
    },
    {
      title: "Partage avec le crew (optionnel)",
      body: [
        "Si tu rejoins un crew, tu te connectes avec ton adresse email (on t'envoie un code à usage unique) et tu choisis un nom que ton crew voit.",
        "Seuls les sons que tu choisis de partager sont envoyés : titre, étape, BPM, tonalité, tags, crédits (noms, rôles, parts), dates, s'il existe un mixdown et s'il est à jour, et s'il existe un kit de sortie. Les sorties que tu partages envoient leur titre, type, couleur, date et morceaux. Jamais d'audio, de chemins de fichiers, de notes, de samples ni de noms de pistes.",
        "Tout ça va dans la base de données de Hivo, hébergée par Supabase dans l'UE (Irlande). Seuls les membres de ton crew peuvent la lire.",
      ],
    },
    {
      title: "Fonctions IA optionnelles",
      body: [
        "Elles ne marchent que si tu ajoutes tes propres clés dans les Réglages, et les demandes partent chez ces entreprises sous ton propre compte et selon leurs conditions.",
        "Launch Kit : les infos du son (titre, BPM, tonalité, tags, crédits, dates) et le texte du kit vont à Google Gemini. Tes notes aussi, seulement si tu actives cette option.",
        "Idées de cover : une description de l'image en texte (sans titre ni noms) va à Cloudflare Workers AI.",
        "Digger : les infos des beats que tu choisis (nom du fichier, durée, tempo, tonalité, volume) vont à Google Gemini ; des extraits audio de 30 secondes seulement si tu actives cette option. Avec une clé YouTube, les recherches vont à YouTube.",
      ],
    },
    {
      title: "Retours",
      body: [
        "Le formulaire de retour envoie ton message, sa catégorie, l'adresse de réponse si tu en tapes une, la version de l'appli, ton système, l'écran où tu étais, la langue de l'appli et un numéro d'installation aléatoire (pour limiter à 10 messages par jour) à la base de données de Hivo.",
      ],
    },
    {
      title: "L'appli du téléphone",
      body: [
        "Elle ne parle qu'à ton propre ordi, par ton Wi-Fi local, et tout ce qu'elle envoie est chiffré avec la clé du QR code d'association. Pas de serveur Hivo entre les deux, pas de compte, pas de statistiques, pas de pub, pas de pistage.",
        "Tes notes, idées et mémos vocaux sont gardés sur le téléphone et sur ton ordi. La caméra sert uniquement à scanner le QR code d'association : aucune photo n'est prise ni gardée. Le micro sert uniquement pendant que tu enregistres un mémo vocal, et l'enregistrement ne va nulle part ailleurs que sur ton ordi.",
        "Les fichiers que tu partages vers Hivo depuis une autre appli (un export BandLab, par exemple) sont copiés dans Hivo sur le téléphone, puis envoyés à ton ordi de la même façon. Un export est supprimé du téléphone une fois que ton ordi l'a reçu.",
        "La version téléchargée sur ce site vérifie une fois par jour s'il y a une nouvelle version en téléchargeant un fichier public sur le stockage des versions de Hivo. Rien sur toi n'est envoyé avec (comme toute requête web, elle arrive au serveur depuis ton adresse internet). La version Google Play reçoit ses mises à jour par Google Play et ne fait pas cette vérification.",
      ],
    },
    {
      title: "Ce site",
      body: [
        "Pas de statistiques, pas de pub, pas de cookies de pistage. La connexion au tableau du crew utilise le même code par email ; ton navigateur garde la connexion et lit les données du crew directement dans la base de données dans l'UE.",
      ],
    },
    {
      title: "Supprimer tes données",
      body: [
        "Désinstalle les applis pour supprimer ce qu'elles gardent sur ton appareil. Sur un ordi, supprime aussi le dossier de réglages de Hivo si tu veux effacer tes étapes et tes notes.",
        "Arrêter de partager un son le supprime de la base du crew ; quitter un crew supprime les sons que tu y partageais. Pour supprimer ton compte crew (ton adresse email), demande-le par le formulaire de retour.",
      ],
    },
    {
      title: "Contact",
      body: ["Utilise le bouton de retour dans le menu de l'appli de l'ordi (« Signaler un bug ou donner ton avis »)."],
    },
  ],
  back: "Retour à Hivo",
};

export const PRIVACY: Record<Lang, PrivacyCopy> = { en, fr };
