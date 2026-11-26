// An update of a host of many clients (stage 66 step 7, ADR 0617): the deploy engine's update with
// the database steps done for every client. `cos fleet upgrade`.
//
//   check    every client's own extensions against the new release's contracts; one that would
//            stop working stops the update here, with nothing changed (decision 7)
//   pause    every active client (the host answers "being updated", messages are parked)
//   migrate  for each client: a bookmark, then its migrations inside its database, its schema
//            version recorded. One that fails is restored to its bookmark, and so is every client
//            migrated before it; nothing is uploaded
//   upload   the Workers, once
//   smoke    the new version answers at a client's staff address; on failure the previous
//            Workers are uploaded again and every client is restored to its bookmark
//   resume   the clients the update paused (a client the operator had paused stays paused)
//
// Crash and re-run: every step is recorded in `registry_operations`. A re-run of `cos fleet
// upgrade` finds the unfinished update and finishes or undoes it before anything else: before the
// upload (pausing, migrating) it restores each client migrated to its bookmark and resumes those it
// paused; during the upload (it may have half happened) it uploads the previous Workers and then
// does the same; after the upload it runs the smoke check and goes on from there; while resuming it
// resumes the rest. Then it says so, and the operator runs the update again.
import type { Migration, MigrationLevel } from "@composable-os/db";
import { type ClientId, readRegistry } from "@composable-os/db/registry";
import {
  beginOperation,
  finishOperation,
  listClients,
  recordSchemaVersion,
  saveOperation,
  setClientStatus,
  unfinishedOperation,
} from "@composable-os/db/registry-writes";
import { type FleetContext, FleetError, schemaVersionOf } from "./clients.ts";

export interface FleetUpdateInput {
  from: string;
  to: string;
  /** The new release's core migrations. */
  migrations: Migration[];
  /** The extension contracts the new release runs. */
  supportedContracts: number[];
  /** Uploads the new release's Workers (the deploy engine, with the fleet's keys). */
  upload(): Promise<void>;
  /** Uploads the installed release's Workers again. */
  uploadPrevious(): Promise<void>;
  /** Throws when the new version does not answer healthy at `hostname`. */
  smoke(hostname: string): Promise<void>;
  /** Records the deployment at `version` (its state). */
  recordVersion(version: string): Promise<void>;
}

type Phase = "pausing" | "migrating" | "uploading" | "uploaded" | "resuming";

interface UpdateState {
  from: string;
  to: string;
  phase: Phase;
  /** The clients this update paused, which it resumes. */
  paused: string[];
  /** Each client's bookmark and schema version before, and after once migrated. */
  clients: Record<string, { bookmark: string; before: number | null; after?: number }>;
}

/** What a run of the update ended as. */
export type FleetUpdateOutcome = "succeeded" | "rolled-back" | "undone" | "blocked" | "nothing";

async function restoreMigrated(ctx: FleetContext, state: UpdateState): Promise<string[]> {
  const restored: string[] = [];
  for (const [id, client] of Object.entries(state.clients)) {
    if (client.after === undefined) continue;
    await ctx.operator.op("restore", { client: id, bookmark: client.bookmark });
    await recordSchemaVersion(ctx.registry, id as ClientId, client.before);
    delete client.after;
    restored.push(id);
  }
  return restored;
}

async function resumePaused(ctx: FleetContext, state: UpdateState): Promise<void> {
  for (const id of state.paused) {
    await setClientStatus(ctx.registry, id as ClientId, "active", ["paused"]);
  }
}

/** The staff hostname the smoke check asks: the first active client's that has one. */
async function smokeHostname(ctx: FleetContext, state: UpdateState): Promise<string | null> {
  const snapshot = await readRegistry(ctx.registry);
  for (const id of [...state.paused].sort()) {
    const staff = snapshot.addresses.get(id as ClientId)?.staff;
    if (staff) return staff;
  }
  return null;
}

async function smokeAndFinish(
  ctx: FleetContext,
  input: FleetUpdateInput,
  op: { id: string },
  state: UpdateState,
): Promise<FleetUpdateOutcome> {
  const hostname = await smokeHostname(ctx, state);
  try {
    if (hostname) await input.smoke(hostname);
    else ctx.io.out("  smoke: no active client with a staff address to ask: skipped");
  } catch (error) {
    ctx.io.err(`  smoke check failed: ${(error as Error).message}`);
    await input.uploadPrevious();
    const restored = await restoreMigrated(ctx, state);
    await resumePaused(ctx, state);
    await finishOperation(ctx.registry, op.id, "undone", state);
    ctx.io.err(
      `Rolled back: ${state.from}'s Workers again, ${restored.length} clients restored to their bookmarks (${restored.join(", ") || "none"}).`,
    );
    return "rolled-back";
  }
  await input.recordVersion(state.to);
  state.phase = "resuming";
  await saveOperation(ctx.registry, op.id, state);
  await resumePaused(ctx, state);
  await finishOperation(ctx.registry, op.id, "succeeded", state);
  ctx.io.out(
    `\nUpdated ${state.from} → ${state.to}: ${Object.keys(state.clients).length} clients migrated, the Workers uploaded once.`,
  );
  return "succeeded";
}

/** Finishes or undoes an update a crash left part-way. */
async function recover(
  ctx: FleetContext,
  input: FleetUpdateInput,
  op: { id: string; state: UpdateState; startedAt: string },
): Promise<FleetUpdateOutcome> {
  const state = op.state;
  ctx.io.out(
    `An update ${state.from} → ${state.to} started ${op.startedAt} did not finish (${state.phase}).`,
  );
  if (state.phase === "uploaded") return smokeAndFinish(ctx, input, op, state);
  if (state.phase === "resuming") {
    await resumePaused(ctx, state);
    await finishOperation(ctx.registry, op.id, "succeeded", state);
    ctx.io.out("Finished it: the clients it paused are served again.");
    return "succeeded";
  }
  if (state.phase === "uploading") await input.uploadPrevious();
  const restored = await restoreMigrated(ctx, state);
  await resumePaused(ctx, state);
  await finishOperation(ctx.registry, op.id, "undone", state);
  ctx.io.out(
    `Undid it: ${restored.length} clients restored to their bookmarks, the paused ones served again${state.phase === "uploading" ? `, ${state.from}'s Workers uploaded again` : ""}. Run the update again.`,
  );
  return "undone";
}

/** `cos fleet upgrade`: see the top of this file. */
export async function fleetUpdate(
  ctx: FleetContext,
  input: FleetUpdateInput,
): Promise<FleetUpdateOutcome> {
  const unfinished = await unfinishedOperation<UpdateState>(ctx.registry, "update", null);
  if (unfinished) {
    if (ctx.dryRun) {
      ctx.io.out(
        `An update did not finish (${unfinished.state.phase}); a run without --dry-run finishes or undoes it.`,
      );
      return "nothing";
    }
    return recover(ctx, input, unfinished);
  }
  const clients = (await listClients(ctx.registry)).filter(
    (c) => c.environment === ctx.fleet.environment,
  );
  // The new release's checks on every client's own extensions (decision 7).
  const blockers: string[] = [];
  for (const client of clients) {
    if (client.schemaVersion === null) continue;
    const { results } = await ctx.operator.op<{
      results: { id: string; source: string; status: string; contract: number | null }[];
    }>("query", {
      client: client.id,
      sql: "SELECT id, source, status, json_extract(manifest, '$.contractVersion') AS contract FROM core_extensions",
    });
    for (const ext of results) {
      if (ext.source !== "runtime" || ext.status !== "active") continue;
      if (!input.supportedContracts.includes(Number(ext.contract ?? 0))) {
        blockers.push(
          `${client.id}: extension ${ext.id} is on contract ${ext.contract}; ${input.to} runs ${input.supportedContracts.join(" and ")}`,
        );
      }
    }
  }
  if (blockers.length) {
    for (const b of blockers) ctx.io.err(`  blocked: ${b}`);
    ctx.io.err(
      "The update stops here: nothing was changed. Fix those extensions, then run it again.",
    );
    return "blocked";
  }
  const target = schemaVersionOf(input.migrations);
  if (ctx.dryRun) {
    ctx.io.out(
      `Would update ${input.from} → ${input.to} (schema ${target}): pause ${clients.filter((c) => c.status === "active").length} active clients, migrate ${clients.length}, upload the Workers once, smoke check, resume. Nothing was changed (--dry-run).`,
    );
    return "nothing";
  }
  if (!ctx.yes) {
    if (!ctx.io.interactive) throw new FleetError("An update pauses every client: pass --yes");
    const answer = await ctx.io.ask(
      `Update ${input.from} → ${input.to} for ${clients.length} clients (each paused while it runs)? (yes/no)`,
      { default: "no" },
    );
    if (answer.toLowerCase() !== "yes") return "nothing";
  }
  const op = await beginOperation<UpdateState>(ctx.registry, "update", null, {
    from: input.from,
    to: input.to,
    phase: "pausing",
    paused: [],
    clients: {},
  });
  const state = op.state;
  for (const client of clients) {
    if (client.status !== "active") continue;
    if (await setClientStatus(ctx.registry, client.id, "paused", ["active"])) {
      state.paused.push(client.id);
      await saveOperation(ctx.registry, op.id, state);
    }
  }
  ctx.io.out(`  paused ${state.paused.length} clients`);
  state.phase = "migrating";
  await saveOperation(ctx.registry, op.id, state);
  for (const client of clients) {
    const { bookmark } = await ctx.operator.op<{ bookmark: string }>("bookmark", {
      client: client.id,
    });
    state.clients[client.id] = { bookmark, before: client.schemaVersion };
    await saveOperation(ctx.registry, op.id, state);
    const report = await ctx.operator.op<{
      applied: string[];
      failed: { name: string; error: string } | null;
      level: MigrationLevel;
    }>("migrate", { client: client.id, migrations: input.migrations });
    if (report.failed) {
      ctx.io.err(`  ${client.id}: migration ${report.failed.name} failed (${report.failed.error})`);
      // Its own part-way migrations, and every client migrated before it, back to their bookmarks.
      (state.clients[client.id] as { after?: number }).after = report.level.schemaVersion ?? 0;
      const restored = await restoreMigrated(ctx, state);
      await resumePaused(ctx, state);
      await finishOperation(ctx.registry, op.id, "undone", state);
      ctx.io.err(
        `The update stopped before any upload: ${restored.join(", ")} restored to their bookmarks; every client is as it was.`,
      );
      return "undone";
    }
    const after = report.level.schemaVersion ?? target;
    (state.clients[client.id] as { after?: number }).after = after;
    await recordSchemaVersion(ctx.registry, client.id, after);
    await saveOperation(ctx.registry, op.id, state);
    ctx.io.out(`  ${client.id}: ${report.applied.length} migrations, schema ${after}`);
  }
  state.phase = "uploading";
  await saveOperation(ctx.registry, op.id, state);
  try {
    await input.upload();
  } catch (error) {
    ctx.io.err(`  upload failed: ${(error as Error).message}`);
    await input.uploadPrevious();
    const restored = await restoreMigrated(ctx, state);
    await resumePaused(ctx, state);
    await finishOperation(ctx.registry, op.id, "undone", state);
    ctx.io.err(`Rolled back: ${input.from}'s Workers again, ${restored.length} clients restored.`);
    return "rolled-back";
  }
  state.phase = "uploaded";
  await saveOperation(ctx.registry, op.id, state);
  return smokeAndFinish(ctx, input, op, state);
}
