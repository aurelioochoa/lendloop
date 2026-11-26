import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { forbidden, invalid, notFound, requireViewer } from "./lib/auth";
import { todayUtc } from "./lib/dates";
import { enqueueNotification } from "./notifications";
import { categoryValidator, conditionValidator } from "./schema";

type Ctx = QueryCtx | MutationCtx;

/** A tool is "out" while an approved loan has started and hasn't been returned (this includes overdue loans). */
export async function isToolOut(ctx: Ctx, toolId: Id<"tools">, today: string): Promise<boolean> {
  const approved = await ctx.db
    .query("loans")
    .withIndex("by_tool_and_status", (q) => q.eq("toolId", toolId).eq("status", "approved"))
    .collect();
  return approved.some((loan) => loan.startDate <= today);
}

function cleanText(value: string, field: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min) invalid(`${field} must be at least ${min} characters.`);
  if (trimmed.length > max) invalid(`${field} must be at most ${max} characters.`);
  return trimmed;
}

async function activeTool(ctx: Ctx, toolId: Id<"tools">): Promise<Doc<"tools">> {
  const tool = await ctx.db.get(toolId);
  if (tool === null || tool.removedAt !== undefined) notFound("That tool doesn't exist anymore.");
  return tool;
}

/**
 * Public, signed-out list: available tools, name and category only.
 * No owner details leave the backend here.
 */
export const listPublic = query({
  args: {},
  handler: async (ctx) => {
    const today = todayUtc();
    const tools = await ctx.db.query("tools").collect();
    const result: { _id: Id<"tools">; name: string; category: Doc<"tools">["category"] }[] = [];
    for (const tool of tools) {
      if (tool.removedAt !== undefined) continue;
      if (await isToolOut(ctx, tool._id, today)) continue;
      result.push({ _id: tool._id, name: tool.name, category: tool.category });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Signed-in browse view: every tool with its availability, optionally by category. */
export const list = query({
  args: { category: v.optional(categoryValidator) },
  handler: async (ctx, { category }) => {
    const viewer = await requireViewer(ctx);
    const today = todayUtc();
    const tools = category
      ? await ctx.db.query("tools").withIndex("by_category", (q) => q.eq("category", category)).collect()
      : await ctx.db.query("tools").collect();

    const rows = [];
    for (const tool of tools) {
      if (tool.removedAt !== undefined) continue;
      const owner = await ctx.db.get(tool.ownerId);
      rows.push({
        _id: tool._id,
        name: tool.name,
        category: tool.category,
        condition: tool.condition,
        description: tool.description,
        available: !(await isToolOut(ctx, tool._id, today)),
        isMine: tool.ownerId === viewer._id,
        lenderTrusted: owner?.trustedLender ?? false,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const today = todayUtc();
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .collect();
    const rows = [];
    for (const tool of tools) {
      if (tool.removedAt !== undefined) continue;
      const pending = await ctx.db
        .query("loans")
        .withIndex("by_tool_and_status", (q) => q.eq("toolId", tool._id).eq("status", "requested"))
        .collect();
      rows.push({
        _id: tool._id,
        name: tool.name,
        category: tool.category,
        condition: tool.condition,
        description: tool.description,
        available: !(await isToolOut(ctx, tool._id, today)),
        pendingRequests: pending.length,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    category: categoryValidator,
    condition: conditionValidator,
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    return await ctx.db.insert("tools", {
      ownerId: viewer._id,
      name: cleanText(args.name, "Name", 2, 60),
      category: args.category,
      condition: args.condition,
      description: cleanText(args.description, "Description", 0, 500),
    });
  },
});

/** Owners edit their own listings only. Admin moderation is removal, not editing. */
export const update = mutation({
  args: {
    toolId: v.id("tools"),
    name: v.optional(v.string()),
    category: v.optional(categoryValidator),
    condition: v.optional(conditionValidator),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { toolId, ...fields }) => {
    const viewer = await requireViewer(ctx);
    const tool = await activeTool(ctx, toolId);
    if (tool.ownerId !== viewer._id) forbidden("You can only edit your own listings.");

    const patch: Partial<Doc<"tools">> = {};
    if (fields.name !== undefined) patch.name = cleanText(fields.name, "Name", 2, 60);
    if (fields.description !== undefined) {
      patch.description = cleanText(fields.description, "Description", 0, 500);
    }
    if (fields.category !== undefined) patch.category = fields.category;
    if (fields.condition !== undefined) patch.condition = fields.condition;
    await ctx.db.patch(toolId, patch);
  },
});

/**
 * Owners remove their own listings; admins can remove any listing.
 * An owner can't remove a tool that is currently lent out. Pending requests are
 * withdrawn and those borrowers get notified.
 */
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const viewer = await requireViewer(ctx);
    const tool = await activeTool(ctx, toolId);
    const isOwner = tool.ownerId === viewer._id;
    if (!isOwner && viewer.role !== "admin") forbidden("You can only remove your own listings.");

    if (isOwner && viewer.role !== "admin" && (await isToolOut(ctx, toolId, todayUtc()))) {
      invalid("This tool is lent out right now. Mark it returned first.");
    }

    const pending = await ctx.db
      .query("loans")
      .withIndex("by_tool_and_status", (q) => q.eq("toolId", toolId).eq("status", "requested"))
      .collect();
    for (const loan of pending) {
      await ctx.db.patch(loan._id, { status: "cancelled", decidedAt: Date.now() });
      await enqueueNotification(ctx, loan._id, "loan.listing_removed", "cancelled");
    }

    await ctx.db.patch(toolId, { removedAt: Date.now(), removedBy: viewer._id });
  },
});
