import express from "express";
import path from "node:path";
import { Store } from "./store.js";
import { ChaosOptions, confirmPayment, verifySignature } from "./provider.js";

interface AppConfig {
  webhookUrl: () => string;
  secret: string;
  chaos: ChaosOptions;
}

export function createApp(store: Store, config: AppConfig) {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf.toString("utf8");
      },
    })
  );

  app.use(express.static(path.join(import.meta.dirname, "..", "public")));

  function getUserId(req: express.Request): string {
    const raw = req.body?.user ?? req.query.user ?? "";
    return String(raw).trim().slice(0, 64);
  }

  function requireUser(req: express.Request, res: express.Response): string | null {
    const user = getUserId(req);
    if (!user) {
      res.status(400).json({ ok: false, code: "no_user", message: "User is required." });
      return null;
    }
    return user;
  }

  function sendStoreResult(res: express.Response, result: { ok: boolean }) {
    return res.status(result.ok ? 200 : 409).json(result);
  }

  app.get("/api/state", (req, res) => {
    const user = requireUser(req, res);
    if (user) res.json(store.state(user));
  });

  app.post("/api/buy", (req, res) => {
    const user = requireUser(req, res);
    if (user) sendStoreResult(res, store.reservePair(user));
  });

  app.post("/api/queue/join", (req, res) => {
    const user = requireUser(req, res);
    if (user) sendStoreResult(res, store.joinQueue(user));
  });

  app.post("/api/queue/leave", (req, res) => {
    const user = requireUser(req, res);
    if (user) sendStoreResult(res, store.leaveQueue(user));
  });

  app.get("/api/admin/stats", (_req, res) => {
    res.json(store.stats());
  });

  app.post("/api/pay", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const result = store.createIntent(user);
    if (result.ok && !result.reused) {
      confirmPayment(result.intentId, {
        webhookUrl: config.webhookUrl(),
        secret: config.secret,
        chaos: config.chaos,
      });
    }

    sendStoreResult(res, result);
  });

  app.post("/webhooks/payments", (req, res) => {
    const rawBody = (req as any).rawBody ?? "";
    const signature = req.header("x-signature");

    if (!verifySignature(config.secret, rawBody, signature)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { event_id, type, intent_id, occurred_at } = req.body ?? {};
    if (!event_id || !type || !intent_id || typeof occurred_at !== "number") {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }

    // Always respond 200 to acknowledge receipt to the payment gateway
    const outcome = store.handleEvent({ event_id, type, intent_id, occurred_at });
    res.status(200).json(outcome);
  });

  return app;
}

