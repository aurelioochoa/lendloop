import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getViewer, isBootstrapAdmin, notFound } from "./lib/auth";
import { roleValidator } from "./schema";

/**
 * Called by the client right after sign-in. Creates (or refreshes) the user row
 * from the verified token, never from client-supplied fields.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first." });
    }
    const name = identity.name ?? identity.givenName ?? identity.nickname ?? "Neighbor";
    const email = identity.email;
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (existing !== null) {
      const patch: Partial<{ name: string; email: string; role: "admin" }> = {};
      if (existing.name !== name) patch.name = name;
      if (email && existing.email !== email) patch.email = email;
      if (existing.role !== "admin" && isBootstrapAdmin(email)) patch.role = "admin";
      if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name,
      email,
      role: isBootstrapAdmin(email) ? "admin" : "user",
      trustedLender: false,
    });
  },
});

/** What the UI needs about the viewer, and nothing more. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    if (viewer === null) return null;
    return {
      _id: viewer._id,
      name: viewer.name,
      role: viewer.role,
      trustedLender: viewer.trustedLender,
    };
  },
});

/**
 * Operator-only role change, run from the CLI:
 *   npx convex run users:setRole '{"email":"you@example.com","role":"admin"}'
 * Internal functions can't be called from the browser.
 */
export const setRole = internalMutation({
  args: { email: v.string(), role: roleValidator },
  handler: async (ctx, { email, role }) => {
    const target = email.trim().toLowerCase();
    const users = await ctx.db.query("users").collect();
    const user = users.find((u) => u.email?.toLowerCase() === target);
    if (!user) notFound(`No user with email ${email}. They must sign in once first.`);
    await ctx.db.patch(user._id, { role });
    return user._id;
  },
});
