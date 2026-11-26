"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { errorMessage, formatRange } from "@/lib/ui";
import { ActivityLine, StatusBadge } from "./LoanBits";

export default function IncomingRequests() {
  const loans = useQuery(api.loans.incoming);
  const approve = useMutation(api.loans.approve);
  const decline = useMutation(api.loans.decline);
  const markReturned = useMutation(api.loans.markReturned);
  const [error, setError] = useState<string | null>(null);

  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((err) => setError(errorMessage(err)));
  };

  if (loans === undefined) return <p className="muted">Loading…</p>;
  if (loans.length === 0) return <p className="empty">No one has asked for your tools yet.</p>;

  return (
    <section>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {loans.map((loan) => (
          <li key={loan._id} className="row">
            <div>
              <strong>{loan.toolName}</strong> <StatusBadge status={loan.status} overdue={loan.overdue} />
              <p className="muted small">
                {loan.borrowerName} · {formatRange(loan.startDate, loan.endDate)}
              </p>
              <ActivityLine activity={loan.activity} />
            </div>
            <div className="actions">
              {loan.status === "requested" && (
                <>
                  <button className="btn primary" onClick={() => run(approve({ loanId: loan._id }))}>
                    Approve
                  </button>
                  <button className="btn ghost" onClick={() => run(decline({ loanId: loan._id }))}>
                    Decline
                  </button>
                </>
              )}
              {loan.status === "approved" && (
                <button className="btn" onClick={() => run(markReturned({ loanId: loan._id }))}>
                  Mark returned
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
