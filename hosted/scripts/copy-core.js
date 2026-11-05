// Copies the build's own files into hosted/core before every build and every offline test, byte for
// byte, so the hosted service runs exactly the store, gates, tools, skill, transcripts and prices the
// harness tested, never a second copy someone edited. hosted/core is not committed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOSTED = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(HOSTED);
const CORE = path.join(HOSTED, "core");
const files = ["lib/store.js", "lib/render.js", "lib/source.js", "lib/drive.js", "lib/drive-sa.js", "lib/tools.js", "lib/library.js",
  "skill/SKILL.md", "data/contacts.csv", "eval/prices.json", "library/index.json", "library/brief_template.md",
  ...fs.readdirSync(path.join(REPO, "data", "transcripts")).filter((f) => f.endsWith(".txt")).sort().map((f) => `data/transcripts/${f}`)];

fs.rmSync(CORE, { recursive: true, force: true });
for (const f of files) {
  const from = path.join(REPO, f), to = path.join(CORE, f);
  if (!fs.existsSync(from)) { console.error(`copy-core: ${f} is missing from the repo`); process.exit(1); }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log(`copy-core: ${files.length} files copied into hosted/core`);
