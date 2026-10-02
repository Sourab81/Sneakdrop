import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { sign } from "../src/provider.js";

let eventCounter = 0;

function createTestStore(totalStock = 3) {
  let currentTime = 1_000_000;
  const store = new Store(new DatabaseSync(":memory:"), {
    totalStock,
    holdMs: 1000,
    maxPerUser: 2,
    now: () => currentTime,
  });

  return {
    store,
    advanceTime: (ms: number) => { currentTime += ms; },
    now: () => currentTime,
  };
}

function makeEvent(type: string, intentId: string, occurredAt: number, eventId = "e" + eventCounter++) {
  return { event_id: eventId, type, intent_id: intentId, occurred_at: occurredAt };
}

function getPaymentIntent(store: Store, user: string): string {
  const result: any = store.createIntent(user);
  assert.ok(result.ok, JSON.stringify(result));
  return result.intentId;
}

async function test(name: string, fn: () => unknown) {
  await fn();
  console.log("  ok  " + name);
}

// Execute async tasks with limited concurrency to avoid OS socket exhaustion
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

await test("never holds more than the stock", () => {
  const { store } = createTestStore(3);
  const results = Array.from({ length: 10 }, (_, i) => (store.buy("u" + i) as any).ok);
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(store.stats().available, 0);
});

await test("one hold per user", () => {
  const { store } = createTestStore();
  assert.ok(store.buy("a").ok);
  assert.equal((store.buy("a") as any).code, "already_holding");
});

await test("max 2 purchases per user", () => {
  const { store, now } = createTestStore(5);
  for (let i = 0; i < 2; i++) {
    assert.ok(store.buy("a").ok);
    store.handleEvent(makeEvent("payment.succeeded", getPaymentIntent(store, "a"), now()));
  }
  assert.equal((store.buy("a") as any).code, "limit_reached");
  assert.equal(store.state("a").purchased, 2);
});

await test("expired holds go back to stock", () => {
  const { store, advanceTime } = createTestStore(1);
  store.buy("a");
  assert.equal(store.stats().available, 0);
  advanceTime(1000);
  assert.equal(store.stats().available, 1);
  assert.ok(store.buy("b").ok);
});

await test("waiting line is FIFO and promoted holds get a fresh timer", () => {
  const { store, advanceTime, now } = createTestStore(2);
  store.buy("a");
  store.buy("b");
  for (const user of ["c", "d", "e"]) {
    assert.ok(store.joinQueue(user).ok);
  }
  assert.equal(store.state("d").queuePosition, 2);
  advanceTime(1000);
  assert.ok(store.state("c").hold && store.state("d").hold, "c and d promoted");
  assert.equal(store.state("c").hold!.expiresAt, now() + 1000);
  assert.equal(store.state("e").queuePosition, 1);
  assert.equal(store.stats().held, 2);
});

await test("can't join the line while stock exists", () => {
  const { store } = createTestStore(2);
  assert.equal((store.joinQueue("a") as any).code, "in_stock");
});

await test("duplicate webhook (same id, and same payment with new id) counts once", () => {
  const { store, now } = createTestStore(3);
  store.buy("a");
  const intentId = getPaymentIntent(store, "a");
  assert.equal(store.handleEvent(makeEvent("payment.succeeded", intentId, now(), "same")).result, "paid");
  assert.equal(store.handleEvent(makeEvent("payment.succeeded", intentId, now(), "same")).result, "duplicate_event");
  assert.equal(store.handleEvent(makeEvent("payment.succeeded", intentId, now())).result, "already_final");
  assert.equal(store.stats().paid, 1);
});

await test("out-of-order events never downgrade a paid order", () => {
  const { store, now } = createTestStore(3);
  store.buy("a");
  const intentId = getPaymentIntent(store, "a");
  store.handleEvent(makeEvent("payment.succeeded", intentId, now()));
  store.handleEvent(makeEvent("payment.processing", intentId, now()));
  store.handleEvent(makeEvent("payment.failed", intentId, now()));
  assert.equal(store.stats().paid, 1);
  assert.equal(store.state("a").lastPayment, "succeeded");
});

await test("failed payment keeps the hold; user can retry with a new intent", () => {
  const { store, now } = createTestStore(3);
  store.buy("a");
  const intent1 = getPaymentIntent(store, "a");
  store.handleEvent(makeEvent("payment.failed", intent1, now()));
  const intent2 = getPaymentIntent(store, "a");
  assert.notEqual(intent1, intent2);
  store.handleEvent(makeEvent("payment.succeeded", intent2, now()));
  assert.equal(store.stats().paid, 1);
});

await test("late 'succeeded' after expiry: refunded if pair was given to the line", () => {
  const { store, advanceTime } = createTestStore(1);
  store.buy("a");
  const intentId = getPaymentIntent(store, "a");
  const paidAt = 1_000_500;
  store.joinQueue("b");
  advanceTime(1000); // a expires, b promoted
  assert.ok(store.state("b").hold);
  assert.equal(store.handleEvent(makeEvent("payment.succeeded", intentId, paidAt)).result, "refunded_pair_gone");
  assert.equal(store.stats().held + store.stats().paid, 1); // never oversold
  assert.equal(store.state("a").lastPayment, "refunded");
});

await test("late 'succeeded' after expiry: honoured if paid in time and pair still free", () => {
  const { store, advanceTime } = createTestStore(1);
  store.buy("a");
  const intentId = getPaymentIntent(store, "a");
  advanceTime(1500);
  assert.equal(store.handleEvent(makeEvent("payment.succeeded", intentId, 1_000_500)).result, "paid_late_reclaimed");
  assert.equal(store.stats().paid, 1);
  assert.equal(store.stats().available, 0);
});

await test("'succeeded' that was really paid AFTER expiry is refunded", () => {
  const { store, advanceTime } = createTestStore(1);
  store.buy("a");
  const intentId = getPaymentIntent(store, "a");
  advanceTime(1500);
  assert.equal(store.handleEvent(makeEvent("payment.succeeded", intentId, 1_001_400)).result, "refunded_pair_gone");
});

// ---- real HTTP: 2000 requests over HTTP ----
await test("2000 simultaneous Buy clicks over HTTP -> exactly 20 holds", async () => {
  const store = new Store(new DatabaseSync(":memory:"), { totalStock: 20, holdMs: 60_000, maxPerUser: 2 });
  const app = createApp(store, { webhookUrl: () => "", secret: "s", chaos: { maxDelayMs: 0, dupProb: 0, reorderProb: 0, failProb: 0 } });
  
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const post = (path: string, user: string) =>
    fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user }),
    }).then((r) => r.json());

  const users = Array.from({ length: 2000 }, (_, i) => "u" + i);
  const buyResults = await mapConcurrent(users, 50, (user) => post("/api/buy", user));

  assert.equal(buyResults.filter((r: any) => r.ok).length, 20);

  const statsRes = await fetch(baseUrl + "/api/admin/stats").then((r) => r.json() as any);
  assert.equal(statsRes.held, 20);

  const sameUserRequests = Array.from({ length: 50 }, () => "solo");
  const sameResults = await mapConcurrent(sameUserRequests, 20, (user) => post("/api/buy", user));
  assert.equal(sameResults.filter((r: any) => r.ok).length, 0);

  const waitingUsers = Array.from({ length: 300 }, (_, i) => "w" + i);
  const queueResults = await mapConcurrent(waitingUsers, 50, (user) => post("/api/queue/join", user));
  assert.equal(queueResults.filter((r: any) => r.ok).length, 300);

  const positions = await mapConcurrent(waitingUsers, 50, (user) =>
    fetch(`${baseUrl}/api/state?user=${user}`).then((r) => r.json() as any)
  );
  assert.equal(new Set(positions.map((p) => p.queuePosition)).size, 300);

  // signed webhook path + bad signature
  const hold = await post("/api/buy", "zz");
  assert.equal(hold.ok, false);

  const badSig = await fetch(baseUrl + "/webhooks/payments", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": "nope" },
    body: "{}",
  });
  assert.equal(badSig.status, 401);

  const rawPayload = JSON.stringify({ event_id: "x", type: "payment.succeeded", intent_id: "nope", occurred_at: 1 });
  const validWebhook = await fetch(baseUrl + "/webhooks/payments", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": sign("s", rawPayload) },
    body: rawPayload,
  });
  assert.equal(validWebhook.status, 200);

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

console.log("\nall tests passed");

