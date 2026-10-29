// The tracker's state and rules, with no MCP in it, so it can be tested on its own.
// Same files and formats as tracker_tools.py (v1.1): data/tracker.csv, data/run_log.csv,
// data/held/*.json, data/summary_<run>.md. The four gates are enforced here:
//   Gate 1 duplicate name   (append: an owner that matches two or more contacts)
//   Gate 2 no actions       (append: an empty rows list)
//   Gate 3 past due date    (append: a calendar due date before the meeting date it was set in)
//   Gate 4 confidential     (scan and readTranscript: a Classification: Confidential header line)
import fs from "node:fs";
import path from "node:path";
import { renderBoard } from "./render.js";

export const TRACKER_COLS = ["action_id", "transcript", "source_line", "action", "owner", "owner_company",
  "owner_role", "due", "due_note", "status", "added_run", "closed_run", "closed_by"];
export const LOG_COLS = ["timestamp", "run_id", "transcript", "step", "result", "detail"];
export const NOT_STATED = "not stated";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- CSV (minimal quoting, matches Python's csv module) ----------

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(values) {
  return values.map(csvCell).join(",") + "\r\n";
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export class GateStop extends Error {
  constructor(payload) {
    super(payload.question);
    this.payload = payload;
  }
}

export class Store {
  constructor(dataDir) {
    this.data = path.resolve(dataDir);
    this.transcripts = path.join(this.data, "transcripts");
    this.contactsPath = path.join(this.data, "contacts.csv");
    this.trackerPath = path.join(this.data, "tracker.csv");
    this.logPath = path.join(this.data, "run_log.csv");
    this.held = path.join(this.data, "held");
    this.ensure();
  }

  ensure() {
    fs.mkdirSync(this.held, { recursive: true });
    fs.mkdirSync(this.transcripts, { recursive: true });
    if (!fs.existsSync(this.trackerPath)) fs.writeFileSync(this.trackerPath, csvLine(TRACKER_COLS));
    if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, csvLine(LOG_COLS));
    if (!fs.existsSync(this.contactsPath)) throw new Error(`contacts table not found at ${this.contactsPath}`);
  }

  readCsv(p) {
    const rows = parseCsv(fs.readFileSync(p, "utf8"));
    const [head, ...body] = rows;
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
  }
  tracker() { return this.readCsv(this.trackerPath); }
  log() { return this.readCsv(this.logPath); }
  contacts() { return this.readCsv(this.contactsPath); }

  writeTracker(rows) {
    // full rewrite is used only for status changes; every other field is written back as read
    const text = csvLine(TRACKER_COLS) + rows.map((r) => csvLine(TRACKER_COLS.map((c) => r[c]))).join("");
    fs.writeFileSync(this.trackerPath, text);
  }

  writeLog(run, transcript, step, result, detail = "") {
    const ts = new Date();
    const local = new Date(ts.getTime() - ts.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    fs.appendFileSync(this.logPath, csvLine([local, run, transcript, step, result, detail]));
  }

  // ---------- transcripts ----------

  transcriptPath(name) {
    const base = path.basename(name);
    if (base !== name || !base.endsWith(".txt")) throw new Error(`not a transcript file name: ${name}`);
    const p = path.join(this.transcripts, base);
    if (!fs.existsSync(p)) throw new Error(`${name} is not in the transcripts folder`);
    return p;
  }

  header(name) {
    const out = { meeting: "", meeting_date: null, confidential: false, attendees: "" };
    for (const line of fs.readFileSync(this.transcriptPath(name), "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (s === "" || s.startsWith("[")) break;
      const i = s.indexOf(":");
      if (i < 0) continue;
      const key = s.slice(0, i).trim().toLowerCase(), val = s.slice(i + 1).trim();
      if (key === "meeting") out.meeting = val;
      else if (key === "date") out.meeting_date = val;
      else if (key === "attendees") out.attendees = val;
      else if (key === "classification" && val.toLowerCase().includes("confidential")) out.confidential = true;
    }
    return out;
  }

  processed() {
    const done = new Set();
    for (const r of this.log()) {
      if (r.step === "append" || r.step === "decline" || (r.step === "stop" && r.result === "held")) done.add(r.transcript);
    }
    return done;
  }

  scan(run) {
    const done = this.processed();
    const files = fs.readdirSync(this.transcripts).filter((f) => f.endsWith(".txt")).sort();
    const fresh = files.filter((f) => !done.has(f));
    const out = { run_id: run, new: [], declined: [] };
    for (const f of fresh) {
      const h = this.header(f);
      if (h.confidential) {
        this.writeLog(run, f, "decline", "declined", "Classification: Confidential in header; body not read");
        out.declined.push(f);
      } else {
        this.writeLog(run, f, "scan", "new", `meeting date ${h.meeting_date || NOT_STATED}`);
        out.new.push({ transcript: f, meeting: h.meeting, meeting_date: h.meeting_date || NOT_STATED, attendees: h.attendees });
      }
    }
    if (!fresh.length) this.writeLog(run, "", "scan", "nothing new", `${files.length} transcripts, all already processed`);
    return out;
  }

  readTranscript(name, run) {
    const h = this.header(name);
    if (h.confidential) {
      // Gate 4 holds even if the scan was skipped: the body never leaves the server
      this.writeLog(run, name, "decline", "declined", "Classification: Confidential in header; body not read (read refused)");
      throw new GateStop({ stop: "confidential", transcript: name,
        question: `${name} is marked confidential in its header. Its body is not read and nothing from it goes in the tracker.` });
    }
    return fs.readFileSync(this.transcriptPath(name), "utf8");
  }

  // ---------- lookup ----------

  matches(name) {
    const key = name.trim().toLowerCase();
    return this.contacts().filter((c) => c.name.trim().toLowerCase() === key);
  }

  lookup(name, run, transcript = "") {
    const m = this.matches(name);
    const result = m.length === 0 ? "none" : m.length === 1 ? "one" : "multiple";
    this.writeLog(run, transcript, "lookup", result, `${name}: ` + m.map((c) => `${c.company}, ${c.role}`).join("; "));
    return { name, result, matches: m };
  }

  // ---------- held rows ----------

  heldPath(transcript) { return path.join(this.held, transcript.replace(/\.txt$/, ".json")); }
  hold(transcript, rows, reason) {
    const p = this.heldPath(transcript);
    fs.writeFileSync(p, JSON.stringify({ transcript, reason, rows }, null, 2));
    return p;
  }
  getHeld(transcript) {
    if (transcript) {
      const p = this.heldPath(transcript);
      return fs.existsSync(p) ? [JSON.parse(fs.readFileSync(p, "utf8"))] : [];
    }
    return fs.readdirSync(this.held).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.held, f), "utf8")));
  }

  // ---------- append (gates 1, 2, 3) ----------

  append({ transcript, rows, run, accept_overdue = false, confirmed_empty = false }) {
    this.transcriptPath(transcript);
    rows = rows.map((r, i) => {
      for (const c of ["action", "owner", "due", "source_line"]) {
        if (r[c] === undefined) throw new Error(`row ${i}: missing ${c}`);
      }
      const o = { ...r, source_line: String(r.source_line), due_note: r.due_note || "" };
      if (!String(o.owner).trim()) o.owner = NOT_STATED;
      if (!String(o.due).trim()) o.due = NOT_STATED;
      o.status = o.status || "open";
      if (!["open", "confirm"].includes(o.status)) throw new Error(`row ${i}: status must be open or confirm on append`);
      return o;
    });

    // Gate 2
    if (rows.length === 0 && confirmed_empty) {
      if (fs.existsSync(this.heldPath(transcript))) fs.unlinkSync(this.heldPath(transcript));
      this.writeLog(run, transcript, "append", "0 rows", "no actions, confirmed by user");
      return { appended: [], confirmed_empty: true };
    }
    if (rows.length === 0) {
      this.writeLog(run, transcript, "stop", "held", "Gate 2 no actions: transcript held no actions; summary carries one sentence");
      this.hold(transcript, [], "no_actions");
      throw new GateStop({ stop: "no_actions", transcript,
        question: "This transcript held no actions. Nothing appended. Confirm that is right, or point me at the line I missed." });
    }

    // Gate 1
    for (const r of rows) {
      if (r.owner === NOT_STATED) { r.owner_company = r.owner_company || ""; r.owner_role = r.owner_role || ""; continue; }
      const m = this.matches(r.owner);
      if (m.length >= 2 && !r.owner_company) {
        const opts = m.map((c) => `${c.company}, ${c.role}`).join("; ");
        this.writeLog(run, transcript, "stop", "held", `Gate 1 duplicate name: ${r.owner} matches ${m.length} contacts (${opts})`);
        this.hold(transcript, rows, "duplicate_name");
        throw new GateStop({ stop: "duplicate_name", transcript, name: r.owner, matches: m,
          question: `${r.owner} matches ${m.length} contacts: ${opts}. Which one? Call tracker_append again with the held rows and owner_company set on that row.` });
      }
      if (m.length >= 2) {
        const chosen = m.find((c) => c.company.toLowerCase() === String(r.owner_company).toLowerCase());
        if (!chosen) throw new Error(`owner_company ${r.owner_company} is not one of the matches for ${r.owner}`);
        r.owner_company = chosen.company; r.owner_role = chosen.role;
        this.writeLog(run, transcript, "lookup", "answered", `${r.owner}: ${chosen.company}, ${chosen.role} (user chose)`);
      } else if (m.length === 1) {
        r.owner_company = m[0].company; r.owner_role = m[0].role;
      } else {
        r.owner_company = ""; r.owner_role = "";
        r.due_note = (r.due_note ? r.due_note + "; " : "") + "owner not in contacts table";
      }
    }

    // Gate 3
    const md = this.header(transcript).meeting_date;
    if (md && DATE_RE.test(md)) {
      for (const r of rows) {
        if (DATE_RE.test(r.due) && r.due < md && !accept_overdue) {
          this.writeLog(run, transcript, "stop", "held", `Gate 3 past due: line ${r.source_line} due ${r.due} is before the meeting date ${md}`);
          this.hold(transcript, rows, "past_due");
          throw new GateStop({ stop: "past_due", transcript, source_line: r.source_line, due: r.due, meeting_date: md,
            question: `Line ${r.source_line} is due ${r.due}, before the meeting date ${md}. Was the date mis-said, or was it already overdue when it was said? Call tracker_append again with the corrected date, or with accept_overdue true to record it as said.` });
        }
      }
    }

    // append, never overwrite
    const head = parseCsv(fs.readFileSync(this.trackerPath, "utf8"))[0];
    if (head.join(",") !== TRACKER_COLS.join(",")) throw new Error("tracker header does not match; refusing to write");
    let n = 0;
    for (const r of this.tracker()) { const m = /^A(\d+)$/.exec(r.action_id); if (m) n = Math.max(n, +m[1]); }
    const written = [];
    for (const r of rows) {
      n += 1;
      const rec = { action_id: `A${String(n).padStart(3, "0")}`, transcript, source_line: r.source_line, action: r.action,
        owner: r.owner, owner_company: r.owner_company || "", owner_role: r.owner_role || "", due: r.due, due_note: r.due_note,
        status: r.status, added_run: run, closed_run: "", closed_by: "" };
      fs.appendFileSync(this.trackerPath, csvLine(TRACKER_COLS.map((c) => rec[c])));
      written.push(rec);
    }
    if (fs.existsSync(this.heldPath(transcript))) fs.unlinkSync(this.heldPath(transcript));
    let detail = written.map((w) => w.action_id).join(", ");
    if (accept_overdue) detail += "; date recorded as said, confirmed by user";
    this.writeLog(run, transcript, "append", `${written.length} rows`, detail);
    return { appended: written };
  }

  // ---------- status changes ----------

  close({ action_id, transcript, source_line, run }) {
    const rows = this.tracker();
    const r = rows.find((x) => x.action_id === action_id);
    if (!r) throw new Error(`${action_id} is not in the tracker`);
    if (r.status === "closed") throw new Error(`${action_id} is already closed (${r.closed_by})`);
    r.status = "closed"; r.closed_run = run; r.closed_by = `${transcript} line ${source_line}`;
    this.writeTracker(rows);
    this.writeLog(run, transcript, "close", action_id, `closed by line ${source_line}: ${r.action}`);
    return { closed: r };
  }

  resolveDate({ action_id, due, meeting_date, run }) {
    const rows = this.tracker();
    const r = rows.find((x) => x.action_id === action_id);
    if (!r) throw new Error(`${action_id} is not in the tracker`);
    if (r.status !== "confirm") throw new Error(`${action_id} is not waiting on a date (status ${r.status})`);
    if (!DATE_RE.test(due) || !DATE_RE.test(meeting_date)) throw new Error("due and meeting_date must be YYYY-MM-DD");
    if (due < meeting_date) throw new Error(`due ${due} is before the meeting date ${meeting_date}; ask the user (Gate 3)`);
    const phrase = r.due;
    r.due = due; r.due_note = `converted from '${phrase}' using meeting date ${meeting_date} (given by user)`; r.status = "open";
    this.writeTracker(rows);
    this.writeLog(run, r.transcript, "resolve_date", action_id, `'${phrase}' to ${due}, meeting date ${meeting_date} given by user`);
    return { resolved: r };
  }

  note(run, transcript, detail) {
    this.writeLog(run, transcript || "", "note", "note", detail);
    return { logged: true };
  }

  // ---------- summary ----------

  summary(run, asOf) {
    const tracker = this.tracker();
    const log = this.log().filter((r) => r.run_id === run);
    const isNew = tracker.filter((r) => r.added_run === run);
    const closed = tracker.filter((r) => r.closed_run === run);
    const confirm = tracker.filter((r) => r.status === "confirm");
    const stops = log.filter((r, i) => r.step === "stop" && r.detail.startsWith("Gate") &&
      !log.slice(i + 1).some((x) => x.transcript === r.transcript && x.step === "append"));
    const answered = log.filter((r) => (r.step === "lookup" && r.result === "answered") || r.step === "resolve_date" ||
      (r.step === "append" && r.detail.includes("confirmed by user")));
    const notes = log.filter((r) => r.step === "note");
    const declined = log.filter((r, i) => r.step === "decline" &&
      log.findIndex((x) => x.step === "decline" && x.transcript === r.transcript) === i);
    const scanned = log.filter((r) => r.step === "scan" && r.result === "new");
    const open = tracker.filter((r) => r.status === "open" || r.status === "confirm");
    const runDate = asOf || new Date().toISOString().slice(0, 10);
    const overdue = open.filter((r) => DATE_RE.test(r.due) && r.due < runDate);

    const L = [`# Run summary, ${run}`, "",
      `Transcripts read: ${scanned.length}. Declined: ${declined.length}. Stopped at a gate: ${stops.length}. ` +
      `New actions: ${isNew.length}. Closed: ${closed.length}. Waiting on a date: ${confirm.length}.`, ""];
    if (stops.length || declined.length) {
      L.push("## Questions waiting for an answer", "");
      for (const r of declined) L.push(`- ${r.transcript}: declined, ${r.detail}.`);
      for (const r of stops) L.push(`- ${r.transcript}: ${r.detail}.`);
      L.push("");
    }
    if (isNew.length) {
      L.push("## New actions this run", "", "| id | action | owner | company | due | status | source |", "|---|---|---|---|---|---|---|");
      for (const r of isNew) L.push(`| ${r.action_id} | ${r.action} | ${r.owner} | ${r.owner_company} | ${r.due} | ${r.status} | ${r.transcript} line ${r.source_line} |`);
      L.push("");
    }
    if (answered.length) {
      L.push("## Answered this run", "");
      for (const r of answered) L.push(`- ${r.transcript}: ${r.detail}.`);
      L.push("");
    }
    if (closed.length) {
      L.push("## Closed this run", "");
      for (const r of closed) L.push(`- ${r.action_id} ${r.action} (${r.owner}), closed by ${r.closed_by}.`);
      L.push("");
    }
    if (confirm.length) {
      L.push("## Waiting on a meeting date", "");
      for (const r of confirm) L.push(`- ${r.action_id} ${r.action} (${r.owner}): due "${r.due}", ${r.due_note}. Give the meeting date for ${r.transcript} and the date will be filled.`);
      L.push("");
    }
    if (notes.length) {
      L.push("## Notes", "");
      for (const r of notes) L.push(`- ${r.transcript || "run"}: ${r.detail}`);
      L.push("");
    }
    if (overdue.length) {
      L.push(`## Overdue at run date ${runDate}`, "");
      for (const r of [...overdue].sort((a, b) => a.due.localeCompare(b.due))) L.push(`- ${r.action_id} ${r.action} (${r.owner}), due ${r.due} (${r.transcript} line ${r.source_line})`);
      L.push("");
    }
    L.push("## Open actions by owner", "");
    const by = new Map();
    for (const r of open) { if (!by.has(r.owner)) by.set(r.owner, []); by.get(r.owner).push(r); }
    const owners = [...by.keys()].sort((a, b) => (a === NOT_STATED) - (b === NOT_STATED) || a.localeCompare(b));
    for (const o of owners) {
      const rs = by.get(o);
      L.push(`**${o}**` + (rs[0].owner_company ? ` (${rs[0].owner_company})` : "") + `: ${rs.length}`);
      for (const r of [...rs].sort((a, b) => a.due.localeCompare(b.due))) L.push(`- ${r.action_id} ${r.action}, due ${r.due} (${r.transcript} line ${r.source_line})`);
      L.push("");
    }
    L.push("Contacts table (stands in for a CRM): data/contacts.csv. Tracker: data/tracker.csv. Log: data/run_log.csv.");
    const out = path.join(this.data, `summary_${run}.md`);
    const text = L.join("\n") + "\n";
    fs.writeFileSync(out, text);
    const board = path.join(this.data, `board_${run}.html`);
    fs.writeFileSync(board, renderBoard(this.data, { runId: run, asOf: runDate }));
    this.writeLog(run, "", "summary", "written", `${out}; ${board}`);
    return { path: out, board, text };
  }
}
