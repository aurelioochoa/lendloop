import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";

export function setup() {
  return convexTest(schema, modules);
}

export type T = ReturnType<typeof setup>;

/** Signs in as a user and stores the user row, like the app does after sign-in. */
export async function signIn(t: T, name: string, email = `${name.toLowerCase()}@example.com`) {
  const as = t.withIdentity({
    name,
    email,
    subject: name.toLowerCase(),
    issuer: "https://clerk.test",
    tokenIdentifier: `https://clerk.test|${name.toLowerCase()}`,
  });
  const userId = (await as.mutation(api.users.store, {})) as Id<"users">;
  return { as, userId };
}

export function isoDate(offsetDays: number, from = Date.now()): string {
  return new Date(from + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export async function createTool(
  as: Awaited<ReturnType<typeof signIn>>["as"],
  name = "Cordless drill",
) {
  return await as.mutation(api.tools.create, {
    name,
    category: "power_tools",
    condition: "good",
    description: "18V, two batteries.",
  });
}
