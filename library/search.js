#!/usr/bin/env node
// Rung 4, the script route (Route B of the check-before-build skill), and the index renderer.
//
//   node library/search.js "<request>"          search the index; prints the verdict as JSON
//   node library/search.js --brief "<request>"  print the brief to fill, with "done before" answered
//   node library/search.js --md                 rewrite library/INDEX.md from library/index.json
//   node library/search.js --list               print the index, one line per entry
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIndex, search, brief, renderIndexMd } from "../lib/library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "index.json");
const TEMPLATE = path.join(here, "brief_template.md");
const argv = process.argv.slice(2);
const index = loadIndex(INDEX);

if (argv.includes("--md")) {
  const out = path.join(here, "INDEX.md");
  fs.writeFileSync(out, renderIndexMd(index));
  console.log("written:", out, `(${index.entries.length} entries)`);
} else if (argv.includes("--list")) {
  for (const e of index.entries) console.log(`${e.number}. ${e.name} (${e.version}, ${e.status}): ${e.use_it_when}`);
} else if (argv.includes("--brief")) {
  const request = argv.filter((a) => a !== "--brief").join(" ");
  const result = search(index, request);
  process.stdout.write(brief(request, fs.readFileSync(TEMPLATE, "utf8"), result.matches, result.verdict));
} else {
  const request = argv.join(" ").trim();
  if (!request) { console.error('usage: node library/search.js "<request>" | --brief "<request>" | --md | --list'); process.exit(2); }
  console.log(JSON.stringify(search(index, request), null, 2));
}
