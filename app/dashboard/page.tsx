"use client";

import { AuthLoading, Authenticated, Unauthenticated, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import AdminPanel from "@/components/AdminPanel";
import IncomingRequests from "@/components/IncomingRequests";
import MyListings from "@/components/MyListings";
import MyRequests from "@/components/MyRequests";
import ToolBrowser from "@/components/ToolBrowser";
import { errorMessage } from "@/lib/ui";

type Tab = "browse" | "listings" | "requests" | "incoming" | "admin";

export default function Dashboard() {
  return (
    <>
      <AuthLoading>
        <p className="muted">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <p className="empty">Sign in to lend and borrow tools.</p>
      </Unauthenticated>
      <Authenticated>
        <SignedInDashboard />
      </Authenticated>
    </>
  );
}

function SignedInDashboard() {
  const storeUser = useMutation(api.users.store);
  const [stored, setStored] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create or refresh the user row from the verified token before reading anything else.
  useEffect(() => {
    storeUser({})
      .then(() => setStored(true))
      .catch((err) => setError(errorMessage(err)));
  }, [storeUser]);

  const me = useQuery(api.users.me, stored ? {} : "skip");
  const [tab, setTab] = useState<Tab>("browse");

  if (error) return <p className="error">{error}</p>;
  if (!me) return <p className="muted">Loading your loop…</p>;

  const tabs: { id: Tab; label: string }[] = [
    { id: "browse", label: "Browse" },
    { id: "listings", label: "My listings" },
    { id: "requests", label: "My requests" },
    { id: "incoming", label: "Incoming requests" },
    ...(me.role === "admin" ? [{ id: "admin" as Tab, label: "Admin" }] : []),
  ];

  return (
    <>
      <div className="dash-head">
        <h1>Hi, {me.name}</h1>
        {me.trustedLender && <span className="badge trusted">Trusted Lender</span>}
        {me.role === "admin" && <span className="badge">Admin</span>}
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "browse" && <ToolBrowser isAdmin={me.role === "admin"} />}
        {tab === "listings" && <MyListings />}
        {tab === "requests" && <MyRequests />}
        {tab === "incoming" && <IncomingRequests />}
        {tab === "admin" && me.role === "admin" && <AdminPanel />}
      </div>
    </>
  );
}
