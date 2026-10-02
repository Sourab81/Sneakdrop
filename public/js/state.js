// Holds the latest server state plus the small amount of client-only context needed to tell
// stories the API does not directly tell (e.g. "your hold just expired"). The server stays authoritative.
export const store = {
  s: null,          // last /api/state response
  skew: 0,          // serverNow - Date.now()
  online: true,
  busy: null,       // "buy" | "join" | "leave" | "pay" while a request is in flight
  attempt: null,    // expiresAt of the hold the user last tried to pay for (sessionStorage-backed)
  expired: false,   // true after a hold lapsed without being paid
  holdTotal: 0,     // ms of the current hold, for the progress bar
  queueStart: 0,    // first position seen in the current line stint
};

export const serverNow = () => Date.now() + store.skew;

export function derive(s, c = store) {
  const held = !!s.hold;
  const inLine = s.queuePosition != null;
  const limit = s.purchased >= s.maxPerUser;
  const soldOut = s.available <= 0;
  const low = !soldOut && s.available <= Math.max(3, Math.ceil(s.total * 0.15));
  const level = soldOut ? "out" : low ? "low" : "ok";

  // Payment state. lastPayment is "latest payment of this user", so for a live hold we only trust it
  // if the user actually started paying for *this* hold (otherwise it belongs to an older reservation).
  let pay = "none";
  if (held) {
    const mine = c.attempt === s.hold.expiresAt;
    if (c.busy === "pay" || (mine && s.lastPayment === "pending")) pay = "processing";
    else if (mine && s.lastPayment === "failed") pay = "failed";
    else pay = "idle";
  } else if (s.lastPayment === "succeeded") pay = "success";
  else if (s.lastPayment === "refunded") pay = "refunded";
  else if (s.lastPayment === "pending") pay = "processing";

  const expired = !held && c.expired && pay !== "success" && pay !== "processing";

  let steps; // reserve / pay / confirm
  if (held) steps = pay === "processing" ? ["completed", "active", "pending"]
    : pay === "failed" ? ["completed", "failed", "pending"] : ["active", "pending", "pending"];
  else if (pay === "success") steps = ["completed", "completed", "completed"];
  else if (pay === "refunded") steps = ["completed", "failed", "pending"];
  else if (pay === "processing") steps = ["completed", "active", "pending"];
  else if (expired) steps = ["failed", "pending", "pending"];
  else steps = ["pending", "pending", "pending"];

  return { held, inLine, limit, soldOut, level, pay, expired, steps };
}
