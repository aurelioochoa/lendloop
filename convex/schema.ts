import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const categoryValidator = v.union(
  v.literal("power_tools"),
  v.literal("hand_tools"),
  v.literal("garden"),
  v.literal("kitchen"),
  v.literal("camping"),
  v.literal("cleaning"),
  v.literal("other"),
);

export const conditionValidator = v.union(
  v.literal("like_new"),
  v.literal("good"),
  v.literal("fair"),
  v.literal("worn"),
);

/**
 * requested -> approved | declined | cancelled
 * approved  -> returned
 * Anything else is rejected by `transitionLoan` in convex/loans.ts.
 */
export const loanStatusValidator = v.union(
  v.literal("requested"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("cancelled"),
  v.literal("returned"),
);

export const roleValidator = v.union(v.literal("admin"), v.literal("user"));

export default defineSchema({
  users: defineTable({
    // Stable id from the auth provider (issuer|subject). Never trust a client-sent user id.
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    role: roleValidator,
    trustedLender: v.boolean(),
  }).index("by_token", ["tokenIdentifier"]),

  tools: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    category: categoryValidator,
    condition: conditionValidator,
    description: v.string(),
    // Soft delete keeps loan history intact and auditable.
    removedAt: v.optional(v.number()),
    removedBy: v.optional(v.id("users")),
  })
    .index("by_owner", ["ownerId"])
    .index("by_category", ["category"]),

  loans: defineTable({
    toolId: v.id("tools"),
    ownerId: v.id("users"),
    borrowerId: v.id("users"),
    startDate: v.string(), // YYYY-MM-DD (UTC calendar date)
    endDate: v.string(), // YYYY-MM-DD, inclusive
    status: loanStatusValidator,
    decidedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
  })
    .index("by_tool_and_status", ["toolId", "status"])
    .index("by_borrower", ["borrowerId"])
    .index("by_owner", ["ownerId"])
    .index("by_status_and_endDate", ["status", "endDate"]),

  // Outbound events to n8n. One row per event; retries reuse the same eventId
  // so the receiver can de-duplicate.
  outbox: defineTable({
    eventId: v.string(),
    type: v.string(),
    loanId: v.id("loans"),
    loanStatus: loanStatusValidator, // status at the moment of the event
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_loan", ["loanId"])
    .index("by_status", ["status"]),

  // Write-backs from n8n (overdue reminders). The idempotency key makes retries safe.
  automationEvents: defineTable({
    idempotencyKey: v.string(),
    loanId: v.id("loans"),
    kind: v.literal("overdue_reminder"),
    outcome: v.union(v.literal("sent"), v.literal("failed")),
    detail: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_loan", ["loanId"]),

  // Failures reported by the n8n error workflow, so a broken run is visible in the app.
  automationErrors: defineTable({
    workflow: v.string(),
    node: v.optional(v.string()),
    message: v.string(),
    executionId: v.string(),
  }).index("by_executionId", ["executionId"]),
});
