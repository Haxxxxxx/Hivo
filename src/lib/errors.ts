import { dict, plural, tr } from "../i18n";

// What a Rust command's error says, in the app's language.
//
// A user-facing failure comes from Rust as a coded error, serialized as JSON
// in the rejection string (src-tauri/src/error.rs):
//
//   {"code":"scope.denied","params":{"what":"project","path":"…"},"detail":"That project isn't inside…"}
//
// `errorText(e)` gives the sentence for its code (EN/FR below). `detail` is
// the raw English: shown when the code isn't known here, and kept for the
// tooltip and the "Report this" feedback (`errorDetail`). An uncoded string
// (an older command, a system message) is wrapped in a translated lead
// sentence, so a French user never gets a bare English line.
//
// Every code used in src-tauri/src must have an entry here: a Rust test
// (error.rs, `every_code_is_translated`) reads this file.

export type ErrorParams = Record<string, string | number>;
export interface CodedError {
  code: string;
  params?: ErrorParams;
  detail?: string;
}

type Msg = (p: ErrorParams) => string;

const s = (p: ErrorParams, k: string) => String(p[k] ?? "");
const nb = " ";

const EN: Record<string, Msg> = {
  // Settings, folders, pickers
  "config.dir": () => "Hivo couldn't open its settings folder on this computer.",
  "settings.read": () => "Your settings couldn't be read.",
  "settings.badConverter": (p) => `The converter link must start with https:// (${s(p, "max")} characters max).`,
  "settings.unknown": (p) => `Unknown setting: ${s(p, "name")}.`,
  "picker.failed": () => "The file picker didn't open. Try again.",
  "folder.notLocal": (p) => `Not a folder on this computer: ${s(p, "path")}`,
  "folder.tooBroad": (p) =>
    `Pick the folder where your ${({ projects: "projects", beats: "beats", "samples or packs": "samples or packs", exports: "exports" } as Record<string, string>)[s(p, "what")] ?? s(p, "what")} are, not a whole drive, your home folder or a system folder: the app can read every file in it.`,
  "folder.notDetected": (p) => `Not a detected DAW folder: ${s(p, "path")}`,
  "folder.notLinked": (p) => `Not a linked folder: ${s(p, "path")}`,
  "folder.alreadyLinked": (p) => `${s(p, "path")} is already linked.`,
  "flStudio.notFl": (p) => `That isn't FL Studio: ${s(p, "path")}`,
  "flStudio.notFound": () => "FL Studio wasn't found. Pick it by hand.",
  "ffmpeg.notFfmpeg": (p) => `That isn't ffmpeg: ${s(p, "path")}`,
  "ffmpeg.notFound": () => "ffmpeg wasn't found. Pick it by hand.",
  "ffmpeg.moved": () => "ffmpeg isn't where it was a moment ago. Check again.",
  // Scope (what the app may touch)
  "scope.denied": (p) =>
    `${({ project: "That project", folder: "That folder", lead: "That prod", file: "That file" } as Record<string, string>)[s(p, "what")] ?? "That file"} isn't inside a folder linked in Settings: ${s(p, "path")}`,
  "scope.notProject": (p) => `Not a project file: ${s(p, "path")}`,
  "scope.notFlProject": (p) => `Not an FL Studio project: ${s(p, "path")}`,
  "scope.notLead": (p) => `Not a saved prod: ${s(p, "path")}`,
  "scope.notMixdown": (p) => `Not a mixdown: ${s(p, "path")}`,
  "scope.beatDenied": (p) => `That beat isn't inside a beats folder linked in Settings: ${s(p, "path")}`,
  "scope.notBeat": (p) => `Not a beat (mp3, wav, ogg, flac or m4a): ${s(p, "path")}`,
  "scope.noOutput": () => "Set an export folder in Settings first.",
  "scope.noFlStudio": () => "FL Studio isn't set (see Settings).",
  "scope.badFlStudio": (p) => `The FL Studio path in Settings isn't FL Studio: ${s(p, "path")}`,
  // Opening and showing files
  "open.remote": () => "Network and device paths aren't opened from Hivo.",
  "open.notProject": () => "Only DAW project files can be opened.",
  "open.failed": () => "It couldn't be opened.",
  "reveal.failed": () => "It couldn't be shown in the folder.",
  // Files
  "io.open": (p) => `Couldn't open ${s(p, "path")}.`,
  "io.read": (p) => `Couldn't read ${s(p, "path")}.`,
  "io.write": (p) => `Couldn't write ${s(p, "path")}.`,
  "io.create": (p) => `Couldn't create ${s(p, "path")}.`,
  "io.delete": (p) => `Couldn't delete ${s(p, "path")}.`,
  "io.copy": (p) => `Couldn't copy ${s(p, "name")}.`,
  "io.save": (p) => `Couldn't save ${s(p, "name")}.`,
  "io.link": (p) => `${s(p, "path")} is a link: nothing is written through it.`,
  "io.unreachable": (p) => `Couldn't reach ${s(p, "path")}.`,
  "io.noFreeName": (p) => `No free name for "${s(p, "name")}" in that folder.`,
  "io.diskFull": () => "The disk is full.",
  "task.failed": () => "That stopped before the end. Try again.",
  "http.client": () => "Hivo couldn't start its network connection. Restart the app and try again.",
  // Names, projects, backups, templates
  "name.empty": () => "The name can't be empty.",
  "name.badChars": () => 'The name can\'t contain / \\ : * ? " < > |',
  "name.badEnd": () => "The name can't end with a dot or contain control characters.",
  "name.reserved": (p) => `"${s(p, "name")}" is a name Windows reserves: pick another.`,
  "project.badPath": () => "That project's path isn't valid.",
  "project.exists": (p) => `A project named "${s(p, "name")}" already exists there.`,
  "project.mkdir": () => "The project folder couldn't be created.",
  "project.nameTaken": (p) => `"${s(p, "name")}" already exists in that folder.`,
  "backup.notListed": (p) => `Not a backup of a linked project: ${s(p, "path")}`,
  "backup.notBackup": (p) => `Not a backup file: ${s(p, "path")}`,
  "backup.permanent": (p) => `${s(p, "path")} is on a removable or network drive, where it would be deleted permanently.`,
  "backup.trash": () => "The backups couldn't be moved to the trash.",
  "template.missing": (p) => `Template not found: ${s(p, "path")}`,
  "template.notFl": (p) => `Not an FL Studio template: ${s(p, "path")}`,
  "template.unreadable": () => "The template isn't a readable FL Studio project.",
  "template.tooManyClips": (p) => `${s(p, "count")} files: ${s(p, "max")} at most in one project.`,
  "template.old": (p) => `The template was saved by FL Studio ${s(p, "version")}: open it in FL Studio 2024 or newer and save it once.`,
  "template.noVersion": () => "The template has no FL Studio version: open it in FL Studio and save it once.",
  "template.noPlaylist": () => "The template has no usable playlist: save it once in FL Studio 2024 or newer.",
  "template.tooManyChannels": () => "The template has too many channels.",
  // Render
  "render.stage": () => "The project couldn't be prepared for the render.",
  "render.launch": () => "FL Studio's renderer couldn't be started. Check the FL Studio path in Settings.",
  "render.wait": () => "The render stopped answering.",
  "render.timeout": () => "The render timed out and no mixdown was written.",
  "render.noOutput": () =>
    "FL Studio exited but no mixdown was written. If FL Studio is already open, close it and render again (it can't render from the command line while it runs); otherwise check the FL Studio path and format in Settings.",
  "render.outputFolder": () => "The export folder couldn't be created.",
  "render.move": () => "The rendered file couldn't be moved to the export folder.",
  "render.format": (p) => `Unsupported render format: ${s(p, "format")}`,
  "render.worker": () => "The render stopped before the end. Try again.",
  "render.missingSamples": (p) =>
    `Rendered, but ${plural(Number(p.count), "1 sample", `${s(p, "count")} samples`, "en")} stored next to the project weren't found, so they're silent in this mixdown: ${s(p, "names")}`,
  // Packages
  "package.add": (p) => `${s(p, "name")} couldn't be added to the zip pack.`,
  // Audio and the Launch Kit
  "audio.damaged": (p) => `${s(p, "name")} couldn't be decoded (damaged or unusual audio file).`,
  "audio.unsupported": () => "That audio file or codec isn't supported.",
  "audio.read": () => "The audio couldn't be read (damaged file?).",
  "audio.empty": (p) => (p.name || p.path ? `${s(p, "name") || s(p, "path")} has no audio.` : "The file has no audio."),
  "audio.tooLong": (p) => `${s(p, "path")} is over 30 minutes: not converted.`,
  "kit.badFileName": (p) => `A Launch Kit file can't be called ${s(p, "name")}.`,
  "kit.outputUnreachable": () => "The export folder can't be reached.",
  "kit.outsideOutput": () => "The Launch Kits folder isn't inside the export folder.",
  "kit.notKitFolder": (p) => `${s(p, "path")} isn't a Launch Kit folder.`,
  "kit.tooMany": (p) => `Too many Launch Kits are called ${s(p, "name")}.`,
  // Shorts and ffmpeg
  "ffmpeg.run": (p) => `ffmpeg couldn't run (${s(p, "path")}).`,
  "ffmpeg.noH264": () => "This ffmpeg has no H.264 encoder. Install a full build (brew install ffmpeg / winget install Gyan.FFmpeg).",
  "ffmpeg.start": () => "ffmpeg couldn't be started.",
  "ffmpeg.failed": () => "ffmpeg failed on this short.",
  "ffmpeg.timeout": () => "ffmpeg took too long and was stopped.",
  "ffmpeg.wait": () => "ffmpeg stopped answering.",
  "ffmpeg.check": () => "Hivo couldn't check for ffmpeg.",
  "ffmpeg.notSetUp": () => "ffmpeg isn't set up yet. See Settings → Shorts (ffmpeg).",
  "shorts.layoutTooLarge": () => "The short's image is too large.",
  "shorts.layoutInvalid": () => "The short's image isn't valid.",
  "shorts.noMixdown": (p) => `The mixdown is missing: ${s(p, "path")}`,
  "shorts.badFormat": () => "That mixdown isn't WAV, MP3, FLAC or OGG.",
  "shorts.badRange": () => "That clip's start or length isn't valid.",
  // Cover concepts (Cloudflare FLUX)
  "cover.needBoth": () => "Enter both the account ID and the API token.",
  "cover.badAccountId": () => "That doesn't look like a Cloudflare account ID (32 letters a–f and digits). Copy it from the Workers AI page of the dashboard.",
  "cover.badToken": () => "That doesn't look like a Cloudflare API token. Copy it again, without spaces.",
  "cover.quota": () => "Today's free Workers AI allowance (10,000 neurons, about 170 concepts) is used up. It resets at 00:00 UTC.",
  "cover.capacity": () => "Cloudflare is out of capacity for FLUX right now, even after several retries. Try again in a minute.",
  "cover.tokenRejected": () => "Cloudflare rejected the API token. Check it in Settings → Cover art (it needs the Workers AI permission).",
  "cover.tokenNotAllowed": () => 'This token isn\'t allowed to run Workers AI on that account. Create one with the "Workers AI" template (Settings → Cover art).',
  "cover.noAccount": () => "Cloudflare didn't find that account ID. Check it in Settings → Cover art.",
  "cover.refused": (p) => `Cloudflare refused the request: ${s(p, "msg")}`,
  "cover.timeout": () => "FLUX took too long to answer. Try again.",
  "cover.trouble": (p) => `Cloudflare Workers AI is having trouble (${s(p, "status")}), even after several retries. Try again in a few minutes.`,
  "cover.error": (p) => `Cloudflare error: ${s(p, "msg")}`,
  "cover.http": (p) => `Cloudflare error (HTTP ${s(p, "status")}).`,
  "cover.failed": () => "Cloudflare reported a failure without details.",
  "cover.offline": () => "Couldn't reach Cloudflare. Are you online?",
  "cover.badImage": () => "FLUX's answer wasn't a usable image. Try again.",
  "cover.off": () => "Cover concepts are off. Add a free Cloudflare account ID and token in Settings → Cover art.",
  "cover.emptyPrompt": () => "The cover prompt is empty. Write a cover art brief first.",
  "cover.longPrompt": (p) => `The cover prompt is longer than FLUX accepts (${s(p, "max")} characters).`,
  "cover.tooLarge": () => "That image is too large to save.",
  "cover.corrupted": () => "The image data is corrupted.",
  "cover.notJpeg": () => "Only JPEG concepts can be saved.",
  // Keys and credentials
  "secret.save": () => "The key couldn't be saved.",
  "secret.remove": () => "The key couldn't be removed.",
  // Gemini
  "gemini.noKey": () => "No Gemini API key yet. Add a free one in Settings → AI.",
  "gemini.badModel": (p) => `"${s(p, "model")}" isn't a valid model name.`,
  "gemini.keyRejected": () => "The Gemini API key was rejected. Check it in Settings → AI.",
  "gemini.keyNotAllowed": () => "This Gemini API key isn't allowed to use the API. Check it in Settings → AI.",
  "gemini.noModel": (p) => `Gemini model "${s(p, "model")}" wasn't found. Pick another one in Settings → AI.`,
  "gemini.dailyQuota": (p) =>
    `Today's free Gemini quota is used up for ${s(p, "model")} and the backup model ${s(p, "fallback")}. It resets at midnight Pacific (9am in Paris). Everything else in the Launch Kit keeps working.`,
  "gemini.busy": (p) => `Gemini's free tier is busy (too many requests this minute), even on the backup model ${s(p, "fallback")}. Wait a minute and try again.`,
  "gemini.overloaded": (p) =>
    `Gemini is overloaded right now (${s(p, "status")}), even after several retries and the backup model ${s(p, "fallback")}. This is on Google's side: try again in a few minutes.`,
  "gemini.error": (p) => `Gemini error: ${s(p, "msg")}`,
  "gemini.http": (p) => `Gemini error (HTTP ${s(p, "status")}).`,
  "gemini.offline": () => "Couldn't reach Gemini. Are you online?",
  "gemini.deadline": () => "Gemini didn't answer within 2 minutes (busy or rate-limited). Try again later.",
  "gemini.timeout": () => "Gemini's servers are too busy to answer right now (the backup model too). Try again in a few minutes.",
  "gemini.blocked": (p) => `Gemini declined the request (blocked: ${s(p, "reason")}).`,
  "gemini.safety": () => "Gemini stopped for safety reasons. Try again, or edit the text by hand.",
  "gemini.cutOff": () => "Gemini's answer was cut off. Try again.",
  "gemini.noText": () => "Gemini's answer was empty. Try again.",
  "gemini.badJson": () => "Gemini's answer wasn't valid. Try again.",
  "ai.tooLong": (p) => `The song's ${s(p, "what")} is too long to send.`,
  "ai.unknownField": (p) => `Unknown Launch Kit field: ${s(p, "field")}`,
  "ai.nothingToCheck": () => "Nothing to check.",
  // Digger
  "dig.invalid": () => "That isn't a dig.",
  "dig.tooBig": () => "The dig is too big to keep.",
  "dig.forget": () => "The last dig couldn't be forgotten.",
  "dig.keep": () => "The dig couldn't be kept for next time.",
  "dig.noBeats": () => "Pick at least one beat.",
  "dig.tooManyBeats": (p) => `${s(p, "max")} beats max.`,
  "dig.language": () => "Unknown language.",
  "dig.noneRead": (p) => `None of the picked beats could be read (${s(p, "names")}).`,
  "dig.excerptsTooBig": () => "The excerpts are too big to send. Try fewer beats.",
  "dig.webOff": () => "Gemini's web search isn't available on this key right now (it isn't part of every free quota). The searches above and YouTube still work.",
  "dig.noLinks": () => "Google Search found no links this time. Use the searches above.",
  "dig.noNewSearches": () => "Gemini had no new searches this time. Try again.",
  "dig.nothingNew": () => "Nothing new this time. Try again later or use the searches above.",
  "beats.tooMany": (p) => `${s(p, "max")} beats per call max.`,
  "beats.gone": () => "The file is gone.",
  "lead.badLink": () => "That link can't be saved (https links only).",
  "lead.noBeatFolder": () => "Add a beats folder in Settings first.",
  // YouTube
  "youtube.badKey": () => "That doesn't look like a Google API key. Copy it again, without spaces.",
  "youtube.emptyQuery": () => "Type something to search for.",
  "youtube.longQuery": (p) => `That search is too long (${s(p, "max")} characters max).`,
  "youtube.badQuery": () => "That search has characters YouTube won't take.",
  "youtube.quota": () => "Today's free YouTube quota (about 100 searches) is used up. It resets at midnight Pacific time. The YouTube search links still work.",
  "youtube.keyRejected": () => "YouTube rejected the API key. Check it in Settings → YouTube search.",
  "youtube.apiOff": () => "This key's Google Cloud project doesn't have the YouTube Data API v3 turned on. Enable it in the Google Cloud console, then try again.",
  "youtube.keyNotAllowed": () => "This key isn't allowed to call the YouTube Data API. Check its API restrictions in the Google Cloud console.",
  "youtube.trouble": (p) => `YouTube is having trouble (${s(p, "status")}). Try again in a minute.`,
  "youtube.http": (p) => `YouTube search failed (HTTP ${s(p, "status")}).`,
  "youtube.timeout": () => "YouTube took too long to answer. Try again.",
  "youtube.offline": () => "Couldn't reach YouTube. Are you online?",
  "youtube.noKey": () => "No YouTube API key yet. Add one in Settings → YouTube search.",
  // Profile lookup (MusicBrainz, Spotify…)
  "lookup.timeout": (p) => `${s(p, "service")} didn't answer in time. Try again.`,
  "lookup.offline": (p) => `Couldn't reach ${s(p, "service")}. Check the connection.`,
  "lookup.failed": (p) => `${s(p, "service")} didn't answer.`,
  "lookup.tooMuch": (p) => `${s(p, "service")} sent too much data.`,
  "lookup.busy": (p) => `${s(p, "service")} is busy (rate limit). Wait a few seconds and try again.`,
  "lookup.notFound": (p) => `${s(p, "service")}: not found.`,
  "lookup.refused": (p) => `${s(p, "service")} refused the request (${s(p, "status")}). Check the credentials in Settings.`,
  "lookup.http": (p) => `${s(p, "service")} answered ${s(p, "status")}.`,
  "lookup.badSpotifyId": () => "That isn't a Spotify artist id.",
  "lookup.badMbid": () => "That isn't a MusicBrainz id.",
  "lookup.longLink": () => "That link is too long.",
  "lookup.badLink": () => "That isn't a profile link (http or https).",
  "spotify.badCredentials": () => "That doesn't look like a Spotify client id and secret (32 characters each, from the Spotify developer dashboard).",
  "spotify.refused": (p) => `Spotify refused the credentials (${s(p, "status")}). Check the client id and secret in Settings.`,
  "spotify.noToken": () => "Spotify sent no token.",
  "spotify.noCredentials": () => "Set Spotify credentials in Settings first.",
  // Phone sync and the phone inbox
  "phone.firewall": () => "The firewall settings couldn't be opened.",
  "phone.windowsOnly": () => "Only on Windows.",
  "phone.unavailable": () => "Phone sync isn't available (no config folder).",
  "phone.off": () => "Turn phone sync on first.",
  "phone.noLan": () => "No local network address found. Connect this computer to Wi-Fi (or a local network) first.",
  "phone.noProjectFolder": () => "Link a project folder in Settings first.",
  "inbox.gone": () => "That item isn't in the phone inbox any more.",
  "inbox.fileMissing": (p) => `A file is missing from the phone inbox: ${s(p, "name")}`,
  "inbox.ideaNoAudio": () => "An idea has no audio to copy.",
  "inbox.nameTaken": (p) => `"${s(p, "name")}" already exists in that folder: pick another name.`,
  "inbox.zipNoAudio": () => "No audio in this zip.",
  "inbox.songFolderGone": () => "This song's folder isn't there any more.",
  "inbox.memoNoAudio": () => "This memo has no audio.",
  "inbox.onlyMemo": () => "Only a voice memo can be linked to a beat or a prod.",
  "inbox.beatFolderGone": () => "This beats folder isn't there any more.",
  "inbox.badZip": () => "This zip can't be read.",
  "inbox.zipTooBig": () => "The zip unpacks to more than 2 GB of audio.",
  "inbox.notASong": () => "That isn't a song in a linked folder.",
  "inbox.badStatus": (p) => `Unknown status: ${s(p, "status")}`,
  "inbox.io": () => "A file from the phone inbox couldn't be copied.",
  "session.open": () => "The session window couldn't be opened.",
  // BandLab sketches
  "sketch.converted": (p) => `${s(p, "name")} converted to WAV for FL Studio`,
  "sketch.convertFailed": () => "A BandLab file couldn't be converted to WAV",
  "sketch.notSketch": (p) => `Not a BandLab sketch: ${s(p, "path")}`,
  "sketch.hasProject": () => "This song already has a project: open it from the Library.",
  "sketch.noPlayable": () => "No audio FL Studio can play in the BandLab folder.",
  "sketch.notInProject": (p) => `The BandLab audio isn't in the project (${s(p, "reason")}): drag it in from the BandLab folder`,
  // Workspace
  "workspace.unreadableNow": () => "Your workspace can't be read right now, so nothing was changed. Fix that and try Retry.",
  "workspace.readsFine": () => "Your workspace reads fine now, so nothing was changed. Try Retry.",
  "workspace.read": () => "Your workspace couldn't be read.",
  "workspace.parse": () => "Your workspace file is damaged.",
  "workspace.write": () => "Your workspace couldn't be saved.",
  "workspace.moveAside": () => "The unreadable workspace couldn't be moved aside.",
  "workspace.noBackup": () => "There's no backup of your workspace.",
  "workspace.backupUnreadable": () => "The workspace backup can't be read either.",
};

const FR: Record<string, Msg> = {
  "config.dir": () => "Hivo n'arrive pas à ouvrir son dossier de réglages sur cet ordi.",
  "settings.read": () => "Tes réglages n'ont pas pu être lus.",
  "settings.badConverter": (p) => `Le lien du convertisseur doit commencer par https:// (${s(p, "max")} caractères max).`,
  "settings.unknown": (p) => `Réglage inconnu${nb}: ${s(p, "name")}.`,
  "picker.failed": () => "Le sélecteur de fichiers ne s'est pas ouvert. Réessaie.",
  "folder.notLocal": (p) => `Ce n'est pas un dossier de cet ordi${nb}: ${s(p, "path")}`,
  "folder.tooBroad": (p) =>
    `Choisis le dossier où sont ${({ projects: "tes projets", beats: "tes beats", "samples or packs": "tes samples ou packs", exports: "tes exports" } as Record<string, string>)[s(p, "what")] ?? s(p, "what")}, pas un disque entier, ton dossier perso ou un dossier système${nb}: l'app peut lire tous les fichiers qui s'y trouvent.`,
  "folder.notDetected": (p) => `Ce n'est pas un dossier de DAW détecté${nb}: ${s(p, "path")}`,
  "folder.notLinked": (p) => `Ce n'est pas un dossier lié${nb}: ${s(p, "path")}`,
  "folder.alreadyLinked": (p) => `${s(p, "path")} est déjà lié.`,
  "flStudio.notFl": (p) => `Ce n'est pas FL Studio${nb}: ${s(p, "path")}`,
  "flStudio.notFound": () => "FL Studio est introuvable. Choisis-le à la main.",
  "ffmpeg.notFfmpeg": (p) => `Ce n'est pas ffmpeg${nb}: ${s(p, "path")}`,
  "ffmpeg.notFound": () => "ffmpeg est introuvable. Choisis-le à la main.",
  "ffmpeg.moved": () => "ffmpeg n'est plus là où il était il y a un instant. Vérifie à nouveau.",
  "scope.denied": (p) =>
    `${({ project: "Ce projet", folder: "Ce dossier", lead: "Cette prod", file: "Ce fichier" } as Record<string, string>)[s(p, "what")] ?? "Ce fichier"} n'est pas dans un dossier lié dans les Réglages${nb}: ${s(p, "path")}`,
  "scope.notProject": (p) => `Ce n'est pas un fichier de projet${nb}: ${s(p, "path")}`,
  "scope.notFlProject": (p) => `Ce n'est pas un projet FL Studio${nb}: ${s(p, "path")}`,
  "scope.notLead": (p) => `Ce n'est pas une prod enregistrée${nb}: ${s(p, "path")}`,
  "scope.notMixdown": (p) => `Ce n'est pas un mixdown${nb}: ${s(p, "path")}`,
  "scope.beatDenied": (p) => `Ce beat n'est pas dans un dossier de beats lié dans les Réglages${nb}: ${s(p, "path")}`,
  "scope.notBeat": (p) => `Ce n'est pas un beat (mp3, wav, ogg, flac ou m4a)${nb}: ${s(p, "path")}`,
  "scope.noOutput": () => "Choisis d'abord un dossier d'export dans les Réglages.",
  "scope.noFlStudio": () => "FL Studio n'est pas réglé (voir les Réglages).",
  "scope.badFlStudio": (p) => `Le chemin de FL Studio dans les Réglages n'est pas FL Studio${nb}: ${s(p, "path")}`,
  "open.remote": () => "Hivo n'ouvre pas les chemins réseau ni les chemins de périphérique.",
  "open.notProject": () => "Seuls les fichiers de projet de DAW peuvent être ouverts.",
  "open.failed": () => "Impossible de l'ouvrir.",
  "reveal.failed": () => "Impossible de le montrer dans son dossier.",
  "io.open": (p) => `Impossible d'ouvrir ${s(p, "path")}.`,
  "io.read": (p) => `Impossible de lire ${s(p, "path")}.`,
  "io.write": (p) => `Impossible d'écrire ${s(p, "path")}.`,
  "io.create": (p) => `Impossible de créer ${s(p, "path")}.`,
  "io.delete": (p) => `Impossible de supprimer ${s(p, "path")}.`,
  "io.copy": (p) => `Impossible de copier ${s(p, "name")}.`,
  "io.save": (p) => `Impossible d'enregistrer ${s(p, "name")}.`,
  "io.link": (p) => `${s(p, "path")} est un lien${nb}: rien n'est écrit à travers.`,
  "io.unreachable": (p) => `Impossible d'atteindre ${s(p, "path")}.`,
  "io.noFreeName": (p) => `Aucun nom libre pour «${nb}${s(p, "name")}${nb}» dans ce dossier.`,
  "io.diskFull": () => "Le disque est plein.",
  "task.failed": () => "Ça s'est arrêté avant la fin. Réessaie.",
  "http.client": () => "Hivo n'arrive pas à lancer sa connexion réseau. Redémarre l'app et réessaie.",
  "name.empty": () => "Le nom ne peut pas être vide.",
  "name.badChars": () => `Le nom ne peut pas contenir / \\ : * ? " < > |`,
  "name.badEnd": () => "Le nom ne peut pas finir par un point ni contenir de caractères de contrôle.",
  "name.reserved": (p) => `«${nb}${s(p, "name")}${nb}» est un nom réservé par Windows${nb}: choisis-en un autre.`,
  "project.badPath": () => "Le chemin de ce projet n'est pas valide.",
  "project.exists": (p) => `Un projet «${nb}${s(p, "name")}${nb}» existe déjà à cet endroit.`,
  "project.mkdir": () => "Le dossier du projet n'a pas pu être créé.",
  "project.nameTaken": (p) => `«${nb}${s(p, "name")}${nb}» existe déjà dans ce dossier.`,
  "backup.notListed": (p) => `Ce n'est pas une sauvegarde d'un projet lié${nb}: ${s(p, "path")}`,
  "backup.notBackup": (p) => `Ce n'est pas un fichier de sauvegarde${nb}: ${s(p, "path")}`,
  "backup.permanent": (p) => `${s(p, "path")} est sur un disque amovible ou réseau, où il serait supprimé définitivement.`,
  "backup.trash": () => "Les sauvegardes n'ont pas pu être mises à la corbeille.",
  "template.missing": (p) => `Modèle introuvable${nb}: ${s(p, "path")}`,
  "template.notFl": (p) => `Ce n'est pas un modèle FL Studio${nb}: ${s(p, "path")}`,
  "template.unreadable": () => "Le modèle n'est pas un projet FL Studio lisible.",
  "template.tooManyClips": (p) => `${s(p, "count")} fichiers${nb}: ${s(p, "max")} au maximum dans un projet.`,
  "template.old": (p) => `Le modèle a été enregistré par FL Studio ${s(p, "version")}${nb}: ouvre-le dans FL Studio 2024 ou plus récent et enregistre-le une fois.`,
  "template.noVersion": () => `Le modèle n'a pas de version de FL Studio${nb}: ouvre-le dans FL Studio et enregistre-le une fois.`,
  "template.noPlaylist": () => `Le modèle n'a pas de playlist utilisable${nb}: enregistre-le une fois dans FL Studio 2024 ou plus récent.`,
  "template.tooManyChannels": () => "Le modèle a trop de canaux.",
  "render.stage": () => "Le projet n'a pas pu être préparé pour le rendu.",
  "render.launch": () => "Le moteur de rendu de FL Studio n'a pas pu démarrer. Vérifie le chemin de FL Studio dans les Réglages.",
  "render.wait": () => "Le rendu ne répond plus.",
  "render.timeout": () => "Le rendu a pris trop de temps et aucun mixdown n'a été écrit.",
  "render.noOutput": () =>
    `FL Studio s'est fermé sans écrire de mixdown. Si FL Studio est déjà ouvert, ferme-le et relance le rendu (il ne peut pas faire de rendu en ligne de commande pendant qu'il tourne)${nb}; sinon vérifie le chemin de FL Studio et le format dans les Réglages.`,
  "render.outputFolder": () => "Le dossier d'export n'a pas pu être créé.",
  "render.move": () => "Le fichier rendu n'a pas pu être déplacé dans le dossier d'export.",
  "render.format": (p) => `Format de rendu non pris en charge${nb}: ${s(p, "format")}`,
  "render.worker": () => "Le rendu s'est arrêté avant la fin. Réessaie.",
  "render.missingSamples": (p) =>
    `Rendu fait, mais ${plural(Number(p.count), "1 sample rangé à côté du projet est introuvable", `${s(p, "count")} samples rangés à côté du projet sont introuvables`, "fr")}, donc ${plural(Number(p.count), "muet", "muets", "fr")} dans ce mixdown${nb}: ${s(p, "names")}`,
  "package.add": (p) => `${s(p, "name")} n'a pas pu être ajouté au pack zip.`,
  "audio.damaged": (p) => `${s(p, "name")} n'a pas pu être décodé (fichier audio abîmé ou inhabituel).`,
  "audio.unsupported": () => "Ce fichier audio ou ce codec n'est pas pris en charge.",
  "audio.read": () => "L'audio n'a pas pu être lu (fichier abîmé${nb}?).",
  "audio.empty": (p) => (p.name || p.path ? `${s(p, "name") || s(p, "path")} ne contient pas d'audio.` : "Le fichier ne contient pas d'audio."),
  "audio.tooLong": (p) => `${s(p, "path")} dure plus de 30 minutes${nb}: pas converti.`,
  "kit.badFileName": (p) => `Un fichier du Launch Kit ne peut pas s'appeler ${s(p, "name")}.`,
  "kit.outputUnreachable": () => "Le dossier d'export est inaccessible.",
  "kit.outsideOutput": () => "Le dossier Launch Kits n'est pas dans le dossier d'export.",
  "kit.notKitFolder": (p) => `${s(p, "path")} n'est pas un dossier de Launch Kit.`,
  "kit.tooMany": (p) => `Trop de Launch Kits s'appellent ${s(p, "name")}.`,
  "ffmpeg.run": (p) => `ffmpeg n'a pas pu tourner (${s(p, "path")}).`,
  "ffmpeg.noH264": () => "Ce ffmpeg n'a pas d'encodeur H.264. Installe une version complète (brew install ffmpeg / winget install Gyan.FFmpeg).",
  "ffmpeg.start": () => "ffmpeg n'a pas pu démarrer.",
  "ffmpeg.failed": () => "ffmpeg a échoué sur ce short.",
  "ffmpeg.timeout": () => "ffmpeg a pris trop de temps et a été arrêté.",
  "ffmpeg.wait": () => "ffmpeg ne répond plus.",
  "ffmpeg.check": () => "Hivo n'a pas pu vérifier ffmpeg.",
  "ffmpeg.notSetUp": () => "ffmpeg n'est pas encore réglé. Voir Réglages → Shorts (ffmpeg).",
  "shorts.layoutTooLarge": () => "L'image du short est trop grande.",
  "shorts.layoutInvalid": () => "L'image du short n'est pas valide.",
  "shorts.noMixdown": (p) => `Le mixdown est introuvable${nb}: ${s(p, "path")}`,
  "shorts.badFormat": () => "Ce mixdown n'est ni en WAV, ni en MP3, FLAC ou OGG.",
  "shorts.badRange": () => "Le début ou la durée de cet extrait n'est pas valide.",
  "cover.needBoth": () => "Saisis l'ID de compte et le jeton d'API.",
  "cover.badAccountId": () => "Ça ne ressemble pas à un ID de compte Cloudflare (32 lettres a–f et chiffres). Copie-le depuis la page Workers AI du tableau de bord.",
  "cover.badToken": () => "Ça ne ressemble pas à un jeton d'API Cloudflare. Recopie-le, sans espaces.",
  "cover.quota": () => "Le quota gratuit Workers AI du jour (10 000 neurones, environ 170 concepts) est épuisé. Il repart à 00 h 00 UTC.",
  "cover.capacity": () => "Cloudflare n'a plus de capacité pour FLUX en ce moment, même après plusieurs essais. Réessaie dans une minute.",
  "cover.tokenRejected": () => "Cloudflare a refusé le jeton d'API. Vérifie-le dans Réglages → Cover (il lui faut la permission Workers AI).",
  "cover.tokenNotAllowed": () => `Ce jeton n'a pas le droit de lancer Workers AI sur ce compte. Crées-en un avec le modèle «${nb}Workers AI${nb}» (Réglages → Cover).`,
  "cover.noAccount": () => "Cloudflare ne trouve pas cet ID de compte. Vérifie-le dans Réglages → Cover.",
  "cover.refused": (p) => `Cloudflare a refusé la demande${nb}: ${s(p, "msg")}`,
  "cover.timeout": () => "FLUX a mis trop de temps à répondre. Réessaie.",
  "cover.trouble": (p) => `Cloudflare Workers AI a des soucis (${s(p, "status")}), même après plusieurs essais. Réessaie dans quelques minutes.`,
  "cover.error": (p) => `Erreur Cloudflare${nb}: ${s(p, "msg")}`,
  "cover.http": (p) => `Erreur Cloudflare (HTTP ${s(p, "status")}).`,
  "cover.failed": () => "Cloudflare a signalé un échec sans détails.",
  "cover.offline": () => `Impossible de joindre Cloudflare. Ta connexion internet marche${nb}?`,
  "cover.badImage": () => "La réponse de FLUX n'est pas une image utilisable. Réessaie.",
  "cover.off": () => "Les concepts de cover sont désactivés. Ajoute un ID de compte et un jeton Cloudflare gratuits dans Réglages → Cover.",
  "cover.emptyPrompt": () => "Le prompt de la cover est vide. Écris d'abord un brief de cover.",
  "cover.longPrompt": (p) => `Le prompt de la cover est plus long que ce que FLUX accepte (${s(p, "max")} caractères).`,
  "cover.tooLarge": () => "Cette image est trop lourde pour être enregistrée.",
  "cover.corrupted": () => "Les données de l'image sont abîmées.",
  "cover.notJpeg": () => "Seuls les concepts en JPEG peuvent être enregistrés.",
  "secret.save": () => "La clé n'a pas pu être enregistrée.",
  "secret.remove": () => "La clé n'a pas pu être retirée.",
  "gemini.noKey": () => "Pas encore de clé d'API Gemini. Ajoute une clé gratuite dans Réglages → IA.",
  "gemini.badModel": (p) => `«${nb}${s(p, "model")}${nb}» n'est pas un nom de modèle valide.`,
  "gemini.keyRejected": () => "La clé d'API Gemini a été refusée. Vérifie-la dans Réglages → IA.",
  "gemini.keyNotAllowed": () => "Cette clé d'API Gemini n'a pas accès à l'API. Vérifie-la dans Réglages → IA.",
  "gemini.noModel": (p) => `Le modèle Gemini «${nb}${s(p, "model")}${nb}» est introuvable. Choisis-en un autre dans Réglages → IA.`,
  "gemini.dailyQuota": (p) =>
    `Le quota Gemini gratuit du jour est épuisé pour ${s(p, "model")} et le modèle de secours ${s(p, "fallback")}. Il repart à minuit heure du Pacifique (9 h à Paris). Le reste du Launch Kit marche toujours.`,
  "gemini.busy": (p) => `L'offre gratuite de Gemini est saturée (trop de demandes cette minute), même sur le modèle de secours ${s(p, "fallback")}. Attends une minute et réessaie.`,
  "gemini.overloaded": (p) =>
    `Gemini est surchargé en ce moment (${s(p, "status")}), même après plusieurs essais et le modèle de secours ${s(p, "fallback")}. Ça vient de Google${nb}: réessaie dans quelques minutes.`,
  "gemini.error": (p) => `Erreur Gemini${nb}: ${s(p, "msg")}`,
  "gemini.http": (p) => `Erreur Gemini (HTTP ${s(p, "status")}).`,
  "gemini.offline": () => `Impossible de joindre Gemini. Ta connexion internet marche${nb}?`,
  "gemini.deadline": () => "Gemini n'a pas répondu en 2 minutes (saturé ou limité). Réessaie plus tard.",
  "gemini.timeout": () => "Les serveurs de Gemini sont trop chargés pour répondre (le modèle de secours aussi). Réessaie dans quelques minutes.",
  "gemini.blocked": (p) => `Gemini a refusé la demande (bloquée${nb}: ${s(p, "reason")}).`,
  "gemini.safety": () => "Gemini s'est arrêté pour des raisons de sécurité. Réessaie, ou modifie le texte à la main.",
  "gemini.cutOff": () => "La réponse de Gemini a été coupée. Réessaie.",
  "gemini.noText": () => "La réponse de Gemini est vide. Réessaie.",
  "gemini.badJson": () => "La réponse de Gemini n'est pas valide. Réessaie.",
  "ai.tooLong": () => "Un texte du son est trop long pour être envoyé.",
  "ai.unknownField": (p) => `Champ du Launch Kit inconnu${nb}: ${s(p, "field")}`,
  "ai.nothingToCheck": () => "Rien à vérifier.",
  "dig.invalid": () => "Ce n'est pas une recherche du Digger.",
  "dig.tooBig": () => "La recherche est trop grosse pour être gardée.",
  "dig.forget": () => "La dernière recherche n'a pas pu être oubliée.",
  "dig.keep": () => "La recherche n'a pas pu être gardée pour la prochaine fois.",
  "dig.noBeats": () => "Choisis au moins un beat.",
  "dig.tooManyBeats": (p) => `${s(p, "max")} beats maximum.`,
  "dig.language": () => "Langue inconnue.",
  "dig.noneRead": (p) => `Aucun des beats choisis n'a pu être lu (${s(p, "names")}).`,
  "dig.excerptsTooBig": () => "Les extraits sont trop lourds à envoyer. Essaie avec moins de beats.",
  "dig.webOff": () => "La recherche web de Gemini n'est pas dispo sur cette clé pour l'instant (elle n'est pas incluse dans tous les quotas gratuits). Les recherches ci-dessus et YouTube marchent toujours.",
  "dig.noLinks": () => "La recherche Google n'a trouvé aucun lien cette fois. Utilise les recherches ci-dessus.",
  "dig.noNewSearches": () => "Gemini n'a pas trouvé de nouvelles recherches cette fois. Réessaie.",
  "dig.nothingNew": () => "Rien de nouveau cette fois. Réessaie plus tard ou utilise les recherches ci-dessus.",
  "beats.tooMany": (p) => `${s(p, "max")} beats maximum par appel.`,
  "beats.gone": () => "Le fichier n'est plus là.",
  "lead.badLink": () => "Ce lien ne peut pas être enregistré (liens https uniquement).",
  "lead.noBeatFolder": () => "Ajoute d'abord un dossier de beats dans les Réglages.",
  "youtube.badKey": () => "Ça ne ressemble pas à une clé d'API Google. Recopie-la, sans espaces.",
  "youtube.emptyQuery": () => "Tape quelque chose à chercher.",
  "youtube.longQuery": (p) => `Cette recherche est trop longue (${s(p, "max")} caractères max).`,
  "youtube.badQuery": () => "Cette recherche contient des caractères que YouTube refuse.",
  "youtube.quota": () => "Le quota YouTube gratuit du jour (environ 100 recherches) est épuisé. Il repart à minuit heure du Pacifique. Les liens de recherche YouTube marchent toujours.",
  "youtube.keyRejected": () => "YouTube a refusé la clé d'API. Vérifie-la dans Réglages → Recherche YouTube.",
  "youtube.apiOff": () => "Le projet Google Cloud de cette clé n'a pas activé YouTube Data API v3. Active-la dans la console Google Cloud, puis réessaie.",
  "youtube.keyNotAllowed": () => "Cette clé n'a pas le droit d'appeler YouTube Data API. Vérifie ses restrictions d'API dans la console Google Cloud.",
  "youtube.trouble": (p) => `YouTube a des soucis (${s(p, "status")}). Réessaie dans une minute.`,
  "youtube.http": (p) => `La recherche YouTube a échoué (HTTP ${s(p, "status")}).`,
  "youtube.timeout": () => "YouTube a mis trop de temps à répondre. Réessaie.",
  "youtube.offline": () => `Impossible de joindre YouTube. Ta connexion internet marche${nb}?`,
  "youtube.noKey": () => "Pas encore de clé d'API YouTube. Ajoutes-en une dans Réglages → Recherche YouTube.",
  "lookup.timeout": (p) => `${s(p, "service")} n'a pas répondu à temps. Réessaie.`,
  "lookup.offline": (p) => `Impossible de joindre ${s(p, "service")}. Vérifie ta connexion.`,
  "lookup.failed": (p) => `${s(p, "service")} n'a pas répondu.`,
  "lookup.tooMuch": (p) => `${s(p, "service")} a envoyé trop de données.`,
  "lookup.busy": (p) => `${s(p, "service")} est saturé (limite de requêtes). Attends quelques secondes et réessaie.`,
  "lookup.notFound": (p) => `${s(p, "service")}${nb}: introuvable.`,
  "lookup.refused": (p) => `${s(p, "service")} a refusé la demande (${s(p, "status")}). Vérifie les identifiants dans les Réglages.`,
  "lookup.http": (p) => `${s(p, "service")} a répondu ${s(p, "status")}.`,
  "lookup.badSpotifyId": () => "Ce n'est pas un ID d'artiste Spotify.",
  "lookup.badMbid": () => "Ce n'est pas un ID MusicBrainz.",
  "lookup.longLink": () => "Ce lien est trop long.",
  "lookup.badLink": () => "Ce n'est pas un lien de profil (http ou https).",
  "spotify.badCredentials": () => "Ça ne ressemble pas à un client id et un secret Spotify (32 caractères chacun, depuis le tableau de bord développeur Spotify).",
  "spotify.refused": (p) => `Spotify a refusé les identifiants (${s(p, "status")}). Vérifie le client id et le secret dans les Réglages.`,
  "spotify.noToken": () => "Spotify n'a pas envoyé de jeton.",
  "spotify.noCredentials": () => "Ajoute d'abord des identifiants Spotify dans les Réglages.",
  "phone.firewall": () => "Les réglages du pare-feu n'ont pas pu s'ouvrir.",
  "phone.windowsOnly": () => "Seulement sur Windows.",
  "phone.unavailable": () => "La sync téléphone n'est pas dispo (pas de dossier de réglages).",
  "phone.off": () => "Active d'abord la sync téléphone.",
  "phone.noLan": () => "Aucune adresse réseau locale trouvée. Connecte d'abord cet ordi au Wi-Fi (ou à un réseau local).",
  "phone.noProjectFolder": () => "Lie d'abord un dossier de projets dans les Réglages.",
  "inbox.gone": () => "Cet élément n'est plus dans la boîte du téléphone.",
  "inbox.fileMissing": (p) => `Un fichier manque dans la boîte du téléphone${nb}: ${s(p, "name")}`,
  "inbox.ideaNoAudio": () => "Une idée n'a pas d'audio à copier.",
  "inbox.nameTaken": (p) => `«${nb}${s(p, "name")}${nb}» existe déjà dans ce dossier${nb}: choisis un autre nom.`,
  "inbox.zipNoAudio": () => "Pas d'audio dans ce zip.",
  "inbox.songFolderGone": () => "Le dossier de ce son n'est plus là.",
  "inbox.memoNoAudio": () => "Ce mémo n'a pas d'audio.",
  "inbox.onlyMemo": () => "Seul un mémo vocal peut être lié à un beat ou une prod.",
  "inbox.beatFolderGone": () => "Ce dossier de beats n'est plus là.",
  "inbox.badZip": () => "Ce zip ne peut pas être lu.",
  "inbox.zipTooBig": () => "Le zip contient plus de 2 Go d'audio une fois décompressé.",
  "inbox.notASong": () => "Ce n'est pas un son d'un dossier lié.",
  "inbox.badStatus": (p) => `Statut inconnu${nb}: ${s(p, "status")}`,
  "inbox.io": () => "Un fichier de la boîte du téléphone n'a pas pu être copié.",
  "session.open": () => "La fenêtre de session n'a pas pu s'ouvrir.",
  "sketch.converted": (p) => `${s(p, "name")} converti en WAV pour FL Studio`,
  "sketch.convertFailed": () => "Un fichier BandLab n'a pas pu être converti en WAV",
  "sketch.notSketch": (p) => `Ce n'est pas un sketch BandLab${nb}: ${s(p, "path")}`,
  "sketch.hasProject": () => `Ce son a déjà un projet${nb}: ouvre-le depuis la Bibliothèque.`,
  "sketch.noPlayable": () => "Aucun audio que FL Studio peut lire dans le dossier BandLab.",
  "sketch.notInProject": (p) => `L'audio BandLab n'est pas dans le projet (${s(p, "reason")})${nb}: glisse-le depuis le dossier BandLab`,
  "workspace.unreadableNow": () => "Ton espace de travail est illisible pour l'instant, donc rien n'a changé. Règle ça et clique sur Réessayer.",
  "workspace.readsFine": () => "Ton espace de travail se lit bien maintenant, donc rien n'a changé. Clique sur Réessayer.",
  "workspace.read": () => "Ton espace de travail n'a pas pu être lu.",
  "workspace.parse": () => "Le fichier de ton espace de travail est abîmé.",
  "workspace.write": () => "Ton espace de travail n'a pas pu être enregistré.",
  "workspace.moveAside": () => "L'espace de travail illisible n'a pas pu être mis de côté.",
  "workspace.noBackup": () => "Il n'y a pas de sauvegarde de ton espace de travail.",
  "workspace.backupUnreadable": () => "La sauvegarde de l'espace de travail est illisible elle aussi.",
};

const T = dict(
  {
    failed: (raw: string) => `Something went wrong: ${raw}`,
  },
  {
    failed: (raw: string) => `Ça n'a pas marché${nb}: ${raw}`,
  },
);

/** Every code the app translates (the Rust test reads the keys of EN). */
export const ERROR_CODES = Object.keys(EN);

/** The raw string a rejection carries (Tauri rejects with a string). */
function rawOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e);
}

/** The coded error in `e`, if it is one. */
export function parseError(e: unknown): CodedError | null {
  const raw = rawOf(e).trim();
  if (!raw.startsWith("{")) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && typeof (v as CodedError).code === "string") return v as CodedError;
  } catch {
    // not JSON: a plain message
  }
  return null;
}

/** The English detail of the last translated errors, by their sentence, so
 * a banner that shows one can hand the raw text to "Report this". */
const recent = new Map<string, string>();

/** A coded error's sentence, or null when the code isn't known here. */
function translate(c: CodedError): string | null {
  const msg = tr({ en: EN, fr: FR })[c.code] ?? EN[c.code];
  if (!msg) return null;
  const params: ErrorParams = {};
  for (const [k, v] of Object.entries(c.params ?? {})) {
    // A param can be a coded error itself (the reason inside a note).
    params[k] = typeof v === "string" && v.startsWith("{") ? errorReason(v) : v;
  }
  const text = msg(params);
  if (c.detail && c.detail !== text) {
    recent.delete(text);
    recent.set(text, c.detail);
    if (recent.size > 20) recent.delete(recent.keys().next().value as string);
  }
  return text;
}

/** The raw English behind a shown message that contains a translated error
 * (for the "Report this" form and a tooltip), if there's one. */
export function detailBehind(shown: string): string | null {
  for (const [text, detail] of [...recent].reverse()) if (shown.includes(text)) return detail;
  return null;
}

/** The raw English of an error (for a tooltip and the feedback form). */
export function errorDetail(e: unknown): string {
  const c = parseError(e);
  if (c) return c.detail || c.code;
  return rawOf(e);
}

/** What went wrong, translated when it's coded, else the message as is
 * (for use inside a sentence that already says what failed). */
export function errorReason(e: unknown): string {
  const c = parseError(e);
  if (c) return translate(c) ?? (c.detail || c.code);
  return rawOf(e);
}

/** The sentence to show for an error from a Tauri command. A coded error
 * gets its translation (unknown code: its English detail); a plain string
 * from Rust gets a translated lead; an Error thrown by the app's own code
 * is shown as is (it's already in the app's language). */
export function errorText(e: unknown): string {
  const c = parseError(e);
  if (c) return translate(c) ?? tr(T).failed(c.detail || c.code);
  if (e instanceof Error) return e.message;
  return tr(T).failed(rawOf(e));
}

/** Same as `errorText`, for a value that may be empty (an optional `error`
 * field): null stays null. */
export function errorTextOr(e: unknown): string | null {
  return e === null || e === undefined || e === "" ? null : errorText(e);
}

/** For the typography test: every French message, filled with sample params. */
export function frenchErrorSamples(): string[] {
  const p: ErrorParams = { path: "/x/y", name: "Envy", what: "project", count: 2, max: 3, status: 500, model: "m", fallback: "f", msg: "m", reason: "r", service: "Spotify", version: "21.2", format: "wav", field: "f", names: "a, b" };
  return Object.values(FR).map((m) => m(p));
}

/** For the tests: codes with an English sentence but no French one, or the other way round. */
export function untranslatedCodes(): string[] {
  return [...Object.keys(EN).filter((k) => !FR[k]), ...Object.keys(FR).filter((k) => !EN[k])];
}
