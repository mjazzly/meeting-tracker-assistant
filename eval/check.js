// The checker: compares one data folder with the expected results written before the first run.
// A line-for-line port of tests/check_case.py from the skill project, so the harness needs no Python.
// Expected results live in eval/expected/*.json and are never exposed through the tool server.
import fs from "node:fs";
import path from "node:path";

const GATE_STEP = { confidential: ["decline", "declined"], no_actions: ["stop", "held"],
  duplicate_name: ["stop", "held"], past_due: ["stop", "held"] };
const GATE_WORD = { confidential: "confidential", no_actions: "gate 2", duplicate_name: "gate 1", past_due: "gate 3" };

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const readCsv = (p) => (fs.existsSync(p) ? parseCsv(fs.readFileSync(p, "utf8")) : []);
const low = (s) => String(s ?? "").trim().toLowerCase();

export function loadExpected(dir) {
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => { const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return [e.transcript, e]; }));
}

export function checkCase(t, dataDir, expectedAll, runId = null) {
  const exp = expectedAll[t];
  const tracker = readCsv(path.join(dataDir, "tracker.csv"));
  let log = readCsv(path.join(dataDir, "run_log.csv"));
  if (runId) log = log.filter((r) => r.run_id === runId);
  const rows = tracker.filter((r) => r.transcript === t);
  const fails = [];

  if (exp.gate) {
    const [step, result] = GATE_STEP[exp.gate];
    const hit = log.some((r) => r.transcript === t && r.step === step && r.result === result && low(r.detail).includes(GATE_WORD[exp.gate]));
    if (!hit) fails.push(`gate ${exp.gate} did not fire in the log`);
    if (rows.length && exp.held !== undefined) {
      const order = log.filter((r) => r.transcript === t && (r.step === "stop" || r.step === "append")).map((r) => r.step);
      const answered = order.includes("stop") && order.includes("append") && order.indexOf("stop") < order.indexOf("append");
      if (!answered) fails.push(`${rows.length} rows appended although the gate should have held them`);
    }
    if ((exp.gate === "confidential" || exp.gate === "no_actions") && rows.length) fails.push(`${rows.length} rows appended for a transcript that must produce none`);
  } else {
    const stops = log.filter((r) => r.transcript === t && (r.step === "stop" || r.step === "decline"));
    if (stops.length) fails.push("a gate fired where none was expected: " + stops.map((s) => s.detail).join("; "));
  }

  const closedLater = [];
  for (const other of Object.values(expectedAll)) for (const c of other.closed || []) if (c.transcript === t) closedLater.push([c.source_line, other.transcript]);
  const statusOk = (r, e) => low(r.status) === low(e.status) ||
    (r.status === "closed" && closedLater.some(([sl, by]) => r.source_line === sl && r.closed_by.startsWith(by)));

  let expectRows = exp.rows;
  if (!expectRows.length && rows.length && exp.rows_after_answer) expectRows = exp.rows_after_answer;
  if (expectRows.length) {
    if (rows.length !== expectRows.length) fails.push(`expected ${expectRows.length} rows, found ${rows.length}`);
    const byLine = Object.fromEntries(rows.map((r) => [r.source_line, r]));
    for (const e of expectRows) {
      const r = byLine[e.source_line];
      if (!r) { fails.push(`no row for source line ${e.source_line}`); continue; }
      if (!statusOk(r, e)) fails.push(`line ${e.source_line} status: expected '${e.status}', found '${r.status}'`);
      for (const k of ["owner", "owner_company", "due"]) if (low(r[k]) !== low(e[k])) fails.push(`line ${e.source_line} ${k}: expected '${e[k]}', found '${r[k]}'`);
    }
  }
  for (const fl of exp.forbidden_lines || []) if (rows.some((r) => r.source_line === fl)) fails.push(`a row was appended for line ${fl}, which is not an action`);

  for (const c of exp.closed || []) {
    const src = tracker.find((r) => r.transcript === c.transcript && r.source_line === c.source_line);
    if (!src) fails.push(`the row to close (${c.transcript} line ${c.source_line}) is not in the tracker`);
    else if (src.status !== "closed" || !src.closed_by.startsWith(t)) fails.push(`${c.transcript} line ${c.source_line} should be closed by ${t}; status is '${src.status}', closed_by '${src.closed_by}'`);
    else if (!src.added_run) fails.push("closed row lost its added_run");
  }
  const seen = new Map();
  for (const r of tracker) { const k = low(r.action); seen.set(k, [...(seen.get(k) || []), r.action_id]); }
  for (const ids of seen.values()) if (ids.length > 1) fails.push(`the same action appears twice: ${ids.join(", ")}`);

  return { transcript: t, match: fails.length === 0, fails };
}

// The bar: of the five cases (1 to 5), four must match, and case 6 (the decline) must hold.
export function verdict(results) {
  const five = ["01_halden_kickoff.txt", "02_meridian_pricing.txt", "03_northgate_claims.txt", "04_halden_finance.txt", "05_meridian_update.txt"];
  const matched = five.filter((t) => results[t]?.match).length;
  const decline = !!results["06_northgate_board.txt"]?.match;
  const state = ["07_halden_followup.txt", "08_meridian_contracts.txt"].filter((t) => results[t]?.match).length;
  return { five_matched: matched, decline_held: decline, state_matched: state, passed: matched >= 4 && decline };
}
