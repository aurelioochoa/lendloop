import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createTool, isoDate, setup, signIn } from "./test.helpers";

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "root@example.com");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("roles", () => {
  test("bootstrap admin comes from ADMIN_EMAILS, everyone else is a user", async () => {
    const t = setup();
    const { as: root } = await signIn(t, "Root", "root@example.com");
    const { as: ana } = await signIn(t, "Ana");
    expect((await root.query(api.users.me, {}))?.role).toBe("admin");
    expect((await ana.query(api.users.me, {}))?.role).toBe("user");
  });

  test("signed-out callers are rejected by authenticated functions", async () => {
    const t = setup();
    await expect(t.query(api.tools.list, {})).rejects.toThrow(/Sign in first/);
    await expect(
      t.mutation(api.tools.create, { name: "Saw", category: "hand_tools", condition: "good", description: "" }),
    ).rejects.toThrow(/Sign in first/);
  });
});

describe("listings", () => {
  test("users edit and delete only their own listings", async () => {
    const t = setup();
    const { as: ana } = await signIn(t, "Ana");
    const { as: bo } = await signIn(t, "Bo");
    const toolId = await createTool(ana);

    await expect(bo.mutation(api.tools.update, { toolId, name: "Mine now" })).rejects.toThrow(
      /only edit your own/,
    );
    await expect(bo.mutation(api.tools.remove, { toolId })).rejects.toThrow(/only remove your own/);

    await ana.mutation(api.tools.update, { toolId, name: "Drill (18V)" });
    expect((await ana.query(api.tools.mine, {}))[0].name).toBe("Drill (18V)");
  });

  test("admins can remove any listing but cannot edit it", async () => {
    const t = setup();
    const { as: ana } = await signIn(t, "Ana");
    const { as: root } = await signIn(t, "Root", "root@example.com");
    const toolId = await createTool(ana);

    await expect(root.mutation(api.tools.update, { toolId, name: "x" })).rejects.toThrow(/only edit your own/);
    await root.mutation(api.tools.remove, { toolId });
    expect(await t.query(api.tools.listPublic, {})).toEqual([]);
  });

  test("the public list shows only name and category of available tools", async () => {
    const t = setup();
    const { as: ana } = await signIn(t, "Ana");
    const { as: bo } = await signIn(t, "Bo");
    const lent = await createTool(ana, "Ladder");
    await createTool(ana, "Tent");

    const loanId = await bo.mutation(api.loans.request, {
      toolId: lent,
      startDate: isoDate(0),
      endDate: isoDate(2),
    });
    await ana.mutation(api.loans.approve, { loanId });

    const list = await t.query(api.tools.listPublic, {});
    expect(list.map((x) => x.name)).toEqual(["Tent"]);
    expect(Object.keys(list[0]).sort()).toEqual(["_id", "category", "name"]);
  });

  test("validates input on the server", async () => {
    const t = setup();
    const { as: ana } = await signIn(t, "Ana");
    await expect(
      ana.mutation(api.tools.create, { name: " ", category: "garden", condition: "good", description: "" }),
    ).rejects.toThrow(/at least 2/);
  });
});

describe("admin-only functions", () => {
  test("only admins can see the overview or mark trusted lenders", async () => {
    const t = setup();
    const { as: ana, userId: anaId } = await signIn(t, "Ana");
    const { as: root } = await signIn(t, "Root", "root@example.com");

    await expect(ana.query(api.admin.overview, {})).rejects.toThrow(/Admins only/);
    await expect(ana.mutation(api.admin.setTrustedLender, { userId: anaId, trusted: true })).rejects.toThrow(
      /Admins only/,
    );

    await root.mutation(api.admin.setTrustedLender, { userId: anaId, trusted: true });
    expect((await ana.query(api.users.me, {}))?.trustedLender).toBe(true);
    expect((await root.query(api.admin.overview, {})).users).toHaveLength(2);
  });
});
