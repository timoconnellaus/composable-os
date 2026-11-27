// The record of a finished install of the shipped extensions (issue #558, ADR 0040 as amended
// 2026-11-28). `installShipped` runs once per cos-app isolate and client; before this record each
// run asked the workspace object for every pack's commit and read every pack's row twice, so a
// release with five packs cost a new isolate's first request some fifteen calls even when nothing
// had changed. Now a run that ended with nothing failed writes, in the client's own database
// (`core_meta`, key `shipped_install`):
//
// - what was installed: a hash of this deployment's shipped list (each extension's id, version,
//   whether it is optional, and a hash of its files), with the client it was installed for
//   (`clientStampOf`: another client's record, copied into this client's database, never matches);
// - what the extensions table held then: a hash of each row's id, source and commit;
// - the outcomes, each `installed` written as `unchanged` (which it is now).
//
// The next run reads the record and the table in one query and, when both still match, asks the
// workspace object in one call whether it holds each shipped extension's recorded commit (its
// storage, no git): then it answers the outcomes again, with no install. The workspace check is
// what keeps a copied database honest: a client's database moved to another host (`cos client
// import`, `cos install --import`) arrives without this host's workspace, and its packs' source
// must be committed there again. Exports also leave the record out and imports delete it
// (packages/db sql-export.ts, `HOST_ONLY_META`). Anything that changes
// what a full run would do changes one of the two: a new release or a changed COS_PACKS or
// COS_ORG_EXTENSIONS (the list), an admin's install, rollback, eject or uninstall (the table).
// A run with a failure writes nothing, so the next isolate tries again, as before.
import { type ShippedInstallResult, sha256Hex } from "@composable-os/core";
import type { CrmDb } from "@composable-os/db";
import { clientStampOf } from "@composable-os/db/client-environment";
import { sql } from "kysely";
import { clientKeyOf } from "../client-scope.ts";
import { contentHash } from "../executor/worker-code.ts";
import { type ShippedListEnv, shippedExtensions } from "./shipped-list.ts";

export const SHIPPED_STAMP_KEY = "shipped_install";

/** Whether the workspace object holds each shipped extension at its commit (one call). */
export type HoldsShipped = (commits: { id: string; commit: string }[]) => Promise<boolean>;

interface Stamp {
  list: string;
  rows: string;
  results: ShippedInstallResult[];
}

// By environment (stage 66 step 5, ADR 0617): one client's list, with the settings it was made
// from, so a changed COS_PACKS on the same environment object is hashed again.
const listHashes = new WeakMap<object, { settings: string; hash: Promise<string> }>();

/** The hash of what this deployment installs as shipped, for this client. Once per isolate. */
export function shippedListHash(env: ShippedListEnv): Promise<string> {
  const key = clientKeyOf(env);
  const settings = JSON.stringify([env.COS_PACKS ?? "*", env.COS_ORG_EXTENSIONS ?? ""]);
  const held = listHashes.get(key);
  if (held?.settings === settings) return held.hash;
  const hash = (async () => {
    const list = await shippedExtensions(env);
    const entries = await Promise.all(
      list.map(async (s) => [s.id, s.version, s.optional === true, await contentHash(s.files)]),
    );
    return sha256Hex(JSON.stringify({ client: clientStampOf(env), entries }));
  })();
  const entry = { settings, hash };
  listHashes.set(key, entry);
  // A list that could not be read (COS_PACKS names a pack the release lacks) is read again.
  hash.catch(() => {
    if (listHashes.get(key) === entry) listHashes.delete(key);
  });
  return hash;
}

/** The stamp and a hash of the extensions table, in one query. */
async function read(
  db: CrmDb,
): Promise<{ stamp: Stamp | null; rows: string; shipped: { id: string; commit: string }[] }> {
  const result = await sql<{ stamp: string | null; rows: string | null }>`
    SELECT
      (SELECT value FROM core_meta WHERE key = ${SHIPPED_STAMP_KEY}) AS stamp,
      (SELECT json_group_array(json_array(id, source, commit_oid)) FROM core_extensions) AS rows
  `.execute(db.query);
  const row = result.rows[0];
  const parsed = JSON.parse(row?.rows ?? "[]") as [string, string, string][];
  const rows = parsed.map((r) => JSON.stringify(r)).sort();
  const shipped = parsed
    .filter(([, source]) => source === "shipped")
    .map(([id, , commit]) => ({ id, commit }));
  let stamp: Stamp | null = null;
  try {
    stamp = row?.stamp ? (JSON.parse(row.stamp) as Stamp) : null;
  } catch {
    stamp = null;
  }
  return { stamp, rows: await sha256Hex(rows.join("\n")), shipped };
}

/**
 * The outcomes of the last install when nothing has changed since (one read, one workspace
 * call), or null: then a full install is needed.
 */
export async function stampedInstall(
  db: CrmDb,
  env: ShippedListEnv,
  holds: HoldsShipped,
): Promise<ShippedInstallResult[] | null> {
  const [list, { stamp, rows, shipped }] = await Promise.all([shippedListHash(env), read(db)]);
  if (!stamp || stamp.list !== list || stamp.rows !== rows || !Array.isArray(stamp.results)) {
    return null;
  }
  if (shipped.length && !(await holds(shipped))) return null;
  return stamp.results;
}

/** Records a finished install: only one where nothing failed. */
export async function recordInstall(
  db: CrmDb,
  env: ShippedListEnv,
  results: ShippedInstallResult[],
): Promise<void> {
  if (results.some((r) => r.outcome === "failed")) return;
  const [list, { rows }] = await Promise.all([shippedListHash(env), read(db)]);
  const stamp: Stamp = {
    list,
    rows,
    results: results.map((r) => (r.outcome === "installed" ? { ...r, outcome: "unchanged" } : r)),
  };
  const value = JSON.stringify(stamp);
  await db.query
    .insertInto("core_meta")
    .values({ key: SHIPPED_STAMP_KEY, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}
