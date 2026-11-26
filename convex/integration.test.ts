import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { reminderKey } from "./automation";
import { PATHS } from "./http";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, hmacSha256Hex, signRequest, verifySignedRequest } from "./lib/hmac";
import { MAX_ATTEMPTS } from "./notifications";
import { createTool, isoDate, setup, signIn, type T } from "./test.helpers";

const WEBHOOK_URL = "http://n8n.test/webhook/lendloop-request";
const WEBHOOK_SECRET = "convex-to-n8n-secret";
const API_SECRET = "n8n-to-convex-secret";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("N8N_REQUEST_WEBHOOK_URL", WEBHOOK_URL);
  vi.stubEnv("N8N_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("LENDLOOP_API_SECRET", API_SECRET);
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function signedFetch(t: T, method: "GET" | "POST", path: string, payload?: unknown, secret = API_SECRET) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const { timestamp, signature } = await signRequest({ secret, method, path, body });
  return await t.fetch(path, {
    method,
    headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : body,
  });
}

/** An approved loan that ended `daysAgo` days ago and hasn't been returned. */
async function overdueLoan(t: T, daysAgo = 2) {
  const ana = await signIn(t, "Ana");
  const bo = await signIn(t, "Bo");
  const toolId = await createTool(ana.as);
  const loanId = await t.run(async (ctx) =>
    ctx.db.insert("loans", {
      toolId,
      ownerId: ana.userId,
      borrowerId: bo.userId,
      startDate: isoDate(-daysAgo - 3),
      endDate: isoDate(-daysAgo),
      status: "approved",
    }),
  );
  return { ana, bo, toolId, loanId };
}

describe("HMAC helpers", () => {
  test("round trip, wrong secret, tampered body, stale timestamp", async () => {
    const base = { method: "POST", path: "/x", body: '{"a":1}' };
    const signed = await signRequest({ secret: "s", ...base });
    const verify = (over: Partial<Parameters<typeof verifySignedRequest>[0]>) =>
      verifySignedRequest({ secret: "s", ...base, ...signed, ...over });

    expect(await verify({})).toEqual({ ok: true });
    expect((await verify({ secret: "other" })).ok).toBe(false);
    expect((await verify({ body: '{"a":2}' })).ok).toBe(false);
    expect((await verify({ path: "/y" })).ok).toBe(false);
    expect((await verify({ nowSeconds: Number(signed.timestamp) + 301 })).ok).toBe(false);
    expect((await verify({ secret: undefined })).ok).toBe(false);
  });

  test("matches a known HMAC-SHA256 vector (RFC 4231 case 2)", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("Convex -> n8n request notifications", () => {
  test("a new request sends one signed, minimal payload to the lender", async () => {
    const t = setup();
    const ana = await signIn(t, "Ana");
    const bo = await signIn(t, "Bo");
    const toolId = await createTool(ana.as);
    await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(2) });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    const check = await verifySignedRequest({
      secret: WEBHOOK_SECRET,
      timestamp: headers[TIMESTAMP_HEADER],
      signature: headers[SIGNATURE_HEADER],
      method: "POST",
      path: "/webhook/lendloop-request",
      body,
    });
    expect(check).toEqual({ ok: true });

    const payload = JSON.parse(body);
    expect(payload.type).toBe("loan.requested");
    expect(payload.recipient).toEqual({ role: "owner", name: "Ana", email: "ana@example.com" });
    // Data minimization: the borrower's identity is not in a message to the lender.
    expect(body).not.toContain("bo@example.com");
    expect(Object.keys(payload).sort()).toEqual(["eventId", "loan", "occurredAt", "recipient", "tool", "type"]);
  });

  test("status changes notify the borrower", async () => {
    const t = setup();
    const ana = await signIn(t, "Ana");
    const bo = await signIn(t, "Bo");
    const toolId = await createTool(ana.as);
    const loanId = await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(2) });
    await ana.as.mutation(api.loans.approve, { loanId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent.map((p) => [p.type, p.recipient.role])).toEqual([
      ["loan.requested", "owner"],
      ["loan.approved", "borrower"],
    ]);
  });

  test("failures are retried with backoff, then marked failed (never silent)", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const t = setup();
    const ana = await signIn(t, "Ana");
    const bo = await signIn(t, "Bo");
    const toolId = await createTool(ana.as);
    await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(2) });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    const eventIds = new Set(
      fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["X-LendLoop-Event-Id"]),
    );
    expect(eventIds.size).toBe(1); // retries reuse the event id so n8n can de-duplicate
    const rows = await t.run(async (ctx) => ctx.db.query("outbox").collect());
    expect(rows[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "n8n answered HTTP 503" });
  });

  test("a 4xx from n8n is not retried", async () => {
    fetchMock.mockImplementation(async () => new Response("bad", { status: 401 }));
    const t = setup();
    const ana = await signIn(t, "Ana");
    const bo = await signIn(t, "Bo");
    const toolId = await createTool(ana.as);
    await bo.as.mutation(api.loans.request, { toolId, startDate: isoDate(1), endDate: isoDate(2) });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("n8n -> Convex endpoints", () => {
  test("rejects missing, wrong and stale signatures", async () => {
    const t = setup();
    expect((await t.fetch(PATHS.overdueLoans, { method: "GET" })).status).toBe(401);
    expect((await signedFetch(t, "GET", PATHS.overdueLoans, undefined, "wrong-secret")).status).toBe(401);

    const { timestamp, signature } = await signRequest({
      secret: API_SECRET,
      method: "GET",
      path: PATHS.overdueLoans,
      body: "",
      nowSeconds: Math.floor(Date.now() / 1000) - 3600,
    });
    const stale = await t.fetch(PATHS.overdueLoans, {
      method: "GET",
      headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature },
    });
    expect(stale.status).toBe(401);
  });

  test("overdue endpoint returns only what a reminder needs", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t, 2);
    const res = await signedFetch(t, "GET", PATHS.overdueLoans);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.loans).toHaveLength(1);
    expect(data.loans[0]).toEqual({
      loanId,
      idempotencyKey: reminderKey(loanId, data.date),
      toolName: "Cordless drill",
      endDate: isoDate(-2),
      daysOverdue: 2,
      borrower: { name: "Bo", email: "bo@example.com" },
    });
  });

  test("reminder write-back is idempotent and hides the loan for the rest of the day", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const { date } = await (await signedFetch(t, "GET", PATHS.overdueLoans)).json();
    const payload = { idempotencyKey: reminderKey(loanId, date), loanId, outcome: "sent" };

    const first = await (await signedFetch(t, "POST", PATHS.reminderStatus, payload)).json();
    const second = await (await signedFetch(t, "POST", PATHS.reminderStatus, payload)).json();
    expect(first).toEqual({ ok: true, duplicate: false });
    expect(second).toEqual({ ok: true, duplicate: true });

    const rows = await t.run(async (ctx) => ctx.db.query("automationEvents").collect());
    expect(rows).toHaveLength(1);
    expect((await (await signedFetch(t, "GET", PATHS.overdueLoans)).json()).loans).toHaveLength(0);
  });

  test("a failed reminder can be upgraded to sent by a retry, not downgraded", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const key = reminderKey(loanId, isoDate(0));
    const post = (outcome: string) =>
      signedFetch(t, "POST", PATHS.reminderStatus, { idempotencyKey: key, loanId, outcome });

    await post("failed");
    expect((await (await signedFetch(t, "GET", PATHS.overdueLoans)).json()).loans).toHaveLength(1);
    await post("sent");
    await post("failed");
    const rows = await t.run(async (ctx) => ctx.db.query("automationEvents").collect());
    expect(rows.map((r) => r.outcome)).toEqual(["sent"]);
  });

  test("rejects a key that belongs to another loan, and malformed bodies", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const wrongKey = await signedFetch(t, "POST", PATHS.reminderStatus, {
      idempotencyKey: "overdue:someOtherLoan:2026-01-01",
      loanId,
      outcome: "sent",
    });
    expect(wrongKey.status).toBe(400);
    const malformed = await signedFetch(t, "POST", PATHS.reminderStatus, { loanId });
    expect(malformed.status).toBe(400);
  });

  test("workflow errors are recorded once per execution and shown to admins", async () => {
    vi.stubEnv("ADMIN_EMAILS", "root@example.com");
    const t = setup();
    const err = { workflow: "Overdue reminders", node: "Fetch overdue loans", message: "timeout", executionId: "42" };
    await signedFetch(t, "POST", PATHS.automationError, err);
    await signedFetch(t, "POST", PATHS.automationError, err);
    const { as: root } = await signIn(t, "Root", "root@example.com");
    const overview = await root.query(api.admin.overview, {});
    expect(overview.workflowErrors).toHaveLength(1);
    expect(overview.workflowErrors[0]).toMatchObject({ workflow: "Overdue reminders", message: "timeout" });
  });

  test("the loan shows its latest automation activity", async () => {
    const t = setup();
    const { bo, loanId } = await overdueLoan(t);
    await signedFetch(t, "POST", PATHS.reminderStatus, {
      idempotencyKey: reminderKey(loanId, isoDate(0)),
      loanId,
      outcome: "sent",
    });
    const [mine] = await bo.as.query(api.loans.myRequests, {});
    expect(mine.overdue).toBe(true);
    expect(mine.activity.lastReminder?.outcome).toBe("sent");
    expect(mine._id).toBe(loanId as Id<"loans">);
  });
});
