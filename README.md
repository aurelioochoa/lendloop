# LendLoop

**Borrow what you need. Lend what you don't.**

A neighborhood tool-lending app. People list tools they own, ask to borrow other people's tools for a date range, and owners approve or decline. Admins moderate listings and mark Trusted Lenders. n8n handles the automations: it notifies people when a request is created or changes, and it sends a daily reminder for overdue loans, writing the result back to Convex.

Stack: Next.js 16 (App Router) · Clerk · Convex · n8n 2.x · TypeScript.

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Running it locally](#running-it-locally)
- [Environment variables](#environment-variables)
- [Roles and permissions](#roles-and-permissions)
- [Automations](#automations)
- [Security and privacy](#security-and-privacy)
- [Tests](#tests)
- [Taking it to production (AWS)](#taking-it-to-production-aws)
- [Trade-offs and next steps](#trade-offs-and-next-steps)

## What it does

| Who | Can |
|---|---|
| Visitor | See what's available (tool name and category only) and sign in |
| Member | List, edit and delete their tools; browse by category; request a tool for a date range; cancel their own request; approve, decline and mark returned on requests for their tools; see when a reminder or notification last went out |
| Admin | Everything a member can, plus remove any listing, mark or unmark Trusted Lenders, see every loan, see failed notifications and n8n workflow errors, and retry a failed notification |

Loan rules, enforced on the server:

- Requests can't start in the past, must end on or after the start, and last at most 30 days.
- You can't borrow your own tool, or have two pending requests for the same tool.
- Approving checks the dates again against other approved loans. Pending requests that clash are declined automatically, and their borrowers are notified.
- Allowed status changes: `requested → approved | declined | cancelled`, then `approved → returned`. Nothing else.
- A tool that is out on loan can't be deleted by its owner. Deleting a listing cancels its pending requests and notifies those borrowers.

## Architecture

```
 Browser (Next.js + Clerk)
   │  Clerk session → Convex token (JWT, verified by Convex)
   ▼
 Convex ── queries / mutations: every permission check lives here
   │  ├─ outbox table ── scheduled action ──► POST n8n webhook (HMAC-signed, retried with backoff)
   │  └─ HTTP actions  ◄── n8n (HMAC-signed): overdue loans, reminder write-back, workflow errors
   ▼
 n8n
   ├─ Request notifications   webhook → verify signature → de-duplicate → notify → 200
   ├─ Overdue reminders       daily 09:00 → fetch overdue → remind → write back (idempotent)
   └─ Error handler           any failed run → recorded in Convex → visible in the Admin tab
```

| Path | What's there |
|---|---|
| `convex/schema.ts` | Tables: users, tools, loans, outbox, automationEvents, automationErrors |
| `convex/lib/auth.ts` | `requireViewer`, `requireAdmin`, typed errors |
| `convex/lib/hmac.ts` | Signing and verification (Web Crypto, constant-time compare) |
| `convex/tools.ts`, `convex/loans.ts` | Listings and the loan state machine |
| `convex/notifications.ts` | Outbox, delivery to n8n, retries |
| `convex/http.ts`, `convex/automation.ts` | Endpoints n8n calls, idempotent write-back |
| `convex/admin.ts` | Admin overview and actions |
| `convex/seed.ts` | Demo data (`npx convex run seed:demo`) |
| `app/`, `components/` | UI: public page, dashboard tabs, admin panel |
| `proxy.ts` | Clerk keeps signed-out visitors off `/dashboard` |
| `n8n/workflows/*.json` | Exported workflows, ready to import |
| `n8n/generate-workflows.mjs` | Source the JSON is generated from (diff-friendly) |
| `docker-compose.yml` | n8n, which imports and publishes the workflows on first start |

## Running it locally

You need Node 20+, Docker and a free Clerk account. Convex can run as a local backend with no account.

**1. Install**

```bash
npm install
cp .env.local.example .env.local
```

**2. Clerk.** Create an application in the [Clerk dashboard](https://dashboard.clerk.com), then [activate the Convex integration](https://dashboard.clerk.com/apps/setup/convex). Put the publishable and secret keys in `.env.local`. Copy the **Frontend API URL** (for example `https://verb-noun-00.clerk.accounts.dev`) for the next step.

**3. Convex**

```bash
npx convex dev            # leave it running; choose local deployment when asked
# in a second terminal:
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://verb-noun-00.clerk.accounts.dev
npx convex env set ADMIN_EMAILS you@example.com        # becomes admin on first sign-in
scripts/setup-secrets.sh  # creates .env.n8n with two fresh secrets and sets them on Convex
```

**4. n8n**

```bash
docker compose up -d      # http://localhost:5678; create the owner account on first visit
```

The three workflows are imported and published on first start. They read their secrets from `.env.n8n`, and no credential needs setting up inside n8n.

**5. App**

```bash
npm run dev               # http://localhost:3000
npx convex run seed:demo  # optional: demo neighbors, tools and one overdue loan
```

Sign in with the email from `ADMIN_EMAILS` to see the Admin tab. To promote someone later: `npx convex run users:setRole '{"email":"them@example.com","role":"admin"}'`.

**Using a Convex cloud deployment instead.** Set `LENDLOOP_CONVEX_SITE_URL` in `.env.n8n` to your `https://<deployment>.convex.site`. Convex then has to reach n8n over the internet: expose port 5678 with a tunnel (cloudflared, ngrok) and run `N8N_REQUEST_WEBHOOK_URL=https://<tunnel>/webhook/lendloop-request scripts/setup-secrets.sh`.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `.env.local` | Clerk |
| `NEXT_PUBLIC_CONVEX_URL` | `.env.local` | Written by `npx convex dev` |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex | Clerk Frontend API URL; Convex checks tokens against it |
| `ADMIN_EMAILS` | Convex | Optional comma-separated list; these users become admins on sign-in |
| `N8N_REQUEST_WEBHOOK_URL` | Convex | The n8n webhook Convex posts loan events to |
| `N8N_WEBHOOK_SECRET` | Convex **and** `.env.n8n` | HMAC secret for Convex → n8n |
| `LENDLOOP_API_SECRET` | Convex **and** `.env.n8n` | HMAC secret for n8n → Convex, a different value |
| `LENDLOOP_CONVEX_SITE_URL` | `.env.n8n` | Where n8n reaches Convex HTTP actions |
| `GENERIC_TIMEZONE` | `.env.n8n` | Timezone of the daily 09:00 run |

`.env.local` and `.env.n8n` are git-ignored, and only the `*.example` files are committed. Next.js never loads `.env.n8n`, so the HMAC secrets stay out of the web app's process.

## Roles and permissions

The UI hides what you can't do, but the rules live only in Convex functions. Each one loads the signed-in user from the verified token, never from client input, then checks ownership or role.

| Action | Rule |
|---|---|
| Edit a listing | Owner only. Admins can remove a listing but not change it |
| Delete a listing | Owner (not while it's lent out) or admin |
| Request | Signed in, not your own tool, valid dates, no clash with approved loans |
| Approve, decline, mark returned | Owner of the tool |
| Cancel | Borrower, while the request is pending |
| Trusted Lender, retry notification, see all loans | Admin |
| Change roles | Operators only, from the CLI (`users:setRole` is an internal function) |

The public page calls a query that returns only `{ name, category }`. Descriptions, owners and loans need a session.

## Automations

### 1. Request notifications (Convex → n8n)

When a request is created, approved, declined, cancelled, returned, or cancelled because its listing was removed, the mutation writes an **outbox** row in the same transaction and schedules delivery. So an event is never lost because a mutation committed and the HTTP call didn't happen.

- **Payload** (minimal): event id and type, loan id, status and dates, tool name, and the recipient's role, name and email. No other user data.
- **Signature**: `X-LendLoop-Signature: sha256=HMAC(secret, "<timestamp>.POST.<path>.<raw body>")`, plus `X-LendLoop-Timestamp` and `X-LendLoop-Event-Id`. n8n verifies against the **raw** body, rejects timestamps more than 5 minutes off, and compares in constant time.
- **Retries**: on a network error, timeout (10 s) or 5xx, Convex retries after 30 s, 1 min, 2 min, then 4 min. After 5 attempts the row is marked failed and shows in the Admin tab with a Retry button. A 4xx other than 408 or 429 isn't retried, because a bad signature won't fix itself.
- **De-duplication**: a retry reuses the event id. n8n remembers handled ids, so a retry after a lost response doesn't notify twice.
- **Notification**: the "Notify recipient" node is a mock that builds the message and shows it, with the email masked, in the execution output. Replace it with Send Email, Slack or Discord.

### 2. Overdue reminders (n8n → Convex)

Runs daily at 09:00 (there's also a **Run now** trigger):

1. A signed `GET /n8n/overdue-loans` returns approved loans whose end date has passed, minus those already reminded today. Each one carries an idempotency key, `overdue:<loanId>:<date>`.
2. For each loan, a mock reminder goes to the borrower.
3. A signed `POST /n8n/reminder-status` writes `sent` or `failed` back under that key. Writing the same key twice is a no-op, and `failed` can later be upgraded to `sent` but never downgraded. Re-runs and HTTP retries therefore never double-count, and borrowers see "Reminder sent 2 days ago" on their loans.

### 3. Error handling

- Every HTTP node retries 3 times, 5 s apart.
- Both workflows name **LendLoop · Error handler** as their error workflow. It posts the workflow, node, message and execution id to `POST /n8n/automation-error`, de-duplicated by execution id, and admins see it in the Admin tab.
- If the webhook workflow fails before it answers, n8n returns 500, so Convex retries the event.

### Convex HTTP endpoints (for n8n)

| Method and path | Body | Returns |
|---|---|---|
| `GET /n8n/overdue-loans` | none | `{ date, loans: [{ loanId, idempotencyKey, toolName, endDate, daysOverdue, borrower: { name, email } }] }` |
| `POST /n8n/reminder-status` | `{ idempotencyKey, loanId, outcome: "sent"\|"failed", detail? }` | `{ ok, duplicate }` |
| `POST /n8n/automation-error` | `{ workflow, node?, message, executionId }` | `{ ok }` |

All three require the signature headers above, signed with `LENDLOOP_API_SECRET`. A missing, wrong or stale signature gets a 401, a body over 10 KB a 413, and a malformed body a 400.

## Security and privacy

- **Authorization on the server only.** Mutations re-check the session, ownership and loan status. The UI is never trusted.
- **Two secrets, one per direction.** A leaked n8n secret can't be used to forge events to n8n, and the reverse also holds. Neither is stored in the workflow JSON, so exporting or sharing the workflows never leaks them.
- **Replay protection.** Signed timestamps expire after 5 minutes, and event ids and idempotency keys make replays harmless.
- **Data minimization.**
  - The public list shows only tool names and categories.
  - Borrowers never see an owner's email, and owners see only a borrower's name.
  - n8n gets just what a message needs.
  - Execution output masks emails.
  - Error reports carry the workflow and node name and the message, not the payload.
  - Executions are pruned after 7 days.
- **Input limits.** Name 2–60 characters, description up to 500, loans up to 30 days, HTTP bodies up to 10 KB, all validated with Convex validators.
- **Errors.** Users get readable messages, and stack traces stay in the logs.
- **n8n trade-off.** The Code nodes read secrets from the environment (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`), so anyone who can edit workflows on that n8n instance can read them. Keep n8n editor access to operators, or see the production notes.

## Tests

```bash
npm test          # 29 Convex tests (vitest + convex-test)
npm run typecheck
npm run lint
```

They cover:
- **Roles**: a non-owner can't edit or approve, a non-admin can't moderate, admin-only queries, and the public list's fields.
- **Validation**: past dates, reversed ranges, more than 30 days, your own tool, and duplicate requests.
- **The state machine**: every allowed and disallowed status change.
- **Overlap**: clashing approvals, and auto-declining the requests that clash.
- **Outbox**: signed payload contents, retry and backoff, failure after 5 attempts, and no retry on 4xx.
- **HTTP endpoints**: missing, wrong and stale signatures.
- **Write-backs**: idempotency, the failed → sent upgrade, and a key that doesn't match its loan.
- **Error reports**: de-duplication.

The suite was checked against the code: breaking the owner check in `tools.update`, or making signature checks always pass, makes tests fail.

With n8n running:

```bash
node --env-file=.env.n8n scripts/webhook-smoke.mjs
```

The script sends five events to the live webhook:

| Event | Expected |
|---|---|
| Valid | 200 |
| Same event again | 200, marked duplicate |
| Wrong secret | 401 |
| 10-minute-old timestamp | 401 |
| Validly signed but malformed | 500, and the error workflow records it in Convex |

Also checked end to end against a local Convex backend and n8n 2.49.6:
- A real loan request reached n8n.
- An event that failed while n8n was down was delivered on a later automatic retry.
- The reminder run wrote back `{ ok: true, duplicate: false }`, and a second run the same day found nothing to send.

## Taking it to production (AWS)

| Piece | Plan |
|---|---|
| Next.js | Vercel, or AWS Amplify Hosting. Clerk production instance on the real domain |
| Convex | Convex cloud production deployment (`npx convex deploy`) with its own env vars |
| n8n | ECS Fargate behind an ALB with HTTPS (ACM). Postgres on RDS instead of SQLite. Queue mode with Redis (ElastiCache) and separate workers once volume grows. Task runners in external mode (the n8n image warns that internal mode is deprecated) |
| Secrets | AWS Secrets Manager, injected as task env vars. Rotate the HMAC secrets by accepting old and new for a short overlap window |
| Webhook exposure | Expose only `/webhook/*` publicly, through AWS WAF with rate limits. Keep the n8n editor behind SSO or a VPN |
| Notifications | Amazon SES (or Slack/Discord) in place of the mock nodes, with SPF/DKIM set up |
| Observability | CloudWatch logs and alarms on n8n errors and failed outbox rows; Convex log streams; the Admin tab for day-to-day checks |
| Backups | RDS automated snapshots for n8n; Convex backups for app data |

## Trade-offs and next steps

- **Mock channels.** Notifications and reminders are mocked, so the demo runs without email credentials. Swapping one in is a single node per workflow.
- **De-duplication in n8n** uses workflow static data, the last 1,000 event ids. That's enough here. In queue mode with several workers I'd move it to Redis or ask Convex, which already knows the event ids.
- **Time zones.** Dates are calendar days in UTC. A real product would store the community's time zone.
- **Next steps:**
  - Photos for listings (Convex file storage).
  - Ratings after a return.
  - An in-app notification center fed by the same outbox.
  - Playwright end-to-end tests for the UI.

AI coding assistance (Claude Code) was used to build this project, as the brief allows.
