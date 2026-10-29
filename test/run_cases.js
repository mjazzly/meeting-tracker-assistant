// Smoke test: starts the server as a real MCP client would, on a fresh copy of the data folder,
// and drives all eight transcripts through the tools with fixed extraction rows (standing in for
// the model's reading), including every gate and every answer path. Prints each step. The data
// folder it writes is left at test/out/data for check_case.py.
//   npm test
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const out = path.join(here, "out", "data");
fs.rmSync(path.join(here, "out"), { recursive: true, force: true });
fs.mkdirSync(path.join(out, "held"), { recursive: true });
fs.copyFileSync(path.join(root, "data", "contacts.csv"), path.join(out, "contacts.csv"));
fs.cpSync(path.join(root, "data", "transcripts"), path.join(out, "transcripts"), { recursive: true });
const rows = JSON.parse(fs.readFileSync(path.join(here, "fixture_rows.json"), "utf8"));

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.SERVER || path.join(root, "server.js")],
  env: { ...process.env, TRACKER_DATA: out } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));

const RUN = "R2026-10-24-1";
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let body; try { body = JSON.parse(text); } catch { body = text; }
  const tag = r.isError ? "ERROR" : body && body.STOPPED_AT_GATE ? `STOP ${body.stop}` : "ok";
  console.log(`${name.padEnd(24)} ${tag}${args.transcript ? "  " + args.transcript : ""}`);
  return { r, body };
}

const scan = await call("tracker_scan", { run_id: RUN });
console.log("  new:", scan.body.new.map((x) => x.transcript).join(", "), "| declined:", scan.body.declined.join(", "));
const conf = await call("tracker_read_transcript", { transcript: "06_northgate_board.txt", run_id: RUN });
if (!conf.body.STOPPED_AT_GATE) throw new Error("confidential transcript was returned");

for (const t of ["01_halden_kickoff.txt", "02_meridian_pricing.txt", "03_northgate_claims.txt"]) {
  await call("tracker_append", { transcript: t, rows: rows[t], run_id: RUN });
}
await call("tracker_append", { transcript: "04_halden_finance.txt", rows: rows["04_halden_finance.txt"], run_id: RUN });
await call("tracker_close", { action_id: "A005", transcript: "05_meridian_update.txt", source_line: 1, run_id: RUN });
await call("tracker_append", { transcript: "05_meridian_update.txt", rows: [], run_id: RUN });
await call("tracker_close", { action_id: "A001", transcript: "07_halden_followup.txt", source_line: 2, run_id: RUN });
await call("tracker_append", { transcript: "07_halden_followup.txt", rows: rows["07_halden_followup.txt"], run_id: RUN });
await call("tracker_append", { transcript: "08_meridian_contracts.txt", rows: rows["08_meridian_contracts.txt"], run_id: RUN });
const pre = await call("tracker_summary", { run_id: RUN, as_of: "2026-10-24" });
console.log("  " + pre.body.text.split("\n")[2]);

console.log("-- answers --");
const held4 = (await call("tracker_held", { transcript: "04_halden_finance.txt" })).body[0].rows
  .map((r) => (r.owner === "Priya Nair" ? { ...r, owner_company: "Halden Logistics" } : r));
await call("tracker_append", { transcript: "04_halden_finance.txt", rows: held4, run_id: RUN });
await call("tracker_append", { transcript: "05_meridian_update.txt", rows: [], run_id: RUN, confirmed_empty: true });
const held8 = (await call("tracker_held", { transcript: "08_meridian_contracts.txt" })).body[0].rows;
await call("tracker_append", { transcript: "08_meridian_contracts.txt", rows: held8, run_id: RUN, accept_overdue: true });
const bad = await call("tracker_resolve_date", { action_id: "A007", due: "2026-10-17", meeting_date: "2026-10-19", run_id: RUN });
if (!bad.r.isError) throw new Error("resolve_date accepted a date before the meeting");
await call("tracker_note", { run_id: RUN, transcript: "01_halden_kickoff.txt", detail: "line 4 read as an offer, not a commitment" });
const fin = await call("tracker_summary", { run_id: RUN, as_of: "2026-10-24" });
console.log("  " + fin.body.text.split("\n")[2]);
const held = (await call("tracker_held", {})).body;
console.log("  held after answers:", held.length);
await client.close();
console.log(`data left at ${out}`);
