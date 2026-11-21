// Extension tools as operations (ADR 0023): `x.<extension>.<tool>`, built from installed
// manifests, so they appear in the registry (and so as MCP tools) next to core operations. The
// handler runs the tool in the sandbox through the extension host.
import type { CoreDatabase } from "@composable-os/db";
import type { ExtensionManifest, ToolManifest } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ForbiddenError, OperationError } from "../errors.ts";
import { type AnyOperation, defineOperation, markHostTool } from "../operation.ts";
import { requireHost } from "./install.ts";

export const TOOL_OPERATION_RE = /^x\.([a-z][a-z0-9]{1,29})\.([a-z][a-zA-Z0-9]{0,39})$/;

function schemaFrom(json: Record<string, unknown>, fallback: z.ZodType): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return fallback;
  }
}

const cache = new Map<string, AnyOperation>();

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
  const packPermission = source === "shipped" ? tool.permission : undefined;
  const key = `${opName}@${manifest.version}:${source}:${JSON.stringify(tool)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const op = defineOperation({
    name: opName,
    description: `${tool.description} (Extension tool from ${manifest.label ?? manifest.id} ${manifest.version}.)`,
    input: schemaFrom(tool.inputSchema, z.record(z.string(), z.unknown())),
    output: schemaFrom(tool.outputSchema, z.unknown()),
    permission: tool.risk === "read" ? "records:read" : "records:write",
    risk: tool.risk,
    ...(audiences ? { audiences } : {}),
    ...(packPermission ? { packPermission } : {}),
    async handler(input, ctx) {
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
      const result = await requireHost(ctx).runTool({
        id: manifest.id,
        commit: row.commit_oid,
        tool: name,
        input,
        caller:
          ctx.principal.kind === "staff"
            ? { actor: ctx.actor, userId: ctx.user.id, name: ctx.user.name }
            : {
                actor: ctx.principal.kind,
                userId: ctx.principal.kind === "customer" ? ctx.principal.customerId : "",
                principal: ctx.principal,
              },
      });
      if (!result.ok) {
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
