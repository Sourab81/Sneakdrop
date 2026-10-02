import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface ChaosOptions {
  maxDelayMs: number;
  dupProb: number;
  reorderProb: number;
  failProb: number;
}

export type Chaos = ChaosOptions;

export const defaultChaos: ChaosOptions = {
  maxDelayMs: 2500,
  dupProb: 0.3,
  reorderProb: 0.3,
  failProb: 0.1,
};

export function sign(secret: string, rawPayload: string): string {
  return createHmac("sha256", secret).update(rawPayload).digest("hex");
}

export function verifySignature(secret: string, rawPayload: string, signature?: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(sign(secret, rawPayload));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const verify = verifySignature;

async function deliverWebhook(url: string, secret: string, event: object) {
  const rawPayload = JSON.stringify(event);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": sign(secret, rawPayload),
      },
      body: rawPayload,
    });
  } catch {
    // In production, the provider would retry on delivery failures
  }
}

interface PaymentConfig {
  webhookUrl: string;
  secret: string;
  chaos: ChaosOptions;
}

// Simulates asynchronous webhook notifications from a third-party payment gateway.
export function confirmPayment(intentId: string, config: PaymentConfig) {
  const { chaos, webhookUrl, secret } = config;
  const occurredAt = Date.now();
  const terminalType = Math.random() < chaos.failProb ? "payment.failed" : "payment.succeeded";

  let events = [
    { event_id: "evt_" + randomUUID(), type: "payment.processing", intent_id: intentId, occurred_at: occurredAt },
    { event_id: "evt_" + randomUUID(), type: terminalType, intent_id: intentId, occurred_at: occurredAt },
  ];

  if (Math.random() < chaos.reorderProb) {
    events = events.reverse();
  }

  for (const event of events) {
    const delay = Math.random() * chaos.maxDelayMs;

    setTimeout(() => deliverWebhook(webhookUrl, secret, event), delay);

    // Duplicate webhook delivery simulation
    if (Math.random() < chaos.dupProb) {
      setTimeout(() => deliverWebhook(webhookUrl, secret, event), delay + Math.random() * 1000);
    }
  }
}

