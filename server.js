#!/usr/bin/env node
// Meeting Tracker tool server (rung 2). Runs on the owner's machine; the Claude desktop app
// starts it and the model calls its tools. State lives in TRACKER_DATA (default ./data next to
// this file), so nothing is carried between sessions by hand. The four gates are enforced in
// lib/store.js; a gate stop comes back as a normal result with stop and question fields, so the
// model reads the question and asks it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./lib/store.js";
import { makeServer } from "./lib/tools.js";
import { Drive, authorize } from "./lib/drive.js";
import { DriveSource } from "./lib/source.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Where the transcripts come from: --source local (the default, the transcripts folder on disk) or
// --source drive (a Google Drive folder, read through the Drive API; lib/source.js copies each new
// file into the run's transcripts folder and lib/store.js reads it there, so the gates are the same).
// One-time Google sign-in, from Terminal: node server.mjs --auth
const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
if (argv.includes("--auth")) { await authorize(); process.exit(0); }
const SOURCE = argOf("source") || process.env.TRACKER_SOURCE || "local";
if (!["local", "drive"].includes(SOURCE)) { console.error(`--source must be local or drive, not ${SOURCE}`); process.exit(2); }
// Drive state is kept apart from local state: a shared run log would mark every transcript as done.
const dataDir = process.env.TRACKER_DATA || path.join(here, SOURCE === "drive" ? "data-drive" : "data");
if (SOURCE === "drive" && !fs.existsSync(path.join(dataDir, "contacts.csv"))) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(path.join(here, "data", "contacts.csv"), path.join(dataDir, "contacts.csv"));
}
const store = new Store(dataDir);
const drive = SOURCE === "drive" ? new DriveSource(store, new Drive(), argOf("folder") || process.env.TRACKER_DRIVE_FOLDER) : null;
const LIBRARY = process.env.TRACKER_LIBRARY || path.join(here, "library");

// The tools themselves are in lib/tools.js, shared with the hosted runner.
const server = makeServer({ store, drive, library: LIBRARY });
await server.connect(new StdioServerTransport());
