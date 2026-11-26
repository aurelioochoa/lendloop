"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES, type Category, categoryLabel, conditionLabel, errorMessage, todayIso } from "@/lib/ui";

export default function ToolBrowser({ isAdmin }: { isAdmin: boolean }) {
  const [category, setCategory] = useState<Category | "">("");
  const tools = useQuery(api.tools.list, category ? { category } : {});
  const removeTool = useMutation(api.tools.remove);
  const [requesting, setRequesting] = useState<Id<"tools"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section>
      <div className="toolbar">
        <label>
          Category{" "}
          <select value={category} onChange={(e) => setCategory(e.target.value as Category | "")}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {tools === undefined ? (
        <p className="muted">Loading…</p>
      ) : tools.length === 0 ? (
        <p className="empty">No tools in this category yet.</p>
      ) : (
        <ul className="grid">
          {tools.map((tool) => (
            <li key={tool._id} className="card">
              <div className="card-head">
                <span className="tag">{categoryLabel(tool.category)}</span>
                <span className={tool.available ? "badge available" : "badge out"}>
                  {tool.available ? "Available" : "Lent out"}
                </span>
              </div>
              <strong>{tool.name}</strong>
              <p className="muted small">
                {conditionLabel(tool.condition)}
                {tool.lenderTrusted && " · Trusted Lender"}
              </p>
              {tool.description && <p className="small">{tool.description}</p>}
              <div className="actions">
                {tool.isMine ? (
                  <span className="muted small">Your listing</span>
                ) : requesting === tool._id ? null : (
                  <button className="btn" onClick={() => setRequesting(tool._id)}>
                    Request to borrow
                  </button>
                )}
                {isAdmin && (
                  <button
                    className="btn danger"
                    onClick={() =>
                      removeTool({ toolId: tool._id }).catch((err) => setError(errorMessage(err)))
                    }
                  >
                    Remove (admin)
                  </button>
                )}
              </div>
              {requesting === tool._id && (
                <RequestForm toolId={tool._id} onDone={() => setRequesting(null)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestForm({ toolId, onDone }: { toolId: Id<"tools">; onDone: () => void }) {
  const request = useMutation(api.loans.request);
  const today = todayIso();
  const [startDate, setStart] = useState(today);
  const [endDate, setEnd] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (sent) return <p className="ok small">Request sent. The lender has been notified.</p>;

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        request({ toolId, startDate, endDate })
          .then(() => setSent(true))
          .catch((err) => setError(errorMessage(err)));
      }}
    >
      <label>
        From <input type="date" value={startDate} min={today} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label>
        To <input type="date" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} required />
      </label>
      <div className="actions">
        <button className="btn primary" type="submit">
          Send request
        </button>
        <button className="btn ghost" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
