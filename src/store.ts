import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface StoreOptions {
  totalStock: number;
  holdMs: number;
  maxPerUser: number;
  now?: () => number;
}

export type FailureResult = { ok: false; code: string; message: string };

function fail(code: string, message: string): FailureResult {
  return { ok: false, code, message };
}

export interface PaymentEvent {
  event_id: string;
  type: string;
  intent_id: string;
  occurred_at: number;
}

export interface HoldInfo {
  expiresAt: number;
  msLeft: number;
}

export interface UserState {
  serverNow: number;
  total: number;
  available: number;
  maxPerUser: number;
  purchased: number;
  hold: HoldInfo | null;
  queuePosition: number | null;
  lastPayment: string | null;
}

export interface StoreStats {
  total: number;
  held: number;
  paid: number;
  expired: number;
  available: number;
  queueLength: number;
}

export class Store {
  db: DatabaseSync;
  options: Required<StoreOptions>;

  constructor(db: DatabaseSync, options: StoreOptions) {
    this.db = db;
    this.options = { now: () => Date.now(), ...options };

    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {}

    db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('held','paid','expired')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_hold_per_user 
        ON reservations(user_id) WHERE status = 'held';

      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE,
        joined_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payments (
        intent_id TEXT PRIMARY KEY,
        reservation_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','refunded')),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
    `);
  }

  get o(): Required<StoreOptions> {
    return this.options;
  }

  // Every mutating operation runs inside a BEGIN IMMEDIATE transaction
  // to prevent race conditions and ensure stock calculations remain strictly atomic.
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private get now(): number {
    return this.options.now();
  }

  private getCount(sql: string, ...params: unknown[]): number {
    const row = this.db.prepare(sql).get(...(params as any[])) as { c: number } | undefined;
    return row ? row.c : 0;
  }

  // Stock is derived on the fly (totalStock - active holds - completed purchases).
  private getAvailableStock(): number {
    const activeCount = this.getCount("SELECT COUNT(*) c FROM reservations WHERE status IN ('held','paid')");
    return this.options.totalStock - activeCount;
  }

  private getPaidCount(user: string): number {
    return this.getCount("SELECT COUNT(*) c FROM reservations WHERE user_id = ? AND status = 'paid'", user);
  }

  private getActiveHold(user: string) {
    return this.db.prepare("SELECT * FROM reservations WHERE user_id = ? AND status = 'held'").get(user) as
      | { id: number; expires_at: number }
      | undefined;
  }

  private createHold(user: string) {
    const now = this.now;
    this.db
      .prepare("INSERT INTO reservations(user_id, status, expires_at, created_at) VALUES (?, 'held', ?, ?)")
      .run(user, now + this.options.holdMs, now);
  }

  // Mark overdue holds as expired and promote the next eligible users from the waiting queue.
  private sweepExpiredHolds() {
    this.db.prepare("UPDATE reservations SET status = 'expired' WHERE status = 'held' AND expires_at <= ?").run(this.now);

    while (this.getAvailableStock() > 0) {
      const nextInQueue = this.db.prepare("SELECT id, user_id FROM queue ORDER BY id LIMIT 1").get() as
        | { id: number; user_id: string }
        | undefined;

      if (!nextInQueue) break;

      this.db.prepare("DELETE FROM queue WHERE id = ?").run(nextInQueue.id);

      // Skip users who became ineligible while waiting (e.g., reached purchase limit or acquired hold)
      if (this.getPaidCount(nextInQueue.user_id) >= this.options.maxPerUser || this.getActiveHold(nextInQueue.user_id)) {
        continue;
      }

      this.createHold(nextInQueue.user_id);
    }
  }

  sweep() {
    this.transaction(() => this.sweepExpiredHolds());
  }

  reservePair(user: string) {
    return this.transaction(() => {
      this.sweepExpiredHolds();

      if (this.getActiveHold(user)) return fail("already_holding", "You already hold a pair.");
      if (this.getPaidCount(user) >= this.options.maxPerUser) {
        return fail("limit_reached", `Max ${this.options.maxPerUser} pairs per person.`);
      }
      if (this.db.prepare("SELECT 1 FROM queue WHERE user_id = ?").get(user)) {
        return fail("in_queue", "You are already in the waiting line.");
      }
      if (this.getAvailableStock() <= 0) return fail("sold_out", "Sold out. You can join the waiting line.");

      this.createHold(user);
      return { ok: true as const, hold: this.getActiveHold(user)! };
    });
  }

  // Alias for backward compatibility
  buy(user: string) {
    return this.reservePair(user);
  }

  joinQueue(user: string) {
    return this.transaction(() => {
      this.sweepExpiredHolds();

      if (this.getActiveHold(user)) return fail("already_holding", "You already hold a pair.");
      if (this.getPaidCount(user) >= this.options.maxPerUser) {
        return fail("limit_reached", `Max ${this.options.maxPerUser} pairs per person.`);
      }
      if (this.getAvailableStock() > 0) return fail("in_stock", "Pairs are available, just click Buy.");

      const res = this.db.prepare("INSERT OR IGNORE INTO queue(user_id, joined_at) VALUES (?, ?)").run(user, this.now);
      if (res.changes === 0) return fail("in_queue", "You are already in the waiting line.");

      return { ok: true as const };
    });
  }

  leaveQueue(user: string) {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM queue WHERE user_id = ?").run(user);
      return { ok: true as const };
    });
  }

  createIntent(user: string) {
    return this.transaction(() => {
      this.sweepExpiredHolds();

      const hold = this.getActiveHold(user);
      if (!hold) return fail("no_hold", "You have no active hold (it may have expired).");

      const existing = this.db
        .prepare("SELECT * FROM payments WHERE reservation_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(hold.id) as { intent_id: string; status: string } | undefined;

      if (existing && (existing.status === "pending" || existing.status === "succeeded")) {
        return { ok: true as const, intentId: existing.intent_id, reused: true };
      }

      const intentId = "pi_" + randomUUID();
      this.db
        .prepare("INSERT INTO payments(intent_id, reservation_id, user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
        .run(intentId, hold.id, user, this.now);

      return { ok: true as const, intentId, reused: false };
    });
  }

  // Webhook handler logic: idempotent processing, handling terminal status lock, and late-payment reclamation.
  handleEvent(event: PaymentEvent): { result: string } {
    return this.transaction(() => {
      const seen = this.db
        .prepare("INSERT OR IGNORE INTO webhook_events(event_id, received_at) VALUES (?, ?)")
        .run(event.event_id, this.now);

      if (seen.changes === 0) return { result: "duplicate_event" };

      this.sweepExpiredHolds();

      const payment = this.db.prepare("SELECT * FROM payments WHERE intent_id = ?").get(event.intent_id) as
        | { reservation_id: number; user_id: string; status: string }
        | undefined;

      if (!payment) return { result: "unknown_intent" };
      if (payment.status === "succeeded" || payment.status === "refunded") return { result: "already_final" };

      if (event.type === "payment.failed") {
        this.db.prepare("UPDATE payments SET status = 'failed' WHERE intent_id = ?").run(event.intent_id);
        return { result: "failed_recorded" };
      }

      if (event.type !== "payment.succeeded") return { result: "ignored_non_terminal" };

      const reservation = this.db.prepare("SELECT * FROM reservations WHERE id = ?").get(payment.reservation_id) as
        | { id: number; status: string; expires_at: number }
        | undefined;

      if (!reservation) return { result: "unknown_reservation" };

      if (reservation.status === "held") {
        this.db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ?").run(reservation.id);
        this.db.prepare("UPDATE payments SET status = 'succeeded' WHERE intent_id = ?").run(event.intent_id);
        return { result: "paid" };
      }

      if (reservation.status === "expired") {
        // If paid in time and stock is still available, reclaim the hold. Otherwise refund.
        const paidInTime = event.occurred_at <= reservation.expires_at;
        const canReclaim =
          paidInTime &&
          this.getAvailableStock() > 0 &&
          !this.getActiveHold(payment.user_id) &&
          this.getPaidCount(payment.user_id) < this.options.maxPerUser;

        if (canReclaim) {
          this.db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ?").run(reservation.id);
          this.db.prepare("UPDATE payments SET status = 'succeeded' WHERE intent_id = ?").run(event.intent_id);
          return { result: "paid_late_reclaimed" };
        }

        this.db.prepare("UPDATE payments SET status = 'refunded' WHERE intent_id = ?").run(event.intent_id);
        return { result: "refunded_pair_gone" };
      }

      return { result: "noop" };
    });
  }

  state(user: string): UserState {
    return this.transaction(() => {
      this.sweepExpiredHolds();

      const hold = this.getActiveHold(user);
      const queueRow = this.db.prepare("SELECT id FROM queue WHERE user_id = ?").get(user) as { id: number } | undefined;
      const lastPayment = this.db
        .prepare("SELECT status FROM payments WHERE user_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(user) as { status: string } | undefined;

      return {
        serverNow: this.now,
        total: this.options.totalStock,
        available: this.getAvailableStock(),
        maxPerUser: this.options.maxPerUser,
        purchased: this.getPaidCount(user),
        hold: hold ? { expiresAt: hold.expires_at, msLeft: hold.expires_at - this.now } : null,
        queuePosition: queueRow ? this.getCount("SELECT COUNT(*) c FROM queue WHERE id <= ?", queueRow.id) : null,
        lastPayment: lastPayment?.status ?? null,
      };
    });
  }

  stats(): StoreStats {
    return this.transaction(() => {
      this.sweepExpiredHolds();

      const countByStatus = (status: string) =>
        this.getCount("SELECT COUNT(*) c FROM reservations WHERE status = ?", status);

      return {
        total: this.options.totalStock,
        held: countByStatus("held"),
        paid: countByStatus("paid"),
        expired: countByStatus("expired"),
        available: this.getAvailableStock(),
        queueLength: this.getCount("SELECT COUNT(*) c FROM queue"),
      };
    });
  }
}
