import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createTool, isoDate, setup, signIn } from "./test.helpers";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});
afterEach(() => vi.unstubAllGlobals());

async function world() {
  const t = setup();
  const ana = await signIn(t, "Ana"); // lender
  const bo = await signIn(t, "Bo"); // borrower
  const cy = await signIn(t, "Cy"); // another borrower
  const toolId = await createTool(ana.as);
  return { t, ana, bo, cy, toolId };
}

describe("borrow requests", () => {
  test("you can't borrow your own tool", async () => {
    const { ana, toolId } = await world();
    await expect(
      ana.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(2) }),
    ).rejects.toThrow(/own tool/);
  });

  test("dates are validated", async () => {
    const { bo, toolId } = await world();
    const req = (startDate: string, endDate: string) =>
      bo.as.mutation(api.loans.request, { toolId, startDate, endDate });
    await expect(req(isoDate(-1), isoDate(1))).rejects.toThrow(/past/);
    await expect(req(isoDate(3), isoDate(1))).rejects.toThrow(/on or after/);
    await expect(req(isoDate(1), isoDate(40))).rejects.toThrow(/at most 30/);
    await expect(req("2026-02-30", "2026-03-01")).rejects.toThrow(/real date/);
  });

  test("approved dates can't be requested again", async () => {
    const { ana, bo, cy, toolId } = await world();
    const loanId = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(3) });
    await ana.as.mutation(api.loans.approve, { loanId });
    await expect(
      cy.as.mutation(api.loans.request, { toolId, startDate: isoDate(3), endDate: isoDate(5) }),
    ).rejects.toThrow(/already booked/);
    // Non-overlapping dates are fine.
    await cy.as.mutation(api.loans.request, { toolId, startDate: isoDate(4), endDate: isoDate(5) });
  });

  test("approving declines clashing pending requests", async () => {
    const { t, ana, bo, cy, toolId } = await world();
    const first = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(3) });
    const clash = await cy.as.mutation(api.loans.request, { toolId, startDate: isoDate(2), endDate: isoDate(4) });
    await ana.as.mutation(api.loans.approve, { loanId: first });
    const status = await t.run(async (ctx) => (await ctx.db.get(clash))?.status);
    expect(status).toBe("declined");
  });
});

describe("who may act on a request", () => {
  test("only the lender approves, declines or marks returned", async () => {
    const { ana, bo, cy, toolId } = await world();
    const loanId = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(0), endDate: isoDate(1) });

    await expect(bo.as.mutation(api.loans.approve, { loanId })).rejects.toThrow(/Only the lender/);
    await expect(cy.as.mutation(api.loans.decline, { loanId })).rejects.toThrow(/Only the lender/);
    await ana.as.mutation(api.loans.approve, { loanId });
    await expect(bo.as.mutation(api.loans.markReturned, { loanId })).rejects.toThrow(/Only the lender/);
    await ana.as.mutation(api.loans.markReturned, { loanId });
  });

  test("only the borrower cancels, and only while pending", async () => {
    const { ana, bo, toolId } = await world();
    const loanId = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(1) });
    await expect(ana.as.mutation(api.loans.cancel, { loanId })).rejects.toThrow(/Only the borrower/);
    await ana.as.mutation(api.loans.approve, { loanId });
    await expect(bo.as.mutation(api.loans.cancel, { loanId })).rejects.toThrow(/approved loan can't become cancelled/);
  });

  test("the state machine rejects impossible transitions", async () => {
    const { ana, bo, toolId } = await world();
    const loanId = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(1) });
    await expect(ana.as.mutation(api.loans.markReturned, { loanId })).rejects.toThrow(/requested loan can't become returned/);
    await ana.as.mutation(api.loans.decline, { loanId });
    await expect(ana.as.mutation(api.loans.approve, { loanId })).rejects.toThrow(/declined loan can't become approved/);
  });

  test("lists show each side only their own loans", async () => {
    const { ana, bo, cy, toolId } = await world();
    await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(2) });
    expect(await bo.as.query(api.loans.myRequests, {})).toHaveLength(1);
    expect(await cy.as.query(api.loans.myRequests, {})).toHaveLength(0);
    const incoming = await ana.as.query(api.loans.incoming, {});
    expect(incoming).toHaveLength(1);
    expect(incoming[0].borrowerName).toBe("Bo");
  });

  test("an owner can't delete a tool that is lent out; pending requests are withdrawn on delete", async () => {
    const { t, ana, bo, cy, toolId } = await world();
    const pending = await cy.as.mutation(api.loans.request, { toolId, startDate: isoDate(5), endDate: isoDate(6) });
    const lent = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(0), endDate: isoDate(1) });
    await ana.as.mutation(api.loans.approve, { loanId: lent });
    await expect(ana.as.mutation(api.tools.remove, { toolId })).rejects.toThrow(/lent out/);

    await ana.as.mutation(api.loans.markReturned, { loanId: lent });
    await ana.as.mutation(api.tools.remove, { toolId });
    expect(await t.run(async (ctx) => (await ctx.db.get(pending))?.status)).toBe("cancelled");
  });
});
