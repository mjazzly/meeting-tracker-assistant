// Offline test of the Drive source: the real server (--source drive) against test/fake_drive.js.
//   node test/drive_cases.js        (run npm test first: it compares with the local smoke run)
// Run 1 drives the eight transcripts through the same calls as test/run_cases.js and checks that the
// tracker comes out byte for byte the same as the local run. Run 2 edits, renames, duplicates and adds
// files in the fake folder and checks each is flagged or read as it should be.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeDrive, fakeGoogleDir } from "./fake_drive.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const base = path.join(here, "out-drive");
fs.rmSync(base, { recursive: true, force: true });
const data = path.join(base, "data");
const rows = JSON.parse(fs.readFileSync(path.join(here, "fixture_rows.json"), "utf8"));
const localTracker = path.join(here, "out", "data", "tracker.csv");
if (!fs.existsSync(localTracker)) { console.error("run npm test first (it writes test/out/data/tracker.csv)"); process.exit(2); }

const fake = new FakeDrive({ strict: true });
const folder = fake.seed(path.join(root, "data", "transcripts"));
const port = await fake.listen();
const gdir = fakeGoogleDir(path.join(base, "google"), port);

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };
const client = new Client({ name: "drive-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath,
  args: [process.env.SERVER || path.join(root, "server.js"), "--source", "drive", "--folder", folder],
  env: { ...process.env, TRACKER_DATA: data, TRACKER_GOOGLE_DIR: gdir, DRIVE_API_BASE: `http://127.0.0.1:${port}` }, stderr: "inherit" }));
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (r.isError) console.log(`  ${name} error: ${text}`);
  return { r, body };
}
const log = () => fs.readFileSync(path.join(data, "run_log.csv"), "utf8");

// ---------- run 1: the same calls and answers as the local smoke test ----------
const RUN = "R2026-10-24-1";
const scan = await call("tracker_scan", { run_id: RUN });
check(scan.body.new?.length === 7 && scan.body.declined?.[0] === "06_northgate_board.txt", "scan: seven new from Drive, the confidential one declined");
check(scan.body.source?.fetched.length === 7 && scan.body.source.header_only[0] === "06_northgate_board.txt", "sync: seven fetched in full, 06 header only");
const cached06 = fs.readFileSync(path.join(data, "transcripts", "06_northgate_board.txt"), "utf8");
check(!/^\[/m.test(cached06) && /confidential/i.test(cached06), "06: only its header lines are on disk, no body line");
const id06 = fake.find("06_northgate_board.txt", folder).id;
check(!fake.calls.some((c) => c.includes(id06) && c.includes("media") && !c.includes("bytes=")), "06 never downloaded in full, only its first 2 KB to read the header");
const conf = await call("tracker_read_transcript", { transcript: "06_northgate_board.txt", run_id: RUN });
check(conf.body.STOPPED_AT_GATE === true && conf.body.stop === "confidential", "read of 06 refused by Gate 4 in the store");

for (const t of ["01_halden_kickoff.txt", "02_meridian_pricing.txt", "03_northgate_claims.txt", "04_halden_finance.txt"]) {
  await call("tracker_read_transcript", { transcript: t, run_id: RUN });
  await call("tracker_append", { transcript: t, rows: rows[t], run_id: RUN });
}
await call("tracker_close", { action_id: "A005", transcript: "05_meridian_update.txt", source_line: 1, run_id: RUN });
await call("tracker_append", { transcript: "05_meridian_update.txt", rows: [], run_id: RUN });
await call("tracker_close", { action_id: "A001", transcript: "07_halden_followup.txt", source_line: 2, run_id: RUN });
await call("tracker_append", { transcript: "07_halden_followup.txt", rows: rows["07_halden_followup.txt"], run_id: RUN });
const g3 = await call("tracker_append", { transcript: "08_meridian_contracts.txt", rows: rows["08_meridian_contracts.txt"], run_id: RUN });
check(g3.body.stop === "past_due", "Gate 3 fires from the Drive copy's meeting date");
const pre = await call("tracker_summary", { run_id: RUN, as_of: "2026-10-24" });
check(pre.body.released?.where === "in My Drive, outside the transcripts folder", "board released; strict drive.file rule sends released/ to My Drive and says so");
const held4 = (await call("tracker_held", { transcript: "04_halden_finance.txt" })).body[0].rows
  .map((r) => (r.owner === "Priya Nair" ? { ...r, owner_company: "Halden Logistics" } : r));
await call("tracker_append", { transcript: "04_halden_finance.txt", rows: held4, run_id: RUN });
await call("tracker_append", { transcript: "05_meridian_update.txt", rows: [], run_id: RUN, confirmed_empty: true });
const held8 = (await call("tracker_held", { transcript: "08_meridian_contracts.txt" })).body[0].rows;
await call("tracker_append", { transcript: "08_meridian_contracts.txt", rows: held8, run_id: RUN, accept_overdue: true });
await call("tracker_note", { run_id: RUN, transcript: "01_halden_kickoff.txt", detail: "line 4 read as an offer, not a commitment" });
const fin = await call("tracker_summary", { run_id: RUN, as_of: "2026-10-24" });
check(fin.body.released?.replaced === true, "second summary in the run replaces the same board file");
const rel = fake.find("released", "root");
check(!!rel && fake.find(`board_${RUN}.html`, rel.id)?.content.toString().includes("<html"), "board_R2026-10-24-1.html is in released/");
check(fs.readFileSync(path.join(data, "tracker.csv"), "utf8") === fs.readFileSync(localTracker, "utf8"), "tracker.csv is byte for byte the local smoke run's tracker");
const ids = (log().match(/fetched,file id \S+; modified \S+; md5 \w+/g) || []).length;
check(ids === 7, "run log: file id, modified time and md5 for each fetched transcript");
check((log().match(/,read,"?file id \S+; md5 \w+; fetched by file id/g) || []).length === 4, "run log: each read re-fetched by file id and matched");

// the user drags released/ into the transcripts folder once; the next board goes there
rel.parents = [folder];

// ---------- run 2: edits, a rename, a duplicate name, a new file ----------
const RUN2 = "R2026-10-31-1";
const f03 = fake.find("03_northgate_claims.txt", folder), f01 = fake.find("01_halden_kickoff.txt", folder);
fake.edit(f03.id, f03.content.toString() + "[99] Late addition after the meeting.\n");
fake.rename(f01.id, "01_halden_kickoff_v2.txt");
fake.add({ name: "02_meridian_pricing.txt", parent: folder, content: "Meeting: copy\n\n[1] A copy.\n" });
fake.add({ name: "09_halden_wrapup.txt", parent: folder, content: "Meeting: Halden wrap-up\nDate: 2026-10-30\nAttendees: Priya Nair\n\n[1] Priya Nair will send the closing note by 2026-11-06.\n" });
fake.add({ name: "notes.gdoc", parent: folder, content: "x", mimeType: "application/vnd.google-apps.document" });
const before = fs.readFileSync(path.join(data, "tracker.csv"), "utf8");
const s2 = await call("tracker_scan", { run_id: RUN2 });
check(s2.body.new.length === 1 && s2.body.new[0].transcript === "09_halden_wrapup.txt", "run 2: only the new file 09 is new");
const fl = s2.body.source.flagged.join(" | ");
check(/03_northgate_claims\.txt was edited in Drive after it was processed/.test(fl), "edited 03 flagged, not re-read");
check(/renamed in Drive to 01_halden_kickoff_v2\.txt/.test(fl), "renamed 01 recognised by file id, not read again");
check(/a second file named 02_meridian_pricing\.txt/.test(fl), "a second file with an existing name flagged, not read");
check(/notes\.gdoc was not read/.test(fl), "a Google Doc in the folder is skipped and said");
check(!fs.readFileSync(path.join(data, "transcripts", "03_northgate_claims.txt"), "utf8").includes("[99]"), "the cached 03 is still the version that was read");
const s3 = await call("tracker_scan", { run_id: "R2026-10-31-2" });
check(s3.body.source.flagged.length === 0, "a flag is raised once, not on every later scan");
// an edit between the scan and the read
const f09 = fake.find("09_halden_wrapup.txt", folder);
fake.edit(f09.id, f09.content.toString().replace("2026-11-06", "2026-11-07"));
await call("tracker_read_transcript", { transcript: "09_halden_wrapup.txt", run_id: RUN2 });
check(/09_halden_wrapup\.txt was edited in Drive after this run's scan/.test(log()), "an edit between scan and read is flagged; the scanned version is read");
check(fs.readFileSync(path.join(data, "tracker.csv"), "utf8") === before, "no tracker row changed by any of it");
const s2sum = await call("tracker_summary", { run_id: RUN2, as_of: "2026-10-31" });
check(s2sum.body.text.includes("## Notes") && s2sum.body.text.includes("was edited in Drive after it was processed"), "the flags reach the run summary as notes");
check(s2sum.body.released.where === "inside the transcripts folder", "once moved, the board goes inside the transcripts folder");

await client.close();
fake.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
