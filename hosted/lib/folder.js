// The Drive folder's fixed layout and the two moves the runner makes on it: pull the state into the run's
// temp folder, and save it back. Every file exists before the first run (hosted/scripts/make-folder.js
// makes them, so heartgold owns them) and is only ever updated in place: a service account cannot
// create a file in a personal My Drive.
//
//   transcripts/  the eight slots, empty until fed (lib/feeder.js)
//   tracker/      tracker.csv  run_log.csv  held.json  answers.json  summary.md
//   released/     board.html
//
// A save sets mt:pushing before its first write and clears it only after run_log.csv, which goes last.
// tracker.csv goes first, so an answer can be marked applied in answers.json only once the rows it
// produced are saved. A save that stops anywhere in between leaves the flag, and the next run stops on it.
import fs from "node:fs";
import path from "node:path";
import { TRACKER_COLS, LOG_COLS } from "../core/lib/store.js";
import { K } from "./kv.js";

export const SAVE_ORDER = ["tracker.csv", "held.json", "answers.json", "summary.md", "board.html", "run_log.csv"];
const WHERE = { "tracker.csv": "tracker", "run_log.csv": "tracker", "held.json": "tracker", "answers.json": "tracker", "summary.md": "tracker", "board.html": "released" };
const MIME = { csv: "text/csv", json: "application/json", md: "text/markdown", html: "text/html" };
const mimeOf = (name) => MIME[name.split(".").pop()];

export const EMPTY_BOARD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Action board</title></head>
<body><p>No run yet in this cycle. The board appears here after the first run.</p></body></html>
`;
export function emptyForm(name) {
  return {
    "tracker.csv": TRACKER_COLS.join(",") + "\r\n",
    "run_log.csv": LOG_COLS.join(",") + "\r\n",
    "held.json": "[]\n",
    "answers.json": "[]\n",
    "summary.md": "",
    "board.html": EMPTY_BOARD,
  }[name];
}

export class Folder {
  // ids: { transcripts, tracker, released }, the subfolder ids make-folder.js printed
  constructor(drive, ids) {
    for (const k of ["transcripts", "tracker", "released"]) if (!ids[k]) throw new Error(`no Drive folder id for ${k}/`);
    this.drive = drive; this.ids = ids; this.meta = null;
  }

  async files() {
    if (this.meta) return this.meta;
    const meta = {};
    for (const where of ["tracker", "released"]) {
      for (const f of await this.drive.list(this.ids[where])) meta[f.name] = { ...f, where };
    }
    const missing = SAVE_ORDER.filter((n) => !meta[n] || meta[n].where !== WHERE[n]);
    if (missing.length) throw new Error(`the folder is missing ${missing.map((n) => `${WHERE[n]}/${n}`).join(", ")}; make-folder.js makes them once`);
    return (this.meta = meta);
  }

  async read(name) {
    return (await this.drive.download((await this.files())[name].id)).toString("utf8");
  }

  // The state files into dir, laid out the way lib/store.js expects. Returns the saved answers.
  async pull(dir) {
    const text = {};
    for (const n of ["tracker.csv", "run_log.csv", "held.json", "answers.json"]) text[n] = await this.read(n);
    fs.writeFileSync(path.join(dir, "tracker.csv"), text["tracker.csv"] || emptyForm("tracker.csv"));
    fs.writeFileSync(path.join(dir, "run_log.csv"), text["run_log.csv"] || emptyForm("run_log.csv"));
    fs.mkdirSync(path.join(dir, "held"), { recursive: true });
    for (const h of JSON.parse(text["held.json"] || "[]")) {
      fs.writeFileSync(path.join(dir, "held", h.transcript.replace(/\.txt$/, ".json")), JSON.stringify(h, null, 2));
    }
    return JSON.parse(text["answers.json"] || "[]");
  }

  // parts: { "tracker.csv": text, ... }; only the files given are written, always in SAVE_ORDER.
  async save(parts, kv, runId) {
    const names = SAVE_ORDER.filter((n) => parts[n] != null);
    if (!names.length) return [];
    const meta = await this.files();
    await kv.set(K.pushing, runId);
    for (const n of names) await this.drive.update(meta[n].id, Buffer.from(parts[n]), mimeOf(n));
    // a run's save always ends with run_log.csv; an answer saved on /held is a one-file save
    await kv.del(K.pushing);
    return names;
  }
}

// What a run saves, read from its temp folder after the store has written it.
export function partsFrom(dir, store, answers, { runId, board = true } = {}) {
  const held = store.getHeld().sort((a, b) => a.transcript.localeCompare(b.transcript));
  const parts = {
    "tracker.csv": fs.readFileSync(path.join(dir, "tracker.csv"), "utf8"),
    "held.json": JSON.stringify(held, null, 2) + "\n",
    "answers.json": JSON.stringify(answers, null, 2) + "\n",
    "run_log.csv": fs.readFileSync(path.join(dir, "run_log.csv"), "utf8"),
  };
  const summary = path.join(dir, `summary_${runId}.md`), boardFile = path.join(dir, `board_${runId}.html`);
  if (fs.existsSync(summary)) parts["summary.md"] = fs.readFileSync(summary, "utf8");
  if (board && fs.existsSync(boardFile)) parts["board.html"] = fs.readFileSync(boardFile, "utf8");
  return parts;
}
