import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { notFound, requireAdmin } from "./lib/auth";
import { todayUtc } from "./lib/dates";
import { loanActivity } from "./loans";
import { requeueDelivery } from "./notifications";

/** Everything the admin screen shows. Removal of any listing goes through tools.remove. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const today = todayUtc();

    const users = await ctx.db.query("users").collect();
    const names = new Map(users.map((u) => [u._id, u.name]));

    const loans = await ctx.db.query("loans").order("desc").take(200);
    const loanRows = await Promise.all(
      loans.map(async (loan) => {
        const tool = await ctx.db.get(loan.toolId);
        return {
          _id: loan._id,
          toolName: tool?.name ?? "Removed tool",
          lenderName: names.get(loan.ownerId) ?? "Unknown",
          borrowerName: names.get(loan.borrowerId) ?? "Unknown",
          startDate: loan.startDate,
          endDate: loan.endDate,
          status: loan.status,
          overdue: loan.status === "approved" && loan.endDate < today,
          activity: await loanActivity(ctx, loan._id),
        };
      }),
    );

    const failedDeliveries = await ctx.db
      .query("outbox")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(50);

    const workflowErrors = await ctx.db.query("automationErrors").order("desc").take(20);

    return {
      users: users.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email ?? null,
        role: u.role,
        trustedLender: u.trustedLender,
      })),
      loans: loanRows,
      failedDeliveries: failedDeliveries.map((d) => ({
        _id: d._id,
        type: d.type,
        attempts: d.attempts,
        lastError: d.lastError ?? null,
        at: d._creationTime,
      })),
      workflowErrors: workflowErrors.map((e) => ({
        _id: e._id,
        workflow: e.workflow,
        node: e.node ?? null,
        message: e.message,
        at: e._creationTime,
      })),
    };
  },
});

export const setTrustedLender = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    await requireAdmin(ctx);
    if ((await ctx.db.get(userId)) === null) notFound("No such user.");
    await ctx.db.patch(userId, { trustedLender: trusted });
  },
});

export const retryDelivery = mutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    await requireAdmin(ctx);
    await requeueDelivery(ctx, outboxId);
  },
});
