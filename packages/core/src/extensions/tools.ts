// Extension tools as operations (ADR 0023): `x.<extension>.<tool>`, built from installed
// manifests, so they appear in the registry (and so as MCP tools) next to core operations. The
// handler runs the tool in the sandbox through the extension host.

import type { CoreDatabase } from "@composable-os/db";
import { type ExtensionManifest, type ToolManifest, toolPermissions } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { TOOL_OPERATION_RE } from "../approvals/describe.ts";
import { ForbiddenError, OperationError, RunsOnApprovalError } from "../errors.ts";
import { type AnyOperation, defineOperation, markHostTool } from "../operation.ts";
import { GRANTABLE_PERMISSIONS, type Permission } from "../principals.ts";
import { callerMarks } from "../routine-mail/marks.ts";
import { requireHost } from "./install.ts";

export { TOOL_OPERATION_RE };

function schemaFrom(json: Record<string, unknown>, fallback: z.ZodType): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return fallback;
  }
}

const cache = new Map<string, AnyOperation>();

/** The audit summary's own keys (pipeline.ts): a tool's `redactResult` never hides them. */
const AUDIT_SUMMARY_KEYS: readonly string[] = ["id", "count", "records"];

/** The operation for one tool of an installed manifest. */
export function toolOperation(
  manifest: ExtensionManifest,
  name: string,
  tool: ToolManifest,
  source: "shipped" | "runtime" = "runtime",
): AnyOperation {
  const opName = `x.${manifest.id}.${name}`;
  // A runtime extension's tool is for staff whatever its manifest says (ADR 0402): `check` and
  // install refuse the declaration, and this holds if one is in the database anyway.
  const audiences = source === "shipped" ? tool.audiences : undefined;
  // Likewise a tool's permission, which a role of the extension can hold (ADR 0436).
  const packPermissions = source === "shipped" ? toolPermissions(tool) : [];
  // A tool a role also reaches opens to a grant only when it says so (ADR 0600, as the check does).
  const roleHeld = new Set(Object.values(manifest.roles ?? {}).flatMap((r) => r.permissions));
  const lifts = tool.grantLiftsRoleLimits === true || !packPermissions.some((p) => roleHeld.has(p));
  const packGrantable = lifts
    ? packPermissions.filter((p) => (manifest.grantable ?? []).includes(p))
    : [];
  // Held by admins and by grant only (ADR 0625): every permission the tool names is restricted.
  // Judged on the tool's declaration whatever the source, so a runtime extension's tool that names
  // one (refused by check and install) is an admin's only, never a member's.
  const restricted = toolPermissions(tool);
  const packRestricted =
    restricted.length > 0 && restricted.every((p) => (manifest.restricted ?? []).includes(p));
  // Open to every staff account, pack roles too (ADR 0652): a shipped pack's or the org's own, a
  // person's own, naming no permission (check and install refuse anything else, and it holds here
  // if one is in the database anyway).
  const anyStaff =
    source === "shipped" &&
    tool.anyStaff === true &&
    tool.humanOnly === true &&
    !packPermissions.length &&
    !restricted.length &&
    tool.corePermission === undefined &&
    !(tool.audiences ?? []).some((a) => a !== "staff");
  // A grantable core permission instead of records:read or records:write (ADR 0652). One that is
  // not grantable, or from a runtime extension, holds the tool to admins (fail closed).
  const corePermission =
    tool.corePermission === undefined
      ? undefined
      : source === "shipped" &&
          !packPermissions.length &&
          (GRANTABLE_PERMISSIONS as readonly string[]).includes(tool.corePermission)
        ? (tool.corePermission as Permission)
        : "users:manage";
  const key = `${opName}@${manifest.version}:${source}:${JSON.stringify(tool)}:${(manifest.grantable ?? []).join(",")}:${[...roleHeld].join(",")}:${(manifest.restricted ?? []).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const op = defineOperation({
    name: opName,
    description: `${tool.description} (Extension tool from ${manifest.label ?? manifest.id} ${manifest.version}.)`,
    input: schemaFrom(tool.inputSchema, z.record(z.string(), z.unknown())),
    output: schemaFrom(tool.outputSchema, z.unknown()),
    permission: corePermission ?? (tool.risk === "read" ? "records:read" : "records:write"),
    risk: tool.risk,
    ...(audiences ? { audiences } : {}),
    // Only a person (ADR 0512): it narrows who may call, so it holds from any extension.
    // A restricted tool (ADR 0625) is a person's, or an AI's acting for one who holds it: never an
    // automation's or another extension's code, so no grant is reached through code written in
    // the app, and no run lends its account's grant to another.
    ...(tool.humanOnly
      ? { actors: ["human"] as const }
      : packRestricted
        ? { actors: ["human", "assistant", "mcp"] as const }
        : {}),
    // A person approves anyone else's call (ADR 0552): it only adds review, so it holds from any
    // extension. The gate queues it whatever the policy, preset or floor says (a deny applies).
    ...(tool.personApproves
      ? { alwaysReview: ["assistant", "mcp", "automation", "extension"] as const }
      : {}),
    ...(packPermissions.length ? { packPermissions } : {}),
    ...(packGrantable.length ? { packGrantable } : {}),
    ...(packRestricted ? { packRestricted: true } : {}),
    ...(anyStaff ? { packAnyStaff: true } : {}),
    // A visitor's acceptances passed on to the host in the buying call (stage 44 step 3, ADR
    // 0644): the name they typed, a signature and health answers never reach the audit log, from
    // any tool.
    // A tool's own (ADR 0626): what someone wrote about their leave never reaches the log either.
    redact: ["agreements", ...(tool.redact ?? [])],
    // A secret its answer carries once (a calendar feed's address, ADR 0628): never kept.
    // A shipped pack's only (a runtime extension's is refused by check and install, and ignored
    // here if one is in the database anyway), and never the audit summary's own keys.
    ...(source === "shipped" && tool.redactResult?.length
      ? {
          redactResult: tool.redactResult.filter((k) => !AUDIT_SUMMARY_KEYS.includes(k)),
        }
      : {}),
    async handler(input, ctx) {
      // The pipeline already never dry-runs a tool that may write (approvals/dry-run.ts: that is
      // the guarantee); this keeps the handler safe if it is ever called with a simulation.
      // A dry run (the approval queue's, ADR 0022) must change nothing, and a tool's own
      // operation calls are real invocations the dry run cannot hold back: so the tool is not run
      // until it is approved (found by the Bookings review, 2026-11-22: a destructive tool queued
      // for a person had already made its change).
      if (ctx.simulation) return null as never;
      const row = await ctx.db
        .selectFrom("core_extensions")
        .select(["status", "commit_oid"])
        .where("id", "=", manifest.id)
        .executeTakeFirst();
      if (row?.status !== "active") {
        throw new ForbiddenError(
          `Extension ${manifest.id} is ${row?.status ?? "not installed"}; its tools cannot run`,
          { extension: manifest.id, status: row?.status ?? null },
        );
      }
      // Called inside an automation cascade: the tool's own calls stay in it (ADR 0478).
      // Called by an AI (the assistant, an MCP client): the tool's own writes keep this call as
      // their root, so what they start knows an AI asked for them, and whether a person approved
      // it (routine mail holds such a send for a person, ADR 0590).
      const o = ctx.origin;
      const cascade =
        o.rootEventId !== undefined
          ? {
              depth: o.depth ?? 0,
              chain: [...(o.chain ?? [])],
              rootEventId: o.rootEventId,
              ...(o.automationId ? { automationId: o.automationId } : {}),
              ...(o.runId ? { runId: o.runId } : {}),
            }
          : ctx.auditId &&
              ctx.principal.kind === "staff" &&
              (ctx.actor === "assistant" || ctx.actor === "mcp")
            ? { depth: 0, chain: [], rootEventId: ctx.auditId }
            : undefined;
      const result = await requireHost(ctx).runTool({
        id: manifest.id,
        commit: row.commit_oid,
        tool: name,
        input,
        ...(tool.risk === "read" ? { readOnly: true } : {}),
        ...(cascade ? { cascade } : {}),
        caller:
          ctx.principal.kind === "staff"
            ? {
                actor: ctx.actor,
                userId: ctx.user.id,
                name: ctx.user.name,
                // A pack role limited to today holds inside the tool too (ADR 0553).
                ...(ctx.roleToday ? { roleToday: ctx.roleToday } : {}),
                // And one limited to the People they look after (ADR 0889).
                ...(ctx.roleLooksAfter ? { roleLooksAfter: ctx.roleLooksAfter } : {}),
                // And one reaching only the records that name them (ADR 0755).
                ...(ctx.roleMine ? { roleMine: ctx.roleMine } : {}),
                // Who approved it, for a tool a person approves called by another actor.
                ...(ctx.approval?.approvedBy ? { approvedBy: ctx.approval.approvedBy } : {}),
                // A run calling this tool: the weaker of its standing and the tool's wins.
                ...callerMarks(ctx),
              }
            : {
                actor: ctx.principal.kind,
                userId: ctx.principal.kind === "customer" ? ctx.principal.customerId : "",
                principal: ctx.principal,
              },
      });
      if (!result.ok) {
        // A read tool in a dry run reached what the dry run does not touch: not run (dry-run.ts).
        if (result.error.code === "runs_on_approval") {
          const uses = (result.error.details as { uses?: unknown } | undefined)?.uses;
          throw new RunsOnApprovalError(
            typeof uses === "string" ? uses : `the extension tool ${manifest.id}.${name}`,
          );
        }
        throw new OperationError("extension_error", result.error.message, {
          extension: manifest.id,
          tool: name,
          code: result.error.code,
          runId: result.runId,
          quarantined: result.quarantined,
          ...(result.error.details === undefined ? {} : { details: result.error.details }),
        });
      }
      return result.value as never;
    },
  });
  markHostTool(op);
  cache.set(key, op);
  return op;
}

type Installed = { manifest: ExtensionManifest; source: "shipped" | "runtime" };

async function manifests(db: Kysely<CoreDatabase>, id?: string): Promise<Installed[]> {
  let query = db.selectFrom("core_extensions").select(["manifest", "status", "source"]);
  if (id) query = query.where("id", "=", id);
  const rows = await query.execute();
  return rows.map((row) => ({
    manifest: JSON.parse(row.manifest) as ExtensionManifest,
    source: row.source,
  }));
}

/**
 * What the installed tool `tool` of `extension` may do for a caller outside the org, or null when
 * there is no such tool or it is not open to them. Read from the installed manifest, never from
 * the run (ADR 0414).
 */
export async function loadOpenTool(
  db: Kysely<CoreDatabase>,
  extension: string,
  tool: string,
): Promise<{
  audiences: readonly string[];
  widened: Map<string, ReadonlySet<string>>;
  permissions: ExtensionManifest["permissions"];
} | null> {
  const [installed] = await manifests(db, extension);
  const spec = installed?.manifest.tools?.[tool];
  if (!installed || !spec || installed.source !== "shipped" || !spec.audiences) return null;
  return {
    audiences: spec.audiences,
    widened: new Map(
      Object.entries(spec.customerFields ?? {}).map(([object, fields]) => [
        object,
        new Set(fields),
      ]),
    ),
    permissions: installed.manifest.permissions,
  };
}

/** Every installed extension tool as an operation (for registry listings and MCP). */
export async function loadExtensionOperations(db: Kysely<CoreDatabase>): Promise<AnyOperation[]> {
  const ops: AnyOperation[] = [];
  for (const { manifest, source } of await manifests(db)) {
    for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
      ops.push(toolOperation(manifest, name, tool, source));
    }
  }
  return ops;
}

/** Resolves `x.<extension>.<tool>` to its operation, or undefined. */
export async function resolveExtensionOperation(
  db: Kysely<CoreDatabase>,
  name: string,
): Promise<AnyOperation | undefined> {
  const match = TOOL_OPERATION_RE.exec(name);
  if (!match) return undefined;
  const [, id, tool] = match as unknown as [string, string, string];
  const [installed] = await manifests(db, id);
  const spec = installed?.manifest.tools?.[tool];
  return installed && spec
    ? toolOperation(installed.manifest, tool, spec, installed.source)
    : undefined;
}
