// `cos install --import <folder>` (stage 66 step 7, criterion 13; the leaving promise): a client's
// export installed as a single-client deployment in another account. Its database goes into the
// new install's empty D1 database before any migration runs (an import goes only into an empty
// database), part by part, each checked as `importPart` checks (statements an export writes, the
// schema against this release's migrations, the row counts against the export's); its files into
// the install's files bucket under their own keys (a single-client deployment has no client
// prefix); its own secrets become the Workers' secrets, so its staff and customers stay signed in;
// and every record it had embedded is queued again, so the new search index is rebuilt by the
// embeddings tick.

import { rebuildRecordViews } from "@composable-os/core/record-views";
import {
  type ExportSource,
  importDatabase,
  importedExtensionObjects,
  migrationsSchema,
  schemaRows,
} from "@composable-os/db/sql-export";
import type { CloudflareClient, Log, ReleaseBundle, ReleaseManifest } from "@composable-os/release";
import type { readExportFolder } from "./clients.ts";
import { d1OverRest } from "./d1-rest.ts";
import { nodeD1 } from "./node-d1.ts";
import { bundleMigrations } from "./run.ts";

export type ExportFolder = ReturnType<typeof readExportFolder>;

/** The single-client Worker secrets an export's own secrets set: what that deployment reads. */
const SINGLE_CLIENT_SECRETS = new Set([
  "BETTER_AUTH_SECRET",
  "CUSTOMER_AUTH_SECRET",
  "DESK_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "TYPESAFE_API_KEY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
]);

/** The export's secrets the app Worker of a single-client deployment holds, by name. */
export function exportedAppSecrets(folder: ExportFolder): {
  secrets: Record<string, string>;
  leftOut: string[];
} {
  const secrets: Record<string, string> = {};
  const leftOut: string[] = [];
  for (const [name, value] of Object.entries({
    ...(folder.secrets?.given ?? {}),
    ...(folder.secrets?.derived ?? {}),
  })) {
    if (SINGLE_CLIENT_SECRETS.has(name) && value) secrets[name] = value;
    // The support cookie's and client-address keys are a host of many clients' own: a single
    // deployment keys both from its staff secret. Stripe keys and AI keys go to the payments
    // gatekeeper and AI Gateway, which `cos install` sets with --secret and --provider-key.
    else leftOut.push(name);
  }
  return { secrets, leftOut };
}

/** Imports the export's database into the install's empty D1 database. */
export async function importIntoD1(input: {
  api: CloudflareClient;
  accountId: string;
  databaseId: string;
  bundle: ReleaseBundle;
  folder: ExportFolder;
  log: Log;
}): Promise<{ parts: number; rows: number }> {
  const db = d1OverRest(input.api, input.accountId, input.databaseId);
  const migrations = bundleMigrations(input.bundle);
  let coreViews: { name: string; sql: string }[] = [];
  await importDatabase(db, input.folder.parts, {
    // No view comes from the export (review of #526, N3): made again below.
    skipViews: true,
    async expectedSchema(imported: D1Database, source: ExportSource) {
      const reference = nodeD1();
      try {
        const core = await migrationsSchema(reference, migrations, source.migrations);
        coreViews = core
          .filter((r) => r.type === "view" && r.sql)
          .map((r) => ({ name: r.name, sql: r.sql as string }));
        const views = new Set(coreViews.map((v) => v.name));
        const kept = core.filter((r) => r.type !== "view" && !views.has(r.tbl_name));
        return [...kept, ...importedExtensionObjects(await schemaRows(imported), core)];
      } finally {
        reference.close();
      }
    },
  });
  const made = await rebuildRecordViews(db, coreViews);
  input.log(`  views: ${made.views} made from this release's definitions`);
  // The new index is empty: every record the export had embedded is queued again.
  const now = new Date().toISOString();
  const hasEmbeddings = await db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'core_embedding'")
    .first();
  if (hasEmbeddings)
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO core_embedding_queue (object_type, record_id, queued_at) SELECT object_type, record_id, ? FROM core_embedding",
        )
        .bind(now),
      db.prepare("DELETE FROM core_embedding"),
    ]);
  const rows = Object.values(input.folder.manifest.database.counts).reduce((a, b) => a + b, 0);
  input.log(
    `  imported ${input.folder.parts.length} parts, ${rows} rows; search index queued to rebuild`,
  );
  return { parts: input.folder.parts.length, rows };
}

/** The files bucket the app binds as BLOBS, as deployed. */
export function filesBucketOf(
  manifest: ReleaseManifest,
  resources: Record<string, string>,
): string {
  const app = manifest.workers.find((w) => w.role === "app");
  const binding = app?.bindings.find((b) => b.name === "BLOBS");
  const name = String(binding?.bucket_name ?? "").match(/^\$R2_NAME\((.+)\)$/)?.[1];
  const bucket = name ? resources[`R2_NAME(${name})`] : undefined;
  if (!bucket) throw new Error("the release's app has no files bucket");
  return bucket;
}

/** Puts every file of the export into the install's files bucket under its own key. */
export async function importFiles(input: {
  api: CloudflareClient;
  accountId: string;
  bucket: string;
  folder: ExportFolder;
  log: Log;
}): Promise<number> {
  for (const file of input.folder.files) {
    await input.api.putR2Object(input.accountId, input.bucket, file.key, file.bytes);
  }
  input.log(`  imported ${input.folder.files.length} files`);
  return input.folder.files.length;
}
