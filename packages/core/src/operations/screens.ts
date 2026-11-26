// Which of the shipped packs' staff screens the caller may open (stage 47, ADR 0660). The admin's
// navigation and record tabs render this answer and nothing else; a screen opened by URL that is
// not in it renders "not found", and the block's own calls are the host's to refuse anyway.
//
// A screen is listed when its pack is installed, active and shipped; the admin's build holds that
// pack's screens as this row declares them (`setBuiltScreens`: the build's gate fingerprint of each
// pack in the repository, so a row holding a pack's id with another manifest lists nothing); and
// the caller passes the pipeline's own authority check (`staffAuthority`: their role, pack role,
// grants and restricted permissions) for every tool its gate names, as a person, and may write
// every object it `writes`. The answer names nothing else: no counts, nothing greyed out. Screens
// are for people, so any other actor gets an empty list (an assistant has the tools). Staff only:
// a customer or the public is told no such operation exists.
//
// Two statements whatever is installed: the account's rights (with its pack role's manifest) and
// the shipped manifests. A pack role reaches this one core read beside its own tools
// (`PACK_ROLE_CORE_READS`), so a coach's or a door account's admin can ask it.
import {
  type ExtensionManifest,
  type ScreenManifest,
  screenGateFingerprint,
} from "@composable-os/sdk";
import { z } from "zod";
import { toolOperation } from "../extensions/tools.ts";
import { type AnyOperation, defineOperation } from "../operation.ts";
import { loadStaffRights, personMayCall, type StaffRights } from "../pack-roles.ts";
import type { Role } from "../principals.ts";
import { agreementDeskFind, agreementDeskStart } from "./agreement-desk.ts";
import { recordUpdate } from "./record.ts";

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

/**
 * The screens the admin's build holds: each repository pack's gate fingerprint
 * (`screenGateFingerprint`), set once by the host that serves the admin. Unset, no screen is
 * listed (fail closed): a host without the admin's build has no screens to show.
 */
let built: ReadonlyMap<string, string> | null = null;
export function setBuiltScreens(fingerprints: Readonly<Record<string, string>> | null): void {
  built = fingerprints ? new Map(Object.entries(fingerprints)) : null;
}

/**
 * Core's own staff screens, declared the way a pack declares its screens (stage 47's shape: a
 * label, where it sits, and the operations whose callers may open it), and listed by the same
 * rule: a person who could call every operation in `opens`. The admin's build holds their
 * components itself (`pack: "core"`). Stage 44 step 6 (ADR 0649): Sign at the desk, so a coach
 * granted agreements:desk (a fixed-role account, ADR 0600 amended) finds it in their small shell.
 */
export const CORE_SCREENS: Readonly<
  Record<string, { label: string; nav: { group: string; order: number }; opens: readonly string[] }>
> = Object.freeze({
  desk: {
    label: "Sign at the desk",
    nav: { group: "Agreements", order: 10 },
    opens: ["agreement.desk.start", "agreement.desk.find"],
  },
});

/** Core's screens are under this name, which no extension may take as its id (reserved). */
export const CORE_SCREEN_PACK = "core";

/** Packs whose installed manifest could not be read, said once each per isolate. */
const unreadable = new Set<string>();

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
    if (ctx.actor !== "human" || ctx.principal.kind !== "staff" || !built) return { screens: [] };
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
    const screens: MyScreen[] = [];
    for (const [key, screen] of Object.entries(CORE_SCREENS)) {
      const ops = screen.opens.map((name) => coreOperationNamed(name));
      if (!ops.every((op) => op && personMayCall(op, ctx.user, rights))) continue;
      screens.push({
        pack: CORE_SCREEN_PACK,
        key,
        label: screen.label,
        nav: screen.nav,
        route: screenRoute(CORE_SCREEN_PACK, key),
        record: null,
      });
    }
    for (const row of rows) {
      const fingerprint = built.get(row.id);
      if (!fingerprint) continue;
      const theirs: MyScreen[] = [];
      try {
        const manifest = JSON.parse(row.manifest) as ExtensionManifest;
        // Another manifest under this pack's id contributes nothing.
        if (screenGateFingerprint(manifest) !== fingerprint) continue;
        for (const [key, screen] of Object.entries(manifest.screens ?? {})) {
          if (!mayOpenScreen(manifest, screen, ctx.user, rights)) continue;
          theirs.push({
            pack: row.id,
            key,
            label: screen.label,
            nav: screen.nav ? { group: screen.nav.group, order: screen.nav.order ?? 100 } : null,
            route: screenRoute(row.id, key),
            record: screen.record ? { object: screen.record.object, as: screen.record.as } : null,
          });
        }
      } catch {
        // One unreadable row never takes the others' screens away: it lists nothing.
        if (!unreadable.has(row.id)) {
          unreadable.add(row.id);
          console.warn(`screens.mine: the installed manifest of ${row.id} could not be read`);
        }
        continue;
      }
      screens.push(...theirs);
    }
    return { screens };
  },
});

// Whether a person could call an operation: the pipeline's own checks, kept with the rights
// (pack-roles.ts) so the Trash's rule (ADR 0863) asks the same question.
export { personMayCall };

/**
 * Whether the caller passes the screen's gate: every tool in `opens` (an unknown one opens
 * nothing) and a write of every object in `writes`. A gate naming nothing opens nothing. Today's
 * items open a pack's screen only for a person who passes it (ADR 0874).
 */
export function mayOpenScreen(
  manifest: ExtensionManifest,
  screen: ScreenManifest,
  user: { id: string; role: Role },
  rights: StaffRights,
): boolean {
  const opens = screen.opens ?? [];
  const writes = screen.writes ?? [];
  if (!opens.length && !writes.length) return false;
  const tools = opens.every((name) => {
    const tool = Object.hasOwn(manifest.tools ?? {}, name) ? manifest.tools[name] : undefined;
    if (!tool) return false;
    // A tool's input never decides whether it may be called: only the record reads look at theirs.
    return personMayCall(toolOperation(manifest, name, tool, "shipped"), user, rights);
  });
  return tools && writes.every((object) => personMayCall(recordUpdate, user, rights, { object }));
}

/** The core operation `name`, for core screens' gates (read late: the registry imports this). */
function coreOperationNamed(name: string): AnyOperation | undefined {
  return coreScreenGates.get(name);
}
const coreScreenGates = new Map<string, AnyOperation>(
  [agreementDeskStart, agreementDeskFind].map((op) => [op.name, op as AnyOperation]),
);

export const screenOperations = [screensMine] as const;
