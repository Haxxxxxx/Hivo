import { describe, expect, it } from "vitest";
import { crewErrorMessage, crewText, currentUiLang, inviteMessage, setUiLang, uiLang } from "./crewMessages";

// One test per dead end on the way into a crew (sign-up is closed).

describe("onboarding messages", () => {
  it("follows the system language", () => {
    expect(uiLang(["fr-FR", "en"])).toBe("fr");
    expect(uiLang(["en-GB", "fr"])).toBe("fr");
    expect(uiLang(["en-US"])).toBe("en");
    expect(uiLang([])).toBe("en");
  });

  it("unknown email: ask whoever runs Hivo to add you", () => {
    const err = { message: "Signups not allowed for otp", code: "otp_disabled" };
    expect(crewErrorMessage(err, "en")).toMatch(/isn't on your crew's list yet\. Ask whoever runs Hivo/);
    expect(crewErrorMessage(err, "fr")).toMatch(/n'est pas encore sur la liste de ton crew/);
  });

  it("wrong or expired sign-in code: ask for a new one", () => {
    expect(crewErrorMessage({ message: "Token has expired or is invalid" }, "en")).toBe("That code is wrong or expired. Ask for a new one.");
    expect(crewErrorMessage({ message: "Token has expired or is invalid" }, "fr")).toBe("Ce code est faux ou expiré. Demande un nouveau code.");
  });

  it("asking for a code again too soon: check the inbox or wait (not 'after 0 seconds')", () => {
    const err = { message: "For security purposes, you can only request this after 0 seconds." };
    expect(crewErrorMessage(err, "en")).toMatch(/Check your inbox \(and spam\), or wait a minute/);
    expect(crewErrorMessage(err, "fr")).toMatch(/attends une minute/);
  });

  it("the hourly email cap is not the 60-second timer", () => {
    for (const message of ["email rate limit exceeded", "over_email_send_rate_limit"]) {
      expect(crewErrorMessage({ message }, "en")).toMatch(/Too many sign-in emails.*up to an hour/);
      expect(crewErrorMessage({ message }, "fr")).toMatch(/jusqu'à une heure/);
    }
  });

  it("a mail server that refuses to send says so (not a raw error)", () => {
    for (const message of ["Error sending magic link email", "Email address not authorized", "Error sending confirmation email"]) {
      expect(crewErrorMessage({ message }, "en")).toMatch(/couldn't be sent.*tell whoever runs Hivo/);
    }
    expect(crewErrorMessage({ message: "Error sending magic link email" }, "fr")).toMatch(/n'a pas pu être envoyé/);
  });

  it("signed in but no crew: enter your invite code", () => {
    expect(crewText("noCrew", "en", { email: "a@b.c" })).toMatch(/signed in as a@b\.c, but not in a crew yet\. Enter the invite code/);
    expect(crewText("noCrew", "fr", { email: "a@b.c" })).toMatch(/Ta session est ouverte avec a@b\.c.*Entre le code d.invitation/);
    expect(crewText("noInviteYet", "en")).toMatch(/Ask your crew's owner/);
  });

  it("invalid, revoked or used-up invite code: ask for a new one", () => {
    expect(crewText("invalidInvite", "en")).toMatch(/wrong, expired, used up or revoked.*Ask your crew for a new one/);
    expect(crewText("invalidInvite", "fr")).toMatch(/révoqué.*Demande un nouveau code/);
  });

  it("too many wrong invite codes, limits, offline", () => {
    expect(crewErrorMessage({ message: "too many tries, wait 10 minutes" }, "en")).toMatch(/Wait 10 minutes/);
    expect(crewErrorMessage({ message: "you already own 3 crews" }, "fr")).toMatch(/3 crews/);
    expect(crewErrorMessage({ message: "Failed to fetch" }, "en")).toMatch(/Are you online/);
    expect(crewErrorMessage({ message: "something else" }, "en")).toBe("something else");
  });

  it("deleting a crew: wrong name, not the owner", () => {
    expect(crewErrorMessage({ message: "type the crew name to delete it" }, "en")).toBe("Type the crew's name exactly to delete it.");
    expect(crewErrorMessage({ message: "only the owner can delete the crew" }, "fr")).toMatch(/Il faut être propriétaire/);
  });

  it("every server message has its own sentence in both languages", () => {
    const server = [
      "sign in first",
      "song not found",
      "unknown stage done",
      "share limit reached (1000 songs per person per crew)",
      "share limit reached (2000 songs per person)",
      "release limit reached (500 per crew)",
      "too many open invites: revoke some first",
      "invite code not found",
      "invite code expired",
      "invite code already used up",
      "only a crew owner can create invites",
      "could not generate a unique invite code, try again",
      "only a crew owner can edit the columns",
      "column not in this crew",
      "bad column id",
      "every stage needs a column",
      "columns must be a list of 1 to 30",
      "column names are 1 to 40 characters",
      "column x listed twice",
      "each column must be an object",
      "bad card order",
      "bad card id",
      "cards must be a list of 1 to 500",
      "only display_name can change",
      "crew_id and owner_id cannot change",
      "passwords are disabled: sign in with an emailed code",
    ];
    for (const message of server) {
      const en = crewErrorMessage({ message }, "en");
      const fr = crewErrorMessage({ message }, "fr");
      expect(en, message).not.toBe(message);
      expect(fr, message).not.toBe(message);
      expect(fr, message).not.toBe(en);
    }
    expect(crewErrorMessage({ message: "share limit reached (1000 songs per person per crew)" }, "fr")).toMatch(/\(1000\)/);
  });

  it("the website can pin the language (/fr, /en) over the browser's", () => {
    setUiLang("fr");
    expect(currentUiLang()).toBe("fr");
    expect(crewText("badCode")).toBe("Ce code est faux ou expiré. Demande un nouveau code.");
    setUiLang("en");
    expect(crewText("badCode")).toBe("That code is wrong or expired. Ask for a new one.");
    setUiLang(null);
  });
});

describe("inviteMessage", () => {
  it("carries the code, the crew, the website in that language and the email step", () => {
    const en = inviteMessage("AB12CD34", "Night Crew", "en");
    expect(en).toContain("AB12CD34");
    expect(en).toContain("Night Crew");
    expect(en).toContain("https://www.hi-vo.fr/en");
    expect(en).toMatch(/send me the email/i);
    const fr = inviteMessage("AB12CD34", "Night Crew", "fr");
    expect(fr).toContain("https://www.hi-vo.fr/fr");
    expect(fr).toMatch(/Envoie-moi/);
  });
});
