// The feeder. The eight transcript files sit in transcripts/ from the start, empty; feeding one writes
// its text from the repo into its slot, and the cycle's reset empties every slot again. Nothing is
// created or deleted, so a service account can do it. Only the eight synthetic transcripts from the
// repo ever go in: a slot's text always comes from repoDir, never from a request.
import fs from "node:fs";
import path from "node:path";

const isEmpty = (f) => f.size != null && Number(f.size) === 0;

export function repoTranscripts(repoDir) {
  return fs.readdirSync(repoDir).filter((f) => f.endsWith(".txt")).sort();
}

async function slots(drive, folderId, repoDir) {
  const listed = await drive.list(folderId);
  const names = repoTranscripts(repoDir);
  const out = names.map((name) => {
    const hits = listed.filter((f) => f.name === name);
    if (hits.length !== 1) throw new Error(`transcripts/ should hold exactly one ${name} (found ${hits.length}); make-folder.js makes the eight slots`);
    return { name, file: hits[0], empty: isEmpty(hits[0]) };
  });
  return out;
}

// due: fill every empty slot among the first `upTo` (a missed day catches up). next: the first empty slot.
export async function feed(drive, folderId, repoDir, { upTo = 0, next = false } = {}) {
  const all = await slots(drive, folderId, repoDir);
  const targets = next ? all.filter((s) => s.empty).slice(0, 1) : all.slice(0, upTo).filter((s) => s.empty);
  for (const s of targets) await drive.update(s.file.id, fs.readFileSync(path.join(repoDir, s.name)), "text/plain");
  return targets.map((s) => s.name);
}

export async function emptyAll(drive, folderId, repoDir) {
  const all = await slots(drive, folderId, repoDir);
  const full = all.filter((s) => !s.empty);
  for (const s of full) await drive.update(s.file.id, Buffer.alloc(0), "text/plain");
  return full.map((s) => s.name);
}

// What lib/source.js sees: the same Drive, with the empty slots left out of every listing, so a slot not
// yet fed is never fetched, flagged or read.
export function hideEmpty(drive) {
  return {
    list: async (folderId, q) => (await drive.list(folderId, q)).filter((f) => !isEmpty(f)),
    download: (id, max) => drive.download(id, max),
    createFolder: () => { throw new Error("the hosted runner creates nothing in Drive"); },
    upload: () => { throw new Error("the hosted runner releases the board through the folder save"); },
  };
}
