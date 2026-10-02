// API communication with SneakDrop backend endpoints

async function request(path, options = {}) {
  const isGet = options.method === "GET";
  const userQuery = isGet && options.user ? "?user=" + encodeURIComponent(options.user) : "";
  const url = path + userQuery;

  try {
    const res = await fetch(url, {
      method: options.method || "POST",
      headers: { "content-type": "application/json" },
      body: isGet ? undefined : JSON.stringify({ user: options.user }),
    });
    return await res.json();
  } catch {
    return { ok: false, code: "network", message: "Can't reach the server. Check your connection." };
  }
}

export const api = {
  fetchState: (user) => request("/api/state", { method: "GET", user }),
  reservePair: (user) => request("/api/buy", { user }),
  joinQueue: (user) => request("/api/queue/join", { user }),
  leaveQueue: (user) => request("/api/queue/leave", { user }),
  processPayment: (user) => request("/api/pay", { user }),
  fetchStats: () => request("/api/admin/stats", { method: "GET" }),
};
