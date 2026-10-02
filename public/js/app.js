import { api } from "./api.js";
import { updateUI, updateTimer, showToast, announce, setExpireHandler, renderStats } from "./ui.js";

// User identity management
const urlParams = new URLSearchParams(window.location.search);
const user = urlParams.get("user") || localStorage.user || "user-" + Math.random().toString(36).slice(2, 7);
localStorage.user = user;

const userInput = document.getElementById("user");
if (userInput) {
  userInput.value = user;
  userInput.addEventListener("change", (e) => {
    const val = e.target.value.trim();
    if (!val) {
      e.target.value = user;
      return;
    }
    localStorage.user = val;
    window.location.search = "?user=" + encodeURIComponent(val);
  });
}

// Client application state
const state = {
  data: null,
  skew: 0,
  online: true,
  busy: null,
  attempt: null,
  expired: false,
  holdTotal: 0,
  queueStart: 0,
};

const attemptKey = "sneakdrop.attempt." + user;
try {
  const storedAttempt = Number(sessionStorage.getItem(attemptKey));
  state.attempt = storedAttempt || null;
} catch {}

function setAttempt(val) {
  state.attempt = val;
  try {
    sessionStorage.setItem(attemptKey, String(val ?? ""));
  } catch {}
}

function serverNow() {
  return Date.now() + state.skew;
}

function deriveState(s) {
  if (!s) return {};
  const held = !!s.hold;
  const inLine = s.queuePosition != null;
  const limit = s.purchased >= s.maxPerUser;
  const soldOut = s.available <= 0;
  const low = !soldOut && s.available <= Math.max(3, Math.ceil(s.total * 0.15));
  const level = soldOut ? "out" : low ? "low" : "ok";

  let pay = "none";
  if (held) {
    const mine = state.attempt === s.hold.expiresAt;
    if (state.busy === "pay" || (mine && s.lastPayment === "pending")) pay = "processing";
    else if (mine && s.lastPayment === "failed") pay = "failed";
    else pay = "idle";
  } else if (s.lastPayment === "succeeded") pay = "success";
  else if (s.lastPayment === "refunded") pay = "refunded";
  else if (s.lastPayment === "pending") pay = "processing";

  const expired = !held && state.expired && pay !== "success" && pay !== "processing";

  let steps;
  if (held) steps = pay === "processing" ? ["completed", "active", "pending"]
    : pay === "failed" ? ["completed", "failed", "pending"] : ["active", "pending", "pending"];
  else if (pay === "success") steps = ["completed", "completed", "completed"];
  else if (pay === "refunded") steps = ["completed", "failed", "pending"];
  else if (pay === "processing") steps = ["completed", "active", "pending"];
  else if (expired) steps = ["failed", "pending", "pending"];
  else steps = ["pending", "pending", "pending"];

  return { held, inLine, limit, soldOut, level, pay, expired, steps };
}

let isRefreshing = false;

async function refreshStatus() {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const res = await api.fetchState(user);
    if (!res || res.ok === false) {
      state.online = false;
      if (state.data) updateUI(state.data, deriveState(state.data), state);
      return;
    }

    const wasOffline = !state.online;
    state.online = true;
    state.skew = res.serverNow - Date.now();

    detectTransitions(state.data, res);
    state.data = res;

    if (res.hold) state.holdTotal = Math.max(state.holdTotal, res.hold.msLeft);
    else state.holdTotal = 0;

    if (res.queuePosition != null) state.queueStart = Math.max(state.queueStart, res.queuePosition);
    else state.queueStart = 0;

    updateUI(res, deriveState(res), state);

    if (wasOffline) announce("Connection restored.");
  } catch {
    state.online = false;
  } finally {
    isRefreshing = false;
  }
}

function detectTransitions(prev, next) {
  if (!prev) return;
  if (prev.hold && next.hold && prev.hold.expiresAt !== next.hold.expiresAt) {
    state.holdTotal = 0;
  }
  if (!prev.hold && next.hold) {
    state.expired = false;
    if (prev.queuePosition != null) {
      showToast("success", "It's your turn", "A pair was reserved for you. Your timer has started.");
      announce("A pair was reserved for you from the waiting line.");
    }
  }
  if (prev.hold && !next.hold && next.lastPayment !== "succeeded" && next.lastPayment !== "pending" && next.purchased <= prev.purchased) {
    state.expired = true;
    showToast("error", "Reservation expired", "Your pair was released. Please try again.");
    announce("Your reservation expired.");
  }
  if (prev.lastPayment !== next.lastPayment) {
    if (next.lastPayment === "succeeded" && next.purchased > prev.purchased) {
      state.expired = false;
      showToast("success", "Payment confirmed", "Your pair is secured.");
      announce("Payment confirmed. Your pair is secured.");
    } else if (next.lastPayment === "failed" && next.hold) {
      showToast("error", "Payment failed", "Your reservation may still be active. Try again.");
      announce("Payment failed.");
    } else if (next.lastPayment === "refunded") {
      showToast("warning", "Payment refunded", "The reservation ended and the pair was taken.");
      announce("Payment refunded.");
    }
  }
}

async function runAction(actionKey, actionFn) {
  if (state.busy) return;
  state.busy = actionKey;
  if (state.data) updateUI(state.data, deriveState(state.data), state);

  try {
    await actionFn();
  } catch (err) {
    console.error(err);
    showToast("error", "Something went wrong.");
  } finally {
    state.busy = null;
    await refreshStatus();
  }
}

const errorTitles = {
  sold_out: "Sold out",
  limit_reached: "Limit reached",
  already_holding: "Already holding a pair",
  in_queue: "Already in line",
  in_stock: "Pairs are available",
  no_hold: "Reservation expired",
  network: "Connection error",
};

function handleApiError(res, fallback) {
  showToast(res.code === "no_hold" ? "error" : "warning", errorTitles[res.code] || fallback, res.message);
}

async function reservePair() {
  return runAction("buy", async () => {
    const res = await api.reservePair(user);
    if (res.ok) {
      state.expired = false;
      showToast("success", "Pair reserved", "Your timer has started.");
      announce("Pair reserved.");
    } else {
      handleApiError(res, "Could not reserve pair");
    }
  });
}

async function joinQueue() {
  return runAction("join", async () => {
    const res = await api.joinQueue(user);
    if (res.ok) {
      state.expired = false;
      showToast("success", "You're in line", "We'll reserve a pair when available.");
    } else {
      handleApiError(res, "Could not join line");
    }
  });
}

async function leaveQueue() {
  return runAction("leave", async () => {
    const res = await api.leaveQueue(user);
    if (res.ok) {
      showToast("info", "Left waiting line", "You can join again while the drop is busy.");
    } else {
      handleApiError(res, "Could not leave line");
    }
  });
}

async function processPayment() {
  return runAction("pay", async () => {
    if (state.data?.hold) setAttempt(state.data.hold.expiresAt);
    const res = await api.processPayment(user);
    if (res.ok) {
      showToast("info", "Payment started", "Confirming your payment...");
    } else {
      handleApiError(res, "Payment could not start");
    }
  });
}

function scrollToReservation() {
  const card = document.getElementById("card-reservation");
  if (card) {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  }
}

// Global button click handler
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || btn.disabled) return;

  const action = btn.dataset.action;
  if (action === "buy") reservePair();
  else if (action === "join") joinQueue();
  else if (action === "leave") leaveQueue();
  else if (action === "pay") processPayment();
  else if (action === "scroll") scrollToReservation();
});

// Image fallback
const productImg = document.getElementById("product-img");
if (productImg) {
  productImg.addEventListener("error", () => {
    const fallback = document.createElement("div");
    fallback.style.cssText = "font-weight:900;font-size:clamp(2rem,8vw,4rem);color:#333;text-transform:uppercase;text-align:center;letter-spacing:-.04em";
    fallback.textContent = "Midnight Run";
    productImg.replaceWith(fallback);
  });
}

// Background sweep & polling timers
setExpireHandler(() => refreshStatus());
setInterval(refreshStatus, 1000);
setInterval(() => updateTimer(state, serverNow()), 250);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshStatus();
});

refreshStatus();

// Admin stats panel toggle listener
const sysDetails = document.getElementById("sys");
let statsInterval = null;

async function updateStats() {
  const stats = await api.fetchStats();
  renderStats(stats, state.online);
}

if (sysDetails) {
  sysDetails.addEventListener("toggle", () => {
    clearInterval(statsInterval);
    if (sysDetails.open) {
      updateStats();
      statsInterval = setInterval(updateStats, 3000);
    }
  });
}
