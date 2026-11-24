// Small helpers several app tests share.
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import type { Tokens } from "@composable-os/client";

/** The staff user `principal` signs in as, made an admin (once, however many tests ask). */
export async function ensureAdmin(principal: Principal) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(principal.userId, principal.name, principal.email, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?")
    .bind(principal.userId)
    .run();
}

/** A token store held in memory, as an app's secure storage would hold it; `peek` reads it. */
export function memoryStore() {
  let saved: Tokens | null = null;
  return {
    load: async () => saved,
    save: async (tokens: Tokens | null) => {
      saved = tokens;
    },
    peek: () => saved,
  };
}
