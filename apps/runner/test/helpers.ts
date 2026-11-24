// Helpers for runtime tests: real D1, the real extension workspace DO and Worker Loader.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type Actor,
  type InvocationContext,
  invokeByName,
  newId,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { automationHost } from "../src/automations/host.ts";
import { extensionHost } from "../src/index.ts";

export const db = createCrmDb(env.DB);
export const host = extensionHost(env);

let counter = 0;
export function unique(prefix = "t"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export async function createAdmin(): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique("admin")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Admin', ?, 1, ?, ?, 'admin')",
  )
    .bind(id, email, now, now)
    .run();
  return { id, email, name: "Admin", role: "admin" };
}

/** A staff user with the member role. */
export async function createMember(): Promise<ActingUser> {
  const user = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(user.id).run();
  return { ...user, role: "member" };
}

export function context(
  user: ActingUser,
  overrides: Partial<InvocationContext> & { actor?: Actor } = {},
): InvocationContext {
  return {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
    extensionHost: host,
    automationHost: automationHost(env),
    ...overrides,
  };
}

export function call<T = unknown>(user: ActingUser, name: string, input: unknown): Promise<T> {
  return invokeByName(name, input, context(user)) as Promise<T>;
}

/** Installs a runtime extension from `files` and returns the install result. */
export function install(user: ActingUser, id: string, files: Record<string, string>) {
  return call<{ id: string; commit: string; version: string; changes: unknown[] }>(
    user,
    "extension.install",
    { id, files },
  );
}

export async function extensionRow(id: string) {
  return db.query
    .selectFrom("core_extensions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

export async function auditFor(operation: string, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT actor, outcome, user_id, origin, error FROM core_audit WHERE operation = ? AND user_id = ? ORDER BY at, id",
  )
    .bind(operation, userId)
    .all<{
      actor: string;
      outcome: string;
      user_id: string;
      origin: string;
      error: string | null;
    }>();
  return results;
}

/** Source of a small extension; `body` goes inside defineExtension({...}). */
export function source(
  id: string,
  body: string,
  version = "1.0.0",
  extra = "",
): Record<string, string> {
  return {
    "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
${extra}
export default defineExtension({
  id: "${id}",
  version: "${version}",
  contractVersion: 1,
  ${body}
});
`,
  };
}

/** How many statements `call` prepares against D1 (each is one query), and "ok" or its refusal. */
export async function queriesOf(
  call: () => Promise<unknown>,
): Promise<{ queries: number; outcome: string }> {
  const d1 = env.DB as unknown as { prepare: (...a: unknown[]) => unknown };
  const prepare = d1.prepare.bind(d1);
  let queries = 0;
  d1.prepare = (...a: unknown[]) => {
    queries++;
    return prepare(...a);
  };
  try {
    const outcome = await call().then(
      () => "ok",
      (e: { code?: string }) => String(e.code),
    );
    return { queries, outcome };
  } finally {
    d1.prepare = prepare;
  }
}
