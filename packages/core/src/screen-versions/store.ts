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
import { SCREEN_VERSION_KINDS } from "@composable-os/sdk";
import { type Kysely, sql } from "kysely";
import type { BlobStore } from "../integrations/runtime.ts";

type Db = Kysely<CoreDatabase>;

/** Where a client's screen files are in the files binding. */
export const SCREEN_FILES_PREFIX = "screens/";

/** How long an open version may take to be sealed before it is swept, with what it was sent. */
export const OPEN_VERSION_HOURS = 24;

/** Open versions of a kind a client may have at once: with a version's limits, the bound on unsealed bytes. */
export const MAX_OPEN_VERSIONS = 3;

/**
 * Versions begun a day, and bytes of new files stored a day, per client: counted in the writes
 * (migration 1490's core_screen_day), so beginning, filling and sealing versions over and over
 * cannot grow a client's files without bound. Five full versions a day.
 */
export const DAILY_VERSIONS = 50;
export const DAILY_BYTES = 250 * 1024 * 1024;

/** How many days of core_screen_day are kept. */
const DAY_ROWS_KEPT = 7;

/** Sealed versions of each kind always kept, newest first; the delete trigger holds it too. */
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

/** Versions removed a round; rounds go on until none is left, at most SWEEP_ROUNDS a sweep. */
const SWEEP_VERSIONS = 50;
const SWEEP_ROUNDS = 20;
/** At most this many pages of the files binding are read for strays by one sweep. */
const SWEEP_PAGES = 20;

/**
 * The daily sweep (the maintenance cron, per client): holds whose time has passed end; open
 * versions past their time go with what they were sent; sealed versions the retention rule lets go
 * are removed (all but the ten newest sealed of each kind, unless held); files no version names and no open
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

  for (let round = 0; round < SWEEP_ROUNDS; round++) {
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
    if (expired.length < SWEEP_VERSIONS) break;
  }

  for (const kind of SCREEN_VERSION_KINDS) {
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const beyond = await db
        .selectFrom("core_screen_version as v")
        .select("v.id")
        .where("v.kind", "=", kind)
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
        // The version first (its trigger refuses one still kept), then its files, whose trigger
        // lets them go only once it has. One batch: both or neither.
        await crm.batch([
          db.deleteFrom("core_screen_version").where("id", "=", id),
          db.deleteFrom("core_screen_version_file").where("version_id", "=", id),
        ]);
        result.sealedRemoved += 1;
      }
      if (beyond.length < SWEEP_VERSIONS) break;
    }
  }

  const since = new Date(now.getTime() - DAY_ROWS_KEPT * 86_400_000).toISOString().slice(0, 10);
  await db.deleteFrom("core_screen_day").where("day", "<", since).execute();

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

/**
 * Objects under `screens/` that no row names and whose version is sealed or gone. Each listed page
 * is checked against the database after it is listed, not against a reading taken before: a put
 * stores its object before its row commits, and only into a version that is open then, so an
 * object whose version is open now may be an upload in flight and is left.
 */
async function deleteStrays(db: Db, blobs: BlobStore): Promise<number> {
  if (!blobs.list) return 0;
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SWEEP_PAGES; page++) {
    const listed = await blobs.list(SCREEN_FILES_PREFIX, cursor);
    const keys = listed.keys;
    if (keys.length) {
      const versionOf = (key: string) => key.slice(SCREEN_FILES_PREFIX.length).split("/")[1] ?? "";
      const keyList = JSON.stringify(keys);
      const versionList = JSON.stringify([...new Set(keys.map(versionOf))]);
      const named = new Set(
        (
          await db
            .selectFrom("core_screen_blob")
            .select("object_key")
            .where(sql<boolean>`object_key IN (SELECT value FROM json_each(${keyList}))`)
            .execute()
        ).map((r) => r.object_key),
      );
      const queued = new Set(
        (
          await db
            .selectFrom("core_blob_deletion")
            .select("key")
            .where(sql<boolean>`key IN (SELECT value FROM json_each(${keyList}))`)
            .execute()
        ).map((r) => r.key),
      );
      const open = new Set(
        (
          await db
            .selectFrom("core_screen_version")
            .select("id")
            .where("state", "=", "open")
            .where(sql<boolean>`id IN (SELECT value FROM json_each(${versionList}))`)
            .execute()
        ).map((r) => r.id),
      );
      const strays = keys.filter(
        (key) => !named.has(key) && !queued.has(key) && !open.has(versionOf(key)),
      );
      if (strays.length) {
        await blobs.delete(strays);
        deleted += strays.length;
      }
    }
    if (!listed.cursor) break;
    cursor = listed.cursor;
  }
  return deleted;
}
