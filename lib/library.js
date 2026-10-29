// Rung 4: the library index and the "does this exist" search.
//   loadIndex(file)                reads library/index.json
//   search(index, request)         scores every entry against a request and returns a verdict:
//                                    MATCH    one entry clearly fits; returned with its limits and tested_on
//                                    POSSIBLE two or more entries fit about equally; the model asks which
//                                    NEW      nothing fits; the brief to fill is returned instead
//   brief(request, template, matches)  the brief with "has it been done before" already answered
//   renderIndexMd(index)           INDEX.md, one line per entry: use case, inputs, output, tested on
// The search is plain word overlap, in code, so the "has it been done before" step runs the same way
// every time and never from the model's memory of what the library holds. No model is called here.
import fs from "node:fs";

const STOP = new Set(("a an the and or of to for in on at by with from into as is are was were be been it its this that these " +
  "those we our us you your they their them i me my he she his her do does did done have has had can could should would will no not still yes really like lot " +
  "need needs needed want wants wanted some any all each every one two three please help me get make take put keep use using " +
  "so if then than when where which who what how about up out over under also just only very more most much many new " +
  "there here now next week month year day today after before").split(/\s+/));

const SYNONYMS = {
  summarize: "summarise", summarising: "summarise", summarizing: "summarise", summary: "summarise", summaries: "summarise",
  spreadsheets: "spreadsheet", xlsx: "excel", workbook: "excel", workbooks: "excel", sheets: "spreadsheet",
  resumes: "cv", resume: "cv", cvs: "cv", candidates: "cv", candidate: "cv",
  automating: "automate", automated: "automate", automation: "automate",
  repeated: "repeat", repeating: "repeat", recurring: "repeat", again: "repeat",
  models: "model", tiers: "tier", cheapest: "cheaper", cheap: "cheaper", costs: "cost",
  transcripts: "transcript", meetings: "meeting", actions: "action", owners: "owner",
  practise: "practice", practising: "practice", practicing: "practice", drills: "drill",
  mapping: "map", maps: "map", mapped: "map", columns: "column", headers: "header",
  processes: "process", steps: "step", requests: "request", prompts: "prompt", briefs: "brief",
};

export function tokens(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => SYNONYMS[w] || (w.length > 4 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .map((w) => SYNONYMS[w] || w);
}

// Phrases in the request that match a keyword phrase whole count more than single words.
function phraseHits(request, phrases) {
  const r = " " + tokens(request).join(" ") + " ";
  let hits = 0;
  for (const p of phrases) {
    const t = tokens(p).join(" ");
    if (t && t.includes(" ") && r.includes(" " + t + " ")) hits++;
  }
  return hits;
}

const WEIGHTS = { name: 3, keywords: 2, use_it_when: 1.5, scenario: 1.5, inputs: 1, output: 1 };

export function score(entry, request) {
  const req = new Set(tokens(request));
  if (!req.size) return { total: 0, matched: [] };
  let total = 0; const matched = new Set();
  for (const [field, w] of Object.entries(WEIGHTS)) {
    const text = Array.isArray(entry[field]) ? entry[field].join(" ") : entry[field];
    for (const t of new Set(tokens(text))) if (req.has(t)) { total += w; matched.add(t); }
  }
  total += 3 * phraseHits(request, entry.keywords || []);
  return { total: Math.round(total * 10) / 10, matched: [...matched] };
}

export function loadIndex(file) {
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(index.entries)) throw new Error("index.json has no entries");
  return index;
}

const MATCH_FLOOR = 6;     // below this the request is new
const MIN_WORDS = 2;       // one shared word is never a match
const CLEAR_LEAD = 1.5;    // the top entry must lead the second by this factor to be the one match

export function search(index, request) {
  const scored = index.entries.map((e) => ({ entry: e, ...score(e, request) }))
    .filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
  const fits = (s) => s.total >= MATCH_FLOOR && s.matched.length >= MIN_WORDS;
  const top = scored[0], second = scored[1];
  const card = (s) => ({
    id: s.entry.id, name: s.entry.name, kind: s.entry.kind, version: s.entry.version, status: s.entry.status,
    use_it_when: s.entry.use_it_when, scenario: s.entry.scenario, inputs: s.entry.inputs, output: s.entry.output,
    limits: s.entry.limits, tested_on: s.entry.tested_on, where: s.entry.where, score: s.total, matched_on: s.matched,
  });
  if (!top || !fits(top)) {
    return { verdict: "NEW", request, matches: scored.slice(0, 2).map(card),
      next: "Nothing in the library covers this. Fill the brief (library_brief); each blank field is a question for the requester." };
  }
  if (second && fits(second) && top.total < second.total * CLEAR_LEAD) {
    const close = scored.filter((s) => fits(s) && s.total >= top.total / CLEAR_LEAD).map(card);
    return { verdict: "POSSIBLE", request, matches: close,
      next: `${close.length} entries fit about equally. Put them to the requester with each one's use_it_when line and ask which, or whether the request is two things. Do not pick (Gate 1).` };
  }
  return { verdict: "MATCH", request, matches: [card(top)], also: scored.slice(1, 3).filter((s) => s.total >= MATCH_FLOOR / 2).map((s) => ({ name: s.entry.name, score: s.total })),
    next: "Read the match's limits against the request. Inside the limits: reuse it and stop. Outside: Gate 2, ask whether to extend the entry or write a new brief." };
}

export function renderIndexMd(index) {
  const lines = [];
  lines.push(`# ${index.name}`, "");
  lines.push(`Version ${index.version}, ${index.updated}. Owner: ${index.owner}. Rendered from \`library/index.json\`; edit that file and run \`node library/search.js --md\`.`, "");
  lines.push("Before anything is built, the request is searched against this index (`library_search`, or `node library/search.js \"<request>\"`). A match is reused inside its limits; anything else gets a brief first.", "");
  lines.push("| # | Name | Use it when | Inputs | Output | Tested on | Status |", "|---|---|---|---|---|---|---|");
  for (const e of index.entries) {
    lines.push(`| ${e.number} | **${e.name}** (${e.version}) | ${e.use_it_when} | ${e.inputs} | ${e.output} | ${e.tested_on} | ${e.status} |`);
  }
  lines.push("", "## Limits, entry by entry", "");
  for (const e of index.entries) lines.push(`- **${e.name}:** ${e.limits} Where: ${e.where}.`);
  lines.push("", "Synthetic data only throughout. Nothing here is described as deployed; a tested-on line says only what was observed and names any miss.");
  return lines.join("\n") + "\n";
}

export function brief(request, template, matches = [], verdict = "NEW") {
  let done;
  if (verdict === "MATCH" && matches[0]) done = `Yes: ${matches[0].name} (${matches[0].version}). Limits: ${matches[0].limits}. If the request sits inside them, stop here and reuse it.`;
  else if (verdict === "POSSIBLE") done = `Possibly: ${matches.map((m) => m.name).join(" or ")}. Ask the requester which before anything else.`;
  else done = matches.length ? `No. Nearest entries, none a fit: ${matches.map((m) => m.name).join(", ")}.` : "No. Nothing in the library is near it.";
  return template.replace("{{request}}", request.trim() || "(not stated)").replace("{{done_before}}", done);
}
