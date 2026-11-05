#!/usr/bin/env node
// The eight cases through the hosted runner's own code path, for CI (.github/workflows/cases.yml).
//   node hosted/ci.js --mock                 (no key: the scripted model; proves the path, records nothing)
//   node hosted/ci.js                        (ANTHROPIC_API_KEY from the tracker-ci workspace; smallest model)
//   node hosted/ci.js --record results/ci    (as above, and writes the record; the workflow does this on main)
// One pass, in the harness's order so eval/expected/ stays valid: the folder made by make-folder.js in a
// fake Drive, signed in as a service account; four runs of two transcripts each; eval/answers.txt saved
// word for word through the /held answer path; one more run that applies it. eval/check.js marks the
// final tracker against the bar in harness.json; every miss is printed by case and line. If the bar is
// not met the whole pass runs once more (the cases share state, so one cannot be rerun alone), and the
// result is red only if the second pass misses too. Exit 0 on green, 1 on red.
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
const { MemoryKV } = await import("./lib/kv.js");
const { run, MODEL, skillVersion } = await import("./lib/runner.js");
const { saveAnswer } = await import("./lib/app.js");

const argv = process.argv.slice(2);
const MOCK = argv.includes("--mock");
const recordDir = (() => { const i = argv.indexOf("--record"); return i >= 0 ? path.resolve(argv[i + 1]) : null; })();
if (MOCK && recordDir) { console.error("a mock pass is never recorded"); process.exit(2); }
if (!MOCK && !process.env.ANTHROPIC_API_KEY) { console.error("No ANTHROPIC_API_KEY (the tracker-ci workspace key). Use --mock to run without one."); process.exit(2); }

const harness = JSON.parse(fs.readFileSync(path.join(root, "harness.json"), "utf8"));
const answers = fs.readFileSync(path.join(root, "eval", "answers.txt"), "utf8").trim();
const expected = loadExpected(path.join(root, "eval", "expected"));
const DAY = 86400e3;
const klToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const start = new Date(Date.parse(klToday + "T00:00:00Z") - 7 * DAY).toISOString().slice(0, 10);
const dayOf = (d) => new Date(Date.parse(start + "T00:30:00Z") + (d - 1) * DAY);

async function model() {
  if (MOCK) return new HostedMock({ usage: null });
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 120000 });
  return { create: (req) => client.messages.create(req) };
}

async function pass(n, work) {
  const fake = new FakeDrive({ strict: true });
  const port = await fake.listen();
  process.env.DRIVE_API_BASE = `http://127.0.0.1:${port}`;
  process.env.TRACKER_GOOGLE_DIR = fakeGoogleDir(path.join(work, `google-${n}`), port);
  const ids = await makeFolder(new Drive(), path.join(root, "data", "transcripts"), emptyForm);
  const w = { day: 2 };
  const deps = { kv: new MemoryKV(), drive: new ServiceAccountDrive(fake.saKey(port)), model: await model(), ids, cycleStart: start,
    now: () => dayOf(w.day), limits: { timeMs: Infinity } };
  const lines = [];
  const step = async (label, opts) => {
    const r = await run(deps, opts);
    lines.push(r.line);
    console.log(`  ${label}: ${r.line.run_id || "-"} ${r.line.outcome}; fed ${r.line.fed?.join(" ") || "none"}; read ${r.line.read?.join(" ") || "none"}; held ${r.line.held ?? 0}; model calls ${r.line.model_calls ?? 0}`);
    if (r.status !== 200) throw new Error(`run failed: ${r.line.detail}`);
  };
  for (const d of [2, 4, 6, 8]) { w.day = d; await step(`day ${d}`, { feed: "due", trigger: "ci" }); }
  const saved = await saveAnswer(deps, { text: answers });
  if (!saved.saved) throw new Error(`the answer was not saved: ${saved.why}`);
  console.log("  eval/answers.txt saved through the answer path");
  await step("answers", { feed: "none", trigger: "ci" });

  const dir = path.join(work, `pass-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["tracker.csv", "run_log.csv"]) fs.writeFileSync(path.join(dir, name), fake.find(name, ids.tracker).content);
  fake.close();
  const cases = {};
  for (const t of Object.keys(expected).sort()) cases[t] = checkCase(t, dir, expected);
  const v = verdict(cases);
  for (const c of Object.values(cases)) console.log(`  ${c.match ? "MATCH" : "MISS "} ${c.transcript}${c.fails.length ? "\n          " + c.fails.join("\n          ") : ""}`);
  console.log(`  ${v.five_matched} of 5 matched, decline ${v.decline_held ? "held" : "did not hold"}, state ${v.state_matched} of 2: ${v.passed ? "BAR MET" : "BAR NOT MET"}`);
  const sum = (k) => lines.reduce((a, l) => a + (l.tokens?.[k] || 0), 0);
  return { verdict: v, cases, runs: lines.length, model_calls: lines.reduce((a, l) => a + (l.model_calls || 0), 0),
    tokens: { input: sum("input"), output: sum("output"), cache_read: sum("cache_read"), cache_write: sum("cache_write") },
    cost_usd: Number(lines.reduce((a, l) => a + (l.cost_usd || 0), 0).toFixed(6)), lines };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mt-ci-"));
const startedAt = new Date().toISOString();
console.log(`hosted CI path: skill ${skillVersion()}, ${MOCK ? "scripted model (mock)" : `model ${MODEL}`}, bar: ${harness.bar}`);
const passes = [];
console.log("pass 1");
passes.push(await pass(1, work));
if (!passes[0].verdict.passed) {
  console.log("pass 1 missed the bar; running the whole pass once more to tell a break from noise\npass 2");
  passes.push(await pass(2, work));
}
const green = passes.at(-1).verdict.passed;
console.log(`\n${green ? "GREEN" : "RED"}: ${passes.length === 1 ? "one pass" : "two passes"}; model calls ${passes.reduce((a, p) => a + p.model_calls, 0)}; cost US$${passes.reduce((a, p) => a + p.cost_usd, 0).toFixed(4)}`);

if (recordDir) {
  const sha = (process.env.GITHUB_SHA || "local").slice(0, 7);
  const label = `C${startedAt.slice(0, 16).replace(/[-:T]/g, "")}-${sha}`;
  const record = { label, started_at: startedAt, commit: process.env.GITHUB_SHA || null, ref: process.env.GITHUB_REF || null,
    workflow_run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    trigger: process.env.GITHUB_EVENT_NAME || "local", skill_version: skillVersion(), model: MODEL, bar: harness.bar, green,
    passes: passes.map(({ lines, ...p }) => ({ ...p, runs: lines.map(({ run_id, outcome, fed, read, held, appended, closed, answers_given, answers_applied, model_calls, tokens, cost_usd }) =>
      ({ run_id, outcome, fed, read, held, appended, closed, answers_given, answers_applied, model_calls, tokens, cost_usd })) })) };
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, `${label}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(`record written: ${path.relative(process.cwd(), path.join(recordDir, `${label}.json`))}`);
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(green ? 0 : 1);
