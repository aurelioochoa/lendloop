// Smoke test for the n8n request-notification webhook, signing like Convex does.
// Usage: node --env-file=.env.n8n scripts/webhook-smoke.mjs [webhookUrl]
import { createHmac, randomUUID } from "node:crypto";

const url = process.argv[2] ?? "http://localhost:5678/webhook/lendloop-request";
const secret = process.env.N8N_WEBHOOK_SECRET;
if (!secret) throw new Error("N8N_WEBHOOK_SECRET is not set (run with --env-file=.env.n8n)");
const path = new URL(url).pathname;

function sign(body, timestamp, key = secret) {
  return "sha256=" + createHmac("sha256", key).update(`${timestamp}.POST.${path}.${body}`).digest("hex");
}

async function send(label, event, { key, skewSeconds = 0 } = {}) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000) - skewSeconds);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lendloop-timestamp": timestamp,
      "x-lendloop-signature": sign(body, timestamp, key),
      "x-lendloop-event-id": event.eventId ?? "",
    },
    body,
  });
  const text = await res.text();
  console.log(`${label.padEnd(34)} -> ${res.status} ${text.slice(0, 160)}`);
  return res.status;
}

const event = {
  eventId: randomUUID(),
  type: "loan.approved",
  occurredAt: Date.now(),
  loan: { id: "demo-loan", status: "approved", startDate: "2026-12-01", endDate: "2026-12-03" },
  tool: { name: "Cordless drill" },
  recipient: { role: "borrower", name: "Sam", email: "sam@example.com" },
};

const results = [
  (await send("valid event", event)) === 200,
  (await send("same eventId again (retry)", event)) === 200,
  (await send("wrong secret", { ...event, eventId: randomUUID() }, { key: "not-the-secret" })) === 401,
  (await send("timestamp 10 minutes old", { ...event, eventId: randomUUID() }, { skewSeconds: 600 })) === 401,
  (await send("signed but malformed (no tool)", { eventId: randomUUID(), type: "loan.approved" })) >= 500,
];
console.log(results.every(Boolean) ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
