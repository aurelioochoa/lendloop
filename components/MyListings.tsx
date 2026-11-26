"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CATEGORIES,
  CONDITIONS,
  type Category,
  type Condition,
  categoryLabel,
  conditionLabel,
  errorMessage,
} from "@/lib/ui";

type Draft = { name: string; category: Category; condition: Condition; description: string };
const EMPTY: Draft = { name: "", category: "power_tools", condition: "good", description: "" };

export default function MyListings() {
  const tools = useQuery(api.tools.mine);
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const remove = useMutation(api.tools.remove);
  const [editing, setEditing] = useState<Id<"tools"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="stack">
      <div className="panel">
        <h2>List a tool</h2>
        <ToolForm
          initial={EMPTY}
          submitLabel="Add listing"
          onSubmit={async (draft) => {
            await create(draft);
          }}
        />
      </div>

      <div>
        <h2>Your listings</h2>
        {error && <p className="error">{error}</p>}
        {tools === undefined ? (
          <p className="muted">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="empty">You haven&apos;t listed anything yet.</p>
        ) : (
          <ul className="list">
            {tools.map((tool) =>
              editing === tool._id ? (
                <li key={tool._id} className="row panel">
                  <ToolForm
                    initial={tool}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                    onSubmit={async (draft) => {
                      await update({ toolId: tool._id, ...draft });
                      setEditing(null);
                    }}
                  />
                </li>
              ) : (
                <li key={tool._id} className="row">
                  <div>
                    <strong>{tool.name}</strong>
                    <p className="muted small">
                      {categoryLabel(tool.category)} · {conditionLabel(tool.condition)} ·{" "}
                      {tool.available ? "Available" : "Lent out"}
                      {tool.pendingRequests > 0 && ` · ${tool.pendingRequests} pending request(s)`}
                    </p>
                  </div>
                  <div className="actions">
                    <button className="btn" onClick={() => setEditing(tool._id)}>
                      Edit
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => {
                        setError(null);
                        remove({ toolId: tool._id }).catch((err) => setError(errorMessage(err)));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

function ToolForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    name: initial.name,
    category: initial.category,
    condition: initial.condition,
    description: initial.description,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        onSubmit(draft)
          .then(() => {
            if (!onCancel) setDraft(EMPTY);
          })
          .catch((err) => setError(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Name
        <input
          value={draft.name}
          maxLength={60}
          required
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label>
        Category
        <select
          value={draft.category}
          onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Condition
        <select
          value={draft.condition}
          onChange={(e) => setDraft({ ...draft, condition: e.target.value as Condition })}
        >
          {CONDITIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        Short description
        <textarea
          value={draft.description}
          maxLength={500}
          rows={2}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <div className="actions wide">
        <button className="btn primary" type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="error small wide">{error}</p>}
    </form>
  );
}
