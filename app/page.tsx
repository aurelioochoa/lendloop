"use client";

import { SignInButton } from "@clerk/nextjs";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { categoryLabel } from "@/lib/ui";

export default function Home() {
  const tools = useQuery(api.tools.listPublic);

  return (
    <>
      <section className="hero">
        <h1>LendLoop</h1>
        <p className="tagline">Borrow what you need. Lend what you don&apos;t.</p>
        <p className="muted">
          Your neighbors already own the ladder, the drill and the tent. List what you have, borrow what you
          need, and get reminded before anything is late.
        </p>
        <Unauthenticated>
          <SignInButton mode="modal" forceRedirectUrl="/dashboard">
            <button className="btn primary">Sign in to lend or borrow</button>
          </SignInButton>
        </Unauthenticated>
        <Authenticated>
          <Link className="btn primary" href="/dashboard">
            Go to my loop
          </Link>
        </Authenticated>
      </section>

      <section>
        <h2>Available now</h2>
        {tools === undefined ? (
          <p className="muted">Loading tools…</p>
        ) : tools.length === 0 ? (
          <p className="empty">Nothing listed yet. Be the first to lend something.</p>
        ) : (
          <ul className="grid">
            {tools.map((tool) => (
              <li key={tool._id} className="card">
                <span className="tag">{categoryLabel(tool.category)}</span>
                <strong>{tool.name}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
