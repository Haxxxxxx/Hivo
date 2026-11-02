import { useFonts } from "expo-font";
import { getLocales } from "expo-localization";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Platform, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { onShare, onShareStart, sweepShareCache, takeShared, type Shared } from "./modules/hivo-share";
import { setLang, tr } from "./src/lib/i18n";
import type { IdeaTarget } from "./src/lib/ideas";
import { parsePairingUrl, type PairOffer, type Pairing } from "./src/lib/pairing";
import { dequeue, enqueue } from "./src/lib/shareQueue";
import { errorText, T } from "./src/strings";
import type { Kind } from "./src/lib/sync";
import { ConfirmPairing } from "./src/components/ConfirmPairing";
import { UpdateBanner } from "./src/components/UpdateBanner";
import { pickFiles } from "./src/files";
import { IdeaScreen } from "./src/screens/IdeaScreen";
import { LibraryScreen, type Tab } from "./src/screens/LibraryScreen";
import { NoteScreen } from "./src/screens/NoteScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { RecordScreen } from "./src/screens/RecordScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ShareScreen, type IncomingShare } from "./src/screens/ShareScreen";
import { addIdea, flush, flushExtras, getState, load, pair, requestSync, sync, useApp, verifyPairing } from "./src/store";
import { C } from "./src/theme";

setLang(getLocales()[0]?.languageCode);

/** Checks the computer answers, then saves the pairing and syncs. */
async function pairChecked(p: Pairing | PairOffer): Promise<void> {
  const t = tr(T);
  const v = await verifyPairing(p);
  if (!v.ok) {
    // null: cancelled on the phone while it waited for the computer's confirmation.
    if (v.code) Alert.alert(t.pairTitle, t.pairCheckFailed(errorText(v.code)));
    return;
  }
  await pair(v.pairing);
  void sync();
}

/** A hivo://pair link opened from the system camera (or `simctl openurl`),
 * only after the user says yes (any app or page can open a link; pairing
 * sends notes to that address). When already paired, it offers to replace
 * the pairing (the computer's address changed, or another computer);
 * unsynced note edits are carried over. */
function pairFromLink(url: string | null | undefined): void {
  if (!url) return;
  const r = parsePairingUrl(url, { loopback: Platform.OS === "ios" });
  if (!r.ok) return;
  const t = tr(T);
  const link = "offer" in r ? r.offer : r.pairing;
  const { desktopName, hosts, port, deviceId } = link;
  const current = getState().pairing;
  if ("pairing" in r && current?.deviceId === deviceId && current.key === r.pairing.key) return;
  const title = current ? t.replacePairTitle(desktopName) : t.linkPairTitle;
  const body = current ? t.replacePairBody(current.desktopName, `${hosts[0]}:${port}`) : t.linkPairBody(desktopName, `${hosts[0]}:${port}`);
  Alert.alert(title, body, [
    { text: t.cancel, style: "cancel" },
    {
      text: current ? t.replacePairYes : t.linkPairYes,
      onPress: () => {
        // Still the pairing the question was about.
        if (getState().pairing?.deviceId !== current?.deviceId) return;
        void pairChecked(link);
      },
    },
  ]);
}

type Route =
  | { name: "library" }
  | { name: "note"; kind: Kind; id: string }
  | { name: "settings" }
  | { name: "idea"; id: string }
  | { name: "record"; target: IdeaTarget | null }
  | { name: "share"; share: IncomingShare; at: number };

const fromNative = (s: Shared): IncomingShare => ({ files: s.files, skipped: s.skipped, text: s.text, subject: s.subject, picked: false, dir: s.dir });

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_600SemiBold: require("@expo-google-fonts/barlow-condensed/600SemiBold/BarlowCondensed_600SemiBold.ttf"),
  });
  const loaded = useApp((s) => s.loaded);
  const paired = useApp((s) => s.pairing !== null);
  const confirming = useApp((s) => s.confirming !== null);
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [tab, setTab] = useState<Tab>("prod");
  const routeRef = useRef(route);
  routeRef.current = route;
  /** What the hardware Back does on a screen that has its own rule (share, record). */
  const backRef = useRef<(() => void) | null>(null);
  // Shares that arrived while recording or while another share is on screen:
  // each waits its turn, none replaces another.
  const [queue, setQueue] = useState<Shared[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  /** A share's files are being copied (a big export takes a while). */
  const [copying, setCopying] = useState(false);
  const showShare = (s: Shared) => {
    setCopying(false);
    setQueue((q) => enqueue(q, s));
  };
  useEffect(() => {
    if (queue.length === 0 || route.name === "record" || route.name === "share") return;
    const { next, rest } = dequeue(queue);
    setQueue(rest);
    if (next) setRoute({ name: "share", share: fromNative(next), at: Date.now() });
  }, [queue, route.name]);

  useEffect(() => {
    // Shared while Hivo is open (registered first: a share can start copying right away).
    const share = onShare(showShare);
    const start = onShareStart(() => setCopying(true));
    void load().then(async () => {
      if (getState().pairing) void sync();
      pairFromLink(await Linking.getInitialURL());
      // Started by "Share to Hivo".
      const shared = await takeShared().catch(() => null);
      setCopying(false);
      if (shared) showShare(shared);
      // Copies left by an earlier run (killed mid-share): only this one is still wanted.
      const onScreen = routeRef.current.name === "share" ? routeRef.current.share.dir : null;
      void sweepShareCache([shared?.dir, onScreen, ...queueRef.current.map((q) => q.dir)].filter((d): d is string => !!d));
    });
    const link = Linking.addEventListener("url", ({ url }) => {
      if (getState().loaded) pairFromLink(url);
    });
    // Sync when the app comes back; save the cache when it leaves.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        if (getState().pairing) void sync();
        // Shared while Hivo was in the background (the intent is waiting).
        void takeShared()
          .then((shared) => {
            setCopying(false);
            if (shared) showShare(shared);
          })
          .catch(() => setCopying(false));
      } else if (s === "background" || s === "inactive") {
        void flush();
        void flushExtras();
      }
    });
    return () => {
      sub.remove();
      link.remove();
      share.remove();
      start.remove();
    };
  }, []);

  useEffect(() => {
    // Unpaired: back to pairing, except a share being sent (it waits in the outbox).
    if (!paired && routeRef.current.name !== "share" && routeRef.current.name !== "idea") setRoute({ name: "library" });
  }, [paired]);

  function goBack() {
    const fromNote = route.name === "note";
    const toInbox = route.name === "idea" || route.name === "record" || route.name === "share";
    setRoute({ name: "library" });
    if (toInbox) setTab("inbox");
    if (fromNote) {
      setTimeout(() => {
        if (Object.keys(getState().sync.pending).length > 0) requestSync();
      }, 50);
    }
  }

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (route.name === "library") return false;
      // Share and record have their own rule (cleanup, never leave a take).
      if (route.name === "share" || route.name === "record") {
        backRef.current?.();
        return true;
      }
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [route]);

  function newIdea(target: IdeaTarget | null) {
    setRoute({ name: "idea", id: addIdea({ target }) });
  }

  async function pick() {
    try {
      const files = await pickFiles();
      if (files.length > 0) setRoute({ name: "share", share: { files, skipped: [], text: null, subject: null, picked: true }, at: Date.now() });
    } catch (e) {
      console.warn("Hivo: the file picker failed", e);
    }
  }

  const ready = loaded && (fontsLoaded || fontError);
  const t = tr(T);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.chassis }} edges={["top", "bottom", "left", "right"]}>
        <StatusBar style="light" />
        {ready ? <UpdateBanner /> : null}
        {ready && copying ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: C.panel }}>
            <ActivityIndicator color={C.hot} size="small" />
            <Text style={{ color: C.cream, fontSize: 14 }}>{t.copyingShare}</Text>
          </View>
        ) : null}
        {!ready ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={C.hot} />
          </View>
        ) : confirming ? (
          // Scanned: compare the code with the computer's until it's confirmed there.
          <ConfirmPairing />
        ) : route.name === "share" ? (
          <ShareScreen key={route.at} share={route.share} onDone={goBack} onIdea={(id) => setRoute({ name: "idea", id })} backRef={backRef} />
        ) : route.name === "idea" && !paired ? (
          // An idea kept from a share before pairing: editable now, sent once paired.
          <IdeaScreen key={route.id} id={route.id} onBack={goBack} />
        ) : !paired ? (
          <PairScreen />
        ) : route.name === "note" ? (
          <NoteScreen
            key={`${route.kind}:${route.id}`}
            kind={route.kind}
            id={route.id}
            onBack={goBack}
            onRecord={(target) => setRoute({ name: "record", target })}
            onIdea={(target) => newIdea(target)}
          />
        ) : route.name === "idea" ? (
          <IdeaScreen key={route.id} id={route.id} onBack={goBack} />
        ) : route.name === "record" ? (
          <RecordScreen target={route.target} onDone={goBack} backRef={backRef} />
        ) : route.name === "settings" ? (
          <SettingsScreen onBack={() => setRoute({ name: "library" })} />
        ) : (
          <LibraryScreen
            tab={tab}
            onTab={setTab}
            onOpen={(i) => setRoute({ name: "note", kind: i.kind, id: i.id })}
            onSettings={() => setRoute({ name: "settings" })}
            onIdea={(id) => (id ? setRoute({ name: "idea", id }) : newIdea(null))}
            onRecord={() => setRoute({ name: "record", target: null })}
            onPick={() => void pick()}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
