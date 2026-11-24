// Installing shipped extensions at boot (ADR 0025): every extension bundled with this release goes
// through `extension.install`, the same audited path an admin uses, as a system call. An extension
// already at the bundled commit is left alone (so an admin's disable sticks); a new release's
// version is installed.
import type { CrmDb } from "@composable-os/db";
import { toOperationError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { invokeByName } from "../invoke.ts";
import { notifyStatements } from "../notifications/send.ts";
import { SYSTEM_USER } from "../users.ts";
import type { ExtensionHost, ShippedExtension } from "./host.ts";

export interface ShippedInstallResult {
  id: string;
  /**
   * `ejected`: an admin ejected it (it is a runtime extension now), so releases leave it alone.
   * `available`: an opt-in shipped extension no admin has installed (ADR 0246).
   */
  outcome: "installed" | "unchanged" | "ejected" | "available" | "failed";
  error?: string;
}

export async function installShippedExtensions(options: {
  db: CrmDb;
  host: ExtensionHost;
  floor?: GateFloor;
}): Promise<ShippedInstallResult[]> {
  const results: ShippedInstallResult[] = [];
  const failed: ShippedExtension[] = [];
  const all = await options.host.shipped();
  // One that depends on another shipped extension (Leads on Deals) may fail before it is
  // installed; it gets a second try after the rest.
  for (const [pass, list] of [
    [1, all],
    [2, failed],
  ] as const) {
    for (const shipped of [...list]) {
      const { result, commit } = await installOne(options, shipped);
      if (result.outcome === "failed" && pass === 1) {
        failed.push(shipped);
        continue;
      }
      // Told only when the second try fails too: one that waited for another installs then.
      if (result.outcome === "failed") {
        await tellAdmins(options.db, shipped.id, commit, result.error ?? "");
      }
      results.push(result);
    }
  }
  return all.flatMap((s) => results.filter((r) => r.id === s.id));
}

async function installOne(
  options: { db: CrmDb; host: ExtensionHost; floor?: GateFloor },
  shipped: ShippedExtension,
): Promise<{ result: ShippedInstallResult; commit: string | null }> {
  let commit: string | null = null;
  const done = (result: ShippedInstallResult) => ({ result, commit });
  try {
    const installed = await options.db.query
      .selectFrom("core_extensions")
      .select(["source"])
      .where("id", "=", shipped.id)
      .executeTakeFirst();
    if (installed?.source === "runtime") {
      return done({ id: shipped.id, outcome: "ejected" });
    }
    if (!installed && shipped.optional) return done({ id: shipped.id, outcome: "available" });
    commit = (await options.host.commitShipped(shipped.id)).commit;
    const row = await options.db.query
      .selectFrom("core_extensions")
      .select(["commit_oid"])
      .where("id", "=", shipped.id)
      .executeTakeFirst();
    if (row?.commit_oid === commit) {
      return done({ id: shipped.id, outcome: "unchanged" });
    }
    await invokeByName(
      "extension.install",
      { id: shipped.id, shipped: true },
      {
        actor: "human",
        user: SYSTEM_USER,
        origin: { surface: "system" },
        db: options.db,
        ...(options.floor ? { floor: options.floor } : {}),
        extensionHost: options.host,
      },
    );
    return done({ id: shipped.id, outcome: "installed" });
  } catch (error) {
    const typed = toOperationError(error);
    console.error(`installing shipped extension ${shipped.id} failed`, typed.toJSON());
    return done({ id: shipped.id, outcome: "failed", error: typed.message });
  }
}

/**
 * A shipped extension this release could not install or upgrade (a reconcile refused over the
 * records there, stage 45: shifts that clash) is told to the admins in the product, once per
 * release of it, with why: the old version keeps running until they put the records right. Never
 * throws: the boot carries on.
 */
async function tellAdmins(
  db: CrmDb,
  id: string,
  commit: string | null,
  why: string,
): Promise<void> {
  try {
    const plan = await notifyStatements(
      db.query,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: `The ${id} extension could not be upgraded`,
        body: `${why.slice(0, 1500)} It keeps running as it was; it is tried again on the next start.`,
        dedupeKey: `shipped-install-failed:${id}:${commit ?? "unknown"}`,
        source: { actor: "system" },
      },
      new Date().toISOString(),
    );
    if (plan.statements.length) await db.batch(plan.statements);
  } catch (error) {
    console.error(`could not tell the admins that ${id} failed to install`, error);
  }
}
