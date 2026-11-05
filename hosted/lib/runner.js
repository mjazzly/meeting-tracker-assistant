// One unattended run of the meeting tracker, in front of lib/store.js the way the Drive source is.
// The order is the table in hosted/DESIGN.md ("One run"):
//   lock; kill switch, month budget, unfinished save; cycle reset; feed; pull; restore; sync; cap;
//   nothing new? stop with no model call : the model runs the skill over the ten tools in memory;
//   summary; mark answers; run line; save (mt:pushing around it); snapshot; unlock.
// Every gate is still the store's. The runner decides only what the model is given and when it stops.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../core/lib/store.js";
import { DriveSource } from "../core/lib/source.js";
import { makeServer } from "../core/lib/tools.js";
import { K, monthKey } from "./kv.js";
import { cycleDay } from "./cycle.js";
import { feed as feedSlots, emptyAll, hideEmpty } from "./feeder.js";
import { Folder, partsFrom, emptyForm, SAVE_ORDER } from "./folder.js";
import { waiting } from "./questions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORE = path.join(here, "..", "core");
export const MODEL = "claude-haiku-5-5";   // fixed in code: the smallest tier; no setting or request changes it
export const TIER = "smallest";
export const LIMITS = {
  perRun: 2,              // transcripts read per invocation; the rest carry to the next run
  maxCalls: 40,           // model calls per run
  maxOutput: 20000,       // output tokens per run
  maxTokensPerCall: 8000,
  timeMs: 240000,         // no new model call starts after this; the function's limit is 300 seconds
  lockSeconds: 600,
  budgetUsd: 3,           // a month, under each Console workspace's US$5 limit
  answerTries: 3,         // an answer given this many times without effect is left for a person
};

const skillText = () => fs.readFileSync(path.join(CORE, "skill", "SKILL.md"), "utf8");
export const skillVersion = () => (/Version: (v[\d.]+)/.exec(skillText()) || [])[1] || "unknown";
const prices = () => JSON.parse(fs.readFileSync(path.join(CORE, "eval", "prices.json"), "utf8"))[MODEL];
export const costOf = (t, p) => (t.input * p.input + t.cache_write * p.cache_write_5m + t.cache_read * p.cache_read + t.output * p.output) / 1e6;

async function note(kv, line) {
  await kv.lpush(K.runs, JSON.stringify(line));
  await kv.ltrim(K.runs, 0, 59);
  return line;
}

function nextRunId(store, today) {
  let n = 0;
  for (const r of store.log()) {
    const m = new RegExp(`^R${today}-(\\d+)$`).exec(r.run_id);
    if (m) n = Math.max(n, +m[1]);
  }
  return `R${today}-${n + 1}`;
}

// Every transcript the log already records, back into this run's empty temp folder by its file id:
// the store needs the file for a held row's append and for Gate 3's meeting date. A confidential one
// comes back as its header lines only, as lib/source.js first fetched it.
async function restore(store, drive, source) {
  for (const rec of source.recorded().byName.values()) {
    const p = path.join(store.transcripts, rec.name);
    if (rec.headerOnly) {
      const lines = (await drive.download(rec.id, 2048)).toString("utf8").split(/\r?\n/);
      const end = lines.findIndex((l) => l.trim() === "" || l.trim().startsWith("["));
      fs.writeFileSync(p, lines.slice(0, end < 0 ? 0 : end).join("\n") + "\n");
    } else {
      fs.writeFileSync(p, await drive.download(rec.id));
    }
  }
}

export function opening(runId, answers) {
  const base = `Run the tracker. Use run id ${runId}.`;
  if (!answers.length) return base;
  return `${base}\n\nAnswers given since the last run. Apply each first, one call each as step 10 says, then run the tracker as usual:\n` +
    answers.map((a) => `- ${a.text}`).join("\n");
}

// deps: { kv, drive, model, ids: { transcripts, tracker, released }, cycleStart, now(), clock(), limits, core }
export async function run(deps, { feed = "due", trigger = "cron" } = {}) {
  const L = { ...LIMITS, ...(deps.limits || {}) };
  const now = deps.now ? deps.now() : new Date();
  const clock = deps.clock || Date.now;
  const t0 = clock();
  const { kv, drive } = deps;
  const at = now.toISOString();
  const month = monthKey(now);
  const base = { at, trigger, model: MODEL };

  const token = crypto.randomBytes(8).toString("hex");
  if (!(await kv.set(K.lock, token, { nx: true, ex: L.lockSeconds }))) {
    return { status: 409, line: await note(kv, { ...base, run_id: "", outcome: "refused", detail: "another run holds the lock" }) };
  }
  let dir = null, client = null, runId = "";
  try {
    if ((await kv.get(K.kill)) === "on") {
      return { status: 200, line: await note(kv, { ...base, run_id: "", outcome: "stopped", detail: "kill switch is on; no feed, no model call" }) };
    }
    const spent = Number(await kv.get(K.monthCost(month))) / 1e6 || 0;
    if (spent >= L.budgetUsd) {
      return { status: 200, line: await note(kv, { ...base, run_id: "", outcome: "stopped", detail: `month budget reached (US$${spent.toFixed(4)} of US$${L.budgetUsd}); no feed, no model call` }) };
    }
    const pushing = await kv.get(K.pushing);
    if (pushing) {
      return { status: 200, line: await note(kv, { ...base, run_id: "", outcome: "needs a person",
        detail: `the last save did not complete (${pushing}); no feed, no Drive write, no model call` }) };
    }

    const folder = new Folder(drive, deps.ids);
    const repoDir = path.join(CORE, "data", "transcripts");
    const cycle = deps.cycleStart ? cycleDay(deps.cycleStart, now) : { started: false };
    let reset = false;
    if (cycle.started && cycle.day === 1 && (await kv.set(K.reset(cycle.cycleStart), at, { nx: true }))) {
      await kv.set(K.pushing, `reset of cycle ${cycle.cycleStart}`);
      await emptyAll(drive, deps.ids.transcripts, repoDir);
      await folder.save(Object.fromEntries(SAVE_ORDER.map((n) => [n, emptyForm(n)])), kv, `reset of cycle ${cycle.cycleStart}`);
      await kv.del(K.snapshot); await kv.del(K.board);
      reset = true;
    }
    const fed = feed === "next" ? await feedSlots(drive, deps.ids.transcripts, repoDir, { next: true })
      : feed === "due" && cycle.started ? await feedSlots(drive, deps.ids.transcripts, repoDir, { upTo: cycle.due }) : [];

    // pull, restore, sync
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-"));
    fs.copyFileSync(path.join(CORE, "data", "contacts.csv"), path.join(dir, "contacts.csv"));
    const answers = await folder.pull(dir);
    const store = new Store(dir);
    const today = cycle.today || new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
    runId = nextRunId(store, today);
    const source = new DriveSource(store, hideEmpty(drive), deps.ids.transcripts);
    await restore(store, drive, source);
    const synced = await source.sync(runId);

    // the cap: at most L.perRun transcripts are read this run; the rest wait, untouched, for the next
    const done = store.processed();
    const fresh = fs.readdirSync(store.transcripts).filter((f) => f.endsWith(".txt") && !done.has(f)).sort();
    const readable = fresh.filter((f) => !store.header(f).confidential);
    const carried = readable.slice(L.perRun);
    for (const f of carried) fs.rmSync(path.join(store.transcripts, f));
    if (carried.length) store.note(runId, "", `carried to the next run: ${carried.join(", ")} (at most ${L.perRun} transcripts are read in one run)`);
    const toScan = fresh.filter((f) => !carried.includes(f));
    const given = answers.filter((a) => a.status === "waiting");

    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let calls = 0, stopped = null, cost = 0, outcome;
    if (!toScan.length && !given.length) {
      store.scan(runId);   // writes "nothing new" to the log, as the model's own scan would
      outcome = "nothing new";
    } else {
      for (const a of given) a.given_runs = [...(a.given_runs || []), runId];
      const server = makeServer({ store, drive: null, library: path.join(CORE, "library") });
      const [a, b] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "meeting-tracker-hosted", version: "3.0.0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const tools = (await client.listTools()).tools.map((t) => { const { $schema, ...input_schema } = t.inputSchema; return { name: t.name, description: t.description, input_schema }; });
      const system = skillText().replace(/^---[\s\S]*?\n---\n/, "").trim();
      const p = prices();
      const messages = [{ role: "user", content: opening(runId, given) }];
      while (true) {
        if (calls >= L.maxCalls) { stopped = `${L.maxCalls} model calls`; break; }
        if (tokens.output >= L.maxOutput) { stopped = `${L.maxOutput} output tokens`; break; }
        if (clock() - t0 > L.timeMs) { stopped = `the time limit (${Math.round(L.timeMs / 1000)} seconds)`; break; }
        if ((Number(await kv.get(K.monthCost(month))) / 1e6 || 0) >= L.budgetUsd) { stopped = "the month budget"; break; }
        calls++;
        const res = await deps.model.create({ model: MODEL, max_tokens: Math.min(L.maxTokensPerCall, L.maxOutput - tokens.output),
          system, tools, messages, cache_control: { type: "ephemeral" } });
        const u = res.usage || {};
        const t = { input: u.input_tokens || 0, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 };
        for (const k of Object.keys(tokens)) tokens[k] += t[k];
        const c = costOf(t, p); cost += c;
        if (c > 0) await kv.incrby(K.monthCost(month), Math.round(c * 1e6));
        messages.push({ role: "assistant", content: res.content });
        if (res.stop_reason !== "tool_use") break;
        const results = [];
        for (const tu of res.content.filter((x) => x.type === "tool_use")) {
          const r = await client.callTool({ name: tu.name, arguments: tu.input });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content.map((x) => x.text || "").join("\n"), is_error: r.isError || undefined });
        }
        messages.push({ role: "user", content: results });
      }
      outcome = stopped ? `stopped at ${stopped}` : "done";
      if (!fs.existsSync(path.join(dir, `board_${runId}.html`))) store.summary(runId, today);
    }

    // an answer counts as applied only when what it answered is no longer waiting
    const heldNow = new Set(store.getHeld().map((h) => h.transcript));
    const confirmNow = new Set(store.tracker().filter((r) => r.status === "confirm").map((r) => r.transcript));
    for (const a of given) {
      const clear = a.transcript ? (a.gate === "meeting_date" ? !confirmNow.has(a.transcript) : !heldNow.has(a.transcript)) : heldNow.size === 0;
      if (clear) { a.status = "applied"; a.applied_run = runId; }
      else if (a.given_runs.length >= L.answerTries) a.status = "needs a person";
    }

    const log = store.log().filter((r) => r.run_id === runId);
    const line = { ...base, run_id: runId, outcome, cycle_day: cycle.started ? cycle.day : null, reset, fed,
      read: [...new Set(log.filter((r) => r.step === "scan" && r.result === "new").map((r) => r.transcript))],
      declined: [...new Set(log.filter((r) => r.step === "decline").map((r) => r.transcript))],
      held: log.filter((r) => r.step === "stop" && r.result === "held").length,
      appended: store.tracker().filter((r) => r.added_run === runId).length,
      closed: store.tracker().filter((r) => r.closed_run === runId).length,
      carried, flagged: synced.flagged.length, answers_given: given.length,
      answers_applied: given.filter((a) => a.status === "applied").length,
      model_calls: calls, tokens, cost_usd: Number(cost.toFixed(6)), stopped };
    store.writeLog(runId, "", "run", outcome, `fed ${fed.join(" ") || "none"}; read ${line.read.length}; model calls ${calls}; ` +
      `output tokens ${tokens.output}; cost US$${cost.toFixed(4)}${carried.length ? `; carried ${carried.join(" ")}` : ""}`);

    // save: run_log.csv alone when nothing was new, everything otherwise; mt:pushing around it
    const parts = partsFrom(dir, store, answers, { runId });
    if (outcome === "nothing new") for (const n of Object.keys(parts)) if (n !== "run_log.csv") delete parts[n];
    line.saved = await folder.save(parts, kv, runId);

    // the snapshot the public routes read, rebuilt from the state just saved
    const prev = JSON.parse((await kv.get(K.snapshot)) || "null");
    const tracker = store.tracker();
    const snap = {
      skill_version: skillVersion(), model: MODEL, tier: TIER, updated_at: at,
      cycle: cycle.started ? { day: cycle.day, cycle: cycle.cycle, started: cycle.cycleStart } : { day: null, starts: deps.cycleStart || null },
      counts: { actions: tracker.length, open: tracker.filter((r) => r.status === "open").length,
        confirm: tracker.filter((r) => r.status === "confirm").length, closed: tracker.filter((r) => r.status === "closed").length },
      waiting: waiting(store),
      answers_waiting: answers.filter((a) => a.status === "waiting").length,
      answered: answers.filter((a) => a.status === "waiting" && a.transcript).map((a) => `${a.transcript} ${a.gate}`),
      answers_needing_a_person: answers.filter((a) => a.status === "needs a person").length,
      board_run: parts["board.html"] ? runId : prev?.board_run || null,
    };
    await kv.set(K.snapshot, JSON.stringify(snap));
    if (parts["board.html"]) await kv.set(K.board, parts["board.html"]);
    return { status: 200, line: await note(kv, line) };
  } catch (e) {
    const unfinished = await kv.get(K.pushing);
    return { status: 500, line: await note(kv, { ...base, run_id: runId, outcome: "failed",
      detail: `${String(e.message || e).slice(0, 300)}${unfinished ? "; the save did not complete, so the next run will stop for a person" : ""}` }) };
  } finally {
    try { await client?.close(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if ((await kv.get(K.lock)) === token) await kv.del(K.lock);
  }
}
