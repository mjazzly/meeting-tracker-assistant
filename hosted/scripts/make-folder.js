#!/usr/bin/env node
// Makes the hosted tracker's Drive folder once, with Megat's own desktop sign-in (lib/drive.js), so
// heartgold owns every file: a service account cannot create files in a personal My Drive, only update
// the ones that exist. Run from Terminal in the server folder:
//   node hosted/scripts/make-folder.js --check-sign-in   (read only: does the desktop sign-in still refresh?)
//   node hosted/scripts/make-folder.js                   (makes the folder, prints the four folder ids)
// It makes:
//   Meeting tracker/
//     transcripts/  the eight transcript files from data/transcripts, empty (the service fills them)
//     tracker/      tracker.csv  run_log.csv  held.json  answers.json  summary.md, in their empty forms
//     released/     board.html, a placeholder
// It shares nothing. Sharing with the service account, and later with anyone who has the link, is done
// by hand in Drive, one step at a time (hosted/DESIGN.md, "Step 3, in order").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME = { csv: "text/csv", json: "application/json", md: "text/markdown", html: "text/html", txt: "text/plain" };
const TRACKER_FILES = ["tracker.csv", "run_log.csv", "held.json", "answers.json", "summary.md"];

export async function makeFolder(drive, repoDir, emptyForm, name = "Meeting tracker") {
  const top = await drive.createFolder(name);
  const ids = { folder: top.id };
  for (const sub of ["transcripts", "tracker", "released"]) ids[sub] = (await drive.createFolder(sub, top.id)).id;
  const put = (n, parent, content) => drive.upload({ name: n, parentId: parent, content: Buffer.from(content), mimeType: MIME[n.split(".").pop()] });
  for (const t of fs.readdirSync(repoDir).filter((f) => f.endsWith(".txt")).sort()) await put(t, ids.transcripts, "");
  for (const n of TRACKER_FILES) await put(n, ids.tracker, emptyForm(n));
  await put("board.html", ids.released, emptyForm("board.html"));
  return ids;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..", "..");
  const { Drive } = await import(path.join(root, "lib", "drive.js"));
  const drive = new Drive();
  try {
    await drive.accessToken();
  } catch (e) {
    console.error(`The desktop Drive sign-in does not work: ${e.message}`);
    console.error("Run this first, then try again:  node server.mjs --auth");
    process.exit(1);
  }
  if (process.argv.includes("--check-sign-in")) { console.log("The desktop Drive sign-in works. Nothing was changed."); process.exit(0); }
  await import(path.join(root, "hosted", "scripts", "copy-core.js"));   // folder.js reads the store's columns from hosted/core
  const { emptyForm } = await import(path.join(root, "hosted", "lib", "folder.js"));
  const ids = await makeFolder(drive, path.join(root, "data", "transcripts"), emptyForm);
  console.log("Made. These are folder ids, not secrets; each goes into Vercel as a setting:\n");
  console.log(`DRIVE_FOLDER_ID=${ids.folder}\nDRIVE_TRANSCRIPTS_ID=${ids.transcripts}\nDRIVE_TRACKER_ID=${ids.tracker}\nDRIVE_RELEASED_ID=${ids.released}`);
}
