// Settings → Send feedback: a bug, an idea or a question, to the same place
// as the desktop app's feedback button (src/sendFeedback.ts).
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MAX_FEEDBACK_CHARS, MAX_REPLY_TO_CHARS, type FeedbackCategory, type FeedbackError } from "../lib/feedback";
import { dict, tr } from "../lib/i18n";
import { canSendFeedback, sendFeedback } from "../sendFeedback";
import { C, FONT, RADIUS, S } from "../theme";
import { Button, Engrave } from "./ui";

const NB = " ";

const T = dict(
  {
    title: "Send feedback",
    intro: "A bug, an idea or a question: it goes straight to the people making Hivo. Only what you write here is sent, with the app version, Android version and language.",
    bug: "Bug",
    idea: "Idea",
    question: "Question",
    messageLabel: "Your message",
    placeholder: "What happened, or what you'd like…",
    replyLabel: "Your email, if you want an answer (optional)",
    send: "Send",
    sending: "Sending…",
    sent: "Sent, thanks! We read every message.",
    errors: {
      empty: "Write something first.",
      off: "This build of Hivo can't send feedback.",
      offline: "Couldn't reach the server. Check the internet connection and try again.",
      today: "That's 10 messages today from this phone: try again tomorrow.",
      busy: "The server is busy right now: try again in a moment.",
      server: "The server refused the message. Try again later.",
    } as Record<FeedbackError, string>,
    unavailable: "This build of Hivo can't send feedback (no server set).",
  },
  {
    title: "Envoyer un retour",
    intro: `Un bug, une idée ou une question${NB}: ça va directement aux gens qui font Hivo. Seul ce que tu écris ici est envoyé, avec la version de l'appli, la version d'Android et la langue.`,
    bug: "Bug",
    idea: "Idée",
    question: "Question",
    messageLabel: "Ton message",
    placeholder: "Ce qui s'est passé, ou ce que tu aimerais…",
    replyLabel: "Ton e-mail, si tu veux une réponse (facultatif)",
    send: "Envoyer",
    sending: "Envoi…",
    sent: `Envoyé, merci${NB}! On lit tous les messages.`,
    errors: {
      empty: "Écris quelque chose d'abord.",
      off: "Cette version de Hivo ne peut pas envoyer de retour.",
      offline: "Impossible de joindre le serveur. Vérifie la connexion internet et réessaie.",
      today: `Ça fait 10 messages aujourd'hui depuis ce téléphone${NB}: réessaie demain.`,
      busy: `Le serveur est occupé${NB}: réessaie dans un instant.`,
      server: "Le serveur a refusé le message. Réessaie plus tard.",
    } as Record<FeedbackError, string>,
    unavailable: "Cette version de Hivo ne peut pas envoyer de retour (pas de serveur configuré).",
  },
);

const CATEGORIES: FeedbackCategory[] = ["bug", "idea", "question"];

export function FeedbackPanel() {
  const t = tr(T);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: true } | { ok: false; error: FeedbackError } | null>(null);

  if (!canSendFeedback()) {
    return (
      <View style={{ marginTop: S.xl }}>
        <Engrave>{t.title}</Engrave>
        <Text style={styles.note}>{t.unavailable}</Text>
      </View>
    );
  }

  async function send() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    const r = await sendFeedback({ category, message, replyTo });
    setBusy(false);
    setStatus(r);
    if (r.ok) {
      setMessage("");
      setReplyTo("");
    }
  }

  return (
    <View style={{ marginTop: S.xl }}>
      <Engrave>{t.title}</Engrave>
      <Text style={styles.note}>{t.intro}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {CATEGORIES.map((c) => {
          const on = c === category;
          return (
            <Pressable
              key={c}
              onPress={() => setCategory(c)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, checked: on }}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{t[c]}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        value={message}
        onChangeText={(v) => {
          setMessage(v);
          if (status) setStatus(null);
        }}
        placeholder={t.placeholder}
        placeholderTextColor={C.engrave}
        accessibilityLabel={t.messageLabel}
        multiline
        maxLength={MAX_FEEDBACK_CHARS}
        style={[styles.input, { minHeight: 120 }]}
      />
      <TextInput
        value={replyTo}
        onChangeText={setReplyTo}
        placeholder={t.replyLabel}
        placeholderTextColor={C.engrave}
        accessibilityLabel={t.replyLabel}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        maxLength={MAX_REPLY_TO_CHARS}
        style={[styles.input, { marginTop: S.sm }]}
      />
      <Button label={busy ? t.sending : t.send} onPress={() => void send()} disabled={busy || !message.trim()} style={{ marginTop: S.md }} />
      {status ? (
        <Text style={[styles.result, { color: status.ok ? C.ok : C.missing }]} accessibilityLiveRegion="polite">
          {status.ok ? t.sent : t.errors[status.error]}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { color: C.engrave, fontSize: 13, lineHeight: 18, marginTop: S.sm },
  chips: { flexDirection: "row", gap: S.sm, marginTop: S.md },
  chip: { minHeight: 48, flex: 1, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.rule, borderRadius: RADIUS, backgroundColor: C.panel },
  chipOn: { borderColor: C.cream, backgroundColor: C.chassis },
  chipText: { color: C.body, fontFamily: FONT.display, fontSize: 15, textTransform: "uppercase", letterSpacing: 0.5 },
  chipTextOn: { color: C.cream },
  input: {
    marginTop: S.md,
    borderWidth: 1,
    borderColor: C.rule,
    backgroundColor: C.chassis,
    borderRadius: RADIUS,
    color: C.cream,
    padding: 10,
    fontSize: 15,
    textAlignVertical: "top",
  },
  result: { fontSize: 14, lineHeight: 20, marginTop: S.sm },
});
