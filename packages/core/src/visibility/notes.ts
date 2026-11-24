// The note scope (stage 56, ADR 0830): which notes kept from the whole staff a caller may read.
//
// A note has a level. `staff` notes are every staff account's, as every activity was before. The
// two others are out of every bulk path (migration 1230: not in core_base_activities, rec_activity,
// rec_activity_link or search) and are read only here, through `visibleTable(ctx, "activity")`:
//
//   `coaches`    its author while their account is active; the staff who look after the one
//                Person it is about (core_person_carer, ADR 0831); admins; `notes:clients`
//   `sensitive`  its author while their account is active; admins; `notes:sensitive`
//
// Only a person reads them (ADR 0832): an AI actor (the assistant, an MCP client, an automation,
// extension code) and work with no caller (`orgReader`) read `staff` notes only, with any grant.
// Grants and looks-after rows are read on every call, so removing one takes effect on the next
// read. Stage 43's authored rows and stage 14a's staff scopes extend this module, not a second one.
import type { NoteLevel } from "@composable-os/db";
import { type RawBuilder, sql } from "kysely";
import { type Actor, holdsPermission, type Permission } from "../principals.ts";
import type { Viewer } from "./index.ts";

export const NOTE_LEVELS = [
  "staff",
  "coaches",
  "sensitive",
] as const satisfies readonly NoteLevel[];
export type { NoteLevel };

/** A viewer the note scope can judge: who is calling, as which actor, with which grants. */
export interface NoteViewer extends Viewer {
  /** The staff-side actor. Absent (work with no caller, a customer's call): not a person. */
  readonly actor?: Actor;
  /** Permissions a human admin granted the account one by one (ADR 0449), read on this call. */
  readonly permissionGrants?: readonly string[] | undefined;
}

/**
 * What the caller may read above `staff`, or null when it reads `staff` notes only: anyone who is
 * not a person on the staff. `userId` is whose authored and looked-after notes count.
 */
export interface NoteRights {
  readonly userId: string;
  /** Every `coaches` note: admins and `notes:clients`. */
  readonly clients: boolean;
  /** Every `sensitive` note: admins and `notes:sensitive`. */
  readonly sensitive: boolean;
  /** Changes and deletes others' notes it can read, lowers levels: admins and `notes:manage`. */
  readonly manage: boolean;
}

/**
 * The caller's note rights. Pure: it reads nothing. `actor` is read only for a staff principal (a
 * customer's handler context throws on it).
 */
export function noteRights(viewer: NoteViewer): NoteRights | null {
  const { principal } = viewer;
  if (principal.kind !== "staff") return null;
  if (viewer.actor !== "human") return null;
  const holds = (permission: Permission) =>
    holdsPermission({ role: principal.role }, viewer.permissionGrants, permission);
  return {
    userId: principal.userId,
    clients: holds("notes:clients"),
    sensitive: holds("notes:sensitive"),
    manage: holds("notes:manage"),
  };
}

/** May the caller read notes of `level` it did not write and does not look after? */
export function readsEveryNote(rights: NoteRights | null, level: NoteLevel): boolean {
  if (level === "staff") return true;
  if (!rights) return false;
  return level === "coaches" ? rights.clients : rights.sensitive;
}

/**
 * The note scope as a predicate over a `core_activity` row aliased `alias`, or null when the
 * caller reads every row (a person holding both reading permissions: an admin, the same SQL as
 * before). Ids are bound; the alias is a trusted identifier.
 */
export function noteScopeWhere(viewer: NoteViewer, alias: string): RawBuilder<unknown> | null {
  const rights = noteRights(viewer);
  const level = sql.ref(`${alias}.level`);
  if (!rights) return sql`${level} = 'staff'`;
  if (rights.clients && rights.sensitive) return null;
  const me = rights.userId;
  // Their own note, while their account is active: a deactivated author reads nothing.
  const authored = sql`(${sql.ref(`${alias}.author_user_id`)} = ${me} AND EXISTS (SELECT 1 FROM core_user nu WHERE nu.id = ${me} AND nu.deactivated_at IS NULL))`;
  // A live Person they look after now: the note is about exactly one Person (activity.log).
  const caredFor = sql`EXISTS (SELECT 1 FROM core_activity_links nl JOIN core_person_carer nc ON nc.person_id = nl.record_id AND nc.user_id = ${me} AND nc.ended_at IS NULL JOIN core_person np ON np.id = nc.person_id AND np.deleted_at IS NULL WHERE nl.activity_id = ${sql.ref(`${alias}.id`)} AND nl.object_type = 'person')`;
  const coaches = rights.clients ? sql`1 = 1` : sql`(${authored} OR ${caredFor})`;
  const sensitive = rights.sensitive ? sql`1 = 1` : authored;
  return sql`(${level} = 'staff' OR (${level} = 'coaches' AND ${coaches}) OR (${level} = 'sensitive' AND ${sensitive}))`;
}

/**
 * The ids of the notes kept from the whole staff (level `coaches` or `sensitive`, live or in the
 * Trash) that `viewer` may not read, as a subquery: for paths that say nothing of them to anyone
 * but a person who may read them (counts of linked activities, an AI actor's audit list, a
 * record's history). Everything kept, for an AI actor; nothing, for a person who reads every
 * level. It reads only kept notes (the partial index `core_activity_kept_idx`, migration 1230).
 */
export function hiddenNoteIds(viewer: NoteViewer): RawBuilder<unknown> {
  const scope = noteScopeWhere(viewer, "hn");
  if (!scope) return sql`(SELECT NULL WHERE 0)`;
  return sql`(SELECT hn.id FROM core_activity hn WHERE hn.level != 'staff' AND NOT ${scope})`;
}

/**
 * A statement for a note's change planned from a read of its level (migration 1230): the batch
 * fails whole (`core_note_changed`) when the note's level is no longer `level` at commit.
 */
export function noteLevelGuard(id: string, level: NoteLevel): RawBuilder<unknown> {
  return sql`INSERT INTO core_note_guard (expected, actual) SELECT 1, count(*) FROM core_activity WHERE id = ${id} AND level = ${level}`;
}
