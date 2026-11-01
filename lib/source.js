// The Drive source adapter. It copies transcripts from one Google Drive folder into the run's own
// transcripts folder, then lib/store.js reads them exactly as it reads the local folder, so the four
// gates run unchanged. Everything it does is written to the run log (step "source"):
//   fetched      a new transcript copied in, with its Drive file id, modified time and md5
//   header only  a transcript whose header says confidential: only the header lines are kept;
//                the body is never written to disk and never reaches the model
//   read         tracker_read_transcript fetched the file again by its file id and its md5 matched
//   flagged      something the tracker will not resolve on its own (an edit, a rename, a second file
//                with the same name, a file that is not plain text); a note carries it to the summary
//   released     the action board written back to the released/ subfolder
// A transcript is identified by its Drive file id, so a file is never read twice: an edited file
// (same id, new content) is flagged, never quietly read again.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FOLDER_MIME } from "./drive.js";

const HEAD_BYTES = 2048;
const DETAIL_RE = /file id (\S+); modified (\S+); md5 (\w+)/;
const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");
const isTerminator = (line) => line.trim() === "" || line.trim().startsWith("[");

export class DriveSource {
  constructor(store, drive, folderId) {
    if (!folderId) throw new Error("No Drive folder id. Pass --folder <id> or set TRACKER_DRIVE_FOLDER.");
    this.store = store; this.drive = drive; this.folder = folderId;
  }

  // What the log says each transcript is: the latest fetched or header-only row per file.
  recorded() {
    const byName = new Map(), byId = new Map();
    for (const r of this.store.log()) {
      if (r.step !== "source" || !["fetched", "header only"].includes(r.result)) continue;
      const m = DETAIL_RE.exec(r.detail);
      if (!m) continue;
      const rec = { name: r.transcript, id: m[1], modified: m[2], md5: m[3], headerOnly: r.result === "header only" };
      byName.set(rec.name, rec); byId.set(rec.id, rec);
    }
    return { byName, byId };
  }

  flagOnce(run, transcript, key, message) {
    if (this.store.log().some((r) => r.step === "source" && r.result === "flagged" && r.detail.startsWith(`key ${key};`))) return null;
    this.store.writeLog(run, transcript, "source", "flagged", `key ${key}; ${message}`);
    this.store.writeLog(run, transcript, "note", "note", `Drive: ${message}`);
    return message;
  }

  cachePath(name) { return path.join(this.store.transcripts, name); }

  async fetch(run, f) {
    const head = await this.drive.download(f.id, HEAD_BYTES);
    const lines = head.toString("utf8").split(/\r?\n/);
    const end = lines.findIndex(isTerminator);
    if (end >= 0) {
      // write the header block only, then let the store's own header check decide (Gate 4 stays in store.js)
      fs.writeFileSync(this.cachePath(f.name), lines.slice(0, end).join("\n") + "\n");
      if (this.store.header(f.name).confidential) {
        this.store.writeLog(run, f.name, "source", "header only", `file id ${f.id}; modified ${f.modifiedTime}; md5 ${f.md5Checksum}; header marks it confidential, body not written or read`);
        return "header only";
      }
    }
    const whole = f.size != null && head.length >= Number(f.size);
    const buf = whole ? head : await this.drive.download(f.id);
    const sum = md5(buf);
    if (f.md5Checksum && sum !== f.md5Checksum) throw new Error(`${f.name}: downloaded content does not match Drive's md5 (edited mid-download?); scan again`);
    fs.writeFileSync(this.cachePath(f.name), buf);
    this.store.writeLog(run, f.name, "source", "fetched", `file id ${f.id}; modified ${f.modifiedTime}; md5 ${sum}`);
    return "fetched";
  }

  // Before tracker_scan: bring every new transcript in the folder into the run's transcripts folder.
  async sync(run) {
    const files = (await this.drive.list(this.folder)).filter((f) => f.mimeType !== FOLDER_MIME);
    const { byName, byId } = this.recorded();
    const done = this.store.processed();
    const out = { folder: this.folder, listed: files.length, fetched: [], header_only: [], flagged: [] };
    const flag = (t, key, msg) => { const m = this.flagOnce(run, t, key, msg); if (m) out.flagged.push(m); };

    const groups = new Map();
    for (const f of files) {
      const plain = f.name.endsWith(".txt") && !f.mimeType.startsWith("application/vnd.google-apps");
      const safe = path.basename(f.name) === f.name && !f.name.startsWith(".");
      if (!plain || !safe) {
        flag("", `skipped ${f.id}`, `${f.name} was not read: only plain .txt transcripts are read (this file is ${f.mimeType}${safe ? "" : ", and its name is not a plain file name"}).`);
        continue;
      }
      if (!groups.has(f.name)) groups.set(f.name, []);
      groups.get(f.name).push(f);
    }

    for (const [name, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      if (group.length > 1) {
        const known = group.filter((f) => byId.has(f.id));
        for (const f of group.filter((g) => !byId.has(g.id))) {
          flag(name, `duplicate ${f.id}`, `a second file named ${name} is in the folder (file id ${f.id}). It was not read; the tracker knows transcripts by name, so rename one of them.`);
        }
        if (!known.length) continue;
      }
      for (const f of group.filter((g) => group.length === 1 || byId.has(g.id))) {
        const rec = byId.get(f.id);
        if (rec && rec.name !== name) {
          flag(name, `renamed ${f.id} ${name}`, `${rec.name} was renamed in Drive to ${name}. It is the same file (id ${f.id}), so it was not read again.`);
        } else if (rec && f.md5Checksum && rec.md5 !== f.md5Checksum) {
          if (done.has(name)) {
            flag(name, `edited ${f.id} ${f.md5Checksum}`, `${name} was edited in Drive after it was processed (modified ${f.modifiedTime}; the version read was modified ${rec.modified}). It was not read again; the tracker keeps the rows from the version it read.`);
          } else {
            out[await this.fetch(run, f) === "fetched" ? "fetched" : "header_only"].push(name);
            this.store.writeLog(run, name, "note", "note", `Drive: ${name} was edited before it was processed; the newer version (modified ${f.modifiedTime}) is the one read.`);
          }
        } else if (!rec && byName.has(name)) {
          if (done.has(name)) {
            flag(name, `replaced ${f.id}`, `${name} in Drive is now a different file (id ${f.id}; the one processed was ${byName.get(name).id}). It was not read; rename it if it is a new meeting.`);
          } else {
            out[await this.fetch(run, f) === "fetched" ? "fetched" : "header_only"].push(name);
          }
        } else if (!rec) {
          out[await this.fetch(run, f) === "fetched" ? "fetched" : "header_only"].push(name);
        }
      }
    }
    return out;
  }

  // Before tracker_read_transcript: fetch the transcript again by its file id. If the content no longer
  // matches what the scan recorded, the edit is flagged and the store reads the version scanned.
  async read(name, run) {
    const rec = this.recorded().byName.get(name);
    if (!rec || rec.headerOnly || this.store.header(name).confidential) return; // the store declines or errors as it does locally
    const buf = await this.drive.download(rec.id);
    const sum = md5(buf);
    if (sum !== rec.md5) {
      this.flagOnce(run, name, `edited ${rec.id} ${sum}`, `${name} was edited in Drive after this run's scan. The version scanned (md5 ${rec.md5}) is the one read; scan again in a later run to see the change flagged.`);
      return;
    }
    fs.writeFileSync(this.cachePath(name), buf);
    this.store.writeLog(run, name, "source", "read", `file id ${rec.id}; md5 ${sum}; fetched by file id, matches the scan`);
  }

  // After tracker_summary: write the board to released/ inside the transcripts folder.
  async release(boardPath, run) {
    const base = path.basename(boardPath);
    const folderQ = ` and mimeType = '${FOLDER_MIME}' and name = 'released'`;
    let where = "inside the transcripts folder";
    let rel = (await this.drive.list(this.folder, folderQ))[0];
    if (!rel) {
      try {
        rel = await this.drive.createFolder("released", this.folder);
      } catch (e) {
        if (e.status !== 403) throw e;
        // if Drive refuses to add a folder here under drive.file, fall back to My Drive and say so
        rel = (await this.drive.list("root", folderQ))[0] || await this.drive.createFolder("released");
        where = "in My Drive, outside the transcripts folder";
        this.flagOnce(run, "", `released-root ${rel.id}`, "the released/ folder was created in My Drive because Drive refused to add it to the transcripts folder under the drive.file scope. Drag it into the transcripts folder once; boards go there from then on.");
      }
    }
    const existing = (await this.drive.list(rel.id, ` and name = '${base}'`))[0];
    let file;
    try {
      file = await this.drive.upload({ name: base, parentId: rel.id, content: fs.readFileSync(boardPath), mimeType: "text/html", replaceId: existing?.id });
    } catch (e) {
      if (e.status !== 403) throw e;
      throw new Error("The tracker cannot write into this released/ folder because it did not create it (the drive.file scope reaches only its own files). Rename or delete that folder in Drive and run the summary again; the tracker will make its own.");
    }
    this.store.writeLog(run, "", "source", "released", `${base}; file id ${file.id}; folder released (id ${rel.id}), ${where}`);
    return { name: base, file_id: file.id, folder_id: rel.id, where, replaced: !!existing };
  }
}
