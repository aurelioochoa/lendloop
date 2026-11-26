"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { errorMessage, formatRange } from "@/lib/ui";
import { ActivityLine, StatusBadge } from "./LoanBits";

export default function MyRequests() {
  const loans = useQuery(api.loans.myRequests);
  const cancel = useMutation(api.loans.cancel);
  const [error, setError] = useState<string | null>(null);

  if (loans === undefined) return <p className="muted">Loading…</p>;
  if (loans.length === 0) return <p className="empty">You haven&apos;t asked to borrow anything yet.</p>;

  return (
    <section>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {loans.map((loan) => (
          <li key={loan._id} className="row">
            <div>
              <strong>{loan.toolName}</strong> <StatusBadge status={loan.status} overdue={loan.overdue} />
              <p className="muted small">{formatRange(loan.startDate, loan.endDate)}</p>
              {loan.overdue && <p className="small warn">Past the return date. Please bring it back.</p>}
              <ActivityLine activity={loan.activity} />
            </div>
            {loan.status === "requested" && (
              <div className="actions">
                <button
                  className="btn ghost"
                  onClick={() => cancel({ loanId: loan._id }).catch((err) => setError(errorMessage(err)))}
                >
                  Cancel request
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
