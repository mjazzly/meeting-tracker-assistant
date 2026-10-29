// Writes eval/EXEMPLAR.md from every results file in eval/results. The page is never edited by
// hand: each run adds a results file, and the page is rebuilt from all of them, so the history,
// the "tested on" line and the latest case table always agree with the records.
import fs from "node:fs";
import path from "node:path";

const CASE_NAMES = {
  "01_halden_kickoff.txt": "1. Clean",
  "02_meridian_pricing.txt": "2. An action with no owner",
  "03_northgate_claims.txt": "3. A relative date with no meeting date",
  "04_halden_finance.txt": "4. A name that matches two people",
  "05_meridian_update.txt": "5. No actions",
  "06_northgate_board.txt": "6. Confidential (must decline)",
  "07_halden_followup.txt": "State: a later meeting closes an action",
  "08_meridian_contracts.txt": "State: a date before the meeting",
};

const fmtInt = (n) => (n == null ? "" : Number(n).toLocaleString("en-GB"));

export function loadResults(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => (a.started_at || a.date).localeCompare(b.started_at || b.date));
}

export function writePage(resultsDir, outPath, skillHeader) {
  const all = loadResults(resultsDir);
  const counted = all.filter((r) => r.counted);
  const latest = counted[counted.length - 1];
  const L = [];
  L.push("# Meeting Tracker Assistant", "");
  L.push("Turns meeting transcripts into an action tracker the model keeps itself. It looks every named person up in a contacts table through a tool it calls, appends to the tracker without overwriting, closes actions a later meeting resolves, and stops to ask at four gates rather than guess: a name that matches two people, a meeting with no actions, a date before the meeting it was set in, and a transcript marked confidential.", "");
  L.push(`**Owner:** Megat Jazly. **Current version:** ${skillHeader.version}. **Limits:** synthetic transcripts and a synthetic contacts table that stands in for a CRM; one folder; no scheduling; no external system connected.`, "");
  if (latest) {
    L.push(`**Tested on:** ${latest.model}${latest.effort ? ` (effort ${latest.effort})` : ""}, ${latest.date}, ${latest.mode === "harness" ? "automated harness run" : "manual chat run"}: ${latest.verdict.five_matched} of 5 cases matched, decline ${latest.verdict.decline_held ? "held" : "did not hold"}${latest.verdict.passed ? ", bar met" : ", bar not met"}.`, "");
  }
  L.push("**The bar:** four of the five cases matched and the decline holding, against expected results written before the first run. A miss is named with its line, never rounded up.", "");

  L.push("## Run history", "");
  L.push("| Date | Run | Skill | How it ran | Model | Cases matched | Decline | State cases | Counted | Tokens in / out |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of all) {
    const v = r.verdict;
    const tok = r.tokens ? `${fmtInt(r.tokens.input)} / ${fmtInt(r.tokens.output)}` : "not recorded";
    const score = r.counted && v;
    L.push(`| ${r.date} | ${r.label} | ${r.skill_version} | ${r.mode === "harness" ? "harness, automated" : "chat, by hand"} | ${r.model}${r.effort ? ` ${r.effort}` : ""} | ${score ? `${v.five_matched} of 5` : "not counted"} | ${score ? (v.decline_held ? "held" : "failed") : "not counted"} | ${score ? `${v.state_matched} of 2` : "not counted"} | ${r.counted ? "yes" : "no"} | ${tok} |`);
  }
  L.push("");
  const notes = all.filter((r) => r.note);
  if (notes.length) {
    L.push("## What each run found", "");
    for (const r of notes) L.push(`- **${r.label}:** ${r.note}`);
    L.push("");
  }
  if (latest) {
    L.push(`## Latest counted run, case by case (${latest.label})`, "");
    L.push("| Case | Result | Why not, if not |", "|---|---|---|");
    for (const [t, name] of Object.entries(CASE_NAMES)) {
      const c = latest.cases[t];
      if (!c) continue;
      L.push(`| ${name} | ${c.match ? "Match" : "**Miss**"} | ${c.fails.join("; ")} |`);
    }
    L.push("");
  }
  L.push("## How a harness run works", "");
  L.push("One command starts the tool server on an empty copy of the data, gives the model the skill and nothing else, and lets it run the whole tracker through the tools. When it stops at its gates, the harness answers with the same fixed message every run. The checker then compares the result with the expected results, which the model never sees, and this page is rebuilt from every recorded run.", "");
  L.push("Rerun after any change to the skill or the server: `node eval.mjs --model <model id>`.");
  fs.writeFileSync(outPath, L.join("\n") + "\n");
  return outPath;
}
