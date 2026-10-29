#!/usr/bin/env node
// Rung 3: the eval harness. One command reruns every case against the assistant and records the result.
//
//   node eval.mjs --model claude-opus-5-5 [--effort high] [--label name] [--max-calls 80]
//   node eval.mjs --mock          (no API call: a scripted stand-in replays fixed rows; never recorded)
//   node eval.mjs --page-only     (rebuild EXEMPLAR.md from eval/results without running anything)
//
// What a run does:
//   1. Copies the contacts table and the eight transcripts into an empty folder under eval/runs/.
//   2. Starts the real tool server (server.mjs) on that folder, as the desktop app does, over MCP.
//   3. Gives the model the skill (skill/SKILL.md) as its only instructions and the server's tools,
//      then sends the same opening message a person would: "Run the tracker. Use run id ...".
//   4. When the model stops with rows held at a gate, sends the fixed answers in eval/answers.txt.
//   5. Checks every transcript against eval/expected/*.json (which the model cannot reach),
//      writes eval/results/<label>.json and the full transcript of tool calls, and rebuilds
//      eval/EXEMPLAR.md from every recorded run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadExpected, checkCase, verdict } from "./check.js";
import { writePage } from "./page.js";
import { MockModel } from "./mock.js";
import { renderBoard, renderExemplar } from "../lib/render.js";
import { loadResults } from "./page.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.basename(here) === "eval" ? path.dirname(here) : here;
const EVAL = path.join(ROOT, "eval");

// ---------- arguments ----------
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const MOCK = flag("mock");
const MODEL = MOCK ? "mock (scripted, no model)" : arg("model", "claude-opus-5-5");
const EFFORT = arg("effort");
const MAX_CALLS = Number(arg("max-calls", 80));
// Prompt caching is on by default: every call resends the skill, the tools and the run so far,
// and a cache read costs a small fraction of a fresh read. --no-cache turns it off for comparison.
const CACHE = !flag("no-cache");

const skillPath = path.join(ROOT, "skill", "SKILL.md");
const skillText = fs.readFileSync(skillPath, "utf8");
const skillBody = skillText.replace(/^---[\s\S]*?\n---\n/, "").trim();
const skillVersion = (/Version: (v[\d.]+)/.exec(skillText) || [])[1] || "unknown";

if (flag("page-only")) {
  console.log("page written:", writePage(path.join(EVAL, "results"), path.join(EVAL, "EXEMPLAR.md"), { version: skillVersion }));
  fs.writeFileSync(path.join(EVAL, "EXEMPLAR.html"), renderExemplar(loadResults(path.join(EVAL, "results")), { version: skillVersion }));
  process.exit(0);
}

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) {
    const m = /^ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m.exec(fs.readFileSync(envFile, "utf8"));
    if (m) return m[1].trim();
  }
  console.error("No API key. Put ANTHROPIC_API_KEY=... in .env in the server folder, or set it in the environment.");
  process.exit(2);
}

// ---------- the run folder ----------
const now = new Date();
const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
const date = local.slice(0, 10);
const stamp = local.slice(0, 16).replace(/[-:T]/g, "");
const RUN_ID = `E${stamp}`;
const modelTag = MOCK ? "mock" : MODEL.replace(/^claude-/, "");
const LABEL = arg("label", `${RUN_ID}-${modelTag}${EFFORT ? "-" + EFFORT : ""}`);
const runDir = path.join(EVAL, MOCK ? "runs-mock" : "runs", LABEL);
const dataDir = path.join(runDir, "data");
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, "held"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "data", "contacts.csv"), path.join(dataDir, "contacts.csv"));
// file by file: some shared folders refuse a whole-directory copy
fs.mkdirSync(path.join(dataDir, "transcripts"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "data", "transcripts")).filter((x) => x.endsWith(".txt"))) {
  fs.copyFileSync(path.join(ROOT, "data", "transcripts", f), path.join(dataDir, "transcripts", f));
}

// ---------- the tool server ----------
const serverFile = fs.existsSync(path.join(ROOT, "server.mjs")) ? "server.mjs" : "server.js";
const mcp = new Client({ name: "eval-harness", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, serverFile)],
  env: { ...process.env, TRACKER_DATA: dataDir }, stderr: "ignore" }));
// The API takes the same JSON Schema the server announces, minus the $schema marker it does not need.
const tools = (await mcp.listTools()).tools.map((t) => {
  const { $schema, ...input_schema } = t.inputSchema;
  return { name: t.name, description: t.description, input_schema };
});

async function callTool(name, input) {
  const r = await mcp.callTool({ name, arguments: input });
  return { text: r.content.map((c) => c.text || "").join("\n"), isError: !!r.isError };
}

// ---------- the model ----------
const model = MOCK ? new MockModel(callTool) : new Anthropic({ apiKey: apiKey() });
const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const transcript = [];
let calls = 0;

async function runUntilEnd(messages) {
  while (true) {
    if (calls >= MAX_CALLS) throw new Error(`stopped after ${MAX_CALLS} model calls without finishing`);
    calls++;
    const req = { model: MODEL, max_tokens: 16000, system: skillBody, tools, messages };
    if (EFFORT) req.output_config = { effort: EFFORT };
    if (CACHE) req.cache_control = { type: "ephemeral" };
    const res = MOCK ? await model.create(req) : await model.messages.create(req);
    if (res.usage) {
      tokens.input += res.usage.input_tokens || 0; tokens.output += res.usage.output_tokens || 0;
      tokens.cache_read += res.usage.cache_read_input_tokens || 0; tokens.cache_write += res.usage.cache_creation_input_tokens || 0;
    }
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) {
      if (b.type === "text" && b.text.trim()) transcript.push({ who: "model", text: b.text });
    }
    if (res.stop_reason !== "tool_use") return res.stop_reason;
    const results = [];
    for (const b of res.content.filter((x) => x.type === "tool_use")) {
      const out = await callTool(b.name, b.input);
      transcript.push({ who: "tool", name: b.name, input: b.input, result: out.text.slice(0, 2000), is_error: out.isError });
      process.stdout.write(`  ${b.name}${b.input?.transcript ? " " + b.input.transcript : ""}${out.isError ? " (error)" : out.text.includes("STOPPED_AT_GATE") ? " (gate)" : ""}\n`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: out.text, is_error: out.isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
}

const opening = `Run the tracker. Use run id ${RUN_ID}.`;
const answers = fs.readFileSync(path.join(EVAL, "answers.txt"), "utf8").trim();
const messages = [{ role: "user", content: opening }];
transcript.push({ who: "person", text: opening });
console.log(`run ${LABEL}: skill ${skillVersion}, model ${MODEL}${EFFORT ? ", effort " + EFFORT : ""}`);

let completed = true, error = null;
try {
  await runUntilEnd(messages);
  const held = JSON.parse((await callTool("tracker_held", {})).text);
  if (held.length) {
    console.log(`  (gates waiting: ${held.length}; sending the fixed answers)`);
    messages.push({ role: "user", content: answers });
    transcript.push({ who: "person", text: answers });
    await runUntilEnd(messages);
  }
} catch (e) {
  completed = false; error = String(e.message || e);
  console.error("run did not finish:", error);
}
await mcp.close();

// ---------- check and record ----------
const expected = loadExpected(path.join(EVAL, "expected"));
const cases = {};
for (const t of Object.keys(expected).sort()) cases[t] = checkCase(t, dataDir, expected, RUN_ID);
const v = verdict(cases);
for (const c of Object.values(cases)) console.log(`${c.match ? "MATCH" : "MISS "} ${c.transcript}${c.fails.length ? "\n        " + c.fails.join("\n        ") : ""}`);
console.log(`\n${v.five_matched} of 5 matched, decline ${v.decline_held ? "held" : "did not hold"}, state ${v.state_matched} of 2: ${v.passed ? "BAR MET" : "BAR NOT MET"}`);
// cost from the published price table; every input token is counted once, at the rate it was charged
const totalIn = tokens.input + tokens.cache_read + tokens.cache_write;
let cost = null;
try {
  const prices = JSON.parse(fs.readFileSync(path.join(EVAL, "prices.json"), "utf8"))[MODEL];
  if (prices) cost = (tokens.input * prices.input + tokens.cache_write * prices.cache_write_5m + tokens.cache_read * prices.cache_read + tokens.output * prices.output) / 1e6;
} catch {}
console.log(`model calls ${calls}; input ${totalIn} (fresh ${tokens.input}, cache write ${tokens.cache_write}, cache read ${tokens.cache_read}), output ${tokens.output}${cost != null ? `; cost US$${cost.toFixed(3)}` : ""}${CACHE ? "; caching on" : "; caching off"}`);

const record = { label: LABEL, run_id: RUN_ID, date, started_at: local, mode: MOCK ? "mock" : "harness", blind: true,
  counted: !MOCK && completed, skill_version: skillVersion, server_version: "2.1.0", model: MODEL, effort: EFFORT,
  model_calls: calls, tokens, total_input: totalIn, cost_usd: cost, cache: CACHE, completed, error, verdict: v, cases,
  note: !completed ? `Did not finish: ${error}` : undefined };
fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify({ system: "skill/SKILL.md " + skillVersion, transcript }, null, 2));
fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(record, null, 2));
// A run that failed before the model produced anything (network, key, quota) is not a test result:
// it stays in its run folder for diagnosis and is never written to the record or the page.
const reachedModel = totalIn + tokens.output > 0;
if (!MOCK && !reachedModel) {
  console.log(`not recorded: the run never reached the model (${error || "no tokens"}). Details in ${runDir}`);
} else if (!MOCK) {
  fs.writeFileSync(path.join(EVAL, "results", `${LABEL}.json`), JSON.stringify(record, null, 2));
  console.log("page written:", writePage(path.join(EVAL, "results"), path.join(EVAL, "EXEMPLAR.md"), { version: skillVersion }));
  fs.writeFileSync(path.join(EVAL, "EXEMPLAR.html"), renderExemplar(loadResults(path.join(EVAL, "results")), { version: skillVersion }));
  console.log("exemplar page:", path.join(EVAL, "EXEMPLAR.html"));
}
if (reachedModel || MOCK) {
  fs.writeFileSync(path.join(runDir, "board.html"), renderBoard(dataDir, { runId: RUN_ID, asOf: date }));
  console.log("action board:", path.join(runDir, "board.html"));
}
if (MOCK) {
  console.log(`mock run: recorded in ${runDir} only; the exemplar page is not touched`);
}
process.exit(v.passed ? 0 : 1);
