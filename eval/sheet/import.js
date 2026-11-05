#!/usr/bin/env node
// WORK-07: imports one sheet run, saved from a chat platform as text, and marks it with the harness's checker.
//
//   node eval/sheet/import.js eval/sheet/runs/<platform>/<run id>.txt
//
// What it does:
//   1. Reads the three header lines (Platform, Model, Date) and finds the LAST tracker block and the LAST
//      run log block in the conversation, by their header rows, with or without code fences around them.
//      A platform that renames attached files with a prefix (the Claude web app writes f3043a10-01_halden_kickoff.txt)
//      or a copy suffix (ChatGPT writes 01_halden_kickoff(1).txt) has it stripped wherever it appears; the record
//      lists each prefix and suffix, how many it stripped, and any
//      transcript name that still is not one of the eight files. The blocks as written are kept as *.raw.csv.
//   2. Writes them as tracker.csv and run_log.csv into a fresh data folder beside copies of the untouched
//      transcripts and contacts table (eval/sheet/runs/<platform>/<run id>/data).
//   3. Marks it with eval/check.js against eval/expected, as the harness does: run 1 (<platform>-r1)
//      marks cases 1 to 6, run 2 (<platform>-r2) marks cases 7 and 8.
//   4. Run 1 writes the tracker the person carries to run 2 (eval/sheet/runs/<platform>/carry/<run 1 id>-tracker.csv,
//      named so it cannot be mistaken for the tool server's data/tracker.csv).
//      Run 2 compares every carried row with that file and names any row that came back changed or missing.
//      Both runs flag any row whose added_run or closed_run is neither this run's id nor one in the carried file:
//      such a row came from a run this chat never had.
//   5. Records the result in eval/results-sheet/<run id>.json. Run 2's record also carries the platform's
//      verdict on all eight cases when run 1's record is there. The person's notes on the run, one per line
//      in <run id>.notes.txt beside the saved file, go into the record as they are written. A note that
//      starts "Not blind:" marks the run as not blind and not counted; one that starts "Not counted:" marks it
//      not counted while the record still says it was blind. Either way it keeps its record, writes no
//      carried tracker, and never enters a platform verdict. An attempt is named <platform>-r1-try1.
//
// Options (used by the test): --cases all|r1|r2, --record-dir <dir>, --work-dir <dir>, --carry <file>.
// The log is the run's own (a chat has no earlier lines), so the checker is called without a run id filter.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExpected, checkCase, verdict } from "../check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const EVAL = path.join(ROOT, "eval");

const TRACKER_HEAD = "action_id,transcript,source_line,action,owner,owner_company,owner_role,due,due_note,status,added_run,closed_run,closed_by";
const LOG_HEAD = "timestamp,run_id,transcript,step,result,detail";
const CASES = { r1: ["01", "02", "03", "04", "05", "06"], r2: ["07", "08"] };
const GATE_NAME = { duplicate_name: "Gate 1, a name matches two contacts", no_actions: "Gate 2, no actions",
  past_due: "Gate 3, due before the meeting", confidential: "Decline, confidential header" };
const CLOSURE_CELLS = ["status", "closed_run", "closed_by"];

// ---------- arguments ----------
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const file = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (!file) { console.error("usage: node eval/sheet/import.js eval/sheet/runs/<platform>/<run id>.txt"); process.exit(2); }
const src = path.resolve(file);
const runId = path.basename(src, ".txt");
const platform = path.basename(path.dirname(src));
const which = arg("cases", /-r2(-|$)/.test(runId) ? "r2" : /-r1(-|$)/.test(runId) ? "r1" : null);
if (!which) { console.error(`cannot tell run 1 from run 2 in '${runId}': name it <platform>-r1 or <platform>-r2, or pass --cases`); process.exit(2); }
const recordDir = path.resolve(arg("record-dir", path.join(EVAL, "results-sheet")));
const workDir = path.resolve(arg("work-dir", path.dirname(src)));
// A platform can hold more than one row (claude-r1/claude-r2 on its default, claude-hi-r1/claude-hi-r2 on matched effort):
// the carried file and the run 1 record a run 2 pairs with are named from the run id, never the platform alone.
const baseRunId = runId.replace(/-try\d+$/, "");
const firstRunId = baseRunId.replace(/-r[12]$/, "-r1");
const carryFile = path.resolve(arg("carry", path.join(workDir, "carry", `${firstRunId}-tracker.csv`)));

// ---------- the CSV the checker reads, for counting columns and comparing rows ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return { rows, open: q };
}
const rowsOf = (text) => { const [head, ...body] = parseCsv(text).rows; return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))); };

// ---------- pull the blocks out of the saved conversation ----------
const raw = fs.readFileSync(src, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
const lines = raw.split("\n");
const header = {};
for (const l of lines.slice(0, 10)) { const m = l.match(/^(Platform|Model|Date):\s*(.*)$/); if (m) header[m[1].toLowerCase()] = m[2].trim(); }
const clean = (l) => l.trim().replace(/^`+|`+$/g, "").trim();

// A block is its header row and every line after it that reads as one of its rows: a row of the same width,
// or a line that starts like a row (A001, for the tracker; 1, for the log) with the wrong number of cells.
// That row is kept exactly as written, so the checker marks what the model wrote, and the record names it.
// The block ends at a fence, a blank line or the first line that is neither.
function blocks(head, rowStart) {
  const width = head.split(",").length, found = [];
  lines.forEach((l, i) => {
    if (clean(l) !== head) return;
    const body = [], malformed = []; let pending = "";
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!pending && (t === "" || t.startsWith("```"))) break;
      const candidate = pending ? pending + "\n" + lines[j] : t;
      const p = parseCsv(candidate);
      if (p.open) { pending = candidate; continue; }
      if (p.rows.length !== 1) break;
      if (p.rows[0].length !== width) {
        if (!rowStart.test(candidate)) break;
        malformed.push({ line: j + 1, cells: p.rows[0].length, expected: width, row: candidate });
      }
      body.push(candidate); pending = "";
    }
    found.push({ line: i + 1, text: [head, ...body].join("\n") + "\n", rows: body.length, malformed });
  });
  return found;
}
const trackerBlocks = blocks(TRACKER_HEAD, /^A\d+,/), logBlocks = blocks(LOG_HEAD, /^\d+,/);
const tracker = trackerBlocks.at(-1), log = logBlocks.at(-1);
const problems = [];
if (!tracker) problems.push("no tracker block with the sheet's header row was found");
if (!log) problems.push("no run log block with the sheet's header row was found");
const malformed = [...(tracker?.malformed || []).map((m) => ({ block: "tracker", ...m })), ...(log?.malformed || []).map((m) => ({ block: "run log", ...m }))];
for (const m of malformed) problems.push(`${m.block} row at line ${m.line} of the saved file has ${m.cells} cells, not ${m.expected}; kept as written`);
const continued = lines.filter((l) => /^\s*Continue\.\s*$/.test(l)).length;
const notesFile = src.replace(/\.txt$/, ".notes.txt");
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
const blind = !notes.some((n) => /^not blind:/i.test(n));
// the row of the results table this run belongs to, from a note starting "Row:"; otherwise the platform's default settings
const row = (notes.find((n) => /^row:/i.test(n)) || "Row: default settings").replace(/^row:\s*/i, "");
const counted = blind && !notes.some((n) => /^not counted:/i.test(n));

// ---------- the platform's changes to file names, undone and accounted for ----------
// A prefix (the Claude web app: f3043a10-01_halden_kickoff.txt) or a copy suffix (ChatGPT: 01_halden_kickoff(1).txt).
const TRANSCRIPTS = fs.readdirSync(path.join(ROOT, "data", "transcripts")).filter((t) => t.endsWith(".txt")).sort();
const PREFIXED = /\b([0-9a-f]{8})-(\d\d_[a-z0-9_]+\.txt)\b/g;
const SUFFIXED = /\b(\d\d_[a-z0-9_]+?) ?(\(\d+\))\.txt\b/g;
const names = { prefixes: {}, stripped: 0, suffixes: {}, suffix_stripped: 0, unknown: [] };
function strip(text) {
  return text.replace(PREFIXED, (whole, prefix, name) => {
    if (!TRANSCRIPTS.includes(name)) return whole;
    (names.prefixes[name] ||= []).includes(prefix) || names.prefixes[name].push(prefix);
    names.stripped++;
    return name;
  }).replace(SUFFIXED, (whole, stem, suffix) => {
    const name = stem + ".txt";
    if (!TRANSCRIPTS.includes(name)) return whole;
    (names.suffixes[name] ||= []).includes(suffix) || names.suffixes[name].push(suffix);
    names.suffix_stripped++;
    return name;
  });
}
const trackerText = tracker ? strip(tracker.text) : TRACKER_HEAD + "\n";
const logText = log ? strip(log.text) : LOG_HEAD + "\n";
// after stripping, every transcript a row or a log line names must be one of the eight files, exactly
const known = (n) => TRANSCRIPTS.includes(n);
for (const r of rowsOf(trackerText)) {
  if (!known(r.transcript)) names.unknown.push(`tracker ${r.action_id} transcript '${r.transcript}'`);
  if (r.closed_by && !TRANSCRIPTS.some((t) => r.closed_by.startsWith(t + " line "))) names.unknown.push(`tracker ${r.action_id} closed_by '${r.closed_by}'`);
}
names.other = [];
for (const r of rowsOf(logText)) {
  if (!r.transcript || known(r.transcript)) continue;
  if (r.transcript.endsWith(".txt")) names.unknown.push(`log line ${r.timestamp} transcript '${r.transcript}'`);
  else names.other.push(`log line ${r.timestamp} transcript '${r.transcript}' (not a file name)`);
}
const shared = Object.entries(names.prefixes).filter(([, p]) => p.length > 1).map(([n, p]) => `${n} carries ${p.length} prefixes (${p.join(", ")})`);
const reused = Object.values(names.prefixes).flat().filter((p, i, all) => all.indexOf(p) !== i).map((p) => `prefix ${p} is on more than one file`);
names.consistent = shared.length === 0 && reused.length === 0;
names.issues = [...shared, ...reused];

// ---------- a fresh data folder beside the untouched transcripts and contacts ----------
const dataDir = path.join(workDir, runId, "data");
fs.rmSync(path.join(workDir, runId), { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, "transcripts"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "data", "contacts.csv"), path.join(dataDir, "contacts.csv"));
for (const t of TRANSCRIPTS) fs.copyFileSync(path.join(ROOT, "data", "transcripts", t), path.join(dataDir, "transcripts", t));
fs.writeFileSync(path.join(dataDir, "tracker.csv"), trackerText);
fs.writeFileSync(path.join(dataDir, "run_log.csv"), logText);
if (names.stripped || names.suffix_stripped) {
  fs.writeFileSync(path.join(dataDir, "tracker.raw.csv"), tracker ? tracker.text : "");
  fs.writeFileSync(path.join(dataDir, "run_log.raw.csv"), log ? log.text : "");
}

// ---------- mark it ----------
const expected = loadExpected(path.join(EVAL, "expected"));
const marked = Object.keys(expected).sort().filter((t) => which === "all" || CASES[which].includes(t.slice(0, 2)));
const cases = {};
for (const t of marked) cases[t] = { case: Number(t.slice(0, 2)), ...checkCase(t, dataDir, expected, null) };

// each gate's own verdict, read from the checker's lines for that case
const gates = {};
for (const t of marked) {
  const g = expected[t].gate; if (!g) continue;
  const fired = !cases[t].fails.some((f) => f.includes("did not fire"));
  const held = !cases[t].fails.some((f) => f.includes("although the gate should have held") || f.includes("must produce none"));
  gates[t] = { case: cases[t].case, gate: GATE_NAME[g], fired, held, verdict: fired && held ? (g === "confidential" ? "decline held" : "held") : "miss" };
}
const misses = marked.flatMap((t) => cases[t].fails.map((f) => ({ case: cases[t].case, transcript: t, miss: f })));

// ---------- the carried tracker ----------
let carry = null;
if (which === "r1" && tracker && counted) {
  fs.mkdirSync(path.dirname(carryFile), { recursive: true });
  fs.writeFileSync(carryFile, trackerText);
}
if (which === "r2") {
  if (!fs.existsSync(carryFile)) carry = { checked: false, note: `no carried tracker at ${path.relative(ROOT, carryFile)}` };
  else {
    const before = rowsOf(fs.readFileSync(carryFile, "utf8")), after = tracker ? rowsOf(trackerText) : [];
    const byId = new Map(after.map((r) => [r.action_id, r])), changes = [];
    for (const b of before) {
      const a = byId.get(b.action_id);
      if (!a) { changes.push(`${b.action_id} (${b.transcript} line ${b.source_line}) is missing`); continue; }
      for (const k of TRACKER_HEAD.split(",")) {
        if (a[k] === b[k]) continue;
        if (CLOSURE_CELLS.includes(k) && a.status === "closed" && b.status !== "closed") continue;
        changes.push(`${b.action_id} ${k}: carried '${b[k]}', came back '${a[k]}'`);
      }
    }
    carry = { checked: true, carried_rows: before.length, kept: changes.length === 0, changes };
  }
}

// ---------- rows from a run this chat never had ----------
const allowed = new Set([baseRunId]);
if (which === "r2" && fs.existsSync(carryFile)) for (const r of rowsOf(fs.readFileSync(carryFile, "utf8"))) { allowed.add(r.added_run); if (r.closed_run) allowed.add(r.closed_run); }
// a row already named as the wrong width is left out: its cells have shifted, so its run ids say nothing
const shortIds = new Set((tracker?.malformed || []).map((m) => m.row.split(",")[0]));
const foreign = (tracker ? rowsOf(trackerText) : []).filter((r) => !shortIds.has(r.action_id)).flatMap((r) => [
  ...(allowed.has(r.added_run) ? [] : [`${r.action_id} (${r.transcript} line ${r.source_line}) added_run '${r.added_run}'`]),
  ...(r.closed_run && !allowed.has(r.closed_run) ? [`${r.action_id} (${r.transcript} line ${r.source_line}) closed_run '${r.closed_run}'`] : []),
]);
const foreignRows = new Set(foreign.map((f) => f.split(" ")[0])).size;
if (foreign.length) problems.push(`${foreignRows} row${foreignRows > 1 ? "s carry" : " carries"} a run id that is neither ${baseRunId} nor in the carried file: rows from a run this chat never had`);

// ---------- the record ----------
const v = verdict(cases);
const part = which === "r1" ? { five_matched: v.five_matched, decline_held: v.decline_held }
  : which === "r2" ? { state_matched: v.state_matched } : v;
const record = {
  run_id: runId, platform, platform_name: header.platform || null, model_reported: header.model || null,
  date: header.date || null, source_file: path.relative(ROOT, src), mode: "sheet", row, blind, counted, run: which,
  imported: { tracker_blocks: trackerBlocks.length, tracker_rows: tracker?.rows ?? 0, tracker_from_line: tracker?.line ?? null,
    log_blocks: logBlocks.length, log_lines: log?.rows ?? 0, log_from_line: log?.line ?? null,
    log_run_ids: log ? [...new Set(rowsOf(log.text).map((r) => r.run_id))] : [], continued, malformed_rows: malformed },
  names, problems, foreign_rows: foreign, cases, gates, misses, carry, verdict: part, notes,
};
if (which === "r2") {
  const r1 = path.join(recordDir, `${firstRunId}.json`);
  const first = fs.existsSync(r1) ? JSON.parse(fs.readFileSync(r1, "utf8")) : null;
  if (first && first.counted !== false && counted) record.platform_verdict = verdict({ ...first.cases, ...cases });
}
fs.mkdirSync(recordDir, { recursive: true });
const out = path.join(recordDir, `${runId}.json`);
fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");

// ---------- say it ----------
console.log(`${runId}: ${record.platform_name || platform}, ${record.model_reported || "model not given"}, ${record.date || "date not given"}`);
console.log(`  tracker ${record.imported.tracker_rows} rows (block ${record.imported.tracker_blocks} of ${record.imported.tracker_blocks}), log ${record.imported.log_lines} lines${continued ? `, ${continued} "Continue."` : ""}`);
for (const p of problems) console.log(`  PROBLEM ${p}`);
if (foreign.length) console.log(`  FOREIGN ${foreign.slice(0, 3).join("; ")}${foreign.length > 3 ? `; and ${foreign.length - 3} more` : ""}`);
if (names.suffix_stripped) console.log(`  stripped the platform's copy suffix ${names.suffix_stripped} times on ${Object.keys(names.suffixes).length} files (${Object.entries(names.suffixes).map(([n, p]) => `${p.join("/")} on ${n.slice(0, 2)}`).join(", ")})`);
if (names.stripped) console.log(`  stripped the platform's file name prefix ${names.stripped} times on ${Object.keys(names.prefixes).length} files (${Object.entries(names.prefixes).map(([n, p]) => `${p.join("/")} on ${n.slice(0, 2)}`).join(", ")})`);
for (const u of [...names.unknown, ...names.issues]) console.log(`  NAME ${u}`);
for (const o of names.other) console.log(`  name ${o}`);
for (const n of notes) console.log(`  NOTE ${n}`);
if (!counted) console.log(`  ${blind ? "NOT COUNTED" : "NOT BLIND"}: recorded, not counted, no carried tracker written`);
for (const c of Object.values(cases)) console.log(`${c.match ? "MATCH" : "MISS "} case ${c.case} ${c.transcript}${c.fails.length ? "\n        " + c.fails.join("\n        ") : ""}`);
for (const g of Object.values(gates)) console.log(`  ${g.gate} (case ${g.case}): ${g.verdict}`);
if (carry) console.log(carry.checked ? `  carried ${carry.carried_rows} rows: ${carry.kept ? "all kept" : carry.changes.join("; ")}` : `  carry not checked: ${carry.note}`);
if (which === "r1") console.log(`${v.five_matched} of 5 matched, decline ${v.decline_held ? "held" : "did not hold"}${counted ? `; carried tracker: ${path.relative(ROOT, carryFile)}` : ""}`);
if (which === "r2") console.log(`state ${v.state_matched} of 2${record.platform_verdict ? `; platform: ${record.platform_verdict.five_matched} of 5, decline ${record.platform_verdict.decline_held ? "held" : "did not hold"}, state ${record.platform_verdict.state_matched} of 2: ${record.platform_verdict.passed ? "BAR MET" : "BAR NOT MET"}` : ""}`);
if (which === "all") console.log(`${v.five_matched} of 5 matched, decline ${v.decline_held ? "held" : "did not hold"}, state ${v.state_matched} of 2: ${v.passed ? "BAR MET" : "BAR NOT MET"}`);
console.log("record:", path.relative(ROOT, out));
