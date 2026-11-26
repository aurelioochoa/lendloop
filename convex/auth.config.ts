import { AuthConfig } from "convex/server";

// Convex validates Clerk-issued tokens against this issuer.
// CLERK_JWT_ISSUER_DOMAIN is the Clerk "Frontend API URL" (set it with `npx convex env set`).
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
