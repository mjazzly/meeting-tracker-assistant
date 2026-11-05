// Offline test of the hosted runner (hosted/lib/runner.js) and its routes (hosted/lib/app.js): the
// cases H1 to H22 in hosted/DESIGN.md, each written before the code. The runner runs against
// test/fake_drive.js signed in as a service account (every create refused for quota, as Google does in
// a personal My Drive), Upstash replaced by hosted/lib/kv.js's MemoryKV, and the model replaced by the
// scripted test/hosted_mock.js. The folder is made by hosted/scripts/make-folder.js itself, with the
// desktop sign-in path, so the layout under test is the one Megat will make.
//   node test/hosted_cases.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FakeDrive, fakeGoogleDir } from "./fake_drive.js";
import { HostedMock } from "./hosted_mock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
execFileSync(process.execPath, [path.join(root, "hosted", "scripts", "copy-core.js")], { stdio: "ignore" });
const { Drive } = await import("../lib/drive.js");
const { ServiceAccountDrive } = await import("../lib/drive-sa.js");
const { makeFolder } = await import("../hosted/scripts/make-folder.js");
const { emptyForm, EMPTY_BOARD } = await import("../hosted/lib/folder.js");
const { MemoryKV, K } = await import("../hosted/lib/kv.js");
const { run } = await import("../hosted/lib/runner.js");
const app = await import("../hosted/lib/app.js");

const out = path.join(here, "out-hosted");
fs.rmSync(out, { recursive: true, force: true });
const TRANSCRIPTS = path.join(root, "data", "transcripts");
const START = "2026-11-10";
const dayOf = (d) => new Date(Date.parse(START + "T00:30:00Z") + (d - 1) * 86400e3);   // 8:30 AM Kuala Lumpur on cycle day d
const ENV = { CRON_SECRET: "cron-" + crypto.randomBytes(8).toString("hex"), RUN_TOKEN: "run-" + crypto.randomBytes(8).toString("hex"),
  ANSWER_TOKEN: "ans-" + crypto.randomBytes(8).toString("hex"), IP_SALT: "salt", ANTHROPIC_API_KEY: "sk-fake-" + crypto.randomBytes(8).toString("hex"),
  GOOGLE_SA_KEY: "set", DRIVE_FOLDER_ID: "top", DRIVE_TRANSCRIPTS_ID: "t", DRIVE_TRACKER_ID: "k", DRIVE_RELEASED_ID: "r", CYCLE_START: START };

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
  const [h, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
}

let failures = 0, n = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures++; };
const head = (id, title) => console.log(`\n${id}  ${title}`);

// A fresh folder, service account, store and scripted model.
async function world({ day = 1, limits = {}, mock = {} } = {}) {
  const fake = new FakeDrive({ strict: true });
  const port = await fake.listen();
  process.env.DRIVE_API_BASE = `http://127.0.0.1:${port}`;
  process.env.TRACKER_GOOGLE_DIR = fakeGoogleDir(path.join(out, `google-${++n}`), port);
  const ids = await makeFolder(new Drive(), TRANSCRIPTS, emptyForm);
  const kv = new MemoryKV();
  const model = new HostedMock(mock);
  const w = { fake, kv, model, ids, day, t: 0 };
  w.deps = { kv, model, drive: new ServiceAccountDrive(fake.saKey(port)), ids, cycleStart: START, limits,
    now: () => dayOf(w.day), clock: () => w.t, env: { ...ENV, DRIVE_FOLDER_ID: ids.folder } };
  w.file = (name) => { const sub = name.endsWith(".txt") ? ids.transcripts : name === "board.html" ? ids.released : ids.tracker; return fake.find(name, sub); };
  w.text = (name) => w.file(name).content.toString("utf8");
  w.json = (name) => JSON.parse(w.text(name));
  w.csv = (name) => parseCsv(w.text(name));
  w.run = (opts = {}) => run(w.deps, opts);
  w.saCalls = () => fake.calls.filter((c) => c.endsWith("(sa)"));
  w.patched = (from) => fake.calls.slice(from).filter((c) => c.startsWith("PATCH")).map((c) => [...fake.files.values()].find((f) => c.includes(f.id))?.name);
  w.req = (method, url, { headers = {}, body = "", ip = "198.51.100.1" } = {}) => ({ method, url, headers: { host: "tracker.example", ...headers }, body, ip });
  w.cookie = `mt_answer=${crypto.createHash("sha256").update(ENV.ANSWER_TOKEN).digest("hex")}`;
  return w;
}
const done = (w) => w.fake.close();
const appliedRowsSaved = (w) => w.json("answers.json").filter((a) => a.status === "applied")
  .every((a) => !a.transcript || w.csv("tracker.csv").some((r) => r.transcript === a.transcript && r.added_run === a.applied_run));

// ---------- H1 ----------
head("H1", "nothing new, no answers");
{
  const w = await world({ day: 0 });      // the day before CYCLE_START: nothing is fed
  const mark = w.fake.calls.length;
  const r = await w.run();
  check(r.status === 200 && r.line.outcome === "nothing new", `run line says nothing new (${r.line.outcome})`);
  check(w.model.calls === 0 && r.line.model_calls === 0, "the scripted model was called 0 times");
  check(JSON.stringify(w.patched(mark)) === JSON.stringify(["run_log.csv"]), `only run_log.csv changed in Drive (${w.patched(mark).join(", ")})`);
  check(/nothing new/.test(w.text("run_log.csv")) && /,run,nothing new,/.test(w.text("run_log.csv")), "the log has the scan's nothing new and the run line");
  done(w);
}

// ---------- H2, H3 ----------
head("H2", "day 1 with an empty folder");
{
  const w = await world({ day: 1 });
  const r = await w.run();
  check(r.line.reset === true && JSON.stringify(r.line.fed) === '["01_halden_kickoff.txt"]', "reset ran and slot 01 was fed");
  check(w.text("01_halden_kickoff.txt") === fs.readFileSync(path.join(TRANSCRIPTS, "01_halden_kickoff.txt"), "utf8"), "slot 01 holds the repo's transcript, byte for byte");
  check(r.line.read.join() === "01_halden_kickoff.txt" && r.line.appended === 3, `01 read, ${r.line.appended} rows appended`);
  check(w.csv("tracker.csv").length === 3 && w.text("board.html").includes("<html") && w.text("board.html") !== EMPTY_BOARD, "tracker.csv and released/board.html updated in place");
  check(!w.saCalls().some((c) => c.startsWith("POST")), "no create call from the service account reached Drive");
  const snap = JSON.parse(await w.kv.get(K.snapshot));
  check(snap?.counts.actions === 3 && snap.cycle.day === 1 && snap.board_run === r.line.run_id, "snapshot written for the public routes");
  check(r.line.saved.join() === "tracker.csv,held.json,answers.json,summary.md,board.html,run_log.csv", "saved in the agreed order, run_log.csv last");
  check((await w.kv.get(K.pushing)) === null && (await w.kv.get(K.lock)) === null, "mt:pushing cleared and the lock released");

  head("H3", "the reset runs once a cycle");
  const r2 = await w.run();
  check(r2.line.reset === false && r2.line.outcome === "nothing new" && w.csv("tracker.csv").length === 3, "a second run on day 1 does not reset; it finds nothing new");
  done(w);
}

// ---------- H4 ----------
head("H4", "reset over a full cycle");
{
  const w = await world({ day: 1, limits: { perRun: 8 } });
  for (let d = 1; d <= 8; d++) { w.day = d; await w.run(); }
  const idsBefore = [...w.fake.files.values()].map((f) => `${f.name}:${f.id}`).sort().join();
  check(w.csv("tracker.csv").length === 9 && w.json("held.json").length === 3, `after eight days: ${w.csv("tracker.csv").length} rows, ${w.json("held.json").length} held`);
  w.day = 29;
  const r = await w.run();
  check(r.line.reset === true && r.line.cycle_day === 1, "day 29 is day 1 of the next cycle and resets");
  const runs = new Set(w.csv("run_log.csv").map((x) => x.run_id));
  check([...runs].every((id) => id.startsWith("R2026-12-08")), "the log holds only the new cycle's run");
  check(w.json("held.json").length === 0 && w.json("answers.json").length === 0, "held.json and answers.json back to []");
  check(["02_meridian_pricing.txt", "08_meridian_contracts.txt"].every((t) => w.file(t).content.length === 0) && w.file("01_halden_kickoff.txt").content.length > 0, "slots 02 to 08 empty again, 01 fed");
  check([...w.fake.files.values()].map((f) => `${f.name}:${f.id}`).sort().join() === idsBefore, "the same file ids as before: nothing created, nothing deleted");
  done(w);
}

// ---------- H5, H6, H7, H9 (one folder) ----------
head("H5", "empty slots are invisible");
{
  const w = await world({ day: 4, limits: { perRun: 8 } });
  const r = await w.run();
  check(r.line.fed.length === 4 && r.line.read.length === 4, "four slots fed and read on day 4 (a missed day catches up)");
  const log = w.csv("run_log.csv");
  check(log.filter((x) => x.step === "source" && x.result === "fetched").length === 4, "the source fetched four files, not eight");
  check(!log.some((x) => x.result === "flagged"), "no flag for the four empty slots");

  head("H6", "a gate holds");
  const held = w.json("held.json");
  check(held.length === 1 && held[0].transcript === "04_halden_finance.txt" && held[0].reason === "duplicate_name", "held.json holds 04 at Gate 1");
  const snap = JSON.parse(await w.kv.get(K.snapshot));
  const q = snap.waiting.find((x) => x.transcript === "04_halden_finance.txt");
  check(q && /^Priya Nair matches 2 contacts: Halden Logistics, Finance Director; Meridian Foods, Marketing Director\. Which one\?$/.test(q.question) && q.since_run === r.line.run_id,
    "the snapshot carries the gate's question and the run it was held in");
  const confirm = snap.waiting.find((x) => x.gate === "meeting_date");
  check(confirm?.transcript === "03_northgate_claims.txt", "03's dates wait on a meeting date and say so");
  const home = await app.home(w.deps);
  check(home.body.includes("Priya Nair matches 2 contacts") && !home.body.includes("<form") && !home.body.includes("/held"), "the public page shows the question and no way to answer it");

  head("H7", "an answer is saved");
  const trackerBefore = w.text("tracker.csv");
  const post = await app.held(w.deps, w.req("POST", "/held", { headers: { cookie: w.cookie, origin: "https://tracker.example" },
    body: new URLSearchParams({ transcript: "04_halden_finance.txt", gate: "duplicate_name", company: "Halden Logistics" }).toString() }));
  const ans = w.json("answers.json");
  check(post.status === 303 && ans.length === 1 && ans[0].status === "waiting", "POST /held saved one answer, waiting");
  check(ans[0].text === "04_halden_finance.txt: Priya Nair is Halden Logistics, Finance Director.", `the answer is one plain sentence (${ans[0].text})`);
  check(w.text("tracker.csv") === trackerBefore, "the tracker is unchanged until the next run");
  const page = await app.held(w.deps, w.req("GET", "/held", { headers: { cookie: w.cookie } }));
  check(page.status === 200 && page.body.includes("An answer is saved; the next run applies it."), "/held shows the answer as saved, without a second form");

  head("H9", "the next run applies it");
  const calls = w.model.calls;
  const r9 = await w.run({ feed: "none" });
  check(w.model.calls > calls && r9.line.answers_given === 1, "nothing new and one answer waiting: the model is called");
  check(w.model.requests.at(-1).includes("Priya Nair is Halden Logistics"), "its opening message carries the sentence");
  check(w.csv("tracker.csv").some((x) => x.transcript === "04_halden_finance.txt" && x.owner === "Priya Nair" && x.owner_company === "Halden Logistics"), "04's rows appended with the company");
  check(w.json("held.json").length === 0, "held.json is empty");
  const a9 = w.json("answers.json")[0];
  check(a9.status === "applied" && a9.applied_run === r9.line.run_id && appliedRowsSaved(w), "the answer is marked applied with this run, and its rows are saved");
  check(w.text("summary.md").includes("## Answered this run"), "the summary has Answered this run");
  done(w);
}

// ---------- H8 ----------
head("H8", "no token, wrong token");
{
  const w = await world({ day: 1 });
  const ip = "203.0.113.9";
  const a = await app.held(w.deps, w.req("GET", "/held", { ip }));
  const b = await app.held(w.deps, w.req("GET", "/held?token=wrong", { ip }));
  const c = await app.runRoute(w.deps, w.req("GET", "/api/run", { ip, headers: { authorization: "Bearer wrong" } }));
  const p = await app.held(w.deps, w.req("POST", "/held", { ip, body: "transcript=04_halden_finance.txt&gate=duplicate_name&company=Halden+Logistics" }));
  check([a, b, c, p].every((x) => x.status === 401), "/held without a cookie, with a wrong token, a POST without one, and /api/run with a wrong token: all 401");
  check((await w.kv.get(K.lock)) === null && w.saCalls().length === 0 && w.model.calls === 0, "no lock taken, no Drive call, no model call");
  for (let i = 0; i < 6; i++) await app.runRoute(w.deps, w.req("GET", "/api/run", { ip, headers: { authorization: "Bearer wrong" } }));
  const shut = await app.runRoute(w.deps, w.req("GET", "/api/run", { ip, headers: { authorization: `Bearer ${ENV.RUN_TOKEN}` } }));
  check(shut.status === 429, "after ten failures that address is closed for the day, even with the right token");
  const other = await app.runRoute(w.deps, w.req("GET", "/api/run", { ip: "198.51.100.7", headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }));
  check(other.status === 200 && JSON.parse(other.body).run_id, "Vercel Cron's secret from another address runs");
  const set = await app.held(w.deps, w.req("GET", `/held?token=${ENV.ANSWER_TOKEN}`, { ip: "198.51.100.7" }));
  check(set.status === 303 && /HttpOnly; Secure; SameSite=Strict/.test(set.headers["set-cookie"]) && set.headers.location === "/held", "the right token sets the cookie once and drops itself from the address");
  done(w);
}

// ---------- H10, H11 ----------
head("H10", "the lock refuses a second run");
{
  const w = await world({ day: 1 });
  await w.kv.set(K.lock, "someone-else");
  const mark = w.fake.calls.length;
  const r = await w.run();
  check(r.status === 409 && JSON.parse((await w.kv.lrange(K.runs, 0, 0))[0]).outcome === "refused", "409 and one refused line in the run list");
  check(w.fake.calls.length === mark && w.model.calls === 0, "no Drive call, no model call");
  check((await w.kv.get(K.lock)) === "someone-else", "the other run's lock is left alone");

  head("H11", "an answer while a run holds the lock");
  const s = await app.saveAnswer({ ...w.deps }, { transcript: "04_halden_finance.txt", gate: "duplicate_name", text: "x" });
  check(!s.saved && /A run is in progress/.test(s.why) && w.json("answers.json").length === 0, "nothing saved; the page says a run is in progress");
  done(w);
}

// ---------- H12 ----------
head("H12", "the cap carries the rest");
{
  const w = await world({ day: 3 });
  const r = await w.run();
  check(r.line.fed.length === 3 && r.line.read.join() === "01_halden_kickoff.txt,02_meridian_pricing.txt" && r.line.carried.join() === "03_northgate_claims.txt", "three fed, two read, 03 carried");
  check(w.csv("run_log.csv").some((x) => x.step === "note" && /carried to the next run: 03_northgate_claims\.txt/.test(x.detail)), "a note names 03 as carried");
  const r2 = await w.run();
  check(r2.line.fed.length === 0 && r2.line.read.join() === "03_northgate_claims.txt", "the next run reads 03 with no feed");
  done(w);
}

// ---------- H13, H14 ----------
head("H13", "the confidential transcript");
{
  const w = await world({ day: 8, limits: { perRun: 8 } });
  const r = await w.run();
  const id06 = w.file("06_northgate_board.txt").id;
  const body06 = fs.readFileSync(path.join(TRANSCRIPTS, "06_northgate_board.txt"), "utf8").split("\n").find((l) => l.startsWith("[2]"));
  check(r.line.declined.join() === "06_northgate_board.txt", "06 declined");
  check(!w.fake.calls.some((c) => c.includes(id06) && c.includes("media") && !c.includes("bytes=")), "06 never downloaded whole, only its first 2 KB");
  check(!w.model.requests.some((m) => m.includes(body06.slice(5, 40))), "no model message holds a line past 06's header");
  const mark = w.fake.calls.length;
  await w.run({ feed: "none" });
  check(w.fake.calls.slice(mark).filter((c) => c.includes(id06)).every((c) => c.includes("bytes=")), "pulled again on the next run, still header only");

  head("H14", "restore on pull");
  check(w.json("held.json").some((h) => h.transcript === "08_meridian_contracts.txt" && h.reason === "past_due"), "08 is held at Gate 3");
  await app.saveAnswer(w.deps, { transcript: "08_meridian_contracts.txt", gate: "past_due", text: "08_meridian_contracts.txt: record the date on line 2 as said." });
  const id08 = w.file("08_meridian_contracts.txt").id, m2 = w.fake.calls.length;
  const r14 = await w.run({ feed: "none" });
  check(w.fake.calls.slice(m2).some((c) => c.includes(id08) && c.includes("media")), "08 downloaded by its file id at pull, two runs after it was read");
  check(w.csv("tracker.csv").filter((x) => x.transcript === "08_meridian_contracts.txt").length === 2 && w.json("answers.json")[0].applied_run === r14.line.run_id, "the Gate 3 answer applied: 08's rows appended, the answer marked");
  done(w);
}

// ---------- H15 ----------
head("H15", "kill switch, then budget");
{
  const w = await world({ day: 1 });
  await w.kv.set(K.kill, "on");
  const mark = w.fake.calls.length;
  const r = await w.run();
  check(r.line.outcome === "stopped" && /kill switch/.test(r.line.detail) && w.fake.calls.length === mark && w.model.calls === 0, "kill switch: stopped, no feed, no Drive call, no model call");
  await w.kv.del(K.kill);
  await w.kv.set(K.monthCost(dayOf(1).toISOString().slice(0, 7)), String(3e6));
  const r2 = await w.run();
  check(r2.line.outcome === "stopped" && /month budget/.test(r2.line.detail) && w.fake.calls.length === mark && w.model.calls === 0, "month budget reached: the same, naming the budget");
  done(w);
}

// ---------- H16, H17 ----------
head("H16", "per run caps");
{
  const w = await world({ day: 1, limits: { maxCalls: 5 }, mock: { neverStop: true } });
  const r = await w.run();
  check(r.line.model_calls === 5 && r.line.stopped === "5 model calls", `stopped at 5 model calls (${r.line.stopped})`);
  check(!w.csv("tracker.csv").length && (await w.kv.get(K.pushing)) === null, "01 left unprocessed, the save completed");
  w.model.neverStop = false;
  const r2 = await w.run();
  check(r2.line.read.join() === "01_halden_kickoff.txt" && r2.line.appended === 3, "the next run reads 01 again and appends it");
  done(w);
}
head("H17", "time guard");
{
  const w = await world({ day: 1, limits: { timeMs: 240000 } });
  w.model.onCall = () => { w.t += 100000; };
  const r = await w.run();
  check(r.line.model_calls === 3 && /time limit/.test(r.line.stopped || ""), `no new call after 240 seconds (${r.line.model_calls} calls, ${r.line.stopped})`);
  done(w);
}

// ---------- H18, H19, H20 ----------
async function heldWithAnswer() {
  const w = await world({ day: 4, limits: { perRun: 8 } });
  await w.run();
  await app.saveAnswer(w.deps, { transcript: "04_halden_finance.txt", gate: "duplicate_name", text: "04_halden_finance.txt: Priya Nair is Halden Logistics, Finance Director." });
  return w;
}
async function stopsNext(w, label) {
  w.deps.drive.token = null; w.fake.failWhen = null;
  const mark = w.fake.calls.length, calls = w.model.calls;
  const r = await w.run();
  check(r.line.outcome === "needs a person" && /the last save did not complete/.test(r.line.detail) && w.fake.calls.length === mark && w.model.calls === calls,
    `${label}: the next run stops with "needs a person", no feed, no Drive write, no model call`);
}
head("H18", "save fails at the log");
{
  const w = await world({ day: 0 });      // before the cycle, so no reset runs first
  w.fake.failWhen = ({ method, who, file }) => method === "PATCH" && who === "sa" && file?.name === "run_log.csv";
  const r = await w.run({ feed: "next" });
  check(r.status === 500 && r.line.outcome === "failed" && /next run will stop for a person/.test(r.line.detail), "the run fails and says the save did not complete");
  check((await w.kv.get(K.pushing)) === r.line.run_id && (await w.kv.get(K.lock)) === null, "mt:pushing stays set with the run id; the lock is released");
  check(!/,run,/.test(w.text("run_log.csv")), "the run line did not reach Drive");
  await stopsNext(w, "H18");
  done(w);
}
head("H19", "save fails after tracker.csv, before held.json");
{
  const w = await heldWithAnswer();
  w.fake.failWhen = ({ method, who, file }) => method === "PATCH" && who === "sa" && file?.name === "held.json";
  const r = await w.run({ feed: "none" });
  check(r.status === 500 && w.csv("tracker.csv").some((x) => x.transcript === "04_halden_finance.txt"), "tracker.csv saved with 04's rows");
  check(w.json("held.json").length === 1 && w.json("answers.json")[0].status === "waiting", "held.json and answers.json unchanged: the answer is not marked applied");
  check((await w.kv.get(K.pushing)) === r.line.run_id, "mt:pushing stays set");
  check(appliedRowsSaved(w), "every answer marked applied in Drive has its rows saved");
  await stopsNext(w, "H19");
  done(w);
}
head("H20", "save fails after held.json, before answers.json");
{
  const w = await heldWithAnswer();
  w.fake.failWhen = ({ method, who, file }) => method === "PATCH" && who === "sa" && file?.name === "answers.json";
  const r = await w.run({ feed: "none" });
  check(r.status === 500 && w.json("held.json").length === 0 && w.csv("tracker.csv").some((x) => x.transcript === "04_halden_finance.txt"), "tracker.csv and held.json saved");
  check(w.json("answers.json")[0].status === "waiting" && (await w.kv.get(K.pushing)) === r.line.run_id, "answers.json unchanged, mt:pushing set");
  check(appliedRowsSaved(w), "every answer marked applied in Drive has its rows saved");
  await stopsNext(w, "H20");
  done(w);
}

// ---------- H21, H22 ----------
head("H21", "public routes cost nothing");
{
  const w = await world({ day: 4, limits: { perRun: 8 } });
  await w.run();
  const mark = w.fake.calls.length, calls = w.model.calls;
  const pages = [await app.home(w.deps), await app.state(w.deps), await app.board(w.deps)];
  check(pages.every((p) => p.status === 200) && w.fake.calls.length === mark && w.model.calls === calls, "GET /, /api/state and /board: 200, no Drive call, no model call");
  const all = pages.map((p) => p.body).join("\n");
  check(![ENV.CRON_SECRET, ENV.RUN_TOKEN, ENV.ANSWER_TOKEN, ENV.ANTHROPIC_API_KEY, ENV.IP_SALT, "PRIVATE KEY"].some((s) => all.includes(s)), "no token or key in any public body");
  check(!/\/edit|usp=|<form/.test(all) && pages[0].body.includes(`drive/folders/${w.ids.folder}`), "no edit link and no form; the folder link is the plain view link");
  check(!/claude-|haiku|opus|sonnet/i.test(pages[0].body) && JSON.parse(pages[1].body).model === "claude-haiku-5-5", "the page names the tier only; the model id is in /api/state for the record");
  done(w);
}
head("H22", "a preview has no settings");
{
  const w = await world({ day: 1 });
  const a = await app.runRoute({ env: {}, kv: null }, w.req("GET", "/api/run", { headers: { authorization: "Bearer x" } }));
  const b = await app.runRoute({ env: { CRON_SECRET: ENV.CRON_SECRET }, kv: w.kv }, w.req("GET", "/api/run", { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }));
  check(a.status === 503 && b.status === 503 && JSON.parse(b.body).missing.includes("ANTHROPIC_API_KEY"), "not configured, naming what is missing");
  check((await w.kv.get(K.lock)) === null && w.saCalls().length === 0, "no lock, no Drive call");
  done(w);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
