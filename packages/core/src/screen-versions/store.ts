// The screen version store (stage 75 step 3, ADR 0961): where a client's versions and their files
// are kept, how a sealed version's file is found, and the daily sweep that removes what the
// retention rule lets go.
//
// A version's record, manifest and file list are in the client's database (migration 1490); its
// files' bytes are in the client's part of the files binding (BLOBS, `clients/<client>/` on a
// many-client host, ADR 0615), under `screens/<sha256>/<version that stored it>`. A file is stored
// once whatever number of versions name it. Nothing here knows how a version is served: a target
// (Worker Loader, a namespace upload, the desktop app) reads a sealed version's files through
// `screenVersionFile`, and nothing outside the version's manifest is ever one of them.
//
// The rules the database holds whatever writes it (the triggers of migration 1490): a version is
// stored open, gains files only while open, and once sealed never changes; a sealed version is
// removed only when ten newer sealed versions exist and nothing holds it; a file named by a
// version is never removed.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import type { BlobStore } from "../integrations/runtime.ts";

type Db = Kysely<CoreDatabase>;

/** Where a client's screen files are in the files binding. */
export const SCREEN_FILES_PREFIX = "screens/";

/** How long an open version may take to be sealed before it is swept, with what it was sent. */
export const OPEN_VERSION_HOURS = 24;

/** Open versions a client may have at once: with the limits of one, the bound on unsealed bytes. */
export const MAX_OPEN_VERSIONS = 3;

/** Sealed versions always kept, newest first; the trigger on core_screen_version holds it too. */
export const KEPT_VERSIONS = 10;

/** Where a file's bytes are: by its hash, and the version that first stored it. */
export function screenObjectKey(sha256: string, versionId: string): string {
  return `${SCREEN_FILES_PREFIX}${sha256}/${versionId}`;
}

/** A sealed version's file, as a target serves it. */
export interface ScreenVersionFile {
  path: string;
  sha256: string;
  size: number;
  /** The host's, from the path's extension. */
  contentType: string;
  /** Where its bytes are in the client's part of the files binding. */
  objectKey: string;
}

/**
 * One file of a sealed version, by its path: null when the version is not sealed, is not the
 * client's, or its manifest does not name the path. The only way a target finds a version's file.
 */
export async function screenVersionFile(
  db: Db,
  versionId: string,
  path: string,
): Promise<ScreenVersionFile | null> {
  const row = await db
    .selectFrom("core_screen_version_file as f")
    .innerJoin("core_screen_version as v", "v.id", "f.version_id")
    .innerJoin("core_screen_blob as b", "b.sha256", "f.sha256")
    .select(["f.path", "f.sha256", "f.size", "f.content_type", "b.object_key"])
    .where("f.version_id", "=", versionId)
    .where("f.path", "=", path)
    .where("v.state", "=", "sealed")
    .executeTakeFirst();
  if (!row) return null;
  return {
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    contentType: row.content_type,
    objectKey: row.object_key,
  };
}

/** What the sweep did. */
export interface ScreenSweep {
  holdsEnded: number;
  openRemoved: number;
  sealedRemoved: number;
  filesQueued: number;
  strays: number;
}

/** At most this many versions are removed by one sweep; the rest wait for the next day. */
const SWEEP_VERSIONS = 50;
/** At most this many pages of the files binding are read for strays by one sweep. */
const SWEEP_PAGES = 20;

/**
 * The daily sweep (the maintenance cron, per client): holds whose time has passed end; open
 * versions past their time go with what they were sent; sealed versions the retention rule lets go
 * are removed (all but the ten newest sealed, unless held); files no version names and no open
 * version was sent are queued for deletion from the files binding (core_blob_deletion, drained by
 * the 10-minute cron) in the same batch that removes their rows, so a file put again after that
 * gets a new key; and stray objects under `screens/` that no row names (a put whose batch failed,
 * two open versions storing the same new file at once) are deleted once their version is not open.
 */
export async function sweepScreenVersions(
  crm: CrmDb,
  now: Date,
  blobs?: BlobStore,
): Promise<ScreenSweep> {
  const db = crm.query;
  const at = now.toISOString();
  const result: ScreenSweep = {
    holdsEnded: 0,
    openRemoved: 0,
    sealedRemoved: 0,
    filesQueued: 0,
    strays: 0,
  };
  const ended = await db
    .deleteFrom("core_screen_version_hold")
    .where("until", "is not", null)
    .where("until", "<=", at)
    .executeTakeFirst();
  result.holdsEnded = Number(ended.numDeletedRows);

  const expired = await db
    .selectFrom("core_screen_version")
    .select("id")
    .where("state", "=", "open")
    .where("expires_at", "<=", at)
    .limit(SWEEP_VERSIONS)
    .execute();
  for (const { id } of expired) {
    await crm.batch([
      db.deleteFrom("core_screen_version_upload").where("version_id", "=", id),
      db.deleteFrom("core_screen_version").where("id", "=", id).where("state", "=", "open"),
    ]);
    result.openRemoved += 1;
  }

  const beyond = await db
    .selectFrom("core_screen_version as v")
    .select("v.id")
    .where("v.state", "=", "sealed")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("core_screen_version_hold as h")
            .select("h.version_id")
            .whereRef("h.version_id", "=", "v.id"),
        ),
      ),
    )
    .orderBy("v.sealed_at", "desc")
    .orderBy("v.id", "desc")
    .limit(SWEEP_VERSIONS)
    .offset(KEPT_VERSIONS)
    .execute();
  for (const { id } of beyond) {
    // The version first (its trigger refuses one still kept), then its files, whose trigger lets
    // them go only once it has. One batch: both or neither.
    await crm.batch([
      db.deleteFrom("core_screen_version").where("id", "=", id),
      db.deleteFrom("core_screen_version_file").where("version_id", "=", id),
    ]);
    result.sealedRemoved += 1;
  }

  const unnamed = sql<boolean>`NOT EXISTS (SELECT 1 FROM core_screen_version_file f WHERE f.sha256 = core_screen_blob.sha256)
    AND NOT EXISTS (SELECT 1 FROM core_screen_version_upload u WHERE u.sha256 = core_screen_blob.sha256)`;
  const unnamedCount = await db
    .selectFrom("core_screen_blob")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where(unnamed)
    .executeTakeFirst();
  result.filesQueued = Number(unnamedCount?.n ?? 0);
  if (result.filesQueued) {
    // One batch: each key is queued for deletion exactly when its row goes.
    await crm.batch([
      sql`INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
        SELECT object_key, ${at} FROM core_screen_blob WHERE ${unnamed}`.compile(db),
      db.deleteFrom("core_screen_blob").where(unnamed),
    ]);
  }

  if (blobs?.list) result.strays = await deleteStrays(db, blobs);
  return result;
}

/** Objects under `screens/` that no row names and whose version is not open. */
async function deleteStrays(db: Db, blobs: BlobStore): Promise<number> {
  if (!blobs.list) return 0;
  const named = new Set(
    (await db.selectFrom("core_screen_blob").select("object_key").execute()).map(
      (r) => r.object_key,
    ),
  );
  const open = new Set(
    (
      await db
        .selectFrom("core_screen_version")
        .select("id")
        .where("state", "=", "open")
        .execute()
    ).map((r) => r.id),
  );
  const queued = new Set(
    (
      await db
        .selectFrom("core_blob_deletion")
        .select("key")
        .where("key", "like", `${SCREEN_FILES_PREFIX}%`)
        .execute()
    ).map((r) => r.key),
  );
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const listed = await blobs.list(SCREEN_FILES_PREFIX, cursor);
    const strays = listed.keys.filter((key) => {
      if (named.has(key) || queued.has(key)) return false;
      const version = key.slice(SCREEN_FILES_PREFIX.length).split("/")[1];
      return !version || !open.has(version);
    });
    if (strays.length) {
      await blobs.delete(strays);
      deleted += strays.length;
    }
    if (!listed.cursor) break;
    cursor = listed.cursor;
  }
  return deleted;
}
