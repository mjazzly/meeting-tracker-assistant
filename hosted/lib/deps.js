// Builds what the routes need from the environment Vercel gives the function. Every value is a setting
// Megat made (hosted/DESIGN.md, "Secrets and settings"); none is written anywhere else. A preview
// deployment has none of them, so it can read nothing and run nothing.
import { upstash } from "./kv.js";

export async function depsFromEnv(env = process.env) {
  const kv = await upstash(env);
  let drive = null, model = null;
  if (env.GOOGLE_SA_KEY) {
    const { ServiceAccountDrive } = await import("../core/lib/drive-sa.js");
    drive = new ServiceAccountDrive(env.GOOGLE_SA_KEY);
  }
  if (env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60000 });
    model = { create: (req) => client.messages.create(req) };
  }
  return { env, kv, drive, model, cycleStart: env.CYCLE_START,
    ids: { transcripts: env.DRIVE_TRANSCRIPTS_ID, tracker: env.DRIVE_TRACKER_ID, released: env.DRIVE_RELEASED_ID } };
}

// Vercel's Node request and response, to the plain shape lib/app.js takes and back.
export function adapt(handler) {
  return async (req, res) => {
    let body = "";
    if (req.method === "POST") { for await (const c of req) body += c; }
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.headers["x-real-ip"] || "";
    let out;
    try {
      out = await handler(await depsFromEnv(), { method: req.method, url: req.url, headers: req.headers, body, ip });
    } catch (e) {
      out = { status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "failed", detail: String(e.message || e).slice(0, 200) }) };
    }
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    res.end(out.body);
  };
}
