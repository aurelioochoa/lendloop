import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { forbidden, invalid, notFound, requireViewer } from "./lib/auth";
import { rangesOverlap, todayUtc, validateLoanRange } from "./lib/dates";
import { enqueueNotification, type EventType } from "./notifications";

type LoanStatus = Doc<"loans">["status"];

const TRANSITIONS: Record<LoanStatus, LoanStatus[]> = {
  requested: ["approved", "declined", "cancelled"],
  approved: ["returned"],
  declined: [],
  cancelled: [],
  returned: [],
};

/** Every status change goes through here: one place for the state machine and the notification. */
async function transitionLoan(
  ctx: MutationCtx,
  loan: Doc<"loans">,
  to: LoanStatus,
  event: EventType,
): Promise<void> {
  if (!TRANSITIONS[loan.status].includes(to)) {
    invalid(`A ${loan.status} loan can't become ${to}.`);
  }
  const now = Date.now();
  await ctx.db.patch(loan._id, {
    status: to,
    ...(to === "returned" ? { returnedAt: now } : { decidedAt: now }),
  });
  await enqueueNotification(ctx, loan._id, event, to);
}

async function getLoan(ctx: QueryCtx, loanId: Id<"loans">): Promise<Doc<"loans">> {
  const loan = await ctx.db.get(loanId);
  if (loan === null) notFound("That request doesn't exist.");
  return loan;
}

async function approvedLoans(ctx: QueryCtx, toolId: Id<"tools">) {
  return await ctx.db
    .query("loans")
    .withIndex("by_tool_and_status", (q) => q.eq("toolId", toolId).eq("status", "approved"))
    .collect();
}

export const request = mutation({
  args: { toolId: v.id("tools"), startDate: v.string(), endDate: v.string() },
  handler: async (ctx, { toolId, startDate, endDate }) => {
    const viewer = await requireViewer(ctx);
    const tool = await ctx.db.get(toolId);
    if (tool === null || tool.removedAt !== undefined) notFound("That tool doesn't exist anymore.");
    if (tool.ownerId === viewer._id) invalid("You can't borrow your own tool.");
    validateLoanRange(startDate, endDate, todayUtc());

    const booked = await approvedLoans(ctx, toolId);
    if (booked.some((l) => rangesOverlap(startDate, endDate, l.startDate, l.endDate))) {
      invalid("Those dates are already booked.");
    }
    const pending = await ctx.db
      .query("loans")
      .withIndex("by_tool_and_status", (q) => q.eq("toolId", toolId).eq("status", "requested"))
      .collect();
    if (
      pending.some(
        (l) => l.borrowerId === viewer._id && rangesOverlap(startDate, endDate, l.startDate, l.endDate),
      )
    ) {
      invalid("You already have a pending request for these dates.");
    }

    const loanId = await ctx.db.insert("loans", {
      toolId,
      ownerId: tool.ownerId,
      borrowerId: viewer._id,
      startDate,
      endDate,
      status: "requested",
    });
    await enqueueNotification(ctx, loanId, "loan.requested", "requested");
    return loanId;
  },
});

/** Lender approves. Other pending requests that clash with these dates are declined automatically. */
export const approve = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await getLoan(ctx, loanId);
    if (loan.ownerId !== viewer._id) forbidden("Only the lender can approve this request.");

    const booked = await approvedLoans(ctx, loan.toolId);
    if (booked.some((l) => rangesOverlap(loan.startDate, loan.endDate, l.startDate, l.endDate))) {
      invalid("Those dates are already booked for this tool.");
    }
    await transitionLoan(ctx, loan, "approved", "loan.approved");

    const clashing = await ctx.db
      .query("loans")
      .withIndex("by_tool_and_status", (q) => q.eq("toolId", loan.toolId).eq("status", "requested"))
      .collect();
    for (const other of clashing) {
      if (rangesOverlap(loan.startDate, loan.endDate, other.startDate, other.endDate)) {
        await transitionLoan(ctx, other, "declined", "loan.declined");
      }
    }
  },
});

export const decline = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await getLoan(ctx, loanId);
    if (loan.ownerId !== viewer._id) forbidden("Only the lender can decline this request.");
    await transitionLoan(ctx, loan, "declined", "loan.declined");
  },
});

/** Borrower withdraws their own pending request. */
export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await getLoan(ctx, loanId);
    if (loan.borrowerId !== viewer._id) forbidden("Only the borrower can cancel this request.");
    await transitionLoan(ctx, loan, "cancelled", "loan.cancelled");
  },
});

/** The lender confirms the tool came back. */
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireViewer(ctx);
    const loan = await getLoan(ctx, loanId);
    if (loan.ownerId !== viewer._id) forbidden("Only the lender can mark this loan returned.");
    await transitionLoan(ctx, loan, "returned", "loan.returned");
  },
});

/** Latest automation activity for a loan, for the "Reminder sent 2 days ago" line. */
export async function loanActivity(ctx: QueryCtx, loanId: Id<"loans">) {
  const reminders = await ctx.db
    .query("automationEvents")
    .withIndex("by_loan", (q) => q.eq("loanId", loanId))
    .collect();
  const lastReminder = reminders.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const deliveries = await ctx.db
    .query("outbox")
    .withIndex("by_loan", (q) => q.eq("loanId", loanId))
    .collect();
  const lastDelivery = deliveries.sort((a, b) => b._creationTime - a._creationTime)[0];
  return {
    lastReminder: lastReminder
      ? { outcome: lastReminder.outcome, at: lastReminder.updatedAt }
      : null,
    lastNotification: lastDelivery
      ? {
          type: lastDelivery.type,
          status: lastDelivery.status,
          at: lastDelivery.deliveredAt ?? lastDelivery._creationTime,
        }
      : null,
  };
}

function isOverdue(loan: Doc<"loans">, today: string): boolean {
  return loan.status === "approved" && loan.endDate < today;
}

/** Loans where the viewer is the borrower. */
export const myRequests = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const today = todayUtc();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", viewer._id))
      .order("desc")
      .collect();
    return await Promise.all(
      loans.map(async (loan) => {
        const tool = await ctx.db.get(loan.toolId);
        return {
          _id: loan._id,
          toolName: tool?.name ?? "Removed tool",
          startDate: loan.startDate,
          endDate: loan.endDate,
          status: loan.status,
          overdue: isOverdue(loan, today),
          activity: await loanActivity(ctx, loan._id),
        };
      }),
    );
  },
});

/** Requests on the viewer's tools. The borrower's name is shown so the lender can decide; nothing else. */
export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const today = todayUtc();
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .order("desc")
      .collect();
    return await Promise.all(
      loans.map(async (loan) => {
        const [tool, borrower] = await Promise.all([
          ctx.db.get(loan.toolId),
          ctx.db.get(loan.borrowerId),
        ]);
        return {
          _id: loan._id,
          toolName: tool?.name ?? "Removed tool",
          borrowerName: borrower?.name ?? "Unknown",
          startDate: loan.startDate,
          endDate: loan.endDate,
          status: loan.status,
          overdue: isOverdue(loan, today),
          activity: await loanActivity(ctx, loan._id),
        };
      }),
    );
  },
});
