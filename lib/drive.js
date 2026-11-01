// Google Drive through its REST API, with no packages added: Node's own fetch and http.
// Two scopes, both asked for at sign-in:
//   drive.readonly  list the transcripts folder and download a transcript by its file id
//   drive.file      write the action board back; this scope reaches only files this app created
// The OAuth client and the token live outside the repo, in ~/.config/meeting-tracker/
// (TRACKER_GOOGLE_DIR overrides it), so neither can reach GitHub.
// DRIVE_API_BASE and DRIVE_TOKEN_URL exist only so the offline tests can point at a fake Drive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

export const SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"];
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = () => process.env.DRIVE_API_BASE || "https://www.googleapis.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function configDir() {
  return process.env.TRACKER_GOOGLE_DIR || path.join(os.homedir(), ".config", "meeting-tracker");
}
const clientPath = () => path.join(configDir(), "client_secret.json");
const tokenPath = () => path.join(configDir(), "token.json");

function loadClient() {
  if (!fs.existsSync(clientPath())) {
    throw new Error(`No OAuth client at ${clientPath()}. Download the Desktop app client JSON from Google Cloud and save it there.`);
  }
  const j = JSON.parse(fs.readFileSync(clientPath(), "utf8"));
  const c = j.installed || j.web || j;
  if (!c.client_id) throw new Error(`${clientPath()} has no client_id; it should be the Desktop app client JSON`);
  return { id: c.client_id, secret: c.client_secret || "", tokenUrl: process.env.DRIVE_TOKEN_URL || c.token_uri || "https://oauth2.googleapis.com/token" };
}

function saveToken(t) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath(), JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function tokenRequest(client, params) {
  const res = await fetch(client.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...params }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Google token request failed: ${body.error || res.status}${body.error_description ? ", " + body.error_description : ""}`);
    e.code = body.error; throw e;
  }
  return body;
}

// One-time sign-in, run from Terminal: node server.mjs --auth
// Opens the Google consent page in the browser and listens on 127.0.0.1 for the answer (PKCE, no
// copy and paste of codes). Writes the refresh token to ~/.config/meeting-tracker/token.json.
export async function authorize({ log = console.error } = {}) {
  const client = loadClient();
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const redirect = `http://127.0.0.1:${srv.address().port}`;
  const url = `${AUTH_URL}?` + new URLSearchParams({ client_id: client.id, redirect_uri: redirect, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state });
  const code = await new Promise((resolve, reject) => {
    srv.on("request", (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.has("code") && !q.has("error")) { res.writeHead(404); res.end(); return; }
      const fine = q.get("state") === state && q.has("code");
      res.writeHead(fine ? 200 : 400, { "content-type": "text/plain" });
      res.end(fine ? "Signed in. You can close this tab and go back to Terminal." : `Sign-in failed: ${q.get("error") || "state did not match"}`);
      fine ? resolve(q.get("code")) : reject(new Error(`sign-in failed: ${q.get("error") || "state did not match"}`));
    });
    log(`Opening the Google sign-in page. If it does not open, paste this into your browser:\n\n${url}\n`);
    if (process.platform === "darwin") execFile("open", [url], () => {});
  });
  srv.close();
  const t = await tokenRequest(client, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect });
  if (!t.refresh_token) throw new Error("Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and run --auth again.");
  const granted = (t.scope || "").split(" ");
  const missing = SCOPES.filter((s) => !granted.includes(s));
  saveToken({ refresh_token: t.refresh_token, access_token: t.access_token, expiry: Date.now() + t.expires_in * 1000, scope: t.scope });
  log(`Signed in. Token saved to ${tokenPath()}.`);
  if (missing.length) log(`Warning: these scopes were not granted (tick both boxes on the consent page): ${missing.join(", ")}`);
  return tokenPath();
}

export class Drive {
  constructor() { this.client = null; this.token = null; }

  async accessToken() {
    if (!this.token) {
      if (!fs.existsSync(tokenPath())) throw new Error(`Not signed in to Google. Run this once in Terminal: node server.mjs --auth`);
      this.token = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
    }
    if (this.token.access_token && Date.now() < this.token.expiry - 60000) return this.token.access_token;
    this.client = this.client || loadClient();
    try {
      const t = await tokenRequest(this.client, { grant_type: "refresh_token", refresh_token: this.token.refresh_token });
      this.token = { ...this.token, access_token: t.access_token, expiry: Date.now() + t.expires_in * 1000 };
      saveToken(this.token);
      return this.token.access_token;
    } catch (e) {
      if (e.code === "invalid_grant") {
        throw new Error("The Google sign-in has expired or was revoked. An app in Testing mode signs you out after 7 days. Run: node server.mjs --auth");
      }
      throw e;
    }
  }

  async call(method, pathAndQuery, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(API() + pathAndQuery, { method, body,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...headers } });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const reason = j.error?.errors?.[0]?.reason || j.error?.status || "";
      const e = new Error(`Drive ${method} ${pathAndQuery.split("?")[0]} failed: ${res.status} ${reason} ${j.error?.message || ""}`.trim());
      e.status = res.status; e.reason = reason; throw e;
    }
    return raw ? res : res.json();
  }

  // Every file directly inside one folder (works for a shared drive too).
  async list(folderId, extraQ = "") {
    const files = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({ q: `'${folderId}' in parents and trashed = false${extraQ}`, pageSize: "1000",
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime, md5Checksum, size)",
        supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}) });
      const r = await this.call("GET", `/drive/v3/files?${q}`);
      files.push(...r.files); pageToken = r.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  async meta(id) {
    return this.call("GET", `/drive/v3/files/${id}?fields=id,name,mimeType,modifiedTime,md5Checksum,size&supportsAllDrives=true`);
  }

  // The file's bytes. With maxBytes, only the start of the file is fetched (a Range request).
  async download(id, maxBytes = 0) {
    const headers = maxBytes ? { range: `bytes=0-${maxBytes - 1}` } : {};
    const res = await this.call("GET", `/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers, raw: true });
    return Buffer.from(await res.arrayBuffer());
  }

  async createFolder(name, parentId) {
    const body = JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) });
    return this.call("POST", "/drive/v3/files?fields=id,name,parents&supportsAllDrives=true",
      { body, headers: { "content-type": "application/json" } });
  }

  // Creates a file, or replaces the content of one this app created before (drive.file allows both).
  async upload({ name, parentId, content, mimeType, replaceId = null }) {
    if (replaceId) {
      return this.call("PATCH", `/upload/drive/v3/files/${replaceId}?uploadType=media&fields=id,name,modifiedTime&supportsAllDrives=true`,
        { body: content, headers: { "content-type": mimeType } });
    }
    const boundary = "mt" + crypto.randomBytes(8).toString("hex");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId], mimeType })}\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--`)]);
    return this.call("POST", "/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime&supportsAllDrives=true",
      { body, headers: { "content-type": `multipart/related; boundary=${boundary}` } });
  }
}
