// `cos ext check <dir>`: the check `extension.check` runs in a deployment, run on a directory
// (ADR 0405). Source checks and evaluation are in evaluate.ts; from the manifest on it is the
// host's own `checkEvaluated`, against an empty local database with the core schema applied.
// Other extensions this one builds on (a relation to `deals.deal`, a field added to one of their
// objects) are read from the directories beside it and reconciled into that database first, the
// way they would already be installed in a deployment.
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type CheckIssue,
  type CheckResult,
  checkEvaluated,
  checkManifest,
  refreshSchemaRegistry,
} from "@composable-os/core/extension-check";
import { evaluateFiles, readExtensionFiles } from "./evaluate.ts";
import { createLocalDb, type LocalDb } from "./local-db.ts";
import { findPlatform, type Platform } from "./platform.ts";
import { portalBlockIssues } from "./portal.ts";

export interface LocatedIssue extends CheckIssue {
  /** The file to open: the issue's own for source issues, else where the path's key is written. */
  file: string;
  line?: number;
}

export interface DirCheckResult extends Omit<CheckResult, "issues"> {
  id: string;
  issues: LocatedIssue[];
}

export class ExtCheckError extends Error {
  override name = "ExtCheckError";
}

/** An extension's id is its directory's name (as for shipped extensions and the workspace). */
export function extensionIdOf(dir: string): string {
  return basename(resolve(dir));
}

/** Ids of other extensions in directories beside `dir` that `manifest` names (`deals.deal`). */
function siblingsNamed(dir: string, id: string, manifest: unknown): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(manifest).matchAll(/"([a-z][a-z0-9]{1,29})\.[A-Za-z]/g)) {
    const name = match[1] as string;
    if (name !== id && existsSync(join(dirname(resolve(dir)), name, "index.ts"))) names.add(name);
  }
  // The extensions it requires (stage 42, ADR 0478), named or not, and those an automation runs
  // only with (ADR 0812): checked against them, as a deployment that has them installed would.
  const m = manifest as { requires?: unknown; automations?: Record<string, unknown> } | null;
  const onlyWith = Object.values(m?.automations ?? {}).flatMap((a) => {
    const ids = (a as { onlyWith?: unknown } | null)?.onlyWith;
    return Array.isArray(ids) ? ids : [];
  });
  for (const name of [...(Array.isArray(m?.requires) ? m.requires : []), ...onlyWith]) {
    if (
      typeof name === "string" &&
      name !== id &&
      existsSync(join(dirname(resolve(dir)), name, "index.ts"))
    ) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Reconciles the extension in `dir` into `local` (after the ones it names), or says why not. One
 * that requires the extension being checked (`root`) is installed after it in a deployment, never
 * before, so it is not one the checked extension builds on: it is left out (stage 49, ADR 0764:
 * Memberships requires Bookings, whose appointments name Memberships' holders as payers).
 */
async function installSibling(
  platform: Platform,
  local: LocalDb,
  dir: string,
  now: string,
  done: Set<string>,
  root: string,
): Promise<string | null> {
  const id = extensionIdOf(dir);
  if (done.has(id)) return null;
  done.add(id);
  const evaluated = await evaluateFiles(platform, readExtensionFiles(dir));
  if (!evaluated.ok) return evaluated.issues[0]?.message ?? "it does not evaluate";
  const requires = (evaluated.manifest as { requires?: unknown } | null)?.requires;
  if (Array.isArray(requires) && requires.includes(root)) {
    done.delete(id);
    return null;
  }
  for (const sibling of siblingsNamed(dir, id, evaluated.manifest)) {
    const why = await installSibling(platform, local, join(dirname(dir), sibling), now, done, root);
    if (why) return `${sibling}: ${why}`;
  }
  await refreshSchemaRegistry(local.db);
  const { issues, plan } = await checkManifest(local.db, id, evaluated.manifest, now, {
    installed: [...done],
  });
  if (issues.length || !plan) return issues[0]?.message ?? "it has no reconcile plan";
  local.batch(plan.statements);
  return null;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Manifest keys whose children are named by the author (an object, a field, an automation). */
const NAMED_UNDER = new Set([
  "objects",
  "fields",
  "views",
  "recordTabs",
  "recordPanels",
  "settings",
  "dashboards",
  "tools",
  "automations",
  "seed",
]);

/**
 * Where a manifest path is written: the deepest part of the path that the author named (an
 * object, a field, an automation), else its deepest key, found in the source as a key, a
 * constant or a string; index.ts when several files have it. A best guess, right for the common
 * case.
 */
export function locate(
  files: Record<string, string>,
  path: string,
): { file: string; line?: number } {
  const segments = path.split(".").filter((s) => s && !/^\d+$/.test(s));
  const named = segments.filter((_, i) => NAMED_UNDER.has(segments[i - 1] ?? ""));
  for (const segment of [...named.reverse(), ...segments.reverse()]) {
    const name = escapeRe(segment);
    const pattern = new RegExp(
      `(?:\\b${name}\\s*[:(]|["'\`]${name}["'\`]|\\b(?:const|function)\\s+${name}\\b)`,
    );
    const hits = Object.entries(files)
      .map(([file, text]) => ({ file, index: text.search(pattern), text }))
      .filter((hit) => hit.index !== -1)
      .sort((a, b) => Number(b.file === "index.ts") - Number(a.file === "index.ts"));
    const hit = hits[0];
    if (hit) return { file: hit.file, line: hit.text.slice(0, hit.index).split("\n").length };
  }
  return { file: "index.ts" };
}

function located(files: Record<string, string>, issue: CheckIssue): LocatedIssue {
  if (issue.stage === "typecheck") {
    const line = /^(\d+):\d+ /.exec(issue.message)?.[1];
    return { ...issue, file: issue.path, ...(line ? { line: Number(line) } : {}) };
  }
  return { ...issue, ...locate(files, issue.path) };
}

/** Checks the extension in `dir`. Throws ExtCheckError when there is nothing to check. */
export async function checkExtensionDir(
  dir: string,
  options: { now?: string } = {},
): Promise<DirCheckResult> {
  const root = resolve(dir);
  if (!existsSync(root)) throw new ExtCheckError(`No such directory: ${dir}`);
  const platform = findPlatform(root);
  if (!platform) {
    throw new ExtCheckError(
      `${dir} is not inside a Composable OS checkout (no packages/sdk and packages/db above it)`,
    );
  }
  const id = extensionIdOf(root);
  const now = options.now ?? new Date().toISOString();
  const files = readExtensionFiles(root);
  const evaluated = await evaluateFiles(platform, files);
  const local = await createLocalDb(platform.migrations);
  try {
    const before: CheckIssue[] = [];
    const done = new Set([id]);
    if (evaluated.ok) {
      for (const sibling of siblingsNamed(root, id, evaluated.manifest)) {
        const why = await installSibling(
          platform,
          local,
          join(dirname(root), sibling),
          now,
          done,
          id,
        );
        if (why) {
          before.push({
            stage: "reconcile",
            code: "dependency",
            path: "(root)",
            message: `This extension builds on "${sibling}" (../${sibling}), which does not pass its own check: ${why}`,
            suggestion: `Run cos ext check on ../${sibling} and fix it first`,
          });
        }
      }
    }
    await refreshSchemaRegistry(local.db);
    const result = await checkEvaluated(local.db, id, evaluated, now, { installed: [...done] });
    // A pack's sections of My account name blocks in its folder (stage 48, ADR 0710): read here,
    // where the files are; the host has only the manifest.
    const portal = result.manifest ? portalBlockIssues(root, result.manifest, platform.root) : [];
    const issues = [...before, ...result.issues, ...portal];
    return {
      ...result,
      id,
      ok: issues.length === 0,
      issues: issues.map((issue) => located(files, issue)),
    };
  } finally {
    local.close();
  }
}
