// Generates the n8n workflow JSON files for LendLoop. Run: node gen-workflows.mjs <outDir>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
mkdirSync(out, { recursive: true });

const ERROR_WORKFLOW_ID = "LLerrorHandler01";
const settings = { executionOrder: "v1", errorWorkflow: ERROR_WORKFLOW_ID, saveManualExecutions: true };

const code = (id, name, position, jsCode, extra = {}) => ({
  id,
  name,
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position,
  parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: jsCode.trim() },
  ...extra,
});

const httpRequest = (id, name, position, parameters) => ({
  id,
  name,
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position,
  parameters: { options: { timeout: 10000 }, ...parameters },
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
});

const link = (...pairs) => {
  const c = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= outputIndex) c[from].main.push([]);
    c[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }
  return c;
};

const SIGN_HELPER = `
// HMAC-SHA256 over "<timestamp>.<METHOD>.<path>.<body>", the same scheme Convex verifies.
// The secret comes from the environment (LENDLOOP_API_SECRET); it is never stored in this workflow.
const crypto = require('crypto');
function signedRequest(method, path, body) {
  const base = $env.LENDLOOP_CONVEX_SITE_URL;
  const secret = $env.LENDLOOP_API_SECRET;
  if (!base || !secret) throw new Error('LENDLOOP_CONVEX_SITE_URL and LENDLOOP_API_SECRET must be set');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(timestamp + '.' + method + '.' + path + '.' + body).digest('hex');
  return {
    url: base.replace(/\\/$/, '') + path,
    body,
    headers: { 'X-LendLoop-Timestamp': timestamp, 'X-LendLoop-Signature': signature },
  };
}
`;

const MASK_EMAIL = `
// Logs keep only a masked address (data minimization).
function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return user.slice(0, 1) + '***@' + domain;
}
`;

// ---------------------------------------------------------------------------
// 1. Request notifications: Convex -> n8n webhook
// ---------------------------------------------------------------------------
const requestNotifications = {
  id: "LLrequestNotify1",
  name: "LendLoop · Request notifications",
  active: false,
  settings,
  pinData: {},
  nodes: [
    {
      id: "rn-webhook",
      name: "Loan event webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2.1,
      position: [0, 300],
      webhookId: "6b1f5d0e-2f4a-4c6e-9b1a-1e0c5a7d3f21",
      parameters: {
        httpMethod: "POST",
        path: "lendloop-request",
        responseMode: "responseNode",
        options: { rawBody: true },
      },
    },
    code(
      "rn-verify",
      "Verify HMAC signature",
      [240, 300],
      `
// Convex signs every event with N8N_WEBHOOK_SECRET (read from the environment).
// Checks: timestamp within 5 minutes, HMAC over the exact raw body, constant-time compare.
const crypto = require('crypto');
const item = $input.first();
const headers = item.json.headers || {};
const secret = $env.N8N_WEBHOOK_SECRET;
const timestamp = headers['x-lendloop-timestamp'];
const signature = String(headers['x-lendloop-signature'] || '');

const reject = (reason) => [{ json: { valid: false, reason } }];

// The signature covers the exact bytes Convex sent, so verify against the raw body
// (Webhook option "Raw Body"), never a re-serialized copy of the parsed JSON.
let raw;
try {
  raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
} catch (e) {
  return reject('raw body unavailable');
}

// Constant-time string compare (the Code node sandbox has no Buffer global).
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

if (!secret) return reject('N8N_WEBHOOK_SECRET is not set');
if (!/^\\d{1,12}$/.test(String(timestamp || ''))) return reject('missing or bad timestamp');
if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return reject('timestamp outside the 5 minute window');

// Path of this webhook as Convex addressed it, e.g. /webhook/lendloop-request.
const path = String(item.json.webhookUrl || '').replace(/^[a-z][a-z0-9+.-]*:\\/\\/[^/]+/i, '').split('?')[0];
const expected = 'sha256=' + crypto.createHmac('sha256', secret)
  .update(timestamp + '.POST.' + path + '.' + raw).digest('hex');
if (!safeEqual(expected, signature)) return reject('signature mismatch');

const event = JSON.parse(raw);
// Convex retries reuse the same eventId; remember handled ids so a retry never notifies twice.
const memory = $getWorkflowStaticData('global');
const duplicate = Array.isArray(memory.handledEventIds) && memory.handledEventIds.includes(event.eventId);
return [{ json: { valid: true, duplicate, event } }];
`,
    ),
    {
      id: "rn-if-valid",
      name: "Signature valid?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [480, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
          conditions: [
            {
              id: "c-valid",
              leftValue: "={{ $json.valid }}",
              rightValue: "",
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
    },
    code(
      "rn-notify",
      "Notify recipient (mock)",
      [720, 200],
      `
// Mock notification: builds the message and returns it (masked) as this node's output, visible in
// n8n's Executions list. In production, replace this node with
// Send Email / Slack / Discord. It uses only what the message needs: the recipient's name and
// email, the tool name, the dates and the new status.
${MASK_EMAIL}
const { event, duplicate } = $input.first().json;
if (duplicate) {
  return [{ json: { eventId: event.eventId, duplicate: true, notified: false } }];
}

const tool = event.tool.name;
const recipient = event.recipient;
const dates = event.loan.startDate === event.loan.endDate
  ? event.loan.startDate
  : event.loan.startDate + ' to ' + event.loan.endDate;
const subjects = {
  'loan.requested': 'New request to borrow your ' + tool,
  'loan.approved': 'Approved: you can borrow the ' + tool,
  'loan.declined': 'Your request for the ' + tool + ' was declined',
  'loan.cancelled': 'A request for your ' + tool + ' was withdrawn',
  'loan.listing_removed': 'The ' + tool + ' is no longer listed',
  'loan.returned': 'Thanks for returning the ' + tool,
};
const message = {
  to: recipient.email,
  subject: subjects[event.type] || 'Update on the ' + tool,
  text: 'Hi ' + recipient.name + ', ' + (subjects[event.type] || 'there is an update') + ' (' + dates + ').',
};

if (!message.to) {
  // A missing address is permanent; retrying won't help, so record it instead of failing.
  // (Visible in the execution output; Convex gets a 200 so it does not retry.)
  return [{ json: { eventId: event.eventId, duplicate: false, notified: false, reason: 'no email on file' } }];
}

const preview = { ...message, to: maskEmail(message.to) };
return [{ json: { eventId: event.eventId, duplicate: false, notified: true, channel: 'mock', message: preview } }];
`,
    ),
    code(
      "rn-remember",
      "Remember handled event",
      [960, 200],
      `
// Only after the notification went out: store the eventId (capped list) for de-duplication.
const result = $input.first().json;
const memory = $getWorkflowStaticData('global');
memory.handledEventIds = memory.handledEventIds || [];
if (!result.duplicate && !memory.handledEventIds.includes(result.eventId)) {
  memory.handledEventIds.push(result.eventId);
  if (memory.handledEventIds.length > 1000) memory.handledEventIds.splice(0, memory.handledEventIds.length - 1000);
}
return [{ json: result }];
`,
    ),
    {
      id: "rn-respond-ok",
      name: "Respond 200",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.4,
      position: [1200, 200],
      parameters: {
        respondWith: "json",
        responseBody: "={{ JSON.stringify({ ok: true, eventId: $json.eventId, duplicate: $json.duplicate, notified: $json.notified }) }}",
        options: { responseCode: 200 },
      },
    },
    {
      id: "rn-respond-401",
      name: "Respond 401",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.4,
      position: [720, 420],
      parameters: {
        respondWith: "json",
        responseBody: '={{ JSON.stringify({ ok: false, error: "invalid signature" }) }}',
        options: { responseCode: 401 },
      },
    },
    {
      id: "rn-note",
      name: "Sticky Note",
      type: "n8n-nodes-base.stickyNote",
      typeVersion: 1,
      position: [-40, 0],
      parameters: {
        width: 720,
        height: 200,
        content:
          "## Request notifications\nConvex calls this webhook when a borrow request is created or changes status.\n- The HMAC signature is checked against **N8N_WEBHOOK_SECRET** (environment, never in this JSON).\n- Invalid signature: 401, nothing is sent. Convex does not retry 4xx.\n- Any error before the response: n8n answers 500, so Convex retries with the same eventId (de-duplicated here), and the error workflow records the failure in Convex.",
      },
    },
  ],
  connections: link(
    ["Loan event webhook", "Verify HMAC signature"],
    ["Verify HMAC signature", "Signature valid?"],
    ["Signature valid?", "Notify recipient (mock)", 0],
    ["Signature valid?", "Respond 401", 1],
    ["Notify recipient (mock)", "Remember handled event"],
    ["Remember handled event", "Respond 200"],
  ),
};

// ---------------------------------------------------------------------------
// 2. Overdue reminders: daily schedule -> Convex HTTP endpoint -> write-back
// ---------------------------------------------------------------------------
const overdueReminders = {
  id: "LLoverdueRemind1",
  name: "LendLoop · Overdue reminders",
  active: false,
  settings,
  pinData: {},
  nodes: [
    {
      id: "or-schedule",
      name: "Every day at 09:00",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, 220],
      parameters: { rule: { interval: [{ field: "days", daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } },
    },
    {
      id: "or-manual",
      name: "Run now",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 400],
      parameters: {},
    },
    code(
      "or-sign-get",
      "Sign overdue-loans request",
      [240, 300],
      `${SIGN_HELPER}
return [{ json: signedRequest('GET', '/n8n/overdue-loans', '') }];
`,
    ),
    httpRequest("or-fetch", "Fetch overdue loans", [480, 300], {
      method: "GET",
      url: "={{ $json.url }}",
      sendHeaders: true,
      specifyHeaders: "json",
      jsonHeaders: "={{ JSON.stringify($json.headers) }}",
    }),
    code(
      "or-split",
      "One item per loan",
      [720, 300],
      `
// Convex already excludes loans that got a successful reminder today (idempotency key per loan per day).
const loans = $input.first().json.loans || [];
return loans.map((loan) => ({ json: loan }));
`,
    ),
    code(
      "or-remind",
      "Send reminder (mock)",
      [960, 300],
      `
// Mock reminder: returns the message (masked) as output, visible in n8n's Executions list. In production, replace with Send Email / Slack / Discord and
// set that node's "On Error" to "Continue (using error output)" so a failed send is written back
// as outcome "failed" instead of stopping the whole run.
${MASK_EMAIL}
return $input.all().map(({ json: loan }) => {
  if (!loan.borrower.email) {
    return { json: { loanId: loan.loanId, idempotencyKey: loan.idempotencyKey, outcome: 'failed', detail: 'no email on file' } };
  }
  const message = {
    to: maskEmail(loan.borrower.email),
    subject: 'Reminder: please return the ' + loan.toolName,
    text: 'Hi ' + loan.borrower.name + ', the ' + loan.toolName + ' was due back on ' + loan.endDate +
      ' (' + loan.daysOverdue + ' day' + (loan.daysOverdue === 1 ? '' : 's') + ' ago).',
  };
  // message is the preview of what a real channel would send.
  return { json: { loanId: loan.loanId, idempotencyKey: loan.idempotencyKey, outcome: 'sent', detail: 'mock', message } };
});
`,
    ),
    code(
      "or-sign-post",
      "Sign write-back",
      [1200, 300],
      `${SIGN_HELPER}
return $input.all().map(({ json }) => {
  const body = JSON.stringify({
    idempotencyKey: json.idempotencyKey,
    loanId: json.loanId,
    outcome: json.outcome,
    detail: json.detail,
  });
  return { json: signedRequest('POST', '/n8n/reminder-status', body) };
});
`,
    ),
    httpRequest("or-writeback", "Record reminder in Convex", [1440, 300], {
      method: "POST",
      url: "={{ $json.url }}",
      sendHeaders: true,
      specifyHeaders: "json",
      jsonHeaders: "={{ JSON.stringify($json.headers) }}",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ $json.body }}",
    }),
    {
      id: "or-note",
      name: "Sticky Note",
      type: "n8n-nodes-base.stickyNote",
      typeVersion: 1,
      position: [-40, 0],
      parameters: {
        width: 760,
        height: 200,
        content:
          "## Overdue reminders\nDaily: fetch overdue loans from Convex (signed GET), remind each borrower, write the result back (signed POST).\n- Write-backs carry an idempotency key `overdue:<loanId>:<date>`, so HTTP retries and re-runs never create duplicates.\n- HTTP nodes retry 3× (5 s apart); a run that still fails goes to the error workflow, which records it in Convex.",
      },
    },
  ],
  connections: link(
    ["Every day at 09:00", "Sign overdue-loans request"],
    ["Run now", "Sign overdue-loans request"],
    ["Sign overdue-loans request", "Fetch overdue loans"],
    ["Fetch overdue loans", "One item per loan"],
    ["One item per loan", "Send reminder (mock)"],
    ["Send reminder (mock)", "Sign write-back"],
    ["Sign write-back", "Record reminder in Convex"],
  ),
};

// ---------------------------------------------------------------------------
// 3. Error handler: any failed run -> recorded in Convex (visible to admins)
// ---------------------------------------------------------------------------
const errorHandler = {
  id: ERROR_WORKFLOW_ID,
  name: "LendLoop · Error handler",
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
  nodes: [
    {
      id: "eh-trigger",
      name: "On workflow error",
      type: "n8n-nodes-base.errorTrigger",
      typeVersion: 1,
      position: [0, 300],
      parameters: {},
    },
    code(
      "eh-sign",
      "Sign error report",
      [240, 300],
      `${SIGN_HELPER}
// Error Trigger output: { execution: { id, lastNodeExecuted, error }, workflow: { name } } for run errors,
// or { trigger: { error }, workflow } when the trigger itself failed.
const e = $input.first().json;
const execution = e.execution || {};
const error = execution.error || (e.trigger && e.trigger.error) || {};
const body = JSON.stringify({
  workflow: (e.workflow && e.workflow.name) || 'unknown workflow',
  node: execution.lastNodeExecuted || undefined,
  message: String(error.message || 'unknown error').slice(0, 500),
  executionId: String(execution.id || 'trigger-' + Date.now()),
});

return [{ json: signedRequest('POST', '/n8n/automation-error', body) }];
`,
    ),
    httpRequest("eh-report", "Report to Convex", [480, 300], {
      method: "POST",
      url: "={{ $json.url }}",
      sendHeaders: true,
      specifyHeaders: "json",
      jsonHeaders: "={{ JSON.stringify($json.headers) }}",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ $json.body }}",
    }),
  ],
  connections: link(["On workflow error", "Sign error report"], ["Sign error report", "Report to Convex"]),
};

for (const [file, wf] of [
  ["request-notifications.json", requestNotifications],
  ["overdue-reminders.json", overdueReminders],
  ["error-handler.json", errorHandler],
]) {
  writeFileSync(join(out, file), JSON.stringify(wf, null, 2) + "\n");
  console.log("wrote", file);
}
