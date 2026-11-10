#!/usr/bin/env node
// Uploads the signed AAB to Google Play as a DRAFT release on a track
// (internal by default): Play Console → Testing → Internal testing then shows
// it, and "Review release → Start rollout" stays the owner's click.
//
// No dependency: the service account signs a JWT (RS256, node:crypto), trades
// it for an access token, then the Android Publisher API v3 edit flow:
// insert → bundles.upload → tracks.update → commit. Used by the release
// workflow's `release` job (GitHub-hosted, environment `release`); the key
// never leaves that step and is never printed.
//
// Env: PLAY_SERVICE_ACCOUNT_JSON (the key file's contents), AAB (path),
// VERSION (e.g. 0.7.2), PACKAGE (default fr.hivo.mobile), TRACK (default
// internal), NOTES (optional one-line release notes, en-US).
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const MAX_NOTES = 500; // Play's limit per language

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The service account's fields we need, checked (never echoed). */
export function readServiceAccount(json) {
  let sa;
  try {
    sa = JSON.parse(json);
  } catch {
    throw new Error("PLAY_SERVICE_ACCOUNT_JSON isn't JSON");
  }
  if (sa?.type !== "service_account" || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new Error("PLAY_SERVICE_ACCOUNT_JSON isn't a service account key");
  }
  return { email: sa.client_email, key: sa.private_key, tokenUri: sa.token_uri || "https://oauth2.googleapis.com/token" };
}

/** The signed assertion for the OAuth 2.0 JWT bearer flow. */
export function signedJwt(sa, nowSec) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.email, scope: SCOPE, aud: sa.tokenUri, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.key))}`;
}

/** Play's versionCode for a version, the same rule as mobile/plugins/versionCode.js. */
export function versionCodeOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) throw new Error(`not a version: ${version}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (min > 99 || pat > 99) throw new Error(`minor and patch must be < 100: ${version}`);
  return maj * 10000 + min * 100 + pat;
}

/** The track body: one draft release with this version code. */
export function trackBody(track, version, versionCode, notes) {
  const text = (notes ?? "").trim().slice(0, MAX_NOTES);
  return {
    track,
    releases: [
      {
        name: version,
        versionCodes: [String(versionCode)],
        status: "draft",
        ...(text ? { releaseNotes: [{ language: "en-US", text }] } : {}),
      },
    ],
  };
}

async function call(url, init, what) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    // Google's error message, without anything we sent.
    let msg = text.slice(0, 600);
    try {
      msg = JSON.parse(text)?.error?.message ?? msg;
    } catch {}
    throw new Error(`${what} failed (HTTP ${res.status}): ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  const e = process.env;
  const sa = readServiceAccount(e.PLAY_SERVICE_ACCOUNT_JSON ?? "");
  const pkg = e.PACKAGE || "fr.hivo.mobile";
  const track = e.TRACK || "internal";
  const expected = versionCodeOf(e.VERSION);
  const aab = readFileSync(e.AAB);

  const token = await call(
    sa.tokenUri,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt(sa, Math.floor(Date.now() / 1000)) }),
    },
    "sign-in",
  );
  const auth = { Authorization: `Bearer ${token.access_token}` };

  const edit = await call(`${API}/${pkg}/edits`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" }, "opening an edit");
  const bundle = await call(
    `${UPLOAD}/${pkg}/edits/${edit.id}/bundles?uploadType=media`,
    { method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: aab },
    "uploading the AAB",
  );
  if (bundle.versionCode !== expected) throw new Error(`the AAB says versionCode ${bundle.versionCode}, ${e.VERSION} should be ${expected}`);
  await call(
    `${API}/${pkg}/edits/${edit.id}/tracks/${track}`,
    { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(trackBody(track, e.VERSION, bundle.versionCode, e.NOTES)) },
    `setting the ${track} track`,
  );
  await call(`${API}/${pkg}/edits/${edit.id}:commit`, { method: "POST", headers: auth }, "committing the edit");
  console.log(`Uploaded ${e.VERSION} (versionCode ${bundle.versionCode}) to Google Play as a draft on the ${track} track.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`::error::Google Play: ${err.message}`);
    process.exit(1);
  });
}
