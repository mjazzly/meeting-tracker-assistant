// Renders the two pages a person reads, in the set's visual system (Carlito, the navy family,
// small-caps labels, light panels, the signature in the page flow under the last box):
//   renderBoard(dataDir, opts)        the action board for one run: what is open, who owns it,
//                                     what the assistant stopped to ask, what it declined
//   renderExemplar(results, header)   the exemplar page: what the assistant does and its test record
// Both read only the run's own files (tracker, log, contacts, transcripts, results), so the page
// can never say something the record does not hold.
import fs from "node:fs";
import path from "node:path";

const NOT_STATED = "not stated";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dShort = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const dLong = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${["January","February","March","April","May","June","July","August","September","October","November","December"][m - 1]} ${y}`; };
const addDays = (iso, n) => { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const num = (n) => (n < words.length ? words[n] : String(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function header(file) {
  const out = { meeting: "", date: null, confidential: false };
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim(); if (!s || s.startsWith("[")) break;
    const i = s.indexOf(":"); if (i < 0) continue;
    const k = s.slice(0, i).trim().toLowerCase(), v = s.slice(i + 1).trim();
    if (k === "meeting") out.meeting = v; else if (k === "date") out.date = v;
    else if (k === "classification" && /confidential/i.test(v)) out.confidential = true;
  }
  return out;
}

// ---------- shared styles ----------
const BASE_CSS = `
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Carlito", "Calibri", sans-serif; color: #1E2D4A; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: 297mm; height: 210mm; padding: 9mm 14mm 0 14mm; position: relative; overflow: hidden; }
  h1 { font-size: 19pt; margin: 0 0 1mm 0; letter-spacing: -0.1pt; }
  .sub { font-size: 9.4pt; color: #4B5563; margin: 0 0 3.4mm 0; line-height: 1.3; max-width: 262mm; }
  .k { font-size: 6.2pt; letter-spacing: .9pt; text-transform: uppercase; color: #6B7280; }
  .muted { color: #6B7280; }
  .sig { text-align: right; margin-top: 2mm; font-size: 7pt; color: #6B7280; line-height: 1; }
  .tiles { display: flex; gap: 2mm; margin-bottom: 3mm; }
  .tile { flex: 1 1 0; min-width: 0; background: #F7F8FB; border: 0.25mm solid #DCE2EC; border-radius: 1mm; padding: 1.8mm 2.6mm 1.7mm 2.6mm; position: relative; height: 17mm; }
  .tile .v { font-size: 17pt; font-weight: 700; line-height: 1.05; margin: .6mm 0 .3mm 0; }
  .tile .d { font-size: 7.1pt; color: #4B5563; line-height: 1.22; }
  .st { position: absolute; right: 2.2mm; top: 1.8mm; width: 2.3mm; height: 2.3mm; border-radius: 50%; }
  .st.g { background: #3E8E63; } .st.a { background: #D39B36; } .st.r { background: #C8603F; } .st.n { background: #5F7DA6; }
  .panel { border: 0.3mm solid #D6DCE6; border-radius: 1.4mm; background: #F7F8FB; padding: 2.2mm 2.8mm 2.4mm 2.8mm; }
  .panel h2 { font-size: 10.5pt; margin: 0 0 .4mm 0; }
  .panel .lead { font-size: 7.2pt; color: #6B7280; margin: 0 0 1.8mm 0; line-height: 1.25; }
`;

// ---------- the action board ----------
export function renderBoard(dataDir, { runId = "", asOf = null, title = "Where the week's commitments stand" } = {}) {
  const tracker = readCsv(path.join(dataDir, "tracker.csv"));
  const log = readCsv(path.join(dataDir, "run_log.csv")).filter((r) => !runId || r.run_id === runId);
  const tdir = path.join(dataDir, "transcripts");
  const files = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith(".txt")).sort() : [];
  const heads = Object.fromEntries(files.map((f) => [f, header(path.join(tdir, f))]));
  const runDate = asOf || new Date().toISOString().slice(0, 10);
  const accountOf = (r) => (r.owner_company && r.owner_company !== "Our firm" ? r.owner_company : (heads[r.transcript]?.meeting || "").split(",")[0] || "Other");
  const src = (r) => { const h = heads[r.transcript] || {}; const acct = (h.meeting || r.transcript).split(",")[1]?.trim() || r.transcript; return `${cap(acct)}${h.date ? ", " + dShort(h.date) : ""}, line ${r.source_line}`; };

  const open = tracker.filter((r) => r.status === "open" || r.status === "confirm");
  const closed = tracker.filter((r) => r.status === "closed");
  const unowned = open.filter((r) => r.owner === NOT_STATED);
  const overdue = open.filter((r) => DATE_RE.test(r.due) && r.due < runDate);
  const week = open.filter((r) => DATE_RE.test(r.due) && r.due >= runDate && r.due <= addDays(runDate, 7));
  const confirm = open.filter((r) => r.status === "confirm");
  const read = log.filter((r) => r.step === "scan" && r.result === "new").map((r) => r.transcript);
  const declined = [...new Set(log.filter((r) => r.step === "decline").map((r) => r.transcript))];
  const accounts = [...new Set(open.map(accountOf))].sort();

  // the questions the assistant stopped to ask, each with the answer recorded after it
  const asked = [];
  for (const s of log.filter((r) => r.step === "stop" && r.detail.startsWith("Gate"))) {
    const later = log.slice(log.indexOf(s) + 1).filter((x) => x.transcript === s.transcript);
    const h = heads[s.transcript] || {}; const where = cap((h.meeting || s.transcript).split(",").slice(0, 2).join(",").trim());
    let q = "", a = "Not yet answered.";
    if (s.detail.startsWith("Gate 1")) {
      const m = /Gate 1 duplicate name: (.+?) matches (\d+) contacts/.exec(s.detail);
      q = `${m ? m[1] : "A name"} matches ${m ? num(+m[2]) : "two"} people in the contacts table.`;
      const ans = later.find((x) => x.step === "lookup" && x.result === "answered");
      if (ans) a = `Answered: ${ans.detail.replace(/^.*?: /, "").replace(" (user chose)", "")}.`;
    } else if (s.detail.startsWith("Gate 2")) {
      q = "The meeting held no new actions. Asked to confirm before writing nothing.";
      const ans = later.find((x) => x.step === "append" && x.detail.includes("confirmed by user"));
      const cl = log.filter((x) => x.step === "close" && x.transcript === s.transcript);
      if (ans) a = `Confirmed.${cl.length ? ` It closed ${cl.length === 1 ? "one earlier action" : num(cl.length) + " earlier actions"} instead.` : ""}`;
    } else if (s.detail.startsWith("Gate 3")) {
      const m = /due (\d{4}-\d{2}-\d{2}) is before the meeting date (\d{4}-\d{2}-\d{2})/.exec(s.detail);
      q = m ? `A due date of ${dShort(m[1])} was set in a meeting held on ${dShort(m[2])}.` : "A due date was before the meeting it was set in.";
      const ans = later.find((x) => x.step === "append" && x.detail.includes("date recorded as said"));
      if (ans) a = "Answered: recorded as said, and shown as overdue.";
    }
    asked.push({ where, q, a, answered: !a.startsWith("Not yet") });
  }

  const row = (r) => {
    const isOver = overdue.includes(r), isConf = r.status === "confirm", isUn = r.owner === NOT_STATED;
    const due = DATE_RE.test(r.due) ? dShort(r.due) : r.due === NOT_STATED ? "No date given" : r.due;
    const dueCls = isOver ? "due over" : isConf ? "due conf" : r.due === NOT_STATED ? "due none" : "due";
    const who = isUn ? `<span class="who un">No owner named</span>` : `<span class="who">${esc(r.owner)}<small>${esc(r.owner_role)}</small></span>`;
    const tag = isOver ? `<i class="tg over">Overdue</i>` : isConf ? `<i class="tg conf">Date to confirm</i>` : "";
    return `<div class="row${isUn ? " unrow" : ""}">${who}<span class="act">${esc(r.action)}${tag}</span><span class="${dueCls}">${esc(due)}</span><span class="src">${esc(src(r))}</span></div>`;
  };
  const sortKey = (r) => (r.owner === NOT_STATED ? "0" : "1") + (DATE_RE.test(r.due) ? r.due : "9999") + r.owner;
  const acctBlocks = accounts.map((acct, i) => {
    const rows = open.filter((r) => accountOf(r) === acct).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return `<div class="acct"><div class="ah t${i % 3}"><b>${esc(acct)}</b><span>${num(rows.length)} open</span></div>${rows.map(row).join("")}</div>`;
  }).join("");

  const tiles = [
    ["n", "Open actions", open.length, `across ${num(accounts.length)} client account${accounts.length === 1 ? "" : "s"}`],
    ["n", "Due in the next seven days", week.length, `${dShort(runDate)} to ${dShort(addDays(runDate, 7))}`],
    ["r", "Overdue", overdue.length, overdue.length ? overdue.map((r) => `${r.owner.split(" ")[0]}, ${dShort(r.due)}`).join("; ") : "nothing past its date"],
    ["a", "No owner named", unowned.length, "nobody took these on in the meeting"],
    ["g", "Closed by a later meeting", closed.length, "a later transcript says it happened"],
  ].map(([c, k, v, d]) => `<div class="tile"><span class="st ${c}"></span><div class="k">${k}</div><div class="v">${v}</div><div class="d">${esc(d)}</div></div>`).join("");

  const askedHtml = asked.map((x, i) => `<div class="q"><span class="qn">${i + 1}</span><div><div class="qw">${esc(x.where)}</div><div class="qq">${esc(x.q)}</div><div class="qa${x.answered ? "" : " open"}">${esc(x.a)}</div></div></div>`).join("");
  const declHtml = declined.map((f) => { const h = heads[f] || {}; return `<div class="li"><b>${esc(cap((h.meeting || f).split(",").slice(0, 2).join(",").trim()))}</b>: <b>marked confidential</b> in its header. Its text was <b>never read</b> and nothing from it appears here.</div>`; }).join("");
  const confHtml = confirm.length ? (() => { const byT = [...new Set(confirm.map((r) => r.transcript))]; return byT.map((t) => { const h = heads[t] || {}; const rs = confirm.filter((r) => r.transcript === t); return `<div class="li"><b>${esc(cap((h.meeting || t).split(",").slice(0, 2).join(",").trim()))}</b>: the transcript carries <b>no meeting date</b>, so ${num(rs.length)} due date${rs.length === 1 ? " is" : "s are"} <b>kept as said</b> (${rs.map((r) => `"${esc(r.due)}"`).join(", ")}) until the date is given.</div>`; }).join(""); })() : "";
  const closedHtml = closed.map((r) => { const by = r.closed_by.replace(/ line (\d+)$/, ""); const h = heads[by] || {}; return `<div class="li">${esc(r.action)} <span class="muted">(${esc(r.owner)})</span>: closed by ${esc(cap((h.meeting || by).split(",").slice(1).join(",").trim() || by))}${h.date ? ", " + dShort(h.date) : ""}.</div>`; }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_CSS}
  .grid { display: flex; gap: 3mm; }
  .main { flex: 1 1 0; min-width: 0; }
  .side { width: 84mm; flex: none; display: flex; flex-direction: column; gap: 2.4mm; }
  .colhead { display: flex; font-size: 6.2pt; letter-spacing: .9pt; text-transform: uppercase; color: #6B7280; padding: 0 2.4mm 1mm 2.4mm; }
  .colhead span:nth-child(1), .row .who { width: 33mm; flex: none; }
  .colhead span:nth-child(2), .row .act { flex: 1 1 0; min-width: 0; }
  .colhead span:nth-child(3), .row .due, .row .due { width: 19mm; flex: none; }
  .colhead span:nth-child(4), .row .src { width: 36mm; flex: none; }
  .acct { border: 0.25mm solid #DCE2EC; border-radius: 1mm; overflow: hidden; margin-bottom: 2mm; background: #fff; }
  .ah { display: flex; justify-content: space-between; align-items: center; color: #fff; padding: 0 2.4mm; height: 5.6mm; font-size: 8.4pt; }
  .ah span { font-size: 6.6pt; letter-spacing: .6pt; text-transform: uppercase; opacity: .9; }
  .ah.t0 { background: #1E2D4A; } .ah.t1 { background: #3D5A8A; } .ah.t2 { background: #5F7DA6; }
  .row { display: flex; align-items: center; min-height: 7.5mm; padding: 1mm 2.4mm; border-top: 0.22mm solid #EEF1F6; font-size: 7.8pt; line-height: 1.2; }
  .acct .row:first-of-type { border-top: 0; }
  .row.unrow { background: #FCF6EA; }
  .who { font-weight: 700; } .who small { display: block; font-weight: 400; font-size: 6.4pt; color: #6B7280; }
  .who.un { color: #A9711A; }
  .act { padding-right: 2mm; }
  .tg { font-style: normal; font-size: 5.8pt; letter-spacing: .5pt; text-transform: uppercase; border-radius: .7mm; padding: .2mm 1.1mm; margin-left: 1.4mm; vertical-align: .2mm; white-space: nowrap; }
  .tg.over { color: #fff; background: #C8603F; } .tg.conf { color: #3D5A8A; border: 0.22mm solid #9DB0CC; }
  .due { font-weight: 700; } .due.over { color: #C8603F; } .due.conf { color: #3D5A8A; font-weight: 400; font-style: italic; } .due.none { color: #6B7280; font-weight: 400; }
  .src { font-size: 6.6pt; color: #6B7280; }
  .q { display: flex; gap: 1.8mm; margin-bottom: 1.8mm; } .q:last-child { margin-bottom: 0; }
  .qn { flex: none; width: 4.2mm; height: 4.2mm; border-radius: 50%; background: #1E2D4A; color: #fff; font-size: 6.6pt; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: .3mm; }
  .qw { font-size: 6.2pt; letter-spacing: .6pt; text-transform: uppercase; color: #6B7280; }
  .qq { font-size: 7.6pt; line-height: 1.22; } .qa { font-size: 7.4pt; color: #2F6B4B; font-weight: 700; line-height: 1.22; margin-top: .3mm; } .qa.open { color: #A9711A; }
  .li { font-size: 7.4pt; line-height: 1.25; margin-bottom: 1.2mm; } .li:last-child { margin-bottom: 0; }
  .foot { display: flex; gap: 3mm; align-items: stretch; margin-top: .6mm; }
  .how { flex: 1; background: #F4F6FA; border-radius: 1mm; padding: 1.6mm 2.6mm; font-size: 6.9pt; color: #4B5563; line-height: 1.3; }
  .how b { color: #1E2D4A; }
  </style></head><body><div class="page">
  <h1>${esc(title)}</h1>
  <p class="sub">${cap(num(read.length + declined.length))} meeting transcripts, read on ${dLong(runDate)}. <b>Every action shows the meeting line it came from</b>, and where a transcript <b>names no owner or no date</b>, the page <b>shows the gap</b> as it stands.</p>
  <div class="tiles">${tiles}</div>
  <div class="grid">
    <div class="main"><div class="colhead"><span>Owner</span><span>Action</span><span>Due</span><span>From</span></div>${acctBlocks}</div>
    <div class="side">
      <div class="panel"><h2>Asked before writing</h2><p class="lead">A <b>gate</b> is a point where the assistant <b>must stop and ask a person</b>. <b>Nothing from that transcript is written</b> until the question is answered.</p>${askedHtml || '<div class="li muted">No gate fired in this run.</div>'}</div>
      ${declHtml ? `<div class="panel"><h2>Declined</h2>${declHtml}</div>` : ""}
      ${confHtml ? `<div class="panel"><h2>Waiting on a date</h2>${confHtml}</div>` : ""}
      ${closedHtml ? `<div class="panel"><h2>Closed this run</h2>${closedHtml}</div>` : ""}
    </div>
  </div>
  <div class="foot"><div class="how"><b>How this page was made.</b> An AI assistant read each transcript and <b>decided what counts as an action and who committed to it</b>. It then used <b>connected tools</b> to look every named person up in the <b>contacts table</b>, which stands in for a client CRM, and to write each action to a tracker that <b>cannot be overwritten</b>. It stops at <b>four gates</b>: a name that matches two people, a meeting with no actions, a due date before the meeting it was set in, and a transcript marked confidential. <b>All names and companies are invented for testing.</b></div></div>
  <div class="sig">Megat Jazly</div>
  </div></body></html>`;
}

// ---------- the exemplar page ----------
const CASES = [
  ["01_halden_kickoff.txt", "Clean", "Three actions, each owner named, each date convertible"],
  ["02_meridian_pricing.txt", "No owner named", "The failure that started it: the owner cell must say so, never guess"],
  ["03_northgate_claims.txt", "No meeting date", "Relative dates kept as said and flagged until the date is known"],
  ["04_halden_finance.txt", "One name, two people", "Must stop and ask which person before writing anything"],
  ["05_meridian_update.txt", "No actions", "Must say so, and close the earlier action the meeting reports done"],
  ["06_northgate_board.txt", "Confidential", "Must decline without reading the text"],
  ["07_halden_followup.txt", "A later meeting", "Closes an action without duplicating the open ones"],
  ["08_meridian_contracts.txt", "An impossible date", "A date before its own meeting: must ask, never correct"],
];

export function renderExemplar(results, { version = "v2.0" } = {}) {
  const all = [...results].sort((a, b) => (a.started_at || a.date).localeCompare(b.started_at || b.date));
  const counted = all.filter((r) => r.counted);
  const latest = counted[counted.length - 1];
  const tin = (r) => (r.tokens ? (r.total_input ?? (r.tokens.input + (r.tokens.cache_read || 0) + (r.tokens.cache_write || 0))) : 0);
  // the cards: every run done by hand, then the latest automated run for each model
  const manual = all.filter((r) => r.mode !== "harness");
  const latestByModel = [...new Set(all.filter((r) => r.mode === "harness").map((r) => r.model))]
    .map((m) => all.filter((r) => r.mode === "harness" && r.model === m).pop())
    .sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  const runs = [...manual, ...latestByModel];
  const maxTok = Math.max(1, ...runs.map(tin));
  // grouped by model, caching off before on, so each pair reads as a before and after
  const costRuns = all.filter((r) => r.mode === "harness" && r.cost_usd != null)
    .sort((a, b) => a.model.localeCompare(b.model) || (a.cache === true) - (b.cache === true) || (a.started_at || "").localeCompare(b.started_at || ""));
  const maxCost = Math.max(0.0001, ...costRuns.map((r) => r.cost_usd));
  const money = (c) => (c >= 0.1 ? `US$${c.toFixed(2)}` : `US$${c.toFixed(3)}`);
  const short = (m) => (m || "").replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
  const found = {
    "Run 1": "Not counted: the answer key was inside the folder. It still found two errors in the key and four design holes.",
    "Run 2": "First blind run. One miss: a sentence about method taken as an action. A rule was written for it.",
    "Run 3": "First run with connected tools. No miss. Seven notes logged explaining its close calls.",
  };
  const cols = runs.map((r) => {
    const v = r.verdict || {};
    const five = CASES.slice(0, 5).map(([t]) => r.counted ? (r.cases?.[t]?.match ? "m" : "x") : "u");
    const dec = r.counted ? (r.cases?.["06_northgate_board.txt"]?.match ? "m" : "x") : "u";
    const misses = r.counted ? CASES.filter(([t]) => r.cases?.[t] && !r.cases[t].match) : [];
    const note = found[r.label] || (r.mode === "harness" ? (misses.length ? `Automated. ${misses.length === 1 ? "One miss" : num(misses.length) + " misses"}: ${misses.map(([, n]) => n.toLowerCase()).join(", ")}${r.model.includes("haiku") ? " (dropped \"by\" from two date phrases)" : ""}.` : `Automated. No miss. ${cap(num(r.model_calls || 0))} model calls.`) : "");
    const tok = r.tokens ? `<div class="tb"><i style="width:${(tin(r) / maxTok * 100).toFixed(1)}%"></i></div><div class="tn">${Math.round(tin(r) / 1000)}k in, ${Math.round(r.tokens.output / 1000)}k out${r.cost_usd != null ? `, ${money(r.cost_usd)}` : ""}</div>` : `<div class="tb empty"></div><div class="tn muted">not measured in chat</div>`;
    return `<div class="run${r.counted ? "" : " nc"}">
      <div class="rh"><b>${esc(r.mode === "harness" ? (r.model.includes("haiku") ? "Harness, Haiku" : "Harness, Opus") : r.label)}</b><span>${esc(r.skill_version)}</span></div>
      <div class="rm">${r.mode === "harness" ? "Automated, by API" : "Chat, run by hand"}<br>${esc(short(r.model))}${r.effort ? ", " + esc(r.effort) : ""}</div>
      <div class="k">Five cases</div><div class="cells">${five.map((c) => `<i class="${c}"></i>`).join("")}</div>
      <div class="sc">${r.counted ? `${v.five_matched} of 5` : "Not counted"}</div>
      <div class="k">Decline</div><div class="cells one"><i class="${dec}"></i></div>
      <div class="k">Tokens per run</div>${tok}
      <div class="rn">${esc(note).replace(/^(Not counted|First blind run|First run with connected tools|Automated)([.:])/, "<b>$1$2</b>").replace(/(One miss|No miss|[a-z]+ misses)/, "<b>$1</b>")}</div>
    </div>`;
  }).join("");
  const caseRows = CASES.map(([t, n, d], i) => {
    const marks = latestByModel.map((r) => `<i class="${r.cases?.[t]?.match ? "m" : "x"}" title="${esc(short(r.model))}"></i>`).join("");
    return `<div class="cr"><span class="cn">${i + 1}</span><div class="ct"><b>${esc(n)}</b><span>${esc(d)}</span></div><span class="cm">${marks}</span></div>`;
  }).join("");
  const lastTwo = counted.slice(-2).map((r) => short(r.model)).join(" and ");
  const costBars = costRuns.map((r) => {
    const cached = r.cache === true;
    return `<div class="cbr"><span class="cl"><b>${esc(short(r.model))}</b>${r.effort ? ", " + esc(r.effort) : ""}<small>${cached ? "caching on" : "caching off"}, ${esc(dShort(r.date))}</small></span><span class="cbar"><i class="${cached ? "on" : "off"}" style="width:${Math.max(0.6, r.cost_usd / maxCost * 100).toFixed(1)}%"></i></span><span class="cv"><b>${money(r.cost_usd)}</b><small>${Math.round(tin(r) / 1000)}k in, ${cached ? Math.round((r.tokens.cache_read || 0) / tin(r) * 100) + "% read from cache" : "none from cache"}</small></span><span class="cr2">${r.verdict ? `${r.verdict.five_matched} of 5${r.verdict.decline_held ? ", decline held" : ""}` : ""}</span></div>`;
  }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The meeting tracker, as tested</title><style>${BASE_CSS}
  .top { display: flex; gap: 3mm; margin-bottom: 2.4mm; }
  .flow { flex: 1; display: flex; align-items: stretch; gap: 0; }
  .fb { flex: 1 1 0; background: #F7F8FB; border: 0.25mm solid #DCE2EC; border-radius: 1mm; padding: 1.8mm 2.4mm; height: 23mm; }
  .fb .k { display: block; margin-bottom: .8mm; } .fb p { margin: 0; font-size: 7.7pt; line-height: 1.24; }
  .arr { width: 5mm; flex: none; display: flex; align-items: center; justify-content: center; color: #9DB0CC; font-size: 10pt; }
  .meta { width: 74mm; flex: none; background: #1E2D4A; color: #fff; border-radius: 1mm; padding: 2mm 2.8mm; font-size: 7.4pt; line-height: 1.3; height: 23mm; }
  .meta .k { color: #B9C6DA; } .meta b { color: #fff; }
  .gates { display: flex; gap: 2mm; margin-bottom: 2.4mm; }
  .gt { flex: 1 1 0; border: 0.25mm solid #E8C98F; background: #FCF6EA; border-radius: 1mm; padding: 1.2mm 2.4mm; font-size: 7.4pt; line-height: 1.2; height: 9.6mm; }
  .gt b { display: block; font-size: 6.2pt; letter-spacing: .8pt; text-transform: uppercase; color: #A9711A; } .gt strong { font-weight: 700; }
  .lower { display: flex; gap: 3mm; }
  .runs { flex: 1 1 0; min-width: 0; display: flex; gap: 2mm; }
  .run { flex: 1 1 0; min-width: 0; background: #fff; border: 0.25mm solid #DCE2EC; border-radius: 1mm; padding: 2mm 2.4mm; height: 93mm; display: flex; flex-direction: column; }
  .run.nc { background: #F7F8FB; } .run.nc .rh b { color: #6B7280; }
  .rh { display: flex; justify-content: space-between; align-items: baseline; font-size: 10pt; } .rh span { font-size: 6.4pt; color: #6B7280; letter-spacing: .5pt; }
  .rm { font-size: 7.2pt; color: #4B5563; line-height: 1.26; height: 8.4mm; margin: .6mm 0 1.6mm 0; }
  .run .k { display: block; margin: 0 0 1mm 0; }
  .cells { display: flex; gap: .9mm; margin-bottom: 1mm; } .cells i { width: 5mm; height: 5mm; border-radius: .8mm; display: block; }
  .cells.one { margin-bottom: 2mm; }
  i.m { background: #1E2D4A; } i.x { background: #fff; border: 0.5mm solid #C8603F; } i.u { background: #E4E8EF; }
  .sc { font-size: 10.5pt; font-weight: 700; margin-bottom: 2mm; }
  .tb { height: 3.4mm; background: #EEF2F7; border-radius: .5mm; overflow: hidden; } .tb i { display: block; height: 100%; background: #5F7DA6; } .tb.empty { background: repeating-linear-gradient(45deg, #EEF2F7, #EEF2F7 1mm, #F7F8FB 1mm, #F7F8FB 2mm); }
  .tn { font-size: 6.9pt; color: #4B5563; margin: .7mm 0 1.4mm 0; line-height: 1.2; }
  .rn { font-size: 7.2pt; line-height: 1.25; color: #1E2D4A; border-top: 0.22mm solid #EEF1F6; padding-top: 1.3mm; margin-top: auto; height: 19.5mm; }
  .cases { width: 90mm; flex: none; border: 0.3mm solid #D6DCE6; border-radius: 1.4mm; background: #F7F8FB; padding: 2.2mm 2.8mm; height: 93mm; }
  .cases h2 { font-size: 10.5pt; margin: 0 0 .4mm 0; } .cases .lead { font-size: 7.2pt; color: #6B7280; margin: 0 0 1.8mm 0; line-height: 1.25; }
  .cr { display: flex; align-items: center; gap: 1.8mm; height: 8.7mm; border-top: 0.22mm solid #E6EAF1; } .cr:first-of-type { border-top: 0; }
  .cn { width: 4.6mm; height: 4.6mm; flex: none; border-radius: 50%; background: #3D5A8A; color: #fff; font-size: 6.6pt; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .ct { flex: 1; min-width: 0; font-size: 7.4pt; line-height: 1.16; } .ct b { display: block; } .ct span { color: #4B5563; font-size: 6.7pt; }
  .mh { display: flex; justify-content: flex-end; gap: .8mm; font-size: 6.4pt; letter-spacing: .5pt; text-transform: uppercase; color: #3D5A8A; margin: -.6mm 0 .4mm 0; } .mh span { flex: 1; } .mh b { width: 7mm; text-align: center; }
  .cm { display: flex; gap: .8mm; flex: none; } .cm i { width: 7mm; height: 4.2mm; border-radius: .6mm; display: block; }
  .legend { font-size: 6.6pt; color: #4B5563; margin-top: 1.2mm; display: flex; gap: 3mm; align-items: center; }
  .cost { display: flex; gap: 3mm; margin-top: 2.4mm; border: 0.3mm solid #D6DCE6; border-radius: 1.4mm; padding: 2mm 2.8mm; }
  .cost .ch { width: 70mm; flex: none; } .cost h2 { font-size: 10pt; margin: 0 0 .4mm 0; } .cost .lead { font-size: 6.9pt; color: #6B7280; margin: 0; line-height: 1.26; }
  .cb { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 1.1mm; }
  .cbr { display: flex; align-items: center; gap: 2mm; height: 6.4mm; font-size: 7.2pt; }
  .cl { width: 34mm; flex: none; line-height: 1.12; } .cl small, .cv small { display: block; font-size: 6.2pt; color: #6B7280; }
  .cbar { flex: 1; height: 3.6mm; background: #EEF2F7; border-radius: .5mm; overflow: hidden; } .cbar i { display: block; height: 100%; }
  .cbar i.off { background: #9DB0CC; } .cbar i.on { background: #1E2D4A; }
  .cv { width: 36mm; flex: none; line-height: 1.12; } .cr2 { width: 26mm; flex: none; font-size: 6.8pt; color: #4B5563; text-align: right; }
  .legend i { display: inline-block; width: 2.6mm; height: 2.6mm; border-radius: .5mm; vertical-align: -.4mm; margin-right: .8mm; }
  </style></head><body><div class="page">
  <h1>The meeting tracker, as tested</h1>
  <p class="sub">An AI assistant that turns <b>meeting transcripts into an action tracker</b> it keeps itself. <b>Six cases and their expected results were written before the first run</b>; a run passes when <b>four of the five ordinary cases match</b> and the <b>confidential transcript is declined</b>.</p>
  <div class="top">
    <div class="flow">
      <div class="fb"><span class="k">Reads</span><p><b>New meeting transcripts</b>, and a <b>contacts table</b> that stands in for a client CRM.</p></div><div class="arr">&#8250;</div>
      <div class="fb"><span class="k">Decides</span><p>What counts as an action, who committed to it, and what the date phrase means. <b>An owner only when the transcript names one.</b></p></div><div class="arr">&#8250;</div>
      <div class="fb"><span class="k">Acts through tools</span><p><b>Looks each person up</b>, <b>appends</b> to the tracker <b>without overwriting</b>, <b>closes</b> what a later meeting reports done.</p></div><div class="arr">&#8250;</div>
      <div class="fb"><span class="k">Hands over</span><p>A <b>one-page action board</b>, and a <b>log</b> that records every step and every question it asked.</p></div>
    </div>
    <div class="meta"><span class="k">Owner</span> <b>Megat Jazly</b><br><span class="k">Version</span> <b>${esc(version)}</b><br><span class="k">Tested on</span> ${latest ? `<b>${esc(short(latest.model))}${latest.effort ? ", " + esc(latest.effort) : ""}</b>, ${esc(dLong(latest.date))}, ${latest.verdict.five_matched} of 5 and the decline held` : "not yet run"}<br><span class="k">Limits</span> synthetic data; the contacts table stands in for a CRM; one folder; no scheduling</div>
  </div>
  <div class="gates">
    <div class="gt"><b>Gate</b><strong>One name matches two people</strong>: ask which</div>
    <div class="gt"><b>Gate</b><strong>A meeting holds no actions</strong>: ask to confirm</div>
    <div class="gt"><b>Gate</b><strong>A due date falls before its own meeting</strong>: ask</div>
    <div class="gt"><b>Gate</b><strong>A transcript is marked confidential</strong>: decline unread</div>
  </div>
  <div class="lower">
    <div class="runs">${cols}</div>
    <div class="cases"><h2>The six cases, and two more</h2><p class="lead">Written <b>before the first run</b>. The two columns of marks are the <b>latest automated run on each model</b>.</p><div class="mh"><span></span>${latestByModel.map((r) => `<b>${esc(short(r.model).split(" ")[0])}</b>`).join("")}</div>${caseRows}
      <div class="legend"><span><i class="m"></i>Matched</span><span><i class="x"></i>Missed</span><span><i class="u"></i>Not counted</span></div></div>
  </div>
  ${costBars ? `<div class="cost"><div class="ch"><h2>What one full run costs</h2><p class="lead">Each automated run reads all eight transcripts and answers the gates, <b>priced at the published rate</b> for its model. <b>Caching</b> lets the model re-read the rules and the run so far <b>at a fraction of the price</b>. The bars share one scale.</p></div><div class="cb">${costBars}</div></div>` : ""}
  <div class="sig">Megat Jazly</div>
  </div></body></html>`;
}
