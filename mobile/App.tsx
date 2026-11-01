import { useFonts } from "expo-font";
import { getLocales } from "expo-localization";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Platform, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { onShare, takeShared, type Shared } from "./modules/hivo-share";
import { setLang, tr } from "./src/lib/i18n";
import type { IdeaTarget } from "./src/lib/ideas";
import { parsePairingUrl } from "./src/lib/pairing";
import { T } from "./src/strings";
import type { Kind } from "./src/lib/sync";
import { UpdateBanner } from "./src/components/UpdateBanner";
import { pickFiles } from "./src/files";
import { IdeaScreen } from "./src/screens/IdeaScreen";
import { LibraryScreen, type Tab } from "./src/screens/LibraryScreen";
import { NoteScreen } from "./src/screens/NoteScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { RecordScreen } from "./src/screens/RecordScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ShareScreen, type IncomingShare } from "./src/screens/ShareScreen";
import { addIdea, flush, flushExtras, getState, load, pair, sync, useApp } from "./src/store";
import { C } from "./src/theme";

setLang(getLocales()[0]?.languageCode);

/** A hivo://pair link opened from the system camera (or `simctl openurl`):
 * only when no computer is paired yet, and only after the user says yes
 * (any app or page can open a link; pairing sends notes to that address). */
function pairFromLink(url: string | null | undefined): void {
  if (!url || getState().pairing) return;
  const r = parsePairingUrl(url, { loopback: Platform.OS === "ios" });
  if (!r.ok) return;
  const t = tr(T);
  const { desktopName, hosts, port } = r.pairing;
  Alert.alert(t.linkPairTitle, t.linkPairBody(desktopName, `${hosts[0]}:${port}`), [
    { text: t.cancel, style: "cancel" },
    {
      text: t.linkPairYes,
      onPress: () => {
        if (getState().pairing) return;
        void pair(r.pairing).then(() => void sync());
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

const fromNative = (s: Shared): IncomingShare => ({ files: s.files, skipped: s.skipped, text: s.text, subject: s.subject, picked: false });

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_600SemiBold: require("@expo-google-fonts/barlow-condensed/600SemiBold/BarlowCondensed_600SemiBold.ttf"),
  });
  const loaded = useApp((s) => s.loaded);
  const paired = useApp((s) => s.pairing !== null);
  const [route, setRoute] = useState<Route>({ name: "library" });
  const [tab, setTab] = useState<Tab>("prod");
  const routeRef = useRef(route);
  routeRef.current = route;
  // A share that arrived while recording waits until the take is saved or dropped.
  const [queuedShare, setQueuedShare] = useState<Shared | null>(null);
  const showShare = (s: Shared) => {
    if (routeRef.current.name === "record") setQueuedShare(s);
    else setRoute({ name: "share", share: fromNative(s), at: Date.now() });
  };
  useEffect(() => {
    if (queuedShare && route.name !== "record") {
      setRoute({ name: "share", share: fromNative(queuedShare), at: Date.now() });
      setQueuedShare(null);
    }
  }, [queuedShare, route.name]);

  useEffect(() => {
    void load().then(async () => {
      if (getState().pairing) void sync();
      else pairFromLink(await Linking.getInitialURL());
      // Started by "Share to Hivo".
      const shared = await takeShared().catch(() => null);
      if (shared) showShare(shared);
    });
    const link = Linking.addEventListener("url", ({ url }) => {
      if (getState().loaded) pairFromLink(url);
    });
    // Shared while Hivo is open.
    const share = onShare(showShare);
    // Sync when the app comes back; save the cache when it leaves.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        if (getState().pairing) void sync();
        // Shared while Hivo was in the background (the intent is waiting).
        void takeShared()
          .then((shared) => shared && showShare(shared))
          .catch(() => {});
      } else if (s === "background" || s === "inactive") {
        void flush();
        void flushExtras();
      }
    });
    return () => {
      sub.remove();
      link.remove();
      share.remove();
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
        if (Object.keys(getState().sync.pending).length > 0) void sync();
      }, 50);
    }
  }

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (route.name === "library") return false;
      // Never leave a recording by the back button: Stop first.
      if (route.name === "record") return true;
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

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.chassis }} edges={["top", "bottom", "left", "right"]}>
        <StatusBar style="light" />
        {ready ? <UpdateBanner /> : null}
        {!ready ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={C.hot} />
          </View>
        ) : route.name === "share" ? (
          <ShareScreen key={route.at} share={route.share} onDone={goBack} onIdea={(id) => setRoute({ name: "idea", id })} />
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
          <RecordScreen target={route.target} onDone={goBack} />
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
