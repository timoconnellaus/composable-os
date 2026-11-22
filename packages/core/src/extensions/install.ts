// Checking and installing extensions (ADR 0025). `checkExtension` is `extension.check`;
// `installExtension` is the one path that makes a version live, used by extension.install,
// extension.rollback and (stage 3b) extension.approve. Both run inside an operation handler: the
// install's DDL, state rows and audit commit in the operation's single D1 batch.

import type { CoreDatabase } from "@composable-os/db";
import { type ExtensionManifest, type ManifestIssue, validateManifest } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { automationSyncStatements } from "../automations/registry.ts";
import { dashboardSpecSchema } from "../dashboards/spec.ts";
import { ConfigError, ValidationError } from "../errors.ts";
import { listObjects } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { hasAccessSourceKind } from "../visibility/access.ts";
// The host's own kinds of access source register themselves when loaded: loaded here too, so the
// install check (and `cos ext check`, which bundles it alone) knows them (ADR 0488).
import "../subscriptions/access.ts";
import type { EvaluateResult, ExtensionHost, SourceIssue } from "./host.ts";
import { CORE_TARGETS, isCoreTarget } from "./naming.ts";
import {
  planReconcile,
  type ReconcileIssue,
  type ReconcilePlan,
  type SchemaChange,
} from "./reconciler.ts";
import { coreFormulaFields } from "./schema.ts";

/** One problem `extension.check` found, in a shape a model can act on. */
export interface CheckIssue {
  /** Which check found it. */
  stage: "typecheck" | "contract" | "formula" | "reconcile";
  code: string;
  /** Where: a file path for source issues, a manifest path otherwise. */
  path: string;
  message: string;
  suggestion?: string;
  span?: { start: number; end: number };
}

export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
  manifest: ExtensionManifest | null;
  /** The dry-run reconcile: DDL in order and the schema changes it makes. */
  plan: { ddl: string[]; changes: SchemaChange[] } | null;
}

export function requireHost(ctx: HandlerContext): ExtensionHost {
  if (!ctx.extensionHost) {
    throw new ConfigError("The extension runtime is not available to this caller");
  }
  return ctx.extensionHost;
}

function fromSource(issue: SourceIssue): CheckIssue {
  return { stage: "typecheck", code: issue.code, path: issue.path, message: issue.message };
}

function fromManifest(issue: ManifestIssue): CheckIssue {
  return {
    stage: issue.code === "contract" ? "contract" : "formula",
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(issue.span ? { span: issue.span } : {}),
  };
}

function fromReconcile(issue: ReconcileIssue): CheckIssue {
  return {
    stage: issue.code === "formula" ? "formula" : "reconcile",
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
  };
}

/**
 * Validates an evaluated manifest for extension `id` and dry-runs its reconcile. Pure apart from
 * reading state.
 */
export async function checkManifest(
  db: Kysely<CoreDatabase>,
  id: string,
  rawManifest: unknown,
  now: string,
  options: CheckOptions = {},
): Promise<{
  issues: CheckIssue[];
  manifest: ExtensionManifest | null;
  plan: ReconcilePlan | null;
}> {
  const knownObjects = listObjects()
    .map((o) => o.name)
    .filter((name) => name.includes(".") && !name.startsWith(`${id}.`));
  const { manifest, issues } = validateManifest(rawManifest, {
    knownObjects,
    baseFields: (object) => (isCoreTarget(object) ? coreFormulaFields(object) : {}),
  });
  const all = issues.map(fromManifest);
  // Shipped dashboards (ADR 0103) must be valid dashboard specs; their SQL runs through the
  // query.sql guards when shown (the views it reads may not exist until this install).
  for (const [name, dashboard] of Object.entries(manifest?.dashboards ?? {})) {
    const parsed = dashboardSpecSchema.safeParse(dashboard);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 10)) {
        all.push({
          stage: "contract",
          code: "contract",
          path: `dashboards.${name}.${issue.path.join(".")}`,
          message: issue.message,
        });
      }
    }
  }
  // Who an extension opens the host to is never AI-configurable (ADR 0402): a runtime extension,
  // written in the workspace, may not open a tool or show an object to anyone but staff.
  if (manifest && options.source === "runtime") all.push(...outsideDeclarations(manifest));
  // The extensions it requires must be installed and on (stage 42, ADR 0478): Courses needs
  // Programs. A missing one is named, never assumed, and named first: without it, what the
  // extension names of it is unknown too.
  const raw = (rawManifest as { requires?: unknown } | null)?.requires;
  const required = Array.isArray(raw)
    ? raw.filter((r): r is string => typeof r === "string").slice(0, 10)
    : [];
  if (required.length) {
    const present = new Set(
      (
        await db
          .selectFrom("core_extensions")
          .select("id")
          .where("id", "in", required)
          .where("status", "=", "active")
          .execute()
      ).map((r) => r.id),
    );
    for (const id of options.installed ?? []) present.add(id);
    required.forEach((id, i) => {
      if (!present.has(id)) {
        all.unshift({
          stage: "contract",
          code: "contract",
          path: `requires.${i}`,
          message: `This extension requires the ${id} extension, which is not installed and on here`,
        });
      }
    });
  }
  // A source of access of a kind the host does not provide gives no one access (ADR 0477).
  for (const [name, object] of Object.entries(manifest?.objects ?? {})) {
    (object.access?.sources ?? []).forEach((source, i) => {
      if ("kind" in source && source.kind !== undefined && !hasAccessSourceKind(source.kind)) {
        all.push({
          stage: "contract",
          code: "contract",
          path: `objects.${name}.access.sources.${i}.kind`,
          message: `The host provides no source of access of kind "${source.kind}"`,
        });
      }
    });
  }
  if (manifest && manifest.id !== id) {
    all.push({
      stage: "contract",
      code: "contract",
      path: "id",
      message: `The extension declares id "${manifest.id}" but is installed as "${id}"`,
    });
  }
  if (!manifest || all.length) return { issues: all, manifest, plan: null };
  const plan = await planReconcile(db, manifest, { now });
  return { issues: plan.issues.map(fromReconcile), manifest, plan };
}

/** What kind of extension is being checked. `runtime`: written in the workspace, by AI or by hand. */
export interface CheckOptions {
  source?: "shipped" | "runtime";
  /**
   * Extensions to count as installed for `requires` (stage 42): the ones `cos ext check` has
   * reconciled into its local database before this one. A deployment's check reads
   * core_extensions.
   */
  installed?: readonly string[];
}

/** Issues for everything in `manifest` that opens the host to customers or the public. */
function outsideDeclarations(manifest: ExtensionManifest): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const why =
    "Only a shipped extension, or one in the org's own repository, can do that: it is a " +
    "reviewed change. Remove it, or move the extension out of the workspace.";
  // Another extension's tool runs with that extension's own permissions (ADR 0478): calling one
  // is a reviewed change, so code written in the app may not list one.
  manifest.permissions.operations.forEach((operation, i) => {
    if (operation.startsWith("x.")) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `permissions.operations.${i}`,
        message: `A runtime extension cannot call another extension's tool (${operation}). ${why}`,
      });
    }
  });
  for (const [name, tool] of Object.entries(manifest.tools)) {
    const open = (tool.audiences ?? []).filter((audience) => audience !== "staff");
    if (open.length || tool.customerFields) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `tools.${name}.audiences`,
        message: `A runtime extension cannot open a tool to ${open.join(" or ") || "customer"} callers. ${why}`,
      });
    }
  }
  // A role changes what a staff account may do, and a tool's permission is what a role holds
  // (ADR 0436): identity and access are not something code written in the app may declare.
  for (const [name, tool] of Object.entries(manifest.tools)) {
    if (tool.permission) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `tools.${name}.permission`,
        message: `A runtime extension cannot declare a permission for a staff role. ${why}`,
      });
    }
  }
  if (manifest.grantable?.length) {
    issues.push({
      stage: "contract",
      code: "outside_audience",
      path: "grantable",
      message: `A runtime extension cannot declare a permission an admin grants. ${why}`,
    });
  }
  for (const name of Object.keys(manifest.roles ?? {})) {
    issues.push({
      stage: "contract",
      code: "outside_audience",
      path: `roles.${name}`,
      message: `A runtime extension cannot declare a staff role. ${why}`,
    });
  }
  for (const [name, object] of Object.entries(manifest.objects)) {
    if (object.customer) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `objects.${name}.customer`,
        message: `A runtime extension cannot make ${name} visible to customers. ${why}`,
      });
    }
    // Records the public may read (ADR 0438): a reviewed change, as a customer is.
    if (object.public) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `objects.${name}.public`,
        message: `A runtime extension cannot make ${name} readable by the public. ${why}`,
      });
    }
    // Fields a customer reads through their own records (ADR 0439): a reviewed change too.
    if (object.customerVia) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `objects.${name}.customerVia`,
        message: `A runtime extension cannot make ${name} readable by customers through their own records. ${why}`,
      });
    }
    // Who holds access to a record (ADR 0477): what a customer reads of it, a reviewed change too.
    if (object.access) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `objects.${name}.access`,
        message: `A runtime extension cannot declare who holds access to ${name}. ${why}`,
      });
    }
    // Records every signed-in customer may read (ADR 0447): a reviewed change, as a customer is.
    if (object.signedIn) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `objects.${name}.signedIn`,
        message: `A runtime extension cannot make ${name} readable by signed-in customers. ${why}`,
      });
    }
    // Selling to the public opens order.start to its records (ADR 0435): a reviewed change too.
    if (object.sellable) {
      issues.push({
        stage: "contract",
        code: "outside_audience",
        path: `objects.${name}.sellable`,
        message: `A runtime extension cannot make ${name} something customers and the public can buy. ${why}`,
      });
    }
  }
  return issues;
}

/**
 * The check itself, given what evaluating the source returned: source issues (typecheck, imports,
 * syntax) as they are, otherwise contract, formulas, automations and the dry-run reconcile against
 * `db`. `extension.check` calls it with the sandbox's evaluation and the deployment's database;
 * `cos ext check` calls it with its own evaluation and an empty local database (ADR 0405). The
 * field registry must be current for `db` (`refreshSchemaRegistry`).
 */
export async function checkEvaluated(
  db: Kysely<CoreDatabase>,
  id: string,
  evaluated: EvaluateResult,
  now: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  if (!evaluated.ok) {
    return { ok: false, issues: evaluated.issues.map(fromSource), manifest: null, plan: null };
  }
  const { issues, manifest, plan } = await checkManifest(db, id, evaluated.manifest, now, options);
  return {
    ok: issues.length === 0,
    issues,
    manifest,
    plan: plan ? { ddl: plan.ddl, changes: plan.changes } : null,
  };
}

/** `extension.check`: typecheck (transpile + imports), contract, formulas, dry-run reconcile. */
export async function checkExtension(
  ctx: HandlerContext,
  input: { id: string; commit: string } | { id: string; files: Record<string, string> },
): Promise<CheckResult> {
  const host = requireHost(ctx);
  // What `extension.check` checks is always workspace source: a runtime extension.
  return checkEvaluated(ctx.db, input.id, await host.evaluate(input), ctx.now, {
    source: "runtime",
  });
}

export interface InstallResult {
  id: string;
  version: string;
  commit: string;
  source: "shipped" | "runtime";
  changes: SchemaChange[];
  /** False when this exact commit was already the installed version (nothing changed). */
  changed: boolean;
}

function firstIssue(issues: CheckIssue[]): string {
  const first = issues[0];
  if (!first) return "";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return `: ${first.path}: ${first.message}${more}`;
}

/** The core_user id of an extension's principal (ADR 0025). */
export function extensionPrincipalId(id: string): string {
  return `extension:${id}`;
}

/**
 * Makes `commit` of extension `id` the live version: evaluates it in the sandbox, checks it,
 * and queues the reconcile DDL, the state rows and the principal on `ctx`'s batch. Throws
 * ValidationError (details.issues: CheckIssue[]) when the check fails. Stage 3b's
 * `extension.approve` calls this with the approved commit.
 */
export async function installExtension(
  ctx: HandlerContext,
  input: {
    id: string;
    commit: string;
    source: "shipped" | "runtime";
    /** Allow a shipped extension to become a runtime one (an approved eject, ADR 0041). */
    eject?: boolean;
  },
): Promise<InstallResult> {
  const host = requireHost(ctx);
  const existing = await ctx.db
    .selectFrom("core_extensions")
    .selectAll()
    .where("id", "=", input.id)
    .executeTakeFirst();
  const ejecting = input.eject && existing?.source === "shipped" && input.source === "runtime";
  if (existing && existing.source !== input.source && !ejecting) {
    throw new ValidationError(
      `${input.id} is already installed as a ${existing.source} extension`,
      { id: input.id },
    );
  }
  const evaluated = await host.evaluate({ id: input.id, commit: input.commit });
  if (!evaluated.ok) {
    const issues = evaluated.issues.map(fromSource);
    throw new ValidationError(`${input.id} failed its check${firstIssue(issues)}`, { issues });
  }
  const { issues, manifest, plan } = await checkManifest(
    ctx.db,
    input.id,
    evaluated.manifest,
    ctx.now,
    { source: input.source },
  );
  if (issues.length || !manifest || !plan) {
    throw new ValidationError(`${input.id} failed its check${firstIssue(issues)}`, { issues });
  }
  const unchanged =
    existing?.commit_oid === input.commit &&
    existing.status === "active" &&
    plan.changes.length === 0;
  if (unchanged) {
    return {
      id: input.id,
      version: manifest.version,
      commit: input.commit,
      source: input.source,
      changes: [],
      changed: false,
    };
  }

  const principal = extensionPrincipalId(input.id);
  const user = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "=", principal)
    .executeTakeFirst();
  if (!user) {
    ctx.write(
      ctx.db.insertInto("core_user").values({
        id: principal,
        name: manifest.label ?? input.id,
        email: `${input.id}@extensions.crm.invalid`,
        email_verified: 0,
        image: null,
        created_at: ctx.now,
        updated_at: ctx.now,
        role: "member",
        kind: "extension",
      }),
    );
  }
  ctx.write(...plan.statements);
  const installedBy = ctx.user.id === "system" ? null : ctx.user.id;
  const manifestJson = JSON.stringify(manifest);
  ctx.write(
    ctx.db
      .insertInto("core_extensions")
      .values({
        id: input.id,
        source: input.source,
        status: "active",
        status_reason: null,
        version: manifest.version,
        commit_oid: input.commit,
        last_good_commit: existing?.last_good_commit ?? null,
        manifest: manifestJson,
        failure_count: 0,
        user_id: principal,
        installed_at: ctx.now,
        installed_by: installedBy,
        updated_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          source: input.source,
          status: "active",
          status_reason: null,
          version: manifest.version,
          commit_oid: input.commit,
          manifest: manifestJson,
          failure_count: 0,
          updated_at: ctx.now,
        }),
      ),
    ctx.db
      .insertInto("core_extension_versions")
      .values({
        extension_id: input.id,
        commit_oid: input.commit,
        version: manifest.version,
        manifest: manifestJson,
        installed_at: ctx.now,
        installed_by: installedBy,
      })
      .onConflict((oc) =>
        oc.columns(["extension_id", "commit_oid"]).doUpdateSet({ installed_at: ctx.now }),
      ),
  );
  // The extension's automations join the registry (ADR 0130); enabled flags and pauses persist.
  ctx.write(
    ...automationSyncStatements(ctx.db, {
      extensionId: input.id,
      commit: input.commit,
      automations: manifest.automations ?? {},
      now: ctx.now,
    }),
  );
  return {
    id: input.id,
    version: manifest.version,
    commit: input.commit,
    source: input.source,
    changes: plan.changes,
    changed: true,
  };
}

export { CORE_TARGETS };
