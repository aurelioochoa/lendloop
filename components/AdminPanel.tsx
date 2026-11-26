"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { errorMessage, formatRange, timeAgo } from "@/lib/ui";
import { ActivityLine, StatusBadge } from "./LoanBits";

export default function AdminPanel() {
  const data = useQuery(api.admin.overview);
  const setTrusted = useMutation(api.admin.setTrustedLender);
  const retry = useMutation(api.admin.retryDelivery);
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((err) => setError(errorMessage(err)));
  };

  if (data === undefined) return <p className="muted">Loading…</p>;

  return (
    <section className="stack">
      {error && <p className="error">{error}</p>}

      <div>
        <h2>Automation health</h2>
        {data.failedDeliveries.length === 0 && data.workflowErrors.length === 0 ? (
          <p className="ok">No failed notifications or workflow errors.</p>
        ) : (
          <ul className="list">
            {data.failedDeliveries.map((d) => (
              <li key={d._id} className="row">
                <div>
                  <strong>Notification failed</strong> <span className="muted small">{d.type}</span>
                  <p className="muted small">
                    {d.attempts} attempts · {d.lastError} · {timeAgo(d.at)}
                  </p>
                </div>
                <button className="btn" onClick={() => run(retry({ outboxId: d._id }))}>
                  Retry
                </button>
              </li>
            ))}
            {data.workflowErrors.map((e) => (
              <li key={e._id} className="row">
                <div>
                  <strong>n8n: {e.workflow}</strong>
                  <p className="muted small">
                    {e.node ? `${e.node}: ` : ""}
                    {e.message} · {timeAgo(e.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2>Members</h2>
        <ul className="list">
          {data.users.map((u) => (
            <li key={u._id} className="row">
              <div>
                <strong>{u.name}</strong> {u.role === "admin" && <span className="badge">Admin</span>}{" "}
                {u.trustedLender && <span className="badge trusted">Trusted Lender</span>}
                <p className="muted small">{u.email ?? "no email on file"}</p>
              </div>
              <button className="btn" onClick={() => run(setTrusted({ userId: u._id, trusted: !u.trustedLender }))}>
                {u.trustedLender ? "Remove Trusted Lender" : "Mark Trusted Lender"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2>All loans</h2>
        {data.loans.length === 0 ? (
          <p className="empty">No loans yet.</p>
        ) : (
          <ul className="list">
            {data.loans.map((loan) => (
              <li key={loan._id} className="row">
                <div>
                  <strong>{loan.toolName}</strong> <StatusBadge status={loan.status} overdue={loan.overdue} />
                  <p className="muted small">
                    {loan.lenderName} → {loan.borrowerName} · {formatRange(loan.startDate, loan.endDate)}
                  </p>
                  <ActivityLine activity={loan.activity} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">To remove any listing, use the Remove (admin) button in Browse.</p>
      </div>
    </section>
  );
}
