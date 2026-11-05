#!/usr/bin/env node
// Step 3's probe, run by Megat from Terminal once the folder is shared with the service account:
//   node hosted/scripts/probe.js --key <path to the service account's JSON key> --tracker <DRIVE_TRACKER_ID>
// It checks the two facts the hosted design rests on, by their effect:
//   1. the service account can update a file heartgold owns (summary.md, written back unchanged)
//   2. it cannot create a file there (Google refuses: no storage quota for a service account)
// The key is read from the file on this machine and used only to sign in; it is never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { ServiceAccountDrive } = await import(path.join(root, "lib", "drive-sa.js"));
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const keyPath = arg("key"), tracker = arg("tracker");
if (!keyPath || !tracker) { console.error("usage: node hosted/scripts/probe.js --key <key.json> --tracker <DRIVE_TRACKER_ID>"); process.exit(2); }

const drive = new ServiceAccountDrive(fs.readFileSync(keyPath, "utf8"));
console.log(`Signed in as the service account ${drive.email}.`);
const files = await drive.list(tracker);
console.log(`It can see tracker/: ${files.map((f) => f.name).sort().join(", ") || "(nothing)"}.`);
const summary = files.find((f) => f.name === "summary.md");
if (!summary) { console.error("summary.md is not in tracker/. Was the folder shared with the service account as Editor?"); process.exit(1); }
const before = await drive.download(summary.id);
await drive.update(summary.id, before, "text/markdown");
console.log("1. Update in place: worked (summary.md written back unchanged).");
try {
  const f = await drive.upload({ name: "probe.txt", parentId: tracker, content: Buffer.from("probe\n"), mimeType: "text/plain" });
  console.log(`2. Create: Google ALLOWED it (file id ${f.id}). The design assumed it would be refused. Removing the file now; tell Claude Code.`);
  await drive.call("DELETE", `/drive/v3/files/${f.id}?supportsAllDrives=true`, { raw: true });
} catch (e) {
  console.log(e.reason === "storageQuotaExceeded" ? "2. Create: refused for storage quota, as expected." : `2. Create: refused, but not for quota (${e.message}). Tell Claude Code.`);
}
