import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { todayUtc } from "./lib/dates";

function shift(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Demo data for local review, run from the CLI only (internal functions can't be
 * called from the browser):
 *
 *   npx convex run seed:demo
 *
 * Creates three neighbors who can't sign in (their token identifiers don't come from
 * Clerk), a handful of tools and loans in every state, including one overdue loan for
 * the n8n reminder workflow. Writes directly, so no notifications are sent.
 */
export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const already = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", "seed|maya"))
      .unique();
    if (already !== null) return { seeded: false, reason: "Demo data already exists." };

    const today = todayUtc();
    const user = (key: string, name: string, trustedLender = false) =>
      ctx.db.insert("users", {
        tokenIdentifier: `seed|${key}`,
        name,
        email: `${key}@example.com`,
        role: "user",
        trustedLender,
      });
    const maya = await user("maya", "Maya Torres", true);
    const sam = await user("sam", "Sam Okafor");
    const lena = await user("lena", "Lena Fischer");

    const tool = (
      ownerId: Id<"users">,
      name: string,
      category: "power_tools" | "hand_tools" | "garden" | "kitchen" | "camping" | "cleaning" | "other",
      condition: "like_new" | "good" | "fair" | "worn",
      description: string,
    ) => ctx.db.insert("tools", { ownerId, name, category, condition, description });

    const drill = await tool(maya, "Cordless drill", "power_tools", "good", "18V, two batteries and a bit set.");
    const ladder = await tool(maya, "Extension ladder", "hand_tools", "fair", "Reaches about 6 m. Heavy, bring a friend.");
    const tent = await tool(sam, "4-person tent", "camping", "like_new", "Used twice. Includes footprint.");
    await tool(sam, "Pressure washer", "cleaning", "good", "Electric, 130 bar.");
    const mixer = await tool(lena, "Stand mixer", "kitchen", "worn", "Old but strong. Dough hook included.");
    await tool(lena, "Hedge trimmer", "garden", "good", "Battery powered.");

    const loan = (
      toolId: Id<"tools">,
      ownerId: Id<"users">,
      borrowerId: Id<"users">,
      startOffset: number,
      endOffset: number,
      status: "requested" | "approved" | "declined" | "cancelled" | "returned",
    ) =>
      ctx.db.insert("loans", {
        toolId,
        ownerId,
        borrowerId,
        startDate: shift(today, startOffset),
        endDate: shift(today, endOffset),
        status,
        ...(status === "requested" ? {} : { decidedAt: Date.now() }),
        ...(status === "returned" ? { returnedAt: Date.now() } : {}),
      });

    // Overdue: approved, ended two days ago, not returned. The reminder workflow picks it up.
    await loan(drill, maya, sam, -5, -2, "approved");
    // Currently out, not overdue yet.
    await loan(tent, sam, lena, -1, 3, "approved");
    // Waiting for the owner.
    await loan(ladder, maya, lena, 2, 4, "requested");
    // History.
    await loan(mixer, lena, maya, -10, -8, "returned");
    await loan(ladder, maya, sam, -12, -11, "declined");

    return { seeded: true, users: 3, tools: 6, loans: 5 };
  },
});
