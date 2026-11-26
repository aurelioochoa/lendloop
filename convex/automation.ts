import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { invalid, notFound } from "./lib/auth";
import { daysBetween } from "./lib/dates";

/**
 * Data access for the n8n-facing HTTP endpoints in convex/http.ts.
 * These are internal: only the signed HTTP actions can reach them.
 */

export function reminderKey(loanId: string, date: string): string {
  return `overdue:${loanId}:${date}`;
}

const KEY_PATTERN = /^overdue:([^:]+):(\d{4}-\d{2}-\d{2})$/;

/**
 * Approved loans past their end date that haven't had a successful reminder today.
 * Returns only what the reminder needs: borrower name + email, tool name, dates.
 */
export const overdueLoans = internalQuery({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_status_and_endDate", (q) => q.eq("status", "approved").lt("endDate", today))
      .collect();

    const result = [];
    for (const loan of loans) {
      const idempotencyKey = reminderKey(loan._id, today);
      const already = await ctx.db
        .query("automationEvents")
        .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey))
        .unique();
      if (already?.outcome === "sent") continue;

      const [tool, borrower] = await Promise.all([ctx.db.get(loan.toolId), ctx.db.get(loan.borrowerId)]);
      result.push({
        loanId: loan._id,
        idempotencyKey,
        toolName: tool?.name ?? "Removed tool",
        endDate: loan.endDate,
        daysOverdue: daysBetween(loan.endDate, today),
        borrower: { name: borrower?.name ?? "Neighbor", email: borrower?.email ?? null },
      });
    }
    return result;
  },
});

/**
 * Idempotent write-back. The same key twice changes nothing; a "failed" can later be
 * upgraded to "sent" by a successful retry, never the other way round.
 */
export const recordReminder = internalMutation({
  args: {
    idempotencyKey: v.string(),
    loanId: v.string(),
    outcome: v.union(v.literal("sent"), v.literal("failed")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const match = KEY_PATTERN.exec(args.idempotencyKey);
    if (!match || match[1] !== args.loanId) invalid("idempotencyKey doesn't match loanId.");
    const loanId = ctx.db.normalizeId("loans", args.loanId);
    if (loanId === null) invalid("Unknown loanId.");
    if ((await ctx.db.get(loanId)) === null) notFound("Unknown loanId.");

    const detail = args.detail?.slice(0, 300);
    const existing = await ctx.db
      .query("automationEvents")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();

    if (existing === null) {
      await ctx.db.insert("automationEvents", {
        idempotencyKey: args.idempotencyKey,
        loanId,
        kind: "overdue_reminder",
        outcome: args.outcome,
        detail,
        updatedAt: Date.now(),
      });
      return { duplicate: false };
    }
    if (existing.outcome === "failed" && args.outcome === "sent") {
      await ctx.db.patch(existing._id, { outcome: "sent", detail, updatedAt: Date.now() });
      return { duplicate: false };
    }
    return { duplicate: true };
  },
});

/** Called by the n8n error workflow. One row per failed execution, however often it is retried. */
export const recordWorkflowError = internalMutation({
  args: {
    workflow: v.string(),
    node: v.optional(v.string()),
    message: v.string(),
    executionId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("automationErrors")
      .withIndex("by_executionId", (q) => q.eq("executionId", args.executionId))
      .unique();
    if (existing !== null) return { duplicate: true };
    await ctx.db.insert("automationErrors", {
      workflow: args.workflow.slice(0, 120),
      node: args.node?.slice(0, 120),
      message: args.message.slice(0, 500),
      executionId: args.executionId.slice(0, 120),
    });
    return { duplicate: false };
  },
});
