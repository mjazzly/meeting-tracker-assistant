#!/usr/bin/env node
// Tests the sheet importer on recorded harness output (eval/sheet/fixtures) before any platform is involved.
//
//   node eval/sheet/test_import.js
//
// Every fixture is written to a fresh temporary folder; nothing goes into eval/sheet/runs or eval/results-sheet.
//   1. Whole runs: two recorded harness runs (one clean, one with named misses) are written out as chat
//      text, an early stop reply first and the final reply after the answers, one with code fences and one
//      as a page copy without them. The importer must give every case the same verdict and the same
//      lines the harness recorded.
//   2. Split: the clean run is cut into run 1 (cases 1 to 6) and run 2 (cases 7 and 8, the tracker carried).
//   3. Faults: a tracker from another run attached; run 2 with a carried row changed, a carried row dropped and a stop missing from the log;
//      a reply with no blocks at all; a run marked not blind, which must carry nothing and count nowhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const IMPORT = path.join(here, "import.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-import-"));
const ANSWERS = fs.readFileSync(path.join(ROOT, "eval", "answers.txt"), "utf8").trim();

let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const readLines = (p) => fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n").trimEnd().split("\n");
// Two recorded harness runs, kept as fixtures because eval/runs/ stays out of the repo: each one's tracker,
// run log and result.json, copied from eval/runs/<label>/. One change: the two summary lines in each run log
// named the summary files by a path on the owner's machine, now made relative to the repo. The checker never
// reads those lines.
const harness = (label) => {
  const dir = path.join(here, "fixtures", label);
  return { tracker: readLines(path.join(dir, "tracker.csv")), log: readLines(path.join(dir, "run_log.csv")),
    result: JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) };
};
const block = (lines, fenced) => fenced ? ["```csv", ...lines, "```"] : ["csv", "Copy", ...lines, ""];
const chat = (head, replies) => [`Platform: ${head.platform}`, `Model: ${head.model}`, `Date: 2026-11-05`, "",
  `You: Run the tracker. Use run id ${head.runId}.`, "", ...replies.flat(), ""].join("\n");
const reply = (tracker, log, fenced, questions) =>
  ["Assistant:", "No tracker attached, starting a new tracker.", "", ...block(tracker, fenced), "", ...block(log, fenced), "", questions, ""];

function runImport(file, args = []) {
  const r = spawnSync(process.execPath, [IMPORT, file, "--record-dir", path.join(TMP, "results"), "--work-dir", path.dirname(file), ...args], { encoding: "utf8" });
  const runId = path.basename(file, ".txt");
  const rec = path.join(TMP, "results", `${runId}.json`);
  return { out: r.stdout + r.stderr, status: r.status, record: fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, "utf8")) : null };
}
function write(platform, runId, text) {
  const p = path.join(TMP, platform, `${runId}.txt`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

// ---------- 1. whole runs: the same verdicts and lines as the harness ----------
for (const [label, fenced] of [["E202610251246-opus-5-5-high", true], ["E202610251245-haiku-5-5", false]]) {
  const h = harness(label);
  const firstSummary = h.log.findIndex((l) => l.includes(",summary,"));
  const heldFiles = ["04_halden_finance.txt", "08_meridian_contracts.txt"];
  const early = reply(h.tracker.filter((l) => !heldFiles.some((f) => l.includes(`,${f},`))), h.log.slice(0, firstSummary), fenced, "1. Which Priya Nair?");
  const late = reply(h.tracker, h.log, fenced, "No questions.");
  const file = write("harness", `whole-${label}`, chat({ platform: "harness replay", model: h.result.model, runId: label }, [early, `You: ${ANSWERS}`, "", late]));
  const { record, out } = runImport(file, ["--cases", "all"]);
  ok(record && record.imported.tracker_blocks === 2 && record.imported.log_blocks === 2, `${label}: both replies found, the last one used (${fenced ? "fenced" : "page copy"})`);
  ok(record && record.imported.tracker_rows === h.tracker.length - 1 && record.imported.log_lines === h.log.length - 1, `${label}: every row and log line imported`);
  for (const [t, c] of Object.entries(h.result.cases))
    ok(record && record.cases[t].match === c.match && same(record.cases[t].fails, c.fails), `${label}: ${t} ${c.match ? "match" : "miss"} as recorded${c.fails.length ? ` (${c.fails.length} named)` : ""}`);
  ok(record && same(record.verdict, h.result.verdict), `${label}: verdict as recorded ${JSON.stringify(h.result.verdict)}`);
  if (!record) console.log(out);
}

// ---------- 2. split into run 1 and run 2, the tracker carried ----------
const h = harness("E202610251246-opus-5-5-high");
const run1Files = ["01", "02", "03", "04", "05", "06"];
const inRun1 = (l, i) => i === 0 || run1Files.some((n) => l.split(",")[2]?.startsWith(n + "_"));
const trackerHead = h.tracker[0];
const tRows = h.tracker.slice(1);
const fileOf = (l) => l.split(",")[1];
const r1Tracker = [trackerHead, ...tRows.filter((l) => run1Files.includes(fileOf(l).slice(0, 2)))
  .map((l) => l.startsWith("A001,") ? l.replace(/,closed,E202610251246,E202610251246,07_halden_followup\.txt line 2$/, ",open,claude-r1,,") : l.replace(/\bE202610251246\b/g, "claude-r1"))];
const r1Log = h.log.filter(inRun1).map((l) => l.replace(",E202610251246,", ",claude-r1,"));
const carried = r1Tracker.slice(1).map((l) => l.startsWith("A001,") ? l.replace(/,open,claude-r1,,$/, ",closed,claude-r1,claude-r2,07_halden_followup.txt line 2") : l);
const r2New = tRows.filter((l) => ["07", "08"].includes(fileOf(l).slice(0, 2))).map((l) => l.replace(/\bE202610251246\b/g, "claude-r2"));
const r2Tracker = [trackerHead, ...carried, ...r2New];
const r2Log = [h.log[0], ...h.log.slice(1).filter((l) => /,0[78]_/.test(l)).map((l) => l.replace(",E202610251246,", ",claude-r2,"))];

const f1 = write("claude", "claude-r1", chat({ platform: "Claude Project", model: "replay", runId: "claude-r1" }, [reply(r1Tracker, r1Log, true, "No questions.")]));
const a = runImport(f1);
ok(a.record && Object.keys(a.record.cases).length === 6 && Object.values(a.record.cases).every((c) => c.match), "run 1: cases 1 to 6 marked, all match");
ok(a.record && same(a.record.verdict, { five_matched: 5, decline_held: true }), "run 1: 5 of 5, decline held");
ok(a.record && a.record.gates["04_halden_finance.txt"].verdict === "held" && a.record.gates["05_meridian_update.txt"].verdict === "held"
  && a.record.gates["06_northgate_board.txt"].verdict === "decline held", "run 1: gates 1 and 2 held, decline held");
const carryPath = path.join(TMP, "claude", "carry", "claude-r1-tracker.csv");
ok(fs.existsSync(carryPath) && readLines(carryPath).length === r1Tracker.length, "run 1: carried tracker written for run 2");

const f2 = write("claude", "claude-r2", chat({ platform: "Claude Project", model: "replay", runId: "claude-r2" }, [reply(r2Tracker, r2Log, true, "No questions.")]));
const b = runImport(f2);
ok(b.record && Object.keys(b.record.cases).length === 2 && Object.values(b.record.cases).every((c) => c.match), "run 2: cases 7 and 8 marked, both match");
ok(b.record && b.record.gates["08_meridian_contracts.txt"].verdict === "held", "run 2: gate 3 held");
ok(b.record && b.record.carry.checked && b.record.carry.kept && b.record.carry.carried_rows === r1Tracker.length - 1, "run 2: every carried row kept (A001 closed is allowed)");
ok(b.record && b.record.platform_verdict?.passed && b.record.platform_verdict.state_matched === 2, "run 2: platform verdict on all eight, bar met");
ok(a.record && b.record && a.record.foreign_rows.length === 0 && b.record.foreign_rows.length === 0 && b.record.problems.length === 0, "run ids: run 1 and run 2 hold only their own and the carried run ids");
// the wrong tracker attached: the harness's own tracker, whose rows carry its run id
const wrong = write("wrong", "wrong-r2", chat({ platform: "Claude Project", model: "replay", runId: "wrong-r2" }, [reply(h.tracker, r2Log, true, "No questions.")]));
const wr = runImport(wrong, ["--carry", carryPath]);
ok(wr.record && wr.record.foreign_rows.length === 16 && wr.record.problems.some((x) => x.startsWith("14 rows carry")) && wr.record.foreign_rows[0].startsWith("A001 (01_halden_kickoff.txt line 3) added_run 'E202610251246'")
  && wr.record.problems.some((x) => x.includes("rows from a run this chat never had")), "run ids: a tracker from another run is flagged row by row");

// ---------- 2b. the same split with the browser's file name prefix on every transcript ----------
const PREFIX = { "01": "f3043a10", "02": "884f6a5a", "03": "b827e7ca", "04": "3cb3b9d2", "05": "1c5e9c4e", "06": "01aaea89", "07": "5e21d0aa", "08": "c0ffee42" };
const prefixed = (l) => l.replace(/\b(\d\d)(_[a-z_]+\.txt)/g, (w, n, rest) => `${PREFIX[n]}-${n}${rest}`);
const w1 = write("web", "web-r1", chat({ platform: "Claude Project", model: "replay", runId: "web-r1" }, [reply(r1Tracker.map(prefixed), r1Log.map(prefixed), true, "No questions.")]));
const p1 = runImport(w1);
ok(p1.record && same(p1.record.verdict, a.record.verdict) && Object.keys(p1.record.cases).every((t) => same(p1.record.cases[t].fails, a.record.cases[t].fails)), "prefix: run 1 marks exactly as without the prefix");
ok(p1.record && same(Object.keys(p1.record.names.prefixes).sort(), run1Files.map((n) => Object.keys(PREFIX).includes(n) && fs.readdirSync(path.join(ROOT, "data", "transcripts")).find((t) => t.startsWith(n + "_"))).sort())
  && p1.record.names.unknown.length === 0 && p1.record.names.consistent, "prefix: one prefix found per file, nothing left unmatched");
const webCarry = path.join(TMP, "web", "carry", "web-r1-tracker.csv");
ok(fs.existsSync(webCarry) && !/[0-9a-f]{8}-\d\d_/.test(fs.readFileSync(webCarry, "utf8")), "prefix: the carried tracker holds the plain file names");
ok(fs.existsSync(path.join(TMP, "web", "web-r1", "data", "tracker.raw.csv")), "prefix: the blocks as written are kept beside the stripped ones");
const w2Tracker = [trackerHead, ...readLines(webCarry).slice(1).map((l) => l.startsWith("A001,") ? l.replace(/,open,claude-r1,,$/, `,closed,claude-r1,web-r2,${PREFIX["07"]}-07_halden_followup.txt line 2`) : l), ...r2New.map(prefixed)];
const w2 = write("web", "web-r2", chat({ platform: "Claude Project", model: "replay", runId: "web-r2" }, [reply(w2Tracker, r2Log.map(prefixed), true, "No questions.")]));
const p2 = runImport(w2);
ok(p2.record && Object.values(p2.record.cases).every((x) => x.match) && p2.record.carry.kept, "prefix: run 2 matches and every carried row is kept");
const clash = r2Log.map(prefixed).map((l) => l.replace(`${PREFIX["08"]}-08_`, `${PREFIX["07"]}-08_`));
const w3 = write("web2", "web2-r2", chat({ platform: "Claude Project", model: "replay", runId: "web2-r2" }, [reply([trackerHead, ...r2New.map(prefixed), "A099,09_extra.txt,1,Something,not stated,,,not stated,,open,web2-r2,,"], clash, true, "No questions.")]));
const p3 = runImport(w3, ["--carry", webCarry]);
ok(p3.record && !p3.record.names.consistent && p3.record.names.issues.some((x) => x.includes(`prefix ${PREFIX["07"]}`)), "prefix: one prefix on two files is named");
ok(p3.record && p3.record.names.unknown.some((x) => x.includes("'09_extra.txt'")), "prefix: a transcript name that is not one of the eight is named");

// ---------- 2c. ChatGPT's copy suffix on five of the six names, the blocks unfenced ----------
const suffixed = (l) => l.replace(/\b(0[1-46]_[a-z_]+)\.txt/g, "$1(1).txt");
const s1 = write("chat", "chat-r1", chat({ platform: "ChatGPT Project", model: "replay", runId: "chat-r1" }, [reply(r1Tracker.map(suffixed).map((l) => l.replace(/claude-r1/g, "chat-r1")), r1Log.map(suffixed).map((l) => l.replace(/claude-r1/g, "chat-r1")), false, "No questions.")]));
const q1 = runImport(s1);
ok(q1.record && same(q1.record.verdict, a.record.verdict) && Object.keys(q1.record.cases).every((t) => same(q1.record.cases[t].fails, a.record.cases[t].fails)), "suffix: run 1 marks exactly as without the suffix");
ok(q1.record && Object.keys(q1.record.names.suffixes).length === 5 && !q1.record.names.suffixes["05_meridian_update.txt"]
  && q1.record.names.unknown.length === 0 && q1.record.foreign_rows.length === 0, "suffix: five files had (1) stripped, 05 left as it was, nothing unmatched");
ok(!/\(1\)/.test(fs.readFileSync(path.join(TMP, "chat", "carry", "chat-r1-tracker.csv"), "utf8")), "suffix: the carried tracker holds the plain file names");

// ---------- 2d. a row one cell short in the middle of the tracker: kept as written, the rows after it kept ----------
const short = r1Tracker.map((l) => l.startsWith("A005,") ? l.replace(",closed,claude-r1,claude-r1,05_meridian_update.txt line 1", ",closed,mal-r1,05_meridian_update.txt line 1") : l.replace(/claude-r1/g, "mal-r1"));
const m1 = write("mal", "mal-r1", chat({ platform: "Gemini Skill", model: "replay", runId: "mal-r1" }, [reply(short, r1Log.map((l) => l.replace(/claude-r1/g, "mal-r1")), true, "No questions.")]));
const mr = runImport(m1);
ok(mr.record && mr.record.imported.tracker_rows === r1Tracker.length - 1 && mr.record.imported.malformed_rows.length === 1
  && mr.record.imported.malformed_rows[0].cells === 12 && mr.record.problems.some((x) => x.includes("has 12 cells, not 13; kept as written")), "short row: kept, named with its line and cell count, and the rows after it still read");
ok(mr.record && mr.record.cases["05_meridian_update.txt"].fails.some((f) => f.includes("02_meridian_pricing.txt line 5 should be closed by 05_meridian_update.txt"))
  && same(mr.record.cases["02_meridian_pricing.txt"].fails, ["line 5 status: expected 'open', found 'closed'"])
  && ["01", "03", "04", "06"].every((n) => Object.entries(mr.record.cases).find(([t]) => t.startsWith(n))[1].match), "short row: the checker marks it as written (the closed row with no closed_by misses cases 2 and 5), the rest unaffected");

// ---------- 2e. a second row on the same platform: its own carried file, paired with its own run 1 ----------
const defaultCarry = fs.readFileSync(carryPath, "utf8");
const hiR1 = r1Tracker.map((l) => l.replace(/claude-r1/g, "claude-hi-r1")).slice(0, 4);   // a run 1 that differs from the default row's
const h1 = write("claude", "claude-hi-r1", chat({ platform: "Claude Project", model: "replay", runId: "claude-hi-r1" }, [reply(hiR1, r1Log.map((l) => l.replace(/claude-r1/g, "claude-hi-r1")), true, "No questions.")]));
fs.writeFileSync(h1.replace(/\.txt$/, ".notes.txt"), "Row: matched effort (High)\n");
const hr1 = runImport(h1);
const hiCarry = path.join(TMP, "claude", "carry", "claude-hi-r1-tracker.csv");
ok(hr1.record && hr1.record.row === "matched effort (High)" && fs.existsSync(hiCarry) && fs.readFileSync(carryPath, "utf8") === defaultCarry,
  "second row: its own carried file, the default row's carried file untouched, the row label from the notes");
const hiR2 = [trackerHead, ...readLines(hiCarry).slice(1), ...r2New.map((l) => l.replace(/claude-r2/g, "claude-hi-r2"))];
const h2 = write("claude", "claude-hi-r2", chat({ platform: "Claude Project", model: "replay", runId: "claude-hi-r2" }, [reply(hiR2, r2Log.map((l) => l.replace(/claude-r2/g, "claude-hi-r2")), true, "No questions.")]));
const hr2 = runImport(h2);
ok(hr2.record && hr2.record.carry.checked && hr2.record.carry.carried_rows === 3 && hr2.record.platform_verdict
  && hr2.record.platform_verdict.five_matched === hr1.record.verdict.five_matched && hr2.record.row === "default settings",
  "second row: run 2 carries and pairs with claude-hi-r1, not claude-r1; a run with no Row note is labelled default settings");

// ---------- 3. faults ----------
const changed = r2Tracker.map((l) => l.startsWith("A002,") ? l.replace(",Aiden Brooks,", ",not stated,") : l).filter((l) => !l.startsWith("A003,"));
const noStop = r2Log.filter((l) => !(l.includes("08_meridian_contracts.txt") && l.includes(",stop,")));
const f3 = write("gpt", "gpt-r2", chat({ platform: "custom GPT", model: "replay", runId: "gpt-r2" }, [reply(changed, noStop, true, "No questions.")]));
const c = runImport(f3, ["--carry", carryPath]);
ok(c.record && c.record.carry.changes.some((x) => x.startsWith("A002 owner: carried 'Aiden Brooks'")), "fault: a changed carried cell is named by row and column");
ok(c.record && c.record.carry.changes.some((x) => x.startsWith("A003 (01_halden_kickoff.txt line 6) is missing")), "fault: a dropped carried row is named by its case and line");
ok(c.record && c.record.gates["08_meridian_contracts.txt"].verdict === "miss"
  && c.record.misses.some((m) => m.case === 8 && m.miss.includes("gate past_due did not fire")), "fault: a missing stop is a named miss on case 8");
ok(c.record && !c.record.platform_verdict, "fault: no platform verdict without that platform's run 1 record");

// a run marked not blind: recorded, not counted, carries nothing, never in a platform verdict
const carryBefore = fs.readFileSync(carryPath, "utf8");
const f5 = write("claude", "claude-r1-try1", chat({ platform: "Claude Project", model: "replay", runId: "claude-r1-try1" }, [reply(r1Tracker.slice(0, 3), r1Log, true, "No questions.")]));
fs.writeFileSync(f5.replace(/\.txt$/, ".notes.txt"), "Not blind: the platform loaded the skill.\n");
const e = runImport(f5);
ok(e.record && e.record.blind === false && e.record.counted === false && e.record.run === "r1" && Object.keys(e.record.cases).length === 6, "not blind: recorded as run 1, not blind, not counted");
ok(fs.readFileSync(carryPath, "utf8") === carryBefore, "not blind: the carried tracker is left as it was");
const f6 = write("nb", "nb-r1", fs.readFileSync(f1, "utf8"));
fs.writeFileSync(f6.replace(/\.txt$/, ".notes.txt"), "Not blind: replay.\n");
runImport(f6);
const f7 = write("nb", "nb-r2", fs.readFileSync(f2, "utf8"));
const g = runImport(f7, ["--carry", carryPath]);
ok(g.record && !g.record.platform_verdict, "not blind: a run 1 that is not counted gives no platform verdict");
// a run counted out by the person: still recorded as blind, not counted, carries nothing
const f8 = write("claude", "claude-r1-try2", chat({ platform: "Claude Project", model: "replay", runId: "claude-r1-try2" }, [reply(r1Tracker.slice(0, 3), r1Log, true, "No questions.")]));
fs.writeFileSync(f8.replace(/\.txt$/, ".notes.txt"), "Not counted: a connection was available.\n");
const k = runImport(f8);
ok(k.record && k.record.blind === true && k.record.counted === false && fs.readFileSync(carryPath, "utf8") === carryBefore, "not counted: blind kept, not counted, the carried tracker left as it was");

const f4 = write("gem", "gem-r1", chat({ platform: "Gemini Gem", model: "replay", runId: "gem-r1" }, [["Assistant:", "I need the contacts file before I can start."]]));
const d = runImport(f4);
ok(d.record && d.record.problems.length === 2 && Object.values(d.record.cases).every((x) => !x.match), "fault: no blocks is recorded as two problems and six misses");
ok(d.record && d.record.verdict.five_matched === 0 && !d.record.verdict.decline_held, "fault: no blocks is 0 of 5, decline not held");

console.log(`\n${failed ? `${failed} FAILED` : "all passed"} (temporary files in ${TMP})`);
process.exit(failed ? 1 : 0);
