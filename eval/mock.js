// A scripted stand-in for the model, used only to test the harness itself (--mock). It replays the
// fixed rows in test/fixture_rows.json through the same tools in the same order a careful run would.
// It proves the plumbing (tool calls, gates, answers, checker, page); it says nothing about a model.
// Mock runs are never written to eval/results or the exemplar page.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.basename(here) === "eval" ? path.dirname(here) : here;

export class MockModel {
  constructor() {
    this.rows = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixture_rows.json"), "utf8"));
    this.phase1 = null; this.phase2 = null; this.n = 0;
  }
  plan1(run) {
    const R = this.rows, s = [];
    s.push(["tracker_scan", { run_id: run }]);
    for (const t of ["01_halden_kickoff.txt", "02_meridian_pricing.txt", "03_northgate_claims.txt", "04_halden_finance.txt"]) {
      s.push(["tracker_read_transcript", { transcript: t, run_id: run }]);
      s.push(["tracker_append", { transcript: t, rows: R[t], run_id: run }]);
    }
    s.push(["tracker_read_transcript", { transcript: "05_meridian_update.txt", run_id: run }]);
    s.push(["tracker_close", { action_id: "A005", transcript: "05_meridian_update.txt", source_line: 1, run_id: run }]);
    s.push(["tracker_append", { transcript: "05_meridian_update.txt", rows: [], run_id: run }]);
    s.push(["tracker_read_transcript", { transcript: "07_halden_followup.txt", run_id: run }]);
    s.push(["tracker_close", { action_id: "A001", transcript: "07_halden_followup.txt", source_line: 2, run_id: run }]);
    s.push(["tracker_append", { transcript: "07_halden_followup.txt", rows: R["07_halden_followup.txt"], run_id: run }]);
    s.push(["tracker_read_transcript", { transcript: "08_meridian_contracts.txt", run_id: run }]);
    s.push(["tracker_append", { transcript: "08_meridian_contracts.txt", rows: R["08_meridian_contracts.txt"], run_id: run }]);
    s.push(["tracker_summary", { run_id: run }]);
    return s;
  }
  plan2(run) {
    const R = this.rows;
    const r4 = R["04_halden_finance.txt"].map((r) => (r.owner === "Priya Nair" ? { ...r, owner_company: "Halden Logistics" } : r));
    return [
      ["tracker_append", { transcript: "04_halden_finance.txt", rows: r4, run_id: run }],
      ["tracker_append", { transcript: "05_meridian_update.txt", rows: [], run_id: run, confirmed_empty: true }],
      ["tracker_append", { transcript: "08_meridian_contracts.txt", rows: R["08_meridian_contracts.txt"], run_id: run, accept_overdue: true }],
      ["tracker_summary", { run_id: run }],
    ];
  }
  async create(req) {
    const first = req.messages[0].content;
    const run = (/run id (\S+?)\.?$/.exec(first) || [])[1];
    const last = req.messages[req.messages.length - 1];
    const inPhase2 = req.messages.some((m, i) => i > 0 && m.role === "user" && typeof m.content === "string");
    if (!this.phase1) this.phase1 = this.plan1(run);
    if (inPhase2 && !this.phase2) this.phase2 = this.plan2(run);
    const queue = inPhase2 ? this.phase2 : this.phase1;
    if (!queue.length || (typeof last.content === "string" && !inPhase2 && last !== req.messages[0])) {
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Mock run finished this phase." }], usage: null };
    }
    const [name, input] = queue.shift();
    return { stop_reason: "tool_use", usage: null,
      content: [{ type: "tool_use", id: `mock_${++this.n}`, name, input }] };
  }
}
