// What the hosted tracker keeps in Upstash Redis (through Vercel's marketplace), and nothing else: the
// run lock, the unfinished-save flag, the kill switch, the month's counted spend, the cycle's reset
// mark, the failed-token counters, and the snapshot the public routes read. The tracker's own state
// lives in the Drive folder; the snapshot is rebuilt from it at the end of every run.
// If Redis cannot be reached nothing runs: a run without its lock never starts.
export const K = {
  lock: "mt:lock",                 // SET NX EX 600, holds the run id
  pushing: "mt:pushing",           // set before the first Drive write of a save, cleared after run_log.csv
  kill: "mt:kill",                 // "on" in the Upstash console stops every run before the feed
  monthCost: (m) => `mt:month:${m}:cost_micro`,
  reset: (cycleStart) => `mt:cycle:${cycleStart}:reset`,
  fails: (day, ip) => `mt:day:${day}:fails:${ip}`,
  runs: "mt:runs",                 // the last 60 run lines, newest first
  snapshot: "mt:snapshot",         // JSON for GET / and GET /api/state
  board: "mt:board",               // the board HTML as last released, for GET /board
};

// An in-memory stand-in with the same calls, for the offline tests and the CI path only.
export class MemoryKV {
  constructor() { this.m = new Map(); this.calls = []; }
  async get(k) { this.calls.push(`get ${k}`); return this.m.get(k) ?? null; }
  async set(k, v, o = {}) { this.calls.push(`set ${k}`); if (o.nx && this.m.has(k)) return null; this.m.set(k, String(v)); return "OK"; }
  async del(k) { this.calls.push(`del ${k}`); return this.m.delete(k) ? 1 : 0; }
  async incrby(k, n) { const v = (Number(this.m.get(k)) || 0) + n; this.m.set(k, String(v)); return v; }
  async incr(k) { return this.incrby(k, 1); }
  async expire() { return 1; }
  async lpush(k, ...vs) { const l = this.m.get(k) || []; l.unshift(...vs.reverse()); this.m.set(k, l); return l.length; }
  async ltrim(k, a, b) { const l = this.m.get(k) || []; this.m.set(k, l.slice(a, b + 1)); return "OK"; }
  async lrange(k, a, b) { const l = this.m.get(k) || []; return l.slice(a, b < 0 ? undefined : b + 1); }
}

export async function upstash(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const { Redis } = await import("@upstash/redis");
  return new Redis({ url, token, automaticDeserialization: false });
}

export const monthKey = (t = new Date()) => t.toISOString().slice(0, 7);
