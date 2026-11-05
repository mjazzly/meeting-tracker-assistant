// The questions waiting on a person, read from the state the store wrote: every held transcript with its
// gate's own question, and every transcript whose dates wait on a meeting date. The wording is the
// store's (lib/store.js), less the line addressed to the model about which tool to call.
const GATE3 = /^Gate 3 past due: line (\S+) due (\S+) is before the meeting date (\S+)/;

export function waiting(store) {
  const log = store.log();
  const out = [];
  for (const h of store.getHeld().sort((a, b) => a.transcript.localeCompare(b.transcript))) {
    const stop = log.filter((r) => r.transcript === h.transcript && r.step === "stop" && r.result === "held").pop();
    const q = { transcript: h.transcript, gate: h.reason, since_run: stop?.run_id || "", rows: h.rows.length };
    if (h.reason === "duplicate_name") {
      const row = h.rows.find((r) => r.owner && !r.owner_company && store.matches(r.owner).length >= 2);
      const m = row ? store.matches(row.owner) : [];
      q.name = row?.owner || "";
      q.options = m.map((c) => ({ company: c.company, role: c.role }));
      q.question = `${q.name} matches ${m.length} contacts: ${m.map((c) => `${c.company}, ${c.role}`).join("; ")}. Which one?`;
    } else if (h.reason === "no_actions") {
      q.question = "This transcript held no actions. Nothing appended. Confirm that is right, or point me at the line I missed.";
    } else if (h.reason === "past_due") {
      const m = GATE3.exec(stop?.detail || "") || [];
      Object.assign(q, { source_line: m[1] || "", due: m[2] || "", meeting_date: m[3] || "" });
      q.question = `Line ${q.source_line} is due ${q.due}, before the meeting date ${q.meeting_date}. Was the date mis-said, or was it already overdue when it was said?`;
    } else {
      q.question = `${h.transcript} is held (${h.reason}).`;
    }
    out.push(q);
  }
  const confirm = store.tracker().filter((r) => r.status === "confirm");
  for (const t of [...new Set(confirm.map((r) => r.transcript))].sort()) {
    const rows = confirm.filter((r) => r.transcript === t);
    out.push({ transcript: t, gate: "meeting_date", since_run: rows[0].added_run, rows: rows.length,
      phrases: rows.map((r) => ({ action_id: r.action_id, due: r.due })),
      question: `${t} has no meeting date, so ${rows.length === 1 ? "one date waits" : `${rows.length} dates wait`} on it (${rows.map((r) => `"${r.due}"`).join(", ")}). What was the meeting date?` });
  }
  return out;
}

// One plain sentence for each kind of answer, as a person would write it to the assistant.
export function sentence(q, a) {
  const t = q.transcript;
  if (q.gate === "duplicate_name") {
    const o = q.options.find((x) => x.company === a.company);
    if (!o) throw new Error("choose one of the matching contacts");
    return `${t}: ${q.name} is ${o.company}, ${o.role}.`;
  }
  if (q.gate === "no_actions") {
    if (a.confirm === "yes") return `${t}: yes, there are no actions in it.`;
    if (/^\d+$/.test(a.line || "")) return `${t}: you missed line ${a.line}; read it again.`;
    throw new Error("confirm there are no actions, or give the line number missed");
  }
  if (q.gate === "past_due") {
    if (a.accept === "yes") return `${t}: record the date on line ${q.source_line} as said.`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.date || "")) return `${t}: the date on line ${q.source_line} should be ${a.date}.`;
    throw new Error("accept the date as said, or give the corrected date as YYYY-MM-DD");
  }
  if (q.gate === "meeting_date") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.date || "")) return `${t}: the meeting date was ${a.date}.`;
    throw new Error("give the meeting date as YYYY-MM-DD");
  }
  throw new Error(`no answer form for ${q.gate}`);
}
