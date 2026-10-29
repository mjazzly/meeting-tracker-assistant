#!/usr/bin/env node
// Meeting Tracker tool server (rung 2). Runs on the owner's machine; the Claude desktop app
// starts it and the model calls its tools. State lives in TRACKER_DATA (default ./data next to
// this file), so nothing is carried between sessions by hand. The four gates are enforced in
// lib/store.js; a gate stop comes back as a normal result with stop and question fields, so the
// model reads the question and asks it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, GateStop } from "./lib/store.js";
import { loadIndex, search, brief, renderIndexMd } from "./lib/library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Store(process.env.TRACKER_DATA || path.join(here, "data"));
const LIBRARY = process.env.TRACKER_LIBRARY || path.join(here, "library");
const libraryIndex = () => loadIndex(path.join(LIBRARY, "index.json"));

const server = new McpServer({ name: "meeting-tracker", version: "2.1.0" });

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof GateStop) return ok({ STOPPED_AT_GATE: true, ...e.payload });
      return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
    }
  };
}

const run_id = z.string().describe("Run id, R plus the date and a sequence number, for example R2026-10-25-1");
const rowSchema = z.object({
  action: z.string().describe("The action in the transcript's own words, under twenty words, pronouns replaced with the person meant"),
  owner: z.string().describe("The person named in the same sentence as the commitment, or 'not stated'"),
  due: z.string().describe("YYYY-MM-DD, the relative phrase when there is no meeting date, or 'not stated'"),
  due_note: z.string().optional().describe("The original date phrase and the meeting date used, or why it is not stated"),
  source_line: z.union([z.string(), z.number()]).describe("The [n] line number the action came from"),
  status: z.enum(["open", "confirm"]).optional().describe("open, or confirm when the date waits on a meeting date"),
  owner_company: z.string().optional().describe("Only when answering Gate 1: the company the user chose"),
  owner_role: z.string().optional(),
});

server.registerTool("tracker_scan", {
  title: "Scan for new transcripts",
  description: "Step 1. Lists every transcript not yet processed, with its meeting date and attendees. Declines any transcript whose header is marked confidential (Gate 4) and logs it; its body is never returned.",
  inputSchema: { run_id },
}, wrap(({ run_id }) => store.scan(run_id)));

server.registerTool("tracker_read_transcript", {
  title: "Read one transcript",
  description: "Step 2. Returns the full text of one transcript. Refuses a confidential one (Gate 4), so its body cannot be read even if the scan was skipped.",
  inputSchema: { transcript: z.string().describe("File name, for example 01_halden_kickoff.txt"), run_id },
}, wrap(({ transcript, run_id }) => store.readTranscript(transcript, run_id)));

server.registerTool("tracker_read_tracker", {
  title: "Read the tracker",
  description: "Returns the tracker rows, optionally filtered by status. Use it to find the action_id of an open action a transcript closes.",
  inputSchema: { status: z.enum(["open", "closed", "confirm"]).optional() },
}, wrap(({ status }) => store.tracker().filter((r) => !status || r.status === status)));

server.registerTool("tracker_close", {
  title: "Close an action",
  description: "Step 4, before any append. Sets one open action to closed because a line says it happened. Status change only; the row is kept.",
  inputSchema: { action_id: z.string(), transcript: z.string(), source_line: z.union([z.string(), z.number()]), run_id },
}, wrap((a) => store.close({ ...a, run: a.run_id })));

server.registerTool("tracker_lookup", {
  title: "Look up a person in the contacts table",
  description: "Step 5. Matches a name against the contacts table, which stands in for a CRM. Returns none, one or multiple matches. Multiple matches mean Gate 1, which tracker_append enforces.",
  inputSchema: { name: z.string(), transcript: z.string().optional(), run_id },
}, wrap(({ name, transcript, run_id }) => store.lookup(name, run_id, transcript || "")));

server.registerTool("tracker_append", {
  title: "Append actions for one transcript",
  description: "Step 6. Appends the extracted rows; never overwrites. Enforces Gate 1 (a name with two or more matches), Gate 2 (no actions) and Gate 3 (a due date before the meeting date). On a stop it holds the rows and returns STOPPED_AT_GATE with the question to ask. To answer: Gate 1, send the held rows with owner_company set; Gate 2, send an empty list with confirmed_empty true; Gate 3, send corrected rows or accept_overdue true.",
  inputSchema: {
    transcript: z.string(),
    rows: z.array(rowSchema),
    run_id,
    accept_overdue: z.boolean().optional().describe("Answer to Gate 3: record the date as it was said"),
    confirmed_empty: z.boolean().optional().describe("Answer to Gate 2: the user confirms there were no actions"),
  },
}, wrap((a) => store.append({ transcript: a.transcript, rows: a.rows, run: a.run_id,
  accept_overdue: !!a.accept_overdue, confirmed_empty: !!a.confirmed_empty })));

server.registerTool("tracker_held", {
  title: "Read held rows",
  description: "Returns the rows held at a gate, for one transcript or all, so an answer can be applied to them.",
  inputSchema: { transcript: z.string().optional() },
}, wrap(({ transcript }) => store.getHeld(transcript)));

server.registerTool("tracker_resolve_date", {
  title: "Fill a date once the meeting date is known",
  description: "For a row waiting on a meeting date (status confirm): writes the calendar date the model worked out from the phrase and the meeting date the user gave. Refuses a date before the meeting date.",
  inputSchema: { action_id: z.string(), due: z.string(), meeting_date: z.string(), run_id },
}, wrap((a) => store.resolveDate({ ...a, run: a.run_id })));

server.registerTool("tracker_note", {
  title: "Write a note to the run log",
  description: "Records a judgement worth keeping (why a line was read as not an action). Notes only; it cannot write a stop.",
  inputSchema: { run_id, transcript: z.string().optional(), detail: z.string() },
}, wrap(({ run_id, transcript, detail }) => store.note(run_id, transcript, detail)));

server.registerTool("tracker_summary", {
  title: "Write the run summary",
  description: "Step 8. Writes data/summary_<run_id>.md and the one-page action board data/board_<run_id>.html from the tracker and the log, and returns the summary text and the board's path. Tell the user where the board is; it is the page they read.",
  inputSchema: { run_id, as_of: z.string().optional().describe("Run date YYYY-MM-DD for the overdue section; default today") },
}, wrap(({ run_id, as_of }) => store.summary(run_id, as_of)));

// Rung 4: the library index and the "does this exist" search. The index lives in library/index.json
// (TRACKER_LIBRARY overrides the folder) and is edited only by the owner; these tools read it.
const request = z.string().describe("The request as the requester wrote it, not reworded");

server.registerTool("library_search", {
  title: "Search the library before building",
  description: "Step 1 of check-before-build. Searches the library index (the seven exemplars and the two assistants) for the request as written and returns a verdict: MATCH with the one entry and its limits and tested-on line; POSSIBLE with the entries that fit about equally, for the user to choose; or NEW, with the nearest entries named so the user can glance at them. The search is word overlap in code; the index is never searched from memory.",
  inputSchema: { request },
}, wrap(({ request }) => search(libraryIndex(), request)));

server.registerTool("library_brief", {
  title: "The brief to fill for a new request",
  description: "Step 2 of check-before-build when the search says NEW (or when the user wants the brief anyway). Returns the brief template with the request filled in and 'has it been done before' answered from the search. Every other field is left blank on purpose: each blank is a question for the requester, asked before any build.",
  inputSchema: { request },
}, wrap(({ request }) => {
  const result = search(libraryIndex(), request);
  return { verdict: result.verdict, brief: brief(request, fs.readFileSync(path.join(LIBRARY, "brief_template.md"), "utf8"), result.matches, result.verdict) };
}));

server.registerTool("library_index", {
  title: "Read the library index",
  description: "Returns the whole index as a table (INDEX.md): one line per entry with use it when, inputs, output, tested on and status, then the limits entry by entry. For when the user asks what the library holds. Read only; the index is edited by the owner.",
  inputSchema: {},
}, wrap(() => renderIndexMd(libraryIndex())));

await server.connect(new StdioServerTransport());
