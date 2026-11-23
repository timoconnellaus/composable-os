// Which of the shipped packs' staff screens the caller may open (stage 47, ADR 0660). The admin's
// navigation and record tabs render this answer and nothing else; a screen opened by URL that is
// not in it renders "not found", and the block's own calls are the host's to refuse anyway.
//
// A screen is listed when its pack is installed, active and shipped, and the caller passes the
// pipeline's own authority check (`staffAuthority`: their role, pack role, grants and restricted
// permissions) for every tool its `opens` names, as a person. The answer names nothing else: no
// counts, nothing greyed out. Screens are for people, so any other actor gets an empty list (an
// assistant has the tools). Staff only: a customer or the public is told no such operation exists.
//
// Two statements whatever is installed: the account's rights (with its pack role's manifest) and
// the shipped manifests. A pack role reaches this one core read beside its own tools
// (`PACK_ROLE_CORE_READS`), so a coach's or a door account's admin can ask it.
import type { ExtensionManifest, ScreenManifest } from "@composable-os/sdk";
import { z } from "zod";
import { allowsAudience } from "../audiences.ts";
import { toolOperation } from "../extensions/tools.ts";
import { defineOperation } from "../operation.ts";
import { loadStaffRights, staffAuthority } from "../pack-roles.ts";
import { staffPrincipal } from "../principals.ts";

const screenOut = z.object({
  pack: z.string(),
  key: z.string(),
  label: z.string(),
  nav: z.object({ group: z.string(), order: z.number().int() }).nullable(),
  /** The screen's page in the admin: `/s/<pack>/<key>`. */
  route: z.string(),
  /** A record screen: the object whose record page shows it as a tab, and the prop it is given. */
  record: z.object({ object: z.string(), as: z.string() }).nullable(),
});
export type MyScreen = z.infer<typeof screenOut>;

/** The route of a screen in the admin. */
export const screenRoute = (pack: string, key: string) => `/s/${pack}/${key}`;

export const screensMine = defineOperation({
  name: "screens.mine",
  description:
    "The staff screens of the installed packs the signed-in person may open in the admin: each " +
    "one's pack, key, label, where it sits in the navigation, its route, and the object whose " +
    "record page shows it as a tab. A screen is listed only when the person could call every " +
    "tool that gates it. Empty for anyone but a person. Read-only.",
  input: z.object({}),
  output: z.object({ screens: z.array(screenOut) }),
  permission: "records:read",
  risk: "read",
  // For the admin only: an MCP client is a non-human caller, which gets no screens anyway.
  mcp: { expose: false },
  async handler(_input, ctx) {
    // Screens are for people (ADR 0660): an assistant, MCP client, automation or extension code
    // has the tools themselves, and no screen.
    if (ctx.actor !== "human" || ctx.principal.kind !== "staff") return { screens: [] };
    const [rights, rows] = await Promise.all([
      loadStaffRights(ctx.db, ctx.user.id),
      ctx.db
        .selectFrom("core_extensions")
        .select(["id", "manifest"])
        .where("status", "=", "active")
        .where("source", "=", "shipped")
        .orderBy("id")
        .execute(),
    ]);
    const principal = staffPrincipal(ctx.user);
    const screens: MyScreen[] = [];
    for (const row of rows) {
      let manifest: ExtensionManifest;
      try {
        manifest = JSON.parse(row.manifest) as ExtensionManifest;
      } catch {
        continue;
      }
      for (const [key, screen] of Object.entries(manifest.screens ?? {})) {
        if (!mayOpen(manifest, screen, (op) => allowsAudience(op, principal), rights, ctx.user)) {
          continue;
        }
        screens.push({
          pack: row.id,
          key,
          label: screen.label,
          nav: screen.nav ? { group: screen.nav.group, order: screen.nav.order ?? 100 } : null,
          route: screenRoute(row.id, key),
          record: screen.record ? { object: screen.record.object, as: screen.record.as } : null,
        });
      }
    }
    return { screens };
  },
});

/**
 * Whether the caller could call every tool the screen names as its gate, by the pipeline's own
 * decision for a person's call (`staffAuthority`). A gate naming no tool, or a tool the installed
 * pack does not have, opens nothing (fail closed).
 */
function mayOpen(
  manifest: ExtensionManifest,
  screen: ScreenManifest,
  audienceAllows: (op: ReturnType<typeof toolOperation>) => boolean,
  rights: Awaited<ReturnType<typeof loadStaffRights>>,
  user: Parameters<typeof staffAuthority>[0],
): boolean {
  if (!screen.opens.length) return false;
  return screen.opens.every((name) => {
    const tool = Object.hasOwn(manifest.tools ?? {}, name) ? manifest.tools[name] : undefined;
    if (!tool) return false;
    const op = toolOperation(manifest, name, tool, "shipped");
    if (!audienceAllows(op)) return false;
    if (op.actors && !op.actors.includes("human")) return false;
    // A tool's input never decides whether a tool may be called by an account: only the reads
    // `record.get` and `record.list` look at theirs, and no screen is gated by those.
    return staffAuthority(user, rights, op, {}) !== null;
  });
}

export const screenOperations = [screensMine] as const;
