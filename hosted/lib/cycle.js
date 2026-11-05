// The 28-day cycle. Day 1 resets the folder and feeds 01; days 2 to 8 feed one transcript each, in file
// order, so 07 and 08 arrive after the ones they close; days 9 to 28 find nothing new and say so.
// Days are counted in Kuala Lumpur time (UTC+8, no daylight saving) from CYCLE_START.
export const CYCLE_DAYS = 28;
export const FEED_DAYS = 8;

const DAY = 86400e3;
export const klDate = (t = new Date()) => new Date(t.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

// { started: false } before CYCLE_START; otherwise the day of the cycle (1 to 28), the date this cycle
// began (its reset key), and how many slots should be filled by today.
export function cycleDay(start, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "")) throw new Error("CYCLE_START must be a date, YYYY-MM-DD");
  const today = klDate(now);
  const since = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY);
  if (since < 0) return { started: false, today, starts: start };
  const n = Math.floor(since / CYCLE_DAYS);
  const day = (since % CYCLE_DAYS) + 1;
  return { started: true, today, day, cycle: n + 1, cycleStart: addDays(start, n * CYCLE_DAYS), due: Math.min(day, FEED_DAYS) };
}
