#!/usr/bin/env node
// The eight cases through the hosted runner's own code path, for CI (.github/workflows/cases.yml).
//   node hosted/ci.js --mock                 (no key: the scripted model; proves the path, records nothing)
//   node hosted/ci.js                        (ANTHROPIC_API_KEY from the tracker-ci workspace; smallest model, the service's effort)
//   node hosted/ci.js --record results/ci    (as above, and writes the record; the workflow does this on main)
//   node hosted/ci.js --measure 5 [--effort high] [--record results/ci-measure]
//                                            (five live-cadence passes, no gate: a per-case tally to choose a model by)
//
// Every pass starts from the folder made by make-folder.js in a fake Drive, signed in as a service account,
// and is marked by eval/check.js against the bar in harness.json; every miss is printed by case and line.
// Two cadences:
//   live     the gate. What the service does: one transcript fed and read per run, as the daily schedule and
//            the manual runs do. After each run, every question it held is answered through the /held path,
//            with the sentence the /held form writes (lib/questions.js), so the answer is applied in the next
//            run alongside the next transcript. The answers are the form's equivalents of eval/answers.txt:
//            Priya Nair is Halden Logistics; yes, 05 has no actions; record 08's date as said; 03's meeting
//            date left unanswered. A ninth run, with nothing left to feed, applies the last answer.
//   batched  recorded, not gating. Two transcripts per run, as after a missed day, then eval/answers.txt
//            word for word in a run with nothing new: the harness's order, and this file's first form.
// If the live pass misses the bar, it runs once more (the cases share state, so one cannot be rerun alone);
// red only if that pass misses too. Exit 0 on green, 1 on red.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
execFileSync(process.execPath, [path.join(here, "scripts", "copy-core.js")], { stdio: "ignore" });
const { FakeDrive, fakeGoogleDir } = await import("../test/fake_drive.js");
const { HostedMock } = await import("../test/hosted_mock.js");
const { Drive } = await import("../lib/drive.js");
const { ServiceAccountDrive } = await import("../lib/drive-sa.js");
const { loadExpected, checkCase, verdict } = await import("../eval/check.js");
const { makeFolder } = await import("./scripts/make-folder.js");
const { emptyForm } = await import("./lib/folder.js");
const { MemoryKV, K } = await import("./lib/kv.js");
const { run, MODEL, EFFORT: SERVICE_EFFORT, skillVersion } = await import("./lib/runner.js");
const { saveAnswer } = await import("./lib/app.js");
const { sentence } = await import("./lib/questions.js");

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const MOCK = argv.includes("--mock");
const MEASURE = arg("measure") ? Number(arg("measure")) : 0;
const EFFORT = arg("effort");
const recordDir = arg("record") ? path.resolve(arg("record")) : null;
if (MOCK && recordDir) { console.error("a mock pass is never recorded"); process.exit(2); }
if (EFFORT && !MEASURE) { console.error("--effort is for --measure only; the gate runs the service's own settings"); process.exit(2); }
if (EFFORT && !["low", "medium", "high", "xhigh", "max"].includes(EFFORT)) { console.error(`--effort must be low, medium, high, xhigh or max`); process.exit(2); }
if (!MOCK && !process.env.ANTHROPIC_API_KEY) { console.error("No ANTHROPIC_API_KEY (the tracker-ci workspace key). Use --mock to run without one."); process.exit(2); }

const harness = JSON.parse(fs.readFileSync(path.join(root, "harness.json"), "utf8"));
const answersTxt = fs.readFileSync(path.join(root, "eval", "answers.txt"), "utf8").trim();
const expected = loadExpected(path.join(root, "eval", "expected"));
// The /held form's choices that say what eval/answers.txt says; meeting_date has none, as the key leaves it.
const FORM = { duplicate_name: { company: "Halden Logistics" }, no_actions: { confirm: "yes" }, past_due: { accept: "yes" } };
const DAY = 86400e3;
const klToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const start = new Date(Date.parse(klToday + "T00:00:00Z") - 9 * DAY).toISOString().slice(0, 10);
const dayOf = (d) => new Date(Date.parse(start + "T00:30:00Z") + (d - 1) * DAY);

async function model() {
  if (MOCK) return new HostedMock({ usage: null });
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120000 });
  return { create: (req) => client.messages.create(req) };
}

async function pass(label, cadence, work) {
  const fake = new FakeDrive({ strict: true });
  const port = await fake.listen();
  process.env.DRIVE_API_BASE = `http://127.0.0.1:${port}`;
  process.env.TRACKER_GOOGLE_DIR = fakeGoogleDir(path.join(work, `google-${label}`), port);
  const ids = await makeFolder(new Drive(), path.join(root, "data", "transcripts"), emptyForm);
  const w = { day: 1 };
  const kv = new MemoryKV();
  // the live cadence runs before CYCLE_START, as the manual runs did: one slot fed per run, no reset
  const deps = { kv, drive: new ServiceAccountDrive(fake.saKey(port)), model: await model(), ids, now: () => dayOf(w.day),
    cycleStart: cadence === "batched" ? start : null, effort: EFFORT || undefined, limits: { timeMs: Infinity } };
  const lines = [], given = [];
  const step = async (name, opts) => {
    const r = await run(deps, opts);
    lines.push(r.line);
    console.log(`  ${name}: ${r.line.run_id || "-"} ${r.line.outcome}; fed ${r.line.fed?.join(" ") || "none"}; read ${r.line.read?.join(" ") || "none"}; ` +
      `held ${r.line.held ?? 0}; answers applied ${r.line.answers_applied ?? 0} of ${r.line.answers_given ?? 0}; model calls ${r.line.model_calls ?? 0}`);
    if (r.status !== 200) throw new Error(`run failed: ${r.line.detail}`);
  };
  // after a live run: answer every question it left waiting that the key answers, as a person would on /held
  const answerWaiting = async () => {
    const snap = JSON.parse((await kv.get(K.snapshot)) || "null");
    for (const q of snap?.waiting || []) {
      if (!FORM[q.gate] || (snap.answered || []).includes(`${q.transcript} ${q.gate}`)) continue;
      const text = sentence(q, FORM[q.gate]);
      const s = await saveAnswer(deps, { transcript: q.transcript, gate: q.gate, text });
      if (!s.saved) throw new Error(`answer not saved: ${s.why}`);
      given.push(text);
      console.log(`    answered on /held: ${text}`);
    }
  };

  if (cadence === "live") {
    for (let i = 1; i <= 8; i++) { await step(`run ${i}`, { feed: "next", trigger: "ci" }); await answerWaiting(); }
    await step("run 9", { feed: "next", trigger: "ci" });
  } else {
    for (const d of [2, 4, 6, 8]) { w.day = d; await step(`day ${d}`, { feed: "due", trigger: "ci" }); }
    const saved = await saveAnswer(deps, { text: answersTxt });
    if (!saved.saved) throw new Error(`the answer was not saved: ${saved.why}`);
    given.push(answersTxt);
    console.log("    eval/answers.txt saved through the answer path");
    await step("answers", { feed: "none", trigger: "ci" });
  }

  const dir = path.join(work, `pass-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["tracker.csv", "run_log.csv"]) fs.writeFileSync(path.join(dir, name), fake.find(name, ids.tracker).content);
  fake.close();
  const cases = {};
  for (const t of Object.keys(expected).sort()) cases[t] = checkCase(t, dir, expected);
  const v = verdict(cases);
  for (const c of Object.values(cases)) console.log(`  ${c.match ? "MATCH" : "MISS "} ${c.transcript}${c.fails.length ? "\n          " + c.fails.join("\n          ") : ""}`);
  console.log(`  ${v.five_matched} of 5 matched, decline ${v.decline_held ? "held" : "did not hold"}, state ${v.state_matched} of 2: ${v.passed ? "BAR MET" : "BAR NOT MET"}`);
  const sum = (k) => lines.reduce((a, l) => a + (l.tokens?.[k] || 0), 0);
  return { cadence, gating: cadence === "live" && !MEASURE, verdict: v, cases, answers: given, runs: lines.length,
    model_calls: lines.reduce((a, l) => a + (l.model_calls || 0), 0),
    tokens: { input: sum("input"), output: sum("output"), cache_read: sum("cache_read"), cache_write: sum("cache_write") },
    cost_usd: Number(lines.reduce((a, l) => a + (l.cost_usd || 0), 0).toFixed(6)), lines };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mt-ci-"));
const startedAt = new Date().toISOString();
const who = MOCK ? "scripted model (mock)" : `model ${MODEL}, effort ${EFFORT || SERVICE_EFFORT}${EFFORT ? " (measure override)" : " (the service's)"}`;
const passes = [];
let green;
if (MEASURE) {
  console.log(`hosted CI path, measure: ${MEASURE} live-cadence passes; skill ${skillVersion()}, ${who}; no gate`);
  for (let i = 1; i <= MEASURE; i++) { console.log(`live pass ${i}`); passes.push(await pass(`m${i}`, "live", work)); }
  const five = ["01_halden_kickoff.txt", "02_meridian_pricing.txt", "03_northgate_claims.txt", "04_halden_finance.txt", "05_meridian_update.txt"];
  console.log(`\nper case, ${MEASURE} passes:`);
  for (const t of Object.keys(expected).sort()) console.log(`  ${t.padEnd(28)} ${passes.filter((p) => p.cases[t].match).length} of ${MEASURE} matched`);
  console.log(`passes meeting the bar: ${passes.filter((p) => p.verdict.passed).length} of ${MEASURE}; ` +
    `of the five cases, matched per pass: ${passes.map((p) => five.filter((t) => p.cases[t].match).length).join(", ")}`);
} else {
  console.log(`hosted CI path: skill ${skillVersion()}, ${who}, bar: ${harness.bar}`);
  console.log("live cadence, pass 1 (gating)");
  passes.push(await pass("live-1", "live", work));
  if (!passes[0].verdict.passed) {
    console.log("the live pass missed the bar; running it once more to tell a break from noise\nlive cadence, pass 2 (gating)");
    passes.push(await pass("live-2", "live", work));
  }
  green = passes.at(-1).verdict.passed;
  console.log("batched cadence (recorded, not gating)");
  passes.push(await pass("batched", "batched", work));
}
const total = (k) => passes.reduce((a, p) => a + p[k], 0);
console.log(`\n${MEASURE ? "MEASURED" : green ? "GREEN" : "RED"}: ${passes.length} passes; model calls ${total("model_calls")}; cost US$${total("cost_usd").toFixed(4)}`);

if (recordDir) {
  const sha = (process.env.GITHUB_SHA || "local").slice(0, 7);
  const label = `${MEASURE ? "M" : "C"}${startedAt.slice(0, 16).replace(/[-:T]/g, "")}-${sha}${EFFORT ? `-${EFFORT}` : ""}`;
  const record = { label, started_at: startedAt, commit: process.env.GITHUB_SHA || null, ref: process.env.GITHUB_REF || null,
    workflow_run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    trigger: process.env.GITHUB_EVENT_NAME || "local", mode: MEASURE ? "measure" : "gate", skill_version: skillVersion(), model: MODEL,
    effort: EFFORT || SERVICE_EFFORT, bar: harness.bar, green: MEASURE ? null : green,
    passes: passes.map(({ lines, ...p }) => ({ ...p, runs: lines.map(({ run_id, outcome, fed, read, held, appended, closed, answers_given, answers_applied, model_calls, tokens, cost_usd }) =>
      ({ run_id, outcome, fed, read, held, appended, closed, answers_given, answers_applied, model_calls, tokens, cost_usd })) })) };
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, `${label}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(`record written: ${path.relative(process.cwd(), path.join(recordDir, `${label}.json`))}`);
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(MEASURE ? 0 : green ? 0 : 1);
