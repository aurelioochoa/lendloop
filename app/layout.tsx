import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import ConvexClientProvider from "./ConvexClientProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "LendLoop",
  description: "Borrow what you need. Lend what you don't.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider>
          <ConvexClientProvider>
            <header className="topbar">
              <Link href="/" className="brand">
                <span className="brand-mark" aria-hidden>↻</span> LendLoop
              </Link>
              <nav className="topnav">
                <Suspense>
                  <Show when="signed-in">
                    <Link href="/dashboard">My loop</Link>
                    <UserButton />
                  </Show>
                  <Show when="signed-out">
                    <SignInButton mode="modal" forceRedirectUrl="/dashboard">
                      <button className="btn">Sign in</button>
                    </SignInButton>
                  </Show>
                </Suspense>
              </nav>
            </header>
            <main className="container">{children}</main>
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
