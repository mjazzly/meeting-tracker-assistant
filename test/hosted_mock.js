// A scripted stand-in for the model, for the hosted runner's offline tests and the CI path's --mock only.
// Unlike eval/mock.js, which replays one fixed run of all eight, it reacts to what the tools return,
// so it works across the hosted runs of at most two transcripts each:
//   an opening that carries answers: tracker_held, then one call per held transcript the answers name
//   then tracker_scan, and for each new transcript: read, its closures, its append (fixed rows)
//   then tracker_summary, then end the turn.
// It proves the plumbing (in-memory tools, gates, the answer path, the save); it says nothing about a model.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROWS = JSON.parse(fs.readFileSync(path.join(here, "fixture_rows.json"), "utf8"));
const CLOSES = { "05_meridian_update.txt": [["A005", 1]], "07_halden_followup.txt": [["A001", 2]] };
// which held transcript an answer names: by file name (the /held form) or by its words (eval/answers.txt)
const NAMES = { "04_halden_finance.txt": /04_halden_finance|Priya Nair is Halden/i, "05_meridian_update.txt": /05_meridian_update|no actions/i,
  "08_meridian_contracts.txt": /08_meridian_contracts|as said/i };

export class HostedMock {
  // usage: the token counts each call reports; neverStop: keep calling a tool forever; onCall(req): a hook
  constructor({ usage = { input_tokens: 2000, output_tokens: 150 }, neverStop = false, onCall = null } = {}) {
    this.usage = usage; this.neverStop = neverStop; this.onCall = onCall;
    this.calls = 0; this.requests = []; this.queue = []; this.n = 0;
  }
  tool(name, input) {
    return { stop_reason: "tool_use", usage: this.usage, content: [{ type: "tool_use", id: `hm_${++this.n}`, name, input }] };
  }
  async create(req) {
    this.calls++; this.requests.push(JSON.stringify(req.messages));
    if (this.onCall) await this.onCall(req);
    const opening = req.messages[0].content;
    const run = /run id (\S+?)\./.exec(opening)[1];
    if (this.neverStop) return this.tool("tracker_read_tracker", {});
    if (req.messages.length === 1) {
      this.queue = [];
      return /Answers given since the last run/.test(opening) ? this.tool("tracker_held", {}) : this.tool("tracker_scan", { run_id: run });
    }
    const asked = req.messages[req.messages.length - 2].content.find((b) => b.type === "tool_use");
    const result = req.messages[req.messages.length - 1].content[0].content;
    if (asked.name === "tracker_held") {
      const answers = opening.split("\n").filter((l) => l.startsWith("- ")).join("\n");
      for (const h of JSON.parse(result)) {
        if (!NAMES[h.transcript]?.test(answers)) continue;
        if (h.transcript === "04_halden_finance.txt") this.queue.push(["tracker_append", { transcript: h.transcript, run_id: run,
          rows: h.rows.map((r) => (r.owner === "Priya Nair" ? { ...r, owner_company: "Halden Logistics" } : r)) }]);
        if (h.transcript === "05_meridian_update.txt") this.queue.push(["tracker_append", { transcript: h.transcript, rows: [], run_id: run, confirmed_empty: true }]);
        if (h.transcript === "08_meridian_contracts.txt") this.queue.push(["tracker_append", { transcript: h.transcript, rows: h.rows, run_id: run, accept_overdue: true }]);
      }
      this.queue.push(["tracker_scan", { run_id: run }]);
    } else if (asked.name === "tracker_scan") {
      for (const { transcript: t } of JSON.parse(result).new) {
        this.queue.push(["tracker_read_transcript", { transcript: t, run_id: run }]);
        for (const [id, line] of CLOSES[t] || []) this.queue.push(["tracker_close", { action_id: id, transcript: t, source_line: line, run_id: run }]);
        this.queue.push(["tracker_append", { transcript: t, rows: ROWS[t] || [], run_id: run }]);
      }
      this.queue.push(["tracker_summary", { run_id: run }]);
    }
    const next = this.queue.shift();
    if (!next) return { stop_reason: "end_turn", usage: this.usage, content: [{ type: "text", text: "Mock run finished." }] };
    return this.tool(...next);
  }
}
