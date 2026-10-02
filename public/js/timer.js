export function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
export function urgency(ms) {
  const s = ms / 1000;
  return s <= 15 ? "critical" : s <= 60 ? "warn" : "ok";
}
/** Calls fn every `every` ms, without drift-sensitive logic (callers compute from absolute times). */
export function every(fn, ms) { return setInterval(fn, ms); }
