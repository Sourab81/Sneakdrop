import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { defaultChaos } from "./provider.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_FILE = process.env.DB_FILE ?? "sneakdrop.db";
const TOTAL_STOCK = Number(process.env.TOTAL_STOCK ?? 20);
const HOLD_SECONDS = Number(process.env.HOLD_SECONDS ?? 300);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "dev-secret";

const store = new Store(new DatabaseSync(DB_FILE), {
  totalStock: TOTAL_STOCK,
  holdMs: HOLD_SECONDS * 1000,
  maxPerUser: 2,
});

const chaos = process.env.NO_CHAOS
  ? { maxDelayMs: 0, dupProb: 0, reorderProb: 0, failProb: 0 }
  : defaultChaos;

const app = createApp(store, {
  webhookUrl: () => `http://127.0.0.1:${PORT}/webhooks/payments`,
  secret: WEBHOOK_SECRET,
  chaos,
});

// Periodically sweep expired holds so line promotions happen even when idle
setInterval(() => store.sweep(), 250);

app.listen(PORT, () => {
  console.log(`Sneaker Drop running on http://localhost:${PORT} (stock: ${TOTAL_STOCK}, hold: ${HOLD_SECONDS}s)`);
});

