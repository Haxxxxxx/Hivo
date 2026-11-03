import { describe, expect, it } from "vitest";
import { canonicalUrl, externalUrl, fromPlayerPage, navDecision, parsePlayerMessage, playerUrl, problemFor, youtubeId } from "./youtube";

const ID = "dQw4w9WgXcQ";
const PAGE = `https://www.hi-vo.fr/embed.html?v=${ID}&hl=en`;

describe("youtubeId (same vectors as the desktop's digger.test.ts)", () => {
  it("reads the video ID of YouTube links only", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(ID);
    expect(youtubeId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1")).toBe(ID);
    expect(youtubeId("https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ")).toBe(ID);
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(ID);
    expect(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share")).toBe(ID);
    expect(youtubeId("https://www.youtube.com/results?search_query=beat")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=too-short")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ/../x")).toBeNull();
    expect(youtubeId("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeId("https://www.beatstars.com/beat/night-123")).toBeNull();
    expect(youtubeId("javascript:alert(1)")).toBeNull();
    expect(youtubeId("")).toBeNull();
  });

  it("normalises YouTube addresses, trims the rest", () => {
    const watch = `https://www.youtube.com/watch?v=${ID}`;
    for (const u of ["https://youtu.be/dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?si=abc", "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ", ` ${watch}&t=42s `]) {
      expect(canonicalUrl(u)).toBe(watch);
    }
    expect(canonicalUrl(" https://www.beatstars.com/beat/night-123 ")).toBe("https://www.beatstars.com/beat/night-123");
  });
});

describe("the player page", () => {
  it("frames the website's page with a strict id and the app's language", () => {
    expect(playerUrl(ID, "en")).toBe(PAGE);
    expect(playerUrl(ID, "fr")).toBe(`https://www.hi-vo.fr/embed.html?v=${ID}&hl=fr`);
    expect(playerUrl(`${ID}&autoplay=0`, "en")).toBeNull();
    expect(playerUrl("../x", "en")).toBeNull();
    expect(playerUrl("", "en")).toBeNull();
  });

  it("keeps the top frame on the player page and the frames on YouTube's player hosts", () => {
    expect(navDecision(PAGE, true, PAGE)).toBe("allow");
    expect(navDecision("about:blank", true, PAGE)).toBe("allow");
    // Another page of the website, even another video: not without a tap on Play.
    expect(navDecision("https://www.hi-vo.fr/", true, PAGE)).toBe("block");
    expect(navDecision("https://www.hi-vo.fr/embed.html?v=aaaaaaaaaaa&hl=en", true, PAGE)).toBe("block");
    expect(navDecision(`https://www.youtube-nocookie.com/embed/${ID}?autoplay=1`, false, PAGE)).toBe("allow");
    expect(navDecision("https://i.ytimg.com/vi/x/hq.jpg", false, PAGE)).toBe("allow");
    expect(navDecision("https://rr1---sn-abc.googlevideo.com/videoplayback", false, PAGE)).toBe("allow");
    // The player frame itself can't take over the top.
    expect(navDecision(`https://www.youtube-nocookie.com/embed/${ID}`, true, PAGE)).toBe("external");
  });

  it("lets YouTube links out to the app or browser, drops everything else", () => {
    expect(navDecision(`https://www.youtube.com/watch?v=${ID}`, true, PAGE)).toBe("external");
    expect(navDecision(`https://www.youtube.com/watch?v=${ID}`, false, PAGE)).toBe("external");
    expect(navDecision("https://youtu.be/x", false, PAGE)).toBe("external");
    expect(navDecision("https://accounts.google.com/ServiceLogin", false, PAGE)).toBe("block");
    expect(navDecision("http://www.youtube.com/watch?v=x", true, PAGE)).toBe("block");
    expect(navDecision("intent://scan/#Intent;scheme=zxing;end", true, PAGE)).toBe("block");
    expect(navDecision("file:///data/data/fr.hivo.mobile/x", false, PAGE)).toBe("block");
    expect(navDecision("javascript:alert(1)", true, PAGE)).toBe("block");
    expect(navDecision("https://user@www.youtube.com/", true, PAGE)).toBe("block");
    expect(navDecision("https://www.youtube.com:8443/", true, PAGE)).toBe("block");
    expect(navDecision("https://evil.example/www.youtube.com", true, PAGE)).toBe("block");
    expect(navDecision("https://youtube.com.evil.example/", true, PAGE)).toBe("block");
    expect(navDecision("https://evilytimg.com/", false, PAGE)).toBe("block");
  });

  it("opens a let-out video at its plain watch address", () => {
    expect(externalUrl(`https://www.youtube-nocookie.com/embed/${ID}?autoplay=1`)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(externalUrl(`https://www.youtube.com/watch?v=${ID}&feature=emb_logo`)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(externalUrl("https://www.youtube.com/@channel")).toBe("https://www.youtube.com/@channel");
  });

  it("reads only the player page's own messages", () => {
    expect(parsePlayerMessage('{"hivo":1,"type":"ready"}')).toEqual({ type: "ready" });
    expect(parsePlayerMessage('{"hivo":1,"type":"state","state":1}')).toEqual({ type: "state", state: 1 });
    expect(parsePlayerMessage('{"hivo":1,"type":"error","code":150}')).toEqual({ type: "error", code: 150 });
    expect(parsePlayerMessage('{"type":"error","code":150}')).toBeNull();
    expect(parsePlayerMessage('{"hivo":1,"type":"error","code":"150"}')).toBeNull();
    expect(parsePlayerMessage('{"hivo":1,"type":"error","code":1.5}')).toBeNull();
    expect(parsePlayerMessage('{"hivo":1,"type":"navigate","url":"x"}')).toBeNull();
    expect(parsePlayerMessage("not json")).toBeNull();
    expect(parsePlayerMessage("null")).toBeNull();
    expect(parsePlayerMessage(`{"hivo":1,"type":"ready","pad":"${"x".repeat(300)}"}`)).toBeNull();
    expect(fromPlayerPage(PAGE)).toBe(true);
    expect(fromPlayerPage("https://www.hi-vo.fr/")).toBe(false);
    expect(fromPlayerPage(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(false);
    expect(fromPlayerPage("https://www.hi-vo.fr.evil.example/embed.html")).toBe(false);
  });

  it("tells a blocked embed from a missing video", () => {
    expect(problemFor(150)).toBe("blocked");
    expect(problemFor(101)).toBe("blocked");
    expect(problemFor(100)).toBe("unavailable");
    expect(problemFor(153)).toBe("refused");
    expect(problemFor(5)).toBe("failed");
  });
});
