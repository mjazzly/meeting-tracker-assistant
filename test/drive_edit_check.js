// Live check of the edit flag against the real Drive folder, after a Drive harness run.
//   node test/drive_edit_check.js --data eval/runs/<drive run label>/data --folder <Drive folder id>
// Steps: run the Drive harness; in Drive, upload a new version of one transcript (right click, File
// information, Manage versions, Upload new version: same file id, new content); then run this. It
// scans once more on that run's state and prints what the source adapter fetched and flagged. A pass
// is: nothing fetched, the edited transcript flagged, and no tracker row changed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const data = path.resolve(arg("data") || ""), folder = arg("folder") || process.env.TRACKER_DRIVE_FOLDER;
if (!arg("data") || !fs.existsSync(path.join(data, "run_log.csv")) || !folder) {
  console.error("usage: node test/drive_edit_check.js --data eval/runs/<drive run label>/data --folder <Drive folder id>"); process.exit(2);
}
const trackerBefore = fs.readFileSync(path.join(data, "tracker.csv"), "utf8");
const client = new Client({ name: "drive-edit-check", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server.mjs"), "--source", "drive", "--folder", folder],
  env: { ...process.env, TRACKER_DATA: data }, stderr: "inherit" }));
const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
const run = `C${now.slice(0, 16).replace(/[-:T]/g, "")}`;
const r = await client.callTool({ name: "tracker_scan", arguments: { run_id: run } });
await client.close();
if (r.isError) { console.error(r.content[0].text); process.exit(1); }
const out = JSON.parse(r.content[0].text);
console.log(`scan ${run}: ${out.source.listed} files listed, fetched ${out.source.fetched.length}, new ${out.new.length}`);
for (const f of out.source.flagged) console.log(`FLAGGED  ${f}`);
const same = fs.readFileSync(path.join(data, "tracker.csv"), "utf8") === trackerBefore;
const pass = out.source.fetched.length === 0 && out.source.flagged.some((f) => f.includes("was edited in Drive after it was processed")) && same;
console.log(`tracker rows unchanged: ${same ? "yes" : "no"}`);
console.log(pass ? "PASS: the edit was flagged and nothing was read twice" : "NOT YET: no edit flagged (upload a new version of one transcript in Drive first)");
process.exit(pass ? 0 : 1);
