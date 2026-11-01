// A stand-in for the Google Drive API, for offline tests only: the calls lib/drive.js makes (token
// refresh, list a folder, download with Range, create a folder, upload, replace), held in memory.
// strict: true copies the drive.file rule as this build expects Google to apply it: the app may add
// files only to folders it created itself, and may change only files it created.
//   node test/fake_drive.js --seed data/transcripts     (prints the port and folder id, then serves)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FOLDER = "application/vnd.google-apps.folder";
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

export class FakeDrive {
  constructor({ strict = true } = {}) { this.files = new Map(); this.n = 0; this.strict = strict; this.clock = Date.parse("2026-10-20T09:00:00Z"); this.calls = []; }
  id() { return `f${String(++this.n).padStart(4, "0")}x${crypto.randomBytes(3).toString("hex")}`; }
  tick() { this.clock += 60000; return new Date(this.clock).toISOString(); }
  add({ name, parent, content = null, mimeType = content == null ? FOLDER : "text/plain", app = false }) {
    const f = { id: this.id(), name, parents: [parent], mimeType, content: content == null ? null : Buffer.from(content), modifiedTime: this.tick(), app };
    this.files.set(f.id, f); return f;
  }
  edit(id, content) { const f = this.files.get(id); f.content = Buffer.from(content); f.modifiedTime = this.tick(); }
  rename(id, name) { const f = this.files.get(id); f.name = name; f.modifiedTime = this.tick(); }
  find(name, parent) { return [...this.files.values()].find((f) => f.name === name && (!parent || f.parents.includes(parent))); }
  seed(dir) {
    const folder = this.add({ name: "Meeting tracker transcripts", parent: "root" });
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".txt")).sort()) this.add({ name: f, parent: folder.id, content: fs.readFileSync(path.join(dir, f)) });
    return folder.id;
  }
  view(f) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
      ...(f.content ? { md5Checksum: md5(f.content), size: String(f.content.length) } : {}) };
  }
  canAdd(parent) { return !this.strict || parent === "root" || this.files.get(parent)?.app; }

  listen() {
    const deny = (res) => { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: 403, message: "The user has not granted the app write access to the file.", errors: [{ reason: "appNotAuthorizedToFile" }] } })); };
    const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    this.server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, "http://x");
      this.calls.push(`${req.method} ${u.pathname}${u.searchParams.get("alt") === "media" ? " media" + (req.headers.range ? " " + req.headers.range : "") : ""}`);
      if (u.pathname === "/token") return json(res, 200, { access_token: "fake-access", expires_in: 3600 });
      if (!/^Bearer fake-access$/.test(req.headers.authorization || "")) return json(res, 401, { error: { code: 401, message: "no token" } });
      const m = /^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/.exec(u.pathname);
      if (!m) return json(res, 404, { error: { code: 404, message: "no route" } });
      const [, upload, id] = m;
      if (req.method === "GET" && !id) {
        const q = u.searchParams.get("q");
        const parent = /'([^']+)' in parents/.exec(q)[1];
        const mt = /mimeType = '([^']+)'/.exec(q)?.[1], nm = /name = '([^']+)'/.exec(q)?.[1];
        const files = [...this.files.values()].filter((f) => f.parents.includes(parent) && (!mt || f.mimeType === mt) && (!nm || f.name === nm)).map((f) => this.view(f));
        return json(res, 200, { files });
      }
      const f = id && this.files.get(id);
      if (id && !f) return json(res, 404, { error: { code: 404, message: "File not found" } });
      if (req.method === "GET" && u.searchParams.get("alt") === "media") {
        const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
        const out = r ? f.content.subarray(+r[1], +r[2] + 1) : f.content;
        res.writeHead(r ? 206 : 200, { "content-type": "text/plain" }); return res.end(out);
      }
      if (req.method === "GET") return json(res, 200, this.view(f));
      if (req.method === "POST" && !upload) {
        const meta = JSON.parse(body.toString());
        const parent = meta.parents?.[0] || "root";
        if (!this.canAdd(parent)) return deny(res);
        return json(res, 200, this.view(this.add({ name: meta.name, parent, app: true })));
      }
      if (req.method === "POST" && upload) {
        const boundary = /boundary=(\S+)/.exec(req.headers["content-type"])[1];
        const parts = body.toString("utf8").split(`--${boundary}`);
        const meta = JSON.parse(parts[1].split("\r\n\r\n")[1]);
        const content = parts[2].split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
        if (!this.canAdd(meta.parents[0])) return deny(res);
        return json(res, 200, this.view(this.add({ name: meta.name, parent: meta.parents[0], content, mimeType: meta.mimeType, app: true })));
      }
      if (req.method === "PATCH" && upload) {
        if (this.strict && !f.app) return deny(res);
        this.edit(id, body); return json(res, 200, this.view(f));
      }
      json(res, 400, { error: { code: 400, message: "unsupported" } });
    });
    return new Promise((r) => this.server.listen(0, "127.0.0.1", () => r(this.server.address().port)));
  }
  close() { this.server?.close(); }
}

// Writes a client and an expired token into a throwaway config folder, so the refresh path runs too.
export function fakeGoogleDir(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "client_secret.json"), JSON.stringify({ installed: { client_id: "fake.apps.googleusercontent.com", client_secret: "fake", token_uri: `http://127.0.0.1:${port}/token` } }));
  fs.writeFileSync(path.join(dir, "token.json"), JSON.stringify({ refresh_token: "fake-refresh", access_token: "old", expiry: 0 }));
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const i = process.argv.indexOf("--seed");
  const d = new FakeDrive({ strict: !process.argv.includes("--loose") });
  const folder = d.seed(process.argv[i + 1]);
  const port = await d.listen();
  console.log(JSON.stringify({ port, folder }));
}
