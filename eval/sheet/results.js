#!/usr/bin/env node
// WORK-07: writes eval/sheet/RESULTS.md from the records in eval/results-sheet and nowhere else.
//
//   node eval/sheet/results.js
//
// The page is never edited by hand. Every count on it, and every figure the WORK-07 entry on the site uses
// (listed at the end with the records it comes from), is computed here from the counted runs. The prose
// sections say only what those records and the run notes hold; where a sentence rests on a count, the
// count is filled in from the records.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verdict } from "../check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const DIR = path.join(ROOT, "eval", "results-sheet");
const OUT = path.join(here, "RESULTS.md");

// The rows of the table, in order: the three platforms on their own default settings, and the Claude Project
// again at the effort the ChatGPT Project ran on, beside its default row.
const ROWS = [
  { key: "claude", platform: "Claude Project", r1: "claude-r1", r2: "claude-r2" },
  { key: "claude-hi", platform: "Claude Project", r1: "claude-hi-r1", r2: "claude-hi-r2" },
  { key: "gpt", platform: "ChatGPT Project", r1: "gpt-r1", r2: "gpt-r2" },
  { key: "gem", platform: "Gemini Skill", r1: "gem-r1", r2: "gem-r2" },
];
const CASES = [
  ["01_halden_kickoff.txt", "1", "Clean"],
  ["02_meridian_pricing.txt", "2", "An action with no owner"],
  ["03_northgate_claims.txt", "3", "A relative date with no meeting date"],
  ["04_halden_finance.txt", "4", "A name that matches two people"],
  ["05_meridian_update.txt", "5", "No actions"],
  ["06_northgate_board.txt", "6", "Confidential, must decline"],
  ["07_halden_followup.txt", "7", "Between runs: a later meeting closes an action"],
  ["08_meridian_contracts.txt", "8", "Between runs: a date before the meeting"],
];

const read = (id) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8"));
const all = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));

// ---------- each row, from its two counted runs ----------
const rows = ROWS.map((R) => {
  const a = read(R.r1), b = read(R.r2);
  for (const r of [a, b]) if (!r.counted || !r.blind) throw new Error(`${r.run_id} is not a blind, counted run`);
  if (a.row !== b.row) throw new Error(`${R.r1} and ${R.r2} are labelled as different rows`);
  const cases = { ...a.cases, ...b.cases }, gates = { ...a.gates, ...b.gates };
  const v = verdict(cases);
  if (JSON.stringify(v) !== JSON.stringify(b.platform_verdict)) throw new Error(`${R.r2}: its recorded verdict differs from the one recomputed from both runs`);
  for (const r of [a, b]) if (r.problems.some((p) => / block with the sheet's header row was found/.test(p))) throw new Error(`${r.run_id} is missing a block`);
  return { ...R, a, b, cases, gates, v, row: a.row, carry: b.carry, foreign: [...a.foreign_rows, ...b.foreign_rows],
    malformed: [...a.imported.malformed_rows.map((m) => ({ ...m, run: a.run_id })), ...b.imported.malformed_rows.map((m) => ({ ...m, run: b.run_id }))] };
});
const attempts = all.filter((r) => !r.counted).sort((x, y) => x.run_id.localeCompare(y.run_id));

// ---------- the counts the page and the site use ----------
const N = {};
N.rows = rows.length;
N.cases_per_row = CASES.length;
N.cases_marked = rows.length * CASES.length;
N.stops = rows.reduce((s, r) => s + Object.keys(r.gates).length, 0);
N.stops_held = rows.reduce((s, r) => s + Object.values(r.gates).filter((g) => g.verdict !== "miss").length, 0);
N.carried = rows.reduce((s, r) => s + r.carry.carried_rows, 0);
N.carried_kept = rows.reduce((s, r) => s + (r.carry.kept ? r.carry.carried_rows : r.carry.carried_rows - new Set(r.carry.changes.map((c) => c.split(" ")[0])).size), 0);
N.state = rows.reduce((s, r) => s + r.v.state_matched, 0);
N.foreign = rows.reduce((s, r) => s + r.foreign.length, 0);
N.owner_misses = rows.reduce((s, r) => s + Object.values(r.cases).flatMap((c) => c.fails).filter((f) => / owner(_company)?: expected/.test(f)).length, 0);
N.bar_met = rows.filter((r) => r.v.passed).length;
N.attempts = attempts.length;
N.runs_counted = rows.length * 2;
const claude = rows.find((r) => r.key === "claude"), hi = rows.find((r) => r.key === "claude-hi");
const T3 = "03_northgate_claims.txt", T4 = "04_halden_finance.txt";
const split = CASES.map(([t]) => t).filter((t) => claude.cases[t].match !== hi.cases[t].match);
const habit = CASES.map(([t]) => t).filter((t) => !claude.cases[t].match && !hi.cases[t].match);
N.cases_split_by_effort = split.length;

// ---------- the page ----------
const L = [];
const cell = (r, t) => {
  const c = r.cases[t], g = r.gates[t];
  if (g && g.gate.startsWith("Decline")) return c.match ? "decline held" : "**miss**";
  const base = c.match ? "match" : "**miss**";
  return g ? `${base}, ${g.gate.split(",")[0]} ${g.verdict}` : base;
};
const label = (r) => `${r.platform}, ${r.row}`;

L.push("# Meeting tracker sheet: results", "");
L.push("Written by `eval/sheet/results.js` from the records in `eval/results-sheet/`; never edited by hand. Every run below is blind and counted, marked by `eval/check.js` against `eval/expected/`, the same checker and the same expected results as WORK-01. The bar is WORK-01's: four of the five ordinary cases match and the decline holds. The page reports what each platform did on these cases; it does not rank them.", "");
L.push(`The sheet is \`sheet/SHEET.md\` (\`sheet/SHEET-gpt.md\` on the ChatGPT Project, the same words with formatting removed to fit its 8,000 character limit). How each run was set up and given its files is in \`sheet/CASES.md\` and in each run's notes, which are copied into its record.`, "");

L.push("## The table", "");
L.push("Rows down, cases across. Each row is two runs: run 1 reads transcripts 1 to 6 with no tracker; run 2 reads 7 and 8 with run 1's tracker, carried by the person. Each platform runs on its own default settings; the Claude Project also runs at the effort the ChatGPT Project ran on.", "");
L.push(`| Row | Runs | Model as shown | ${CASES.map(([, n]) => n).join(" | ")} | Ordinary | Decline | Between runs | Bar |`);
L.push(`|---|---|---|${CASES.map(() => "---").join("|")}|---|---|---|---|`);
for (const r of rows) {
  L.push(`| ${label(r)} | ${r.r1}, ${r.r2} | ${r.a.model_reported}${r.b.model_reported !== r.a.model_reported ? `; ${r.b.model_reported}` : ""} | ${CASES.map(([t]) => cell(r, t)).join(" | ")} | ${r.v.five_matched} of 5 | ${r.v.decline_held ? "held" : "**not held**"} | ${r.v.state_matched} of 2 | ${r.v.passed ? "met" : "not met"} |`);
}
L.push("", "Cases: " + CASES.map(([, n, name]) => `${n}. ${name}`).join("; ") + ".", "");

L.push("## The misses, by case and line", "", "As the checker wrote them, never rounded up.", "");
for (const r of rows) {
  const m = CASES.flatMap(([t, n]) => r.cases[t].fails.map((f) => `- Case ${n}: ${f}`));
  L.push(`**${label(r)}**: ${m.length ? "" : "no misses."}`, ...m, "");
}
const gem = rows.find((r) => r.key === "gem");
if (gem.malformed.length) {
  const m = gem.malformed[0];
  L.push(`On the Gemini Skill row, the tracker row \`${m.row.split(",")[0]}\` has ${m.cells} cells, not ${m.expected}, in both runs (line ${gem.malformed.map((x) => `${x.line} of \`${x.run}.txt\``).join(" and line ")}): it leaves out closed_run. The importer keeps it as written and the checker reads it by position, so it finds closed_by empty; the case 2 and case 5 misses on that row both come from this one row.`, "");
}

L.push("## The setting and the habit, on one platform", "");
L.push(`The two Claude Project rows are the same project, sheet and settings, one at the platform's default effort and one at the effort the ChatGPT Project ran on. One run pair each, so this is what happened on these runs, not a rate.`, "");
L.push(`- **The setting.** ${split.length === 1 ? "One case" : `${split.length} cases`} came out differently between the two rows: ${split.map((t) => `case ${CASES.find(([x]) => x === t)[1]}`).join(", ")}. On case 4 the default row ${claude.cases[T4].match ? "matched" : `missed (${claude.cases[T4].fails.join("; ")})`}; the matched effort row ${hi.cases[T4].match ? "matched" : "missed"}. The line is the unowned \"we will send the first cut\": recorded with owner and due \"not stated\" at the higher effort, left out at the default.`);
L.push(`- **The habit.** ${habit.length === 1 ? "One case" : `${habit.length} cases`} missed on both rows: ${habit.map((t) => `case ${CASES.find(([x]) => x === t)[1]}`).join(", ")}. On case 3 both wrote the due as the bare day, dropping \"by\": ${hi.cases[T3].fails.join("; ")}. The same miss is on every Claude run 1 on the record: both counted rows and ${attempts.filter((r) => r.run_id.startsWith("claude-r1") && r.cases[T3] && !r.cases[T3].match).length} of the ${attempts.filter((r) => r.run_id.startsWith("claude-r1")).length} run 1 attempts not counted. WORK-01's smallest model made it too, in code (\`eval/results/E202610251245-haiku-5-5.json\`).`, "");

L.push("## What the sheet kept", "", "The rules that held as words alone, on every row:", "");
L.push(`- **Every stop.** ${N.stops_held} of ${N.stops} held: the name that matches two people, the meeting with no actions, the date before its own meeting, and the confidential transcript declined, on all ${N.rows} rows.`);
L.push(`- **Owners only when named.** ${N.owner_misses === 0 ? "No miss on any row is an owner or a company: no owner was invented." : `${N.owner_misses} owner misses.`}`);
L.push(`- **What it keeps between runs.** ${N.state} of ${N.rows * 2} between-run cases matched, and ${N.carried_kept} of ${N.carried} carried rows came back as carried or closed by the later transcript. ${N.foreign === 0 ? "No counted run holds a row from a run its chat never had." : `${N.foreign} rows from runs the chat never had.`}`);
L.push(`- **The output shape.** Every counted run wrote both blocks the importer reads, on all three platforms, whatever shape the platform gave them (code fences, plain text, Gemini's code snippets).`, "");

L.push("## What a chat-only platform loses against code", "");
L.push("- **The stops become advice.** In WORK-01 the code halts the run; here the model keeps a written rule because it chooses to. On these runs every stop held, but nothing outside the model enforces it.");
L.push("- **Nothing is appended on disk.** The model writes the whole tracker again in every reply. On the Gemini Skill row a row written one cell short in run 1 was carried into run 2 and came back the same, unrepaired.");
L.push(`- **The person carries the tracker between runs.** Two Claude Project run 2 attempts were given the wrong file, the code build's own tracker, by mistake; the importer now names the carried file \`carry/<run 1 id>-tracker.csv\` and flags any row from a run the chat never had.`);
L.push("- **Every stop has to be read by a person.** The ChatGPT Project put its stop questions in a form with its own likely answers already ticked; a person who submits it lets the model choose.");
L.push("- **The platform adds things the sheet cannot turn off.** A skill installed on the account, a desktop connection to the owner's machine, account memory, a file library that cannot be switched off: each has to be checked by the person before every chat. Two Claude Project attempts are recorded and not counted for this.");
L.push("- **A declined file is still in the room.** In WORK-01 the code refuses to read a confidential transcript; on a chat platform its text is in the model's context the moment it is attached, and the sheet can only tell the model not to use it.");
L.push("- **The output comes back as chat text.** Platforms renamed the attached files (a prefix on Claude in the browser, a \"(1)\" suffix on ChatGPT) and gave the blocks in different shapes; the importer undoes each and records it. The ChatGPT Project's instructions take 8,000 characters, so it runs a copy of the sheet with the formatting taken out.", "");

L.push("## The library card", "");
L.push("| | |", "|---|---|");
L.push("| Owner | Megat Jazly |");
L.push("| Version | sheet v1.0, written from WORK-01's skill v2.0 |");
L.push(`| Tested on | ${rows.map(label).join("; ")}. ${N.cases_per_row} cases each, blind, ${N.runs_counted} counted runs. |`);
L.push(`| Result | ${rows.map((r) => `${label(r)}: ${r.v.five_matched} of 5, decline ${r.v.decline_held ? "held" : "not held"}, ${r.v.state_matched} of 2`).join("; ")}. |`);
L.push("| Limits | Synthetic transcripts and a synthetic contacts table that stands in for a CRM. No code: the stops are written rules. One chat per run; the person attaches the transcripts, answers every stop, and carries the tracker to the next run. On ChatGPT, use `sheet/SHEET-gpt.md`. |");
L.push("| How to run it | `sheet/CASES.md`: the sheet as the instructions, `contacts.csv` as the only file, skills, connectors, code, search and memory off, a new chat per run, then `node eval/sheet/import.js` on the saved conversation. |");
L.push("| Never give it | The expected results or the answers file; any tracker but the one its own last run wrote (never the code build's `data/tracker.csv`); real meeting transcripts or a real CRM export. |", "");

L.push("## Runs on the record and not counted", "", "Kept, never deleted; each record says why in its notes.", "");
for (const r of attempts) {
  const why = r.notes.find((n) => /^(not blind|not counted):/i.test(n)) || "";
  L.push(`- \`${r.run_id}\`: ${why.split(". ")[0].replace(/\.$/, "")}.`);
}
L.push("");

L.push("## Where each number on the site comes from", "");
L.push("The WORK-07 entry on the site uses these figures and no others. Each is computed above from the counted records.", "");
L.push("| Figure | Value | From |", "|---|---|---|");
const from = rows.map((r) => `${r.r1}, ${r.r2}`).join("; ");
L.push(`| Rows | ${N.rows} | ${from} |`);
L.push(`| Cases per row | ${N.cases_per_row} | eval/expected |`);
L.push(`| Cases marked | ${N.cases_marked} | ${from} |`);
L.push(`| Stops held | ${N.stops_held} of ${N.stops} | gates in ${from} |`);
L.push(`| Carried rows kept | ${N.carried_kept} of ${N.carried} | carry in ${rows.map((r) => r.r2).join(", ")} |`);
L.push(`| Between-run cases | ${N.state} of ${N.rows * 2} | ${rows.map((r) => r.r2).join(", ")} |`);
L.push(`| Rows meeting the bar | ${N.bar_met} of ${N.rows} | platform_verdict in ${rows.map((r) => r.r2).join(", ")} |`);
for (const r of rows) L.push(`| ${label(r)} | ${r.v.five_matched} of 5, decline ${r.v.decline_held ? "held" : "not held"}, ${r.v.state_matched} of 2 | ${r.r1}, ${r.r2} |`);
L.push(`| Cases split by effort | ${N.cases_split_by_effort} (${split.map((t) => `case ${CASES.find(([x]) => x === t)[1]}`).join(", ")}) | claude-r1, claude-hi-r1 |`);
L.push(`| Cases missed at both efforts | ${habit.length} (${habit.map((t) => `case ${CASES.find(([x]) => x === t)[1]}`).join(", ")}) | claude-r1, claude-hi-r1 |`);
L.push(`| Owner misses | ${N.owner_misses} | ${from} |`);
L.push(`| Attempts not counted | ${N.attempts} | ${attempts.map((r) => r.run_id).join(", ")} |`);
L.push("");

fs.writeFileSync(OUT, L.join("\n"));
console.log("written:", path.relative(ROOT, OUT));
console.log(JSON.stringify(N));
