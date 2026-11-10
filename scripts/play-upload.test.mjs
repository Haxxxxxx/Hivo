import { createVerify, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { readServiceAccount, signedJwt, trackBody, versionCodeOf } from "./play-upload.mjs";

const require = createRequire(import.meta.url);
const { versionCode } = require("../mobile/plugins/versionCode.js");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyJson = JSON.stringify({
  type: "service_account",
  client_email: "uploader@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth2.googleapis.com/token",
});

const part = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

describe("play-upload", () => {
  it("refuses anything but a service account key, without echoing it", () => {
    expect(() => readServiceAccount("nope")).toThrow("isn't JSON");
    expect(() => readServiceAccount(JSON.stringify({ type: "authorized_user", secret: "s3cr3t" }))).toThrow(/isn't a service account key$/);
    try {
      readServiceAccount(JSON.stringify({ type: "authorized_user", secret: "s3cr3t" }));
    } catch (e) {
      expect(String(e)).not.toContain("s3cr3t");
    }
  });

  it("signs a JWT Google accepts the shape of", () => {
    const sa = readServiceAccount(keyJson);
    const jwt = signedJwt(sa, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    expect(part(h)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(part(c)).toEqual({
      iss: "uploader@example.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
  });

  it("uses the phone build's versionCode rule", () => {
    for (const v of ["0.7.2", "0.8.0", "1.12.3"]) expect(versionCodeOf(v)).toBe(versionCode(v));
    expect(() => versionCodeOf("0.7")).toThrow();
    expect(() => versionCodeOf("0.100.0")).toThrow();
  });

  it("makes a draft release, never a rollout", () => {
    expect(trackBody("internal", "0.7.2", 702, " Fixes ")).toEqual({
      track: "internal",
      releases: [{ name: "0.7.2", versionCodes: ["702"], status: "draft", releaseNotes: [{ language: "en-US", text: "Fixes" }] }],
    });
    expect(trackBody("internal", "0.7.2", 702, "").releases[0]).not.toHaveProperty("releaseNotes");
    expect(trackBody("internal", "0.7.2", 702, "x".repeat(600)).releases[0].releaseNotes[0].text).toHaveLength(500);
  });
});
