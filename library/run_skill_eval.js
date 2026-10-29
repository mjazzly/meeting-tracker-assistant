#!/usr/bin/env node
// Rung 4, the skill run: one command gives a model the check-before-build skill and the three library
// tools, sends each of the six requests in library/expected.json in a fresh conversation, and checks
// the reply against what the skill says it must do. The model never sees expected.json.
//
//   node library/run_skill_eval.js --model claude-haiku-5-5
//   node library/run_skill_eval.js --model claude-opus-5-5 --effort high
//
// What is checked, per case (all from the reply text and the tool calls):
//   every case     library_search was called with the request as written (no rewording)
//   MATCH cases    the reply names the one entry and quotes its tested-on state; nothing else is "the match"
//   case 6         the reply names the limit the request crosses (email) and asks extend or new brief;
//                  it never says the entry sends email
//   POSSIBLE case  the reply names both entries and ends in a question; it does not pick
//   NEW case       library_brief was called; the reply says nothing in the library fits and lists
//                  numbered questions for the blank fields
// Results go to library/results/<label>.json; a miss is named with its reason, never rounded up.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const MODEL = arg("model", "claude-haiku-5-5");
const EFFORT = arg("effort");
const MAX_CALLS = 8;

const skillText = fs.readFileSync(path.join(ROOT, "skill", "check-before-build", "SKILL.md"), "utf8");
const skillBody = skillText.replace(/^---[\s\S]*?\n---\n/, "").trim();
const skillVersion = (/Version: (v[\d.]+)/.exec(skillText) || [])[1] || "unknown";
const { cases } = JSON.parse(fs.readFileSync(path.join(here, "expected.json"), "utf8"));

function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const f = path.join(ROOT, ".env");
  if (fs.existsSync(f)) { const m = /^ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m.exec(fs.readFileSync(f, "utf8")); if (m) return m[1].trim(); }
  console.error("No API key: put ANTHROPIC_API_KEY=... in .env"); process.exit(2);
}

const now = new Date(); const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
let LABEL = `S${local.slice(0, 19).replace(/[-:T]/g, "")}-${MODEL.replace(/^claude-/, "")}${EFFORT ? "-" + EFFORT : ""}`;
// two runs started in the same second still get separate files
for (let n = 2; fs.existsSync(path.join(here, "results", `${LABEL}.json`)); n++) LABEL = LABEL.replace(/(-run\d+)?$/, `-run${n}`);

const mcp = new Client({ name: "skill-eval", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server.mjs")],
  env: { ...process.env, TRACKER_DATA: path.join(ROOT, "data") }, stderr: "ignore" }));
const tools = (await mcp.listTools()).tools.filter((t) => t.name.startsWith("library_")).map((t) => {
  const { $schema, ...input_schema } = t.inputSchema; return { name: t.name, description: t.description, input_schema };
});
const model = new Anthropic({ apiKey: apiKey() });
const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

async function runCase(request) {
  const messages = [{ role: "user", content: request }];
  const calls = []; let text = ""; let n = 0;
  while (n < MAX_CALLS) {
    n++;
    const req = { model: MODEL, max_tokens: 8000, system: skillBody, tools, messages, cache_control: { type: "ephemeral" } };
    if (EFFORT) req.output_config = { effort: EFFORT };
    const res = await model.messages.create(req);
    if (res.usage) { tokens.input += res.usage.input_tokens || 0; tokens.output += res.usage.output_tokens || 0;
      tokens.cache_read += res.usage.cache_read_input_tokens || 0; tokens.cache_write += res.usage.cache_creation_input_tokens || 0; }
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text") text += b.text + "\n";
    if (res.stop_reason !== "tool_use") break;
    const results = [];
    for (const b of res.content.filter((x) => x.type === "tool_use")) {
      const r = await mcp.callTool({ name: b.name, arguments: b.input });
      const out = r.content.map((c) => c.text || "").join("\n");
      calls.push({ name: b.name, input: b.input });
      results.push({ type: "tool_result", tool_use_id: b.id, content: out, is_error: r.isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: text.trim(), calls, model_calls: n };
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
function check(c, r) {
  const fails = []; const t = r.text; const tl = t.toLowerCase();
  const searches = r.calls.filter((x) => x.name === "library_search");
  if (!searches.length) fails.push("library_search was not called");
  else if (!searches.some((s) => norm(s.input.request) === norm(c.request))) fails.push(`search request was reworded: "${searches[0].input.request}"`);
  const allNames = ["Conversation Brief Assistant", "Column Mapper", "Process Mapper", "Fit Check", "Pattern Log", "Runbook Writer", "Right-Size", "Meeting Tracker Assistant", "Prompt Drill Coach"];
  const named = allNames.filter((n) => tl.includes(n.toLowerCase()));
  if (c.verdict === "MATCH") {
    const want = c.names[0];
    if (!tl.includes(want.toLowerCase())) fails.push(`reply does not name ${want}`);
    if (!/tested on|not yet run|of 5|harness/.test(tl)) fails.push("reply does not carry the tested-on state");
    if (c.limits_must_name) {
      if (!/email/.test(tl)) fails.push("reply does not name the email limit");
      if (!/extend/.test(tl) || !/brief/.test(tl)) fails.push("reply does not ask extend or new brief");
      if (/\b(it|which) (will|can|does) (send|email)/.test(tl)) fails.push("reply claims the entry sends email");
    } else if (!/reuse|use it as it stands|use it as is|as it stands/.test(tl)) fails.push("reply does not say to reuse it");
  }
  if (c.verdict === "POSSIBLE") {
    for (const n of c.names) if (!tl.includes(n.toLowerCase())) fails.push(`reply does not name ${n}`);
    if (!t.includes("?")) fails.push("reply does not ask which");
    if (/\b(go with|use|reuse) (the )?(process mapper|runbook writer)\b/.test(tl) && !/which/.test(tl)) fails.push("reply picked one");
  }
  if (c.verdict === "NEW") {
    if (!r.calls.some((x) => x.name === "library_brief")) fails.push("library_brief was not called");
    if (!/nothing in the library|new|not in the library|does not exist/.test(tl)) fails.push("reply does not say it is new");
    if (!/\n\s*1[.)]/.test(t)) fails.push("reply has no numbered questions");
    if (!/objective/.test(tl)) fails.push("reply does not ask for the objective");
    if (named.length && /this exists/.test(tl)) fails.push(`reply presents ${named.join(", ")} as existing for this`);
  }
  return fails;
}

console.log(`run ${LABEL}: skill ${skillVersion}, model ${MODEL}${EFFORT ? ", effort " + EFFORT : ""}, ${cases.length} cases`);
const results = []; let matched = 0;
for (const c of cases) {
  process.stdout.write(`  ${c.case} ... `);
  let r;
  try { r = await runCase(c.request); } catch (e) { r = { text: "", calls: [], model_calls: 0, error: String(e.message || e) }; }
  const fails = r.error ? [`did not finish: ${r.error}`] : check(c, r);
  if (!fails.length) matched++;
  console.log(fails.length ? `MISS (${fails.join("; ")})` : "MATCH");
  results.push({ case: c.case, request: c.request, expected: c.verdict, match: !fails.length, fails, tool_calls: r.calls, model_calls: r.model_calls, reply: r.text });
}
await mcp.close();
const totalIn = tokens.input + tokens.cache_read + tokens.cache_write;
let cost = null;
try { const p = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "prices.json"), "utf8"))[MODEL];
  if (p) cost = (tokens.input * p.input + tokens.cache_write * p.cache_write_5m + tokens.cache_read * p.cache_read + tokens.output * p.output) / 1e6; } catch {}
console.log(`\n${matched} of ${cases.length} matched. input ${totalIn} (fresh ${tokens.input}, cache write ${tokens.cache_write}, cache read ${tokens.cache_read}), output ${tokens.output}${cost != null ? `; cost US$${cost.toFixed(3)}` : ""}`);
const record = { label: LABEL, date: local.slice(0, 10), started_at: local, skill_version: skillVersion, model: MODEL, effort: EFFORT,
  matched, of: cases.length, tokens, total_input: totalIn, cost_usd: cost, cases: results };
fs.mkdirSync(path.join(here, "results"), { recursive: true });
if (totalIn + tokens.output > 0) {
  fs.writeFileSync(path.join(here, "results", `${LABEL}.json`), JSON.stringify(record, null, 2));
  console.log("recorded:", path.join("library", "results", `${LABEL}.json`));
} else console.log("not recorded: the run never reached the model");
process.exit(matched === cases.length ? 0 : 1);
