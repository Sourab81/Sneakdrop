const $ = (id) => document.getElementById(id);

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function getUrgency(ms) {
  const seconds = ms / 1000;
  if (seconds <= 15) return "critical";
  if (seconds <= 60) return "warn";
  return "ok";
}

export function setButton(id, { text, variant, action, loading = false, disabled = false, hidden = false }) {
  const el = $(id);
  if (!el) return;
  el.hidden = hidden;
  if (hidden) return;

  if (text != null && el.textContent !== text) {
    el.textContent = text;
  }

  if (variant) {
    el.className = `btn btn--${variant}${loading ? " is-loading" : ""}`;
  } else {
    el.classList.toggle("is-loading", loading);
  }

  if (action) el.dataset.action = action;
  else delete el.dataset.action;

  el.disabled = disabled || loading;
  el.setAttribute("aria-busy", loading ? "true" : "false");
}

function setText(id, text) {
  const el = $(id);
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
}

function setTone(id, tone) {
  const el = $(id);
  if (el) el.dataset.tone = tone;
}

export function showToast(type, title, msg = "") {
  const container = $("toasts");
  if (!container) return;

  const toastEl = document.createElement("div");
  toastEl.className = `toast toast--${type}`;

  const titleEl = document.createElement("div");
  titleEl.className = "toast__title";
  titleEl.textContent = title;
  toastEl.appendChild(titleEl);

  if (msg) {
    const msgEl = document.createElement("div");
    msgEl.className = "toast__msg";
    msgEl.textContent = msg;
    toastEl.appendChild(msgEl);
  }

  container.appendChild(toastEl);

  while (container.children.length > 4) {
    container.firstElementChild.remove();
  }

  const duration = type === "error" ? 6000 : 4000;
  setTimeout(() => {
    toastEl.classList.add("is-leaving");
    setTimeout(() => toastEl.remove(), 180);
  }, duration);
}

export function announce(text) {
  setText("sr-status", text);
}

export function updateUI(s, v, clientState) {
  const busy = clientState.busy;

  // Header status chip
  const chip = $("drop-status");
  if (chip) {
    if (!clientState.online) {
      chip.dataset.tone = "warn";
      setText("drop-status-text", "Connection lost — retrying");
    } else if (v.soldOut) {
      chip.dataset.tone = "out";
      setText("drop-status-text", "Sold out");
    } else {
      chip.dataset.tone = "live";
      setText("drop-status-text", v.level === "low" ? "Drop live · low stock" : "Drop live");
    }
  }

  // Hero section stock & CTA
  const pct = s.total ? Math.max(0, Math.min(100, (s.available / s.total) * 100)) : 0;
  const heroStock = $("hero-stock");
  if (heroStock) heroStock.dataset.level = v.level;

  setText("hero-stock-text", v.soldOut ? "Sold out" : `${s.available} / ${s.total} pairs left`);
  const heroBar = $("hero-stock-bar");
  if (heroBar) heroBar.style.width = pct + "%";

  if (v.limit) {
    setButton("btn-hero", { text: "Limit reached", variant: "secondary", disabled: true });
  } else if (v.held) {
    setButton("btn-hero", { text: "✓ Reserved — pay below", variant: "secondary", action: "scroll" });
  } else if (v.inLine) {
    setButton("btn-hero", { text: `In line · #${s.queuePosition}`, variant: "secondary", disabled: true });
  } else if (v.soldOut) {
    setButton("btn-hero", { text: busy === "join" ? "Joining…" : "Join waiting line", variant: "secondary", action: "join", loading: busy === "join", disabled: !!busy });
  } else {
    setButton("btn-hero", { text: busy === "buy" ? "Reserving…" : "Buy now", variant: "primary", action: "buy", loading: busy === "buy", disabled: !!busy });
  }

  // Stock card
  const stockCard = $("card-stock");
  if (stockCard) stockCard.dataset.level = v.level;

  setText("stock-headline", v.soldOut ? "Drop sold out" : v.level === "low" ? `${plural(s.available, "pair", "pairs")} left` : "Available");
  setText("stock-num", String(s.available));
  setText("stock-of", `of ${s.total} pairs`);

  const stockBar = $("stock-bar");
  if (stockBar) stockBar.style.width = pct + "%";

  const stockBarWrap = $("stock-bar-wrap");
  if (stockBarWrap) stockBarWrap.setAttribute("aria-label", `${s.available} of ${s.total} pairs available`);

  setText("stock-text", v.soldOut ? "All pairs reserved. Unpaid pairs will go to the waiting line."
    : v.level === "low" ? "Stock is low. Reserve yours now."
    : "Pairs return to stock if reservations expire.");

  // Purchases card
  const pips = $("pips");
  if (pips && pips.children.length !== s.maxPerUser) {
    pips.replaceChildren(
      ...Array.from({ length: s.maxPerUser }, () => {
        const span = document.createElement("span");
        span.className = "pip";
        return span;
      })
    );
  }
  if (pips) {
    [...pips.children].forEach((pip, i) => pip.classList.toggle("is-on", i < s.purchased));
  }

  setText("purchased-num", String(s.purchased));
  setText("purchased-of", `/ ${s.maxPerUser} pairs`);

  const limitHeadline = $("limit-headline");
  if (limitHeadline) limitHeadline.hidden = !v.limit;

  setText("purchases-text", v.limit ? "You've purchased the maximum allowed."
    : `Limit of ${plural(s.maxPerUser, "pair", "pairs")} per buyer.`);

  setTone("card-purchases", v.limit ? "warning" : "idle");

  renderReservation(s, v, busy);
  renderPayment(s, v, busy);
  renderQueue(s, v, busy, clientState);

  // Timeline indicator
  document.querySelectorAll("#timeline .timeline__step").forEach((li, i) => {
    li.dataset.state = v.steps[i];
    if (v.steps[i] === "active") li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");

    const hint = li.querySelector("[data-hint]");
    if (hint) {
      const stepNames = { pending: "Waiting", active: "In progress", completed: "Done", failed: "Failed" };
      hint.textContent = stepNames[v.steps[i]];
    }
  });

  updateTimer(clientState, Date.now() + clientState.skew);
}

function renderReservation(s, v, busy) {
  const cardId = "card-reservation";
  const timerBlock = $("res-timer-block");
  if (timerBlock) timerBlock.hidden = !v.held;

  if (v.held) {
    setTone(cardId, v.pay === "failed" ? "danger" : "active");
    setText("res-headline", "Pair reserved");
    setText("res-text", v.pay === "processing" ? "Payment is processing. Your hold remains active."
      : v.pay === "failed" ? "Payment failed. Try again before your timer expires."
      : "Complete payment before your timer expires.");

    setButton("btn-pay", { text: v.pay === "processing" ? "Processing…" : "Pay now", variant: "primary", action: "pay", loading: v.pay === "processing", disabled: !!busy, hidden: v.pay === "failed" });
    setButton("btn-expired-retry", { hidden: true });
    return;
  }

  setButton("btn-pay", { hidden: true });

  if (v.expired) {
    setTone(cardId, "danger");
    setText("res-headline", "Reservation expired");
    setText("res-text", "Your reservation expired and the pair was released.");
    const canRetry = !v.limit && !v.inLine;
    setButton("btn-expired-retry", { text: v.soldOut ? "Join waiting line" : "Try again", variant: "primary", action: v.soldOut ? "join" : "buy", loading: busy === "buy" || busy === "join", disabled: !!busy, hidden: !canRetry });
    return;
  }

  setButton("btn-expired-retry", { hidden: true });
  setTone(cardId, "idle");
  setText("res-headline", "No active reservation");
  setText("res-text", v.limit ? "Purchase limit reached."
    : v.inLine ? "You'll automatically get a reservation when it's your turn."
    : v.soldOut ? "Drop sold out. Join the waiting line below."
    : "Reserve a pair to start your timer.");
}

function renderPayment(s, v, busy) {
  const cardId = "card-payment";
  const statusMap = {
    none: ["idle", "Nothing to pay yet", "Payment opens once you hold a pair."],
    idle: ["idle", "Ready to pay", "Your pair is reserved. Complete payment before the timer ends."],
    processing: ["active", "Processing payment…", "Confirming your transaction..."],
    success: ["success", "✓ Payment confirmed", "Payment confirmed. Your pair is secured."],
    failed: ["danger", "Payment failed", "Payment could not be completed. You can try again while your reservation is active."],
    refunded: ["warning", "Payment refunded", "Payment arrived after reservation expired and was refunded."],
  };

  const [tone, headline, text] = statusMap[v.pay] || statusMap.none;
  setTone(cardId, tone);
  setText("pay-headline", headline);
  setText("pay-text", text);
  setButton("btn-retry", { text: "Try again", variant: "primary", action: "pay", disabled: !!busy, loading: busy === "pay", hidden: v.pay !== "failed" });
}

function renderQueue(s, v, busy, clientState) {
  const pos = s.queuePosition;
  const posEl = $("queue-pos");
  const barWrap = $("queue-bar-wrap");

  if (posEl) posEl.hidden = !v.inLine;
  if (barWrap) barWrap.hidden = !v.inLine;

  if (v.inLine) {
    const ahead = pos - 1;
    const start = Math.max(clientState.queueStart, pos);
    setTone("card-queue", "active");
    setText("queue-headline", "You're in line");
    setText("queue-pos", `#${pos}`);

    const queueBar = $("queue-bar");
    if (queueBar) queueBar.style.width = Math.round(((start - pos + 1) / start) * 100) + "%";

    setText("queue-text", (ahead === 0 ? "You're next! " : `${plural(ahead, "person", "people")} ahead of you. `) + "We will automatically reserve a pair when available.");

    setButton("btn-join", { hidden: true });
    setButton("btn-leave", { text: busy === "leave" ? "Leaving…" : "Leave queue", variant: "danger", action: "leave", loading: busy === "leave", disabled: !!busy });
    return;
  }

  setButton("btn-leave", { hidden: true });
  setTone("card-queue", "idle");

  if (v.held || v.limit) {
    setText("queue-headline", "No line needed");
    setText("queue-text", v.held ? "You already hold a pair." : "Purchase limit reached.");
    setButton("btn-join", { hidden: true });
  } else if (v.soldOut) {
    setText("queue-headline", "Drop is busy");
    setText("queue-text", "Join the line to get reserved automatically when a pair frees up.");
    setButton("btn-join", { text: busy === "join" ? "Joining…" : "Join waiting line", variant: "secondary", action: "join", loading: busy === "join", disabled: !!busy });
  } else {
    setText("queue-headline", "No wait right now");
    setText("queue-text", "Pairs are in stock. Click Buy now to reserve.");
    setButton("btn-join", { hidden: true });
  }
}

let lastSecond = null;
let expireCallback = null;

export function setExpireHandler(fn) {
  expireCallback = fn;
}

export function updateTimer(clientState, now) {
  const s = clientState.data;
  if (!s || !s.hold) {
    lastSecond = null;
    return null;
  }

  const msLeft = s.hold.expiresAt - now;
  setText("countdown", formatTime(msLeft));

  const urgencyLevel = getUrgency(msLeft);
  const cd = $("countdown");
  const holdBar = $("hold-bar");

  if (cd) cd.dataset.urgency = urgencyLevel;
  if (holdBar) holdBar.dataset.urgency = urgencyLevel;

  const pct = clientState.holdTotal > 0 ? Math.max(0, Math.min(100, (msLeft / clientState.holdTotal) * 100)) : 0;
  const holdBarFill = $("hold-bar-fill");
  if (holdBarFill) holdBarFill.style.width = pct + "%";

  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  if (seconds !== lastSecond) {
    lastSecond = seconds;
    if ([60, 30, 10].includes(seconds)) {
      announce(`${seconds} seconds remaining on your reservation.`);
    }
    if (seconds === 0 && expireCallback) {
      expireCallback();
    }
  }

  return msLeft;
}

export function renderStats(stats, online) {
  const chip = $("sys-status");
  if (!stats || stats.ok === false) {
    if (chip) chip.dataset.tone = "warn";
    setText("sys-status-text", "Status unavailable");
    return;
  }

  document.querySelectorAll("[data-sys]").forEach((el) => {
    const field = el.dataset.sys;
    el.textContent = String(stats[field] ?? "—");
  });

  if (chip) chip.dataset.tone = online ? "live" : "warn";
  setText("sys-status-text", online ? "System operational" : "Connection lost");
}
