// Google Drive as a service account, for the hosted runner: no consent screen, no 7-day sign-out, and
// it reaches only the folder shared with it. Same list, download and upload calls as lib/drive.js
// (it extends that class and changes only where the access token comes from), so lib/source.js reads
// through it unchanged. Node only, no packages added: the sign-in is a JWT signed with node:crypto.
//
// One limit shapes the hosted design: Google gives a service account no storage quota, so it cannot
// create a file in a personal My Drive (403 storageQuotaExceeded). It can read what is shared with it
// and update the content of a file it can edit, which stays the owner's. Every file the hosted runner
// writes therefore exists before the first run and is updated in place (see hosted/DESIGN.md).
//
// The key arrives as the JSON Google gives, or as base64 of it (GOOGLE_SA_KEY on Vercel). It is never
// written to disk and never logged.
import crypto from "node:crypto";
import { Drive } from "./drive.js";

export const SA_SCOPE = "https://www.googleapis.com/auth/drive";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export function parseKey(raw) {
  if (!raw) throw new Error("No service account key. Set GOOGLE_SA_KEY to the base64 of the key's JSON.");
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const k = JSON.parse(text);
  if (k.type !== "service_account" || !k.client_email || !k.private_key) throw new Error("GOOGLE_SA_KEY is not a service account key");
  return k;
}

export class ServiceAccountDrive extends Drive {
  constructor(key) {
    super();
    this.key = typeof key === "string" ? parseKey(key) : key;
  }

  get email() { return this.key.client_email; }

  async accessToken() {
    if (this.token && Date.now() < this.token.expiry - 60000) return this.token.access_token;
    const tokenUrl = process.env.DRIVE_TOKEN_URL || this.key.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT", ...(this.key.private_key_id ? { kid: this.key.private_key_id } : {}) })}.` +
      b64({ iss: this.key.client_email, scope: SA_SCOPE, aud: tokenUrl, iat: now, exp: now + 3600 });
    const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), this.key.private_key).toString("base64url");
    const res = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_GRANT, assertion: `${unsigned}.${sig}` }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Service account sign-in failed: ${body.error || res.status}${body.error_description ? ", " + body.error_description : ""}`);
    this.token = { access_token: body.access_token, expiry: Date.now() + body.expires_in * 1000 };
    return this.token.access_token;
  }

  // Replace the content of a file that already exists. The only write the hosted runner makes.
  async update(id, content, mimeType) {
    return this.upload({ replaceId: id, content, mimeType });
  }
}
