// The five routes, as plain functions of a request, so the offline tests call exactly what Vercel calls.
//   GET /           anyone: the board as last released, the questions waiting, the last run, the cycle day
//   GET /board      anyone: the board's own page, shown in a frame on /
//   GET /api/state  anyone: read-only JSON for the record job
//   GET /api/run    Vercel Cron (CRON_SECRET) or Megat (RUN_TOKEN): one run
//   GET/POST /held  Megat (ANSWER_TOKEN, as a cookie): the held questions and one form each
// The public routes read only the Upstash snapshot: no Drive call, no model call, nothing writable.
// req: { method, url, headers (lower-case names), body (string), ip }; returns { status, headers, body }.
import crypto from "node:crypto";
import { K, monthKey } from "./kv.js";
import { run, MODEL, TIER, LIMITS } from "./runner.js";
import { Folder } from "./folder.js";
import { sentence } from "./questions.js";
import { klDate } from "./cycle.js";

const REPO = "https://github.com/mjazzly/meeting-tracker-assistant";
const SITE = "https://mjazzly.github.io";
const MAX_FAILS = 10;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const html = (status, body, headers = {}) => ({ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }, body });
const json = (status, obj, headers = {}) => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body: JSON.stringify(obj, null, 2) });
// The three public routes are cached at Vercel's edge for a minute, so a flood of visits reaches the
// function (and the Upstash database it shares with the data answers demo) at most once a minute per region.
const PUBLIC = { "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" };

// ---------- failed tokens: ten in a day closes that address for the day ----------
const ipKey = (env, ip) => sha(`${env.IP_SALT || "meeting-tracker"}|${ip || "unknown"}`).slice(0, 16);
async function closed(kv, env, ip) { return Number(await kv.get(K.fails(klDate(), ipKey(env, ip)))) >= MAX_FAILS; }
async function failed(kv, env, ip) { const k = K.fails(klDate(), ipKey(env, ip)); await kv.incr(k); await kv.expire(k, 172800); }

// ---------- the page shell, in the site's theme ----------
function page(title, main, { back = `${SITE}/aiwork.html#work-08`, backLabel = "Back to AI Work" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Megat Jazly</title><meta name="robots" content="noindex">
<link rel="icon" href="${SITE}/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/tracker.css"></head><body>
<nav class="top"><div class="wrap"><a class="brand" href="${SITE}/index.html"><span class="seam silver" aria-hidden="true"></span><span class="brand-name">Megat Jazly</span><span class="seam" aria-hidden="true"></span></a>
<div class="links"><a href="${back}">${backLabel}</a></div></div></nav>
<div class="wrap">${main}
<footer><div class="end"><p>Thanks for reading. Say hello anytime.</p></div></footer></div></body></html>`;
}

const GATE_NAME = { duplicate_name: "Which person", no_actions: "No actions", past_due: "Date before the meeting", meeting_date: "Meeting date" };

function runLine(r) {
  if (!r) return "No run yet.";
  const when = `${r.at.slice(0, 10)} ${r.at.slice(11, 16)} UTC`;
  if (!r.run_id) return `${esc(when)}: ${esc(r.outcome)}, ${esc(r.detail || "")}.`;
  const parts = [`${r.read?.length || 0} read`, `${r.appended} actions added`, `${r.closed} closed`, `${r.held} held`];
  if (r.answers_given) parts.push(`${r.answers_applied} of ${r.answers_given} answers applied`);
  parts.push(r.model_calls ? `${r.model_calls} model calls, US$${r.cost_usd.toFixed(4)}` : "no model call");
  return `<span class="mono">${esc(r.run_id)}</span>, ${esc(when)}: ${esc(r.outcome)}. ${esc(parts.join(", "))}.`;
}

async function snapshot(kv) {
  const snap = JSON.parse((await kv.get(K.snapshot)) || "null");
  const runs = (await kv.lrange(K.runs, 0, 29)).map((x) => (typeof x === "string" ? JSON.parse(x) : x));
  return { snap, runs };
}

// A deployment without Upstash (a preview, or before setup) answers every route plainly, never with a crash.
const unset = (deps) => !deps.kv;

// ---------- GET / ----------
export async function home(deps) {
  if (unset(deps)) return html(503, page("Meeting tracker", `<section><p>Not configured.</p></section>`));
  const { snap, runs } = await snapshot(deps.kv);
  const env = deps.env || {};
  const folder = env.DRIVE_FOLDER_ID ? `https://drive.google.com/drive/folders/${encodeURIComponent(env.DRIVE_FOLDER_ID)}` : null;
  const cyc = snap?.cycle?.day ? `Day ${snap.cycle.day} of 28. On days 1 to 8 the service adds one synthetic transcript to the folder; on days 9 to 28 a run finds nothing new and makes no model call.`
    : "The first cycle has not started yet.";
  const waiting = snap?.waiting || [];
  const qs = waiting.length ? `<ul class="held">${waiting.map((q) => `<li><span class="gate-mark">${esc(GATE_NAME[q.gate] || q.gate)}</span> <span class="mono">${esc(q.transcript)}</span>, since <span class="mono">${esc(q.since_run)}</span><p>${esc(q.question)}</p></li>`).join("")}</ul>`
    : `<p class="quiet">Nothing is waiting on a person.</p>`;
  const main = `<header class="hero"><p class="eyebrow">Meeting tracker <span class="dot">·</span> runs every morning</p>
<h1>The tracker, running on its own</h1>
<p class="thesis">Every morning a scheduled run reads any new meeting transcript in a Google Drive folder, adds the actions to a tracker kept in that same folder, and writes the board below. Where the tracker would otherwise have to guess, a gate in the code stops it and holds the question until a person answers. A transcript here is the written record of one meeting; every one is synthetic.</p>
<div class="hero-links">${folder ? `<a href="${folder}">The Drive folder</a>` : ""}<a href="${REPO}/tree/main/results/hosted">Record of every run</a><a href="${REPO}/actions/workflows/cases.yml">Checks on every change</a><a href="${REPO}">The code</a></div></header>
<section><div class="panel"><h2>Last run</h2><p>${runLine(runs[0])}</p><p class="quiet">${esc(cyc)} The model is the ${TIER} tier.</p></div></section>
<section><div class="panel"><h2>Waiting on a person (${waiting.length})</h2>${qs}<p class="quiet">Answers are given on a page only the owner can open, and applied by the next run.</p></div></section>
<section><h2>The board as last released${snap?.board_run ? `, <span class="mono">${esc(snap.board_run)}</span>` : ""}</h2>
<iframe class="board" src="/board" title="The action board" loading="lazy"></iframe></section>`;
  return html(200, page("Meeting tracker, running on its own", main), PUBLIC);
}

// ---------- GET /board ----------
export async function board(deps) {
  if (unset(deps)) return html(503, "<!doctype html><p>Not configured.</p>");
  const b = await deps.kv.get(K.board);
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...PUBLIC,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:" },
    body: b || "<!doctype html><p>No board yet.</p>" };
}

// ---------- GET /api/state ----------
export async function state(deps) {
  if (unset(deps)) return json(503, { error: "not configured" });
  const { snap, runs } = await snapshot(deps.kv);
  const spent = Number(await deps.kv.get(K.monthCost(monthKey()))) / 1e6 || 0;
  return json(200, { last_run: runs[0] || null, runs, ...(snap || {}), model: MODEL, tier: TIER,
    month: monthKey(), cost_month_usd: Number(spent.toFixed(6)), budget_usd: LIMITS.budgetUsd }, PUBLIC);
}

// ---------- GET /api/run ----------
const RUN_NEEDS = ["CRON_SECRET", "RUN_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_SA_KEY", "DRIVE_TRANSCRIPTS_ID", "DRIVE_TRACKER_ID", "DRIVE_RELEASED_ID", "CYCLE_START"];
export async function runRoute(deps, req) {
  const env = deps.env || {};
  if (!deps.kv) return json(503, { error: "not configured" });
  if (await closed(deps.kv, env, req.ip)) return json(429, { error: "closed for today" });
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const trigger = same(auth, env.CRON_SECRET) ? "cron" : same(auth, env.RUN_TOKEN) ? "manual" : null;
  if (!trigger) { await failed(deps.kv, env, req.ip); return json(401, { error: "not allowed" }); }
  const missing = RUN_NEEDS.filter((k) => !env[k]);
  if (missing.length || !deps.drive || !deps.model) return json(503, { error: "not configured", missing });
  const q = new URL(req.url, "http://x").searchParams;
  const feed = trigger === "manual" && q.get("feed") === "next" ? "next" : trigger === "manual" && q.get("feed") === "none" ? "none" : "due";
  const out = await run(deps, { feed, trigger });
  return json(out.status, out.line);
}

// ---------- /held ----------
const COOKIE = "mt_answer";
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }))[COOKIE];

// The one answer path: the form on /held and the CI path both come through here.
export async function saveAnswer(deps, { transcript = null, gate = null, text }) {
  const lock = crypto.randomBytes(8).toString("hex");
  if (!(await deps.kv.set(K.lock, lock, { nx: true, ex: 60 }))) return { saved: false, why: "A run is in progress. Nothing was saved; try again in a few minutes." };
  try {
    if (await deps.kv.get(K.pushing)) return { saved: false, why: "The last save did not complete, so nothing new is saved until a person has looked." };
    const folder = new Folder(deps.drive, deps.ids);
    const answers = JSON.parse((await folder.read("answers.json")) || "[]");
    const a = { id: `ans-${answers.length + 1}`, transcript, gate, text, saved_at: new Date().toISOString(), given_runs: [], applied_run: null, status: "waiting" };
    answers.push(a);
    await folder.save({ "answers.json": JSON.stringify(answers, null, 2) + "\n" }, deps.kv, `answer ${a.id}`);
    const snap = JSON.parse((await deps.kv.get(K.snapshot)) || "null");
    if (snap) {
      snap.answers_waiting = answers.filter((x) => x.status === "waiting").length;
      if (transcript) snap.answered = [...new Set([...(snap.answered || []), `${transcript} ${gate}`])];
      await deps.kv.set(K.snapshot, JSON.stringify(snap));
    }
    return { saved: true, answer: a };
  } finally {
    if ((await deps.kv.get(K.lock)) === lock) await deps.kv.del(K.lock);
  }
}

function heldForm(q) {
  const hidden = `<input type="hidden" name="transcript" value="${esc(q.transcript)}"><input type="hidden" name="gate" value="${esc(q.gate)}">`;
  let fields = "";
  if (q.gate === "duplicate_name") fields = (q.options || []).map((o) => `<label><input type="radio" name="company" value="${esc(o.company)}" required> ${esc(o.company)}, ${esc(o.role)}</label>`).join("");
  else if (q.gate === "no_actions") fields = `<label><input type="radio" name="confirm" value="yes"> Yes, there are no actions</label><label>Or the line missed <input name="line" inputmode="numeric" size="4"></label>`;
  else if (q.gate === "past_due") fields = `<label><input type="radio" name="accept" value="yes"> Record it as said</label><label>Or the corrected date <input type="date" name="date"></label>`;
  else if (q.gate === "meeting_date") fields = `<label>The meeting date <input type="date" name="date" required></label>`;
  return `<form method="post" action="/held" class="answer">${hidden}${fields}<button>Save the answer</button></form>`;
}

export async function held(deps, req) {
  const env = deps.env || {};
  if (!deps.kv || !env.ANSWER_TOKEN) return html(503, page("Held questions", `<section><p>Not configured.</p></section>`));
  if (await closed(deps.kv, env, req.ip)) return html(429, page("Held questions", `<section><p>Closed for today.</p></section>`));
  const u = new URL(req.url, "http://x");
  const want = sha(env.ANSWER_TOKEN);
  if (req.method === "GET" && u.searchParams.has("token")) {
    if (!same(u.searchParams.get("token"), env.ANSWER_TOKEN)) { await failed(deps.kv, env, req.ip); return html(401, page("Held questions", `<section><p>This page is for the owner.</p></section>`)); }
    return { status: 303, headers: { location: "/held", "set-cookie": `${COOKIE}=${want}; Path=/held; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000`, "cache-control": "no-store" }, body: "" };
  }
  if (!same(cookieOf(req), want)) { await failed(deps.kv, env, req.ip); return html(401, page("Held questions", `<section><p>This page is for the owner.</p></section>`)); }
  const { snap } = await snapshot(deps.kv);
  const waiting = snap?.waiting || [];

  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && req.headers.host && new URL(origin).host !== req.headers.host) return html(403, page("Held questions", `<section><p>Refused: the form came from another site.</p></section>`));
    const f = Object.fromEntries(new URLSearchParams(req.body || ""));
    const q = waiting.find((x) => x.transcript === f.transcript && x.gate === f.gate);
    if (!q) return html(400, page("Held questions", `<section><p>That question is no longer waiting.</p><p><a href="/held">Back</a></p></section>`));
    let text;
    try { text = sentence(q, f); } catch (e) { return html(400, page("Held questions", `<section><p>${esc(e.message)}.</p><p><a href="/held">Back</a></p></section>`)); }
    if (!deps.drive || !deps.ids) return html(503, page("Held questions", `<section><p>Not configured.</p></section>`));
    const r = await saveAnswer(deps, { transcript: q.transcript, gate: q.gate, text });
    if (!r.saved) return html(409, page("Held questions", `<section><p>${esc(r.why)}</p><p><a href="/held">Back</a></p></section>`));
    return { status: 303, headers: { location: "/held?saved=1", "cache-control": "no-store" }, body: "" };
  }

  const answered = new Set(snap?.answered || []);
  const items = waiting.map((q) => `<li><span class="gate-mark">${esc(GATE_NAME[q.gate] || q.gate)}</span> <span class="mono">${esc(q.transcript)}</span>, since <span class="mono">${esc(q.since_run)}</span><p>${esc(q.question)}</p>${answered.has(`${q.transcript} ${q.gate}`) ? `<p class="quiet">An answer is saved; the next run applies it.</p>` : heldForm(q)}</li>`).join("");
  const main = `<header class="hero"><p class="eyebrow">Meeting tracker <span class="dot">·</span> owner only</p><h1>Held questions</h1>
<p class="thesis">Each answer is saved to the folder as one sentence and applied by the next run. ${u.searchParams.has("saved") ? "<b>Saved.</b>" : ""} ${snap?.answers_waiting ? `${snap.answers_waiting} saved answers wait for the next run.` : ""}</p></header>
<section>${items ? `<ul class="held">${items}</ul>` : `<p>Nothing is waiting on a person.</p>`}</section>`;
  return html(200, page("Held questions", main, { back: "/", backLabel: "Back to the board" }));
}
