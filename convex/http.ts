import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { todayUtc } from "./lib/dates";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignedRequest } from "./lib/hmac";

/**
 * Endpoints called by n8n. Every request must carry an HMAC signature made with
 * LENDLOOP_API_SECRET (a different secret from the one Convex uses to sign
 * webhooks it sends to n8n, so one leaked secret doesn't open both directions).
 */

const MAX_BODY_BYTES = 10_000;

export const PATHS = {
  overdueLoans: "/n8n/overdue-loans",
  reminderStatus: "/n8n/reminder-status",
  automationError: "/n8n/automation-error",
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function authorize(request: Request, path: string, body: string): Promise<Response | null> {
  const check = await verifySignedRequest({
    secret: process.env.LENDLOOP_API_SECRET,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
    method: request.method,
    path,
    body,
  });
  if (check.ok) return null;
  // The reason goes to the Convex logs, not to the caller.
  console.warn(`Rejected ${request.method} ${path}: ${check.reason}`);
  return json({ error: "unauthorized" }, 401);
}

async function readBody(request: Request): Promise<string | Response> {
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  return body;
}

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clientError(err: unknown): Response {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string };
    return json({ error: data?.message ?? "invalid request" }, 400);
  }
  throw err;
}

const http = httpRouter();

http.route({
  path: PATHS.overdueLoans,
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const denied = await authorize(request, PATHS.overdueLoans, "");
    if (denied) return denied;
    const today = todayUtc();
    const loans = await ctx.runQuery(internal.automation.overdueLoans, { today });
    return json({ date: today, loans });
  }),
});

http.route({
  path: PATHS.reminderStatus,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const denied = await authorize(request, PATHS.reminderStatus, body);
    if (denied) return denied;

    const data = parseObject(body);
    if (
      !data ||
      typeof data.idempotencyKey !== "string" ||
      typeof data.loanId !== "string" ||
      (data.outcome !== "sent" && data.outcome !== "failed") ||
      (data.detail !== undefined && typeof data.detail !== "string")
    ) {
      return json({ error: "expected { idempotencyKey, loanId, outcome: 'sent'|'failed', detail? }" }, 400);
    }
    try {
      const result = await ctx.runMutation(internal.automation.recordReminder, {
        idempotencyKey: data.idempotencyKey,
        loanId: data.loanId,
        outcome: data.outcome,
        detail: data.detail as string | undefined,
      });
      return json({ ok: true, ...result });
    } catch (err) {
      return clientError(err);
    }
  }),
});

http.route({
  path: PATHS.automationError,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const denied = await authorize(request, PATHS.automationError, body);
    if (denied) return denied;

    const data = parseObject(body);
    if (
      !data ||
      typeof data.workflow !== "string" ||
      typeof data.message !== "string" ||
      typeof data.executionId !== "string" ||
      (data.node !== undefined && typeof data.node !== "string")
    ) {
      return json({ error: "expected { workflow, message, executionId, node? }" }, 400);
    }
    const result = await ctx.runMutation(internal.automation.recordWorkflowError, {
      workflow: data.workflow,
      message: data.message,
      executionId: data.executionId,
      node: data.node as string | undefined,
    });
    return json({ ok: true, ...result });
  }),
});

export default http;
