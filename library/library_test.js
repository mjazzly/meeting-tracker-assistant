#!/usr/bin/env node
// Rung 4 test: runs the six cases in library/expected.json against the search and names every miss.
//   node library/library_test.js
// No model is called; this checks the index and the search, which are code. The skill that uses
// them is tested separately, in a chat, and its result goes in the skill's version log.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIndex, search } from "../lib/library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const index = loadIndex(path.join(here, "index.json"));
const { cases } = JSON.parse(fs.readFileSync(path.join(here, "expected.json"), "utf8"));

let passed = 0; const rows = [];
for (const c of cases) {
  const r = search(index, c.request);
  const names = r.matches.map((m) => m.name);
  const why = [];
  if (r.verdict !== c.verdict) why.push(`verdict ${r.verdict}, expected ${c.verdict}`);
  if (c.verdict !== "NEW") {
    for (const n of c.names) if (!names.includes(n)) why.push(`missing ${n}`);
    if (c.verdict === "MATCH" && names.length && names[0] !== c.names[0]) why.push(`top match ${names[0]}`);
    if (c.verdict === "POSSIBLE") for (const n of names) if (!c.names.includes(n)) why.push(`extra ${n}`);
  }
  for (const phrase of c.limits_must_name || []) {
    const lim = (r.matches[0] && r.matches[0].limits || "").toLowerCase();
    if (!lim.includes(phrase)) why.push(`limits do not name "${phrase}"`);
  }
  const ok = why.length === 0; if (ok) passed++;
  rows.push({ case: c.case, result: ok ? "Match" : "Miss", got: `${r.verdict}: ${names.join(", ") || "none"}`, why: why.join("; ") });
}

// Every entry must carry the fields the index promises; a blank tested_on is a miss of its own.
const fieldMiss = [];
for (const e of index.entries) for (const f of ["name", "use_it_when", "scenario", "inputs", "output", "limits", "tested_on", "status", "where"]) {
  if (!String(e[f] || "").trim()) fieldMiss.push(`${e.name}: ${f} is blank`);
}

const width = Math.max(...rows.map((r) => r.case.length));
for (const r of rows) console.log(`${r.result.padEnd(5)} ${r.case.padEnd(width)}  ${r.got}${r.why ? "  <- " + r.why : ""}`);
console.log(`\n${passed} of ${cases.length} cases matched. Index: ${index.entries.length} entries${fieldMiss.length ? ", " + fieldMiss.length + " blank fields: " + fieldMiss.join("; ") : ", every field filled"}.`);
process.exit(passed === cases.length && !fieldMiss.length ? 0 : 1);
