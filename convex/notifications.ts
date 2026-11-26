import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signRequest } from "./lib/hmac";

/**
 * Outbound notifications (Convex -> n8n "request notification" workflow).
 *
 * Mutations write an outbox row and schedule `deliver` in the same transaction, so
 * an event is never lost even when n8n is down. `deliver` signs the payload with
 * HMAC and retries with exponential backoff; after MAX_ATTEMPTS the row is marked
 * `failed` and shows up in the admin view instead of failing silently.
 */

export type EventType =
  | "loan.requested"
  | "loan.approved"
  | "loan.declined"
  | "loan.cancelled"
  | "loan.listing_removed"
  | "loan.returned";

/** Who must hear about each event. */
const RECIPIENT: Record<EventType, "owner" | "borrower"> = {
  "loan.requested": "owner",
  "loan.cancelled": "owner",
  "loan.approved": "borrower",
  "loan.declined": "borrower",
  "loan.listing_removed": "borrower",
  "loan.returned": "borrower",
};

export const MAX_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

export async function enqueueNotification(
  ctx: MutationCtx,
  loanId: Id<"loans">,
  type: EventType,
  loanStatus: Doc<"loans">["status"],
): Promise<void> {
  const outboxId = await ctx.db.insert("outbox", {
    eventId: crypto.randomUUID(),
    type,
    loanId,
    loanStatus,
    status: "pending",
    attempts: 0,
  });
  await ctx.scheduler.runAfter(0, internal.notifications.deliver, { outboxId });
}

/**
 * Builds the minimal payload at send time: only what the notification needs
 * (recipient name + email, tool name, dates, status). No ids of other users,
 * no descriptions, no phone numbers.
 */
export const getDelivery = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null || row.status !== "pending") return null;
    const loan = await ctx.db.get(row.loanId);
    if (loan === null) return null;
    const tool = await ctx.db.get(loan.toolId);
    const recipientRole = RECIPIENT[row.type as EventType] ?? "owner";
    const recipient = await ctx.db.get(recipientRole === "owner" ? loan.ownerId : loan.borrowerId);
    return {
      eventId: row.eventId,
      type: row.type,
      occurredAt: new Date(row._creationTime).toISOString(),
      loan: {
        id: loan._id,
        status: row.loanStatus,
        startDate: loan.startDate,
        endDate: loan.endDate,
      },
      tool: { name: tool?.name ?? "Removed tool" },
      recipient: {
        role: recipientRole,
        name: recipient?.name ?? "Neighbor",
        email: recipient?.email ?? null,
      },
    };
  },
});

export const deliver = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const payload = await ctx.runQuery(internal.notifications.getDelivery, { outboxId });
    if (payload === null) return;

    const url = process.env.N8N_REQUEST_WEBHOOK_URL;
    const secret = process.env.N8N_WEBHOOK_SECRET;
    if (!url || !secret) {
      await ctx.runMutation(internal.notifications.recordAttempt, {
        outboxId,
        ok: false,
        retryable: false,
        error: "N8N_REQUEST_WEBHOOK_URL or N8N_WEBHOOK_SECRET is not set",
      });
      return;
    }

    const body = JSON.stringify(payload);
    const { timestamp, signature } = await signRequest({
      secret,
      method: "POST",
      path: new URL(url).pathname,
      body,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signature,
          [EVENT_ID_HEADER]: payload.eventId,
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        await ctx.runMutation(internal.notifications.recordAttempt, { outboxId, ok: true });
      } else {
        // 4xx other than 408/429 means our request is wrong; retrying won't fix it.
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        await ctx.runMutation(internal.notifications.recordAttempt, {
          outboxId,
          ok: false,
          retryable,
          error: `n8n answered HTTP ${res.status}`,
        });
      }
    } catch (err) {
      await ctx.runMutation(internal.notifications.recordAttempt, {
        outboxId,
        ok: false,
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  },
});

export const recordAttempt = internalMutation({
  args: {
    outboxId: v.id("outbox"),
    ok: v.boolean(),
    retryable: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { outboxId, ok, retryable, error }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null || row.status !== "pending") return;
    const attempts = row.attempts + 1;

    if (ok) {
      await ctx.db.patch(outboxId, { status: "delivered", attempts, deliveredAt: Date.now() });
      return;
    }
    if (retryable && attempts < MAX_ATTEMPTS) {
      await ctx.db.patch(outboxId, { attempts, lastError: error });
      await ctx.scheduler.runAfter(backoffMs(attempts), internal.notifications.deliver, { outboxId });
      return;
    }
    await ctx.db.patch(outboxId, { status: "failed", attempts, lastError: error });
  },
});

/** Used by the admin "retry" button for a failed delivery. Same eventId, so n8n can de-duplicate. */
export async function requeueDelivery(ctx: MutationCtx, outboxId: Id<"outbox">): Promise<void> {
  const row = await ctx.db.get(outboxId);
  if (row === null || row.status !== "failed") return;
  await ctx.db.patch(outboxId, { status: "pending", attempts: 0, lastError: undefined });
  await ctx.scheduler.runAfter(0, internal.notifications.deliver, { outboxId });
}
