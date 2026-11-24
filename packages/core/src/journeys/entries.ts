// Journey entries (stage 53 step 3, ADR 0800): who may be added to a journey by hand, the
// statements that add them, stop them and erase them. A handful of statements whatever the
// number of people: each list of ids is one bound JSON value read with json_each, so 500 people
// never pass D1's 100 bound variables per statement or 1,000 statements per invocation.
import type { CoreDatabase } from "@composable-os/db";
import { type CompiledQuery, type Kysely, sql } from "kysely";
import { jsonList } from "../records/common.ts";
import { erasedAddressHash } from "../records/erase-subject.ts";
import { GUARDIAN_LINK } from "../visibility/guardians.ts";
import type { JourneyKind } from "./definition.ts";
import { LIVE_ENTRY_STATES } from "./definition.ts";

/** Why a Person was not added. */
export const ENTRY_EXCLUSIONS = [
  "not_found",
  "minor",
  "erased_address",
  "already_on",
  "once",
  "too_soon",
] as const;
export type EntryExclusion = (typeof ENTRY_EXCLUSIONS)[number];

interface EntryFacts {
  id: string;
  found: number;
  marked: number;
  dependant: number;
  live: number;
  last_entered: string | null;
  primary_email: string | null;
}

const liveStates = sql.join(LIVE_ENTRY_STATES.map((s) => sql`${s}`));

/**
 * Which of `personIds` may be added to the journey now, and why each other one may not: a Person
 * not found, in the trash or merged away; a minor (a live dependant or a Person staff marked) on a
 * promotional journey (decision 10); whose address is on the erased list; already on it; or kept
 * off by its re-entry rule. Two queries. Preferences, suppression and consent are stage 30's, and
 * the journey's conditions are the engine's: both are checked by step 4 before each send.
 */
export async function entryCandidates(
  db: Kysely<CoreDatabase>,
  input: {
    journeyId: string;
    kind: JourneyKind;
    reentry: { rule: "once" } | { rule: "after"; days: number };
    personIds: readonly string[];
    now: string;
  },
): Promise<{ add: string[]; excluded: { personId: string; why: EntryExclusion }[] }> {
  const ids = [...new Set(input.personIds)];
  const { rows } = await sql<EntryFacts>`SELECT ids.value AS id,
      (p.id IS NOT NULL AND p.deleted_at IS NULL AND p.merged_into_id IS NULL) AS found,
      EXISTS (SELECT 1 FROM core_agreement_minor m WHERE m.person_id = ids.value) AS marked,
      EXISTS (SELECT 1 FROM core_person_link l
        JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
        WHERE l.dependant_id = ids.value AND l.kind = ${GUARDIAN_LINK} AND l.ended_at IS NULL)
        AS dependant,
      EXISTS (SELECT 1 FROM core_journey_entry e WHERE e.journey_id = ${input.journeyId}
        AND e.person_id = ids.value AND e.state IN (${liveStates})) AS live,
      (SELECT MAX(e.entered_at) FROM core_journey_entry e WHERE e.journey_id = ${input.journeyId}
        AND e.person_id = ids.value) AS last_entered,
      (SELECT m.email FROM core_person_emails m WHERE m.person_id = ids.value AND m.live = 1
        ORDER BY m.is_primary DESC, m.position LIMIT 1) AS primary_email
    FROM json_each(${JSON.stringify(ids)}) ids
    LEFT JOIN core_person p ON p.id = ids.value`.execute(db);
  // An address someone asked to be erased (ADR 0320) is on the erased list by its hash, which
  // SQLite cannot compute: hashed here, looked up in one statement.
  const hashes = new Map<string, string>();
  for (const row of rows) {
    if (row.primary_email) hashes.set(row.id, await erasedAddressHash(row.primary_email));
  }
  const erased = new Set<string>();
  if (hashes.size) {
    const found = await db
      .selectFrom("core_erased_address")
      .select("hash")
      .where("object_type", "=", "person")
      .where("hash", "in", jsonList([...new Set(hashes.values())]))
      .execute();
    for (const row of found) erased.add(row.hash);
  }
  const add: string[] = [];
  const excluded: { personId: string; why: EntryExclusion }[] = [];
  const since =
    input.reentry.rule === "after"
      ? new Date(Date.parse(input.now) - input.reentry.days * 86_400_000).toISOString()
      : null;
  for (const row of rows) {
    const why: EntryExclusion | null = !row.found
      ? "not_found"
      : input.kind === "promotional" && (row.marked || row.dependant)
        ? "minor"
        : erased.has(hashes.get(row.id) ?? "")
          ? "erased_address"
          : row.live
            ? "already_on"
            : row.last_entered && input.reentry.rule === "once"
              ? "once"
              : row.last_entered && since && row.last_entered > since
                ? "too_soon"
                : null;
    if (why) excluded.push({ personId: row.id, why });
    else add.push(row.id);
  }
  return { add, excluded };
}

/** The two statements that add people at a version's first step, due now, with their log rows. */
export function enterStatements(
  db: Kysely<CoreDatabase>,
  input: {
    journeyId: string;
    versionId: string;
    firstStep: string;
    rows: readonly { entryId: string; logId: string; personId: string }[];
    userId: string;
    standing: "person" | "ai";
    now: string;
  },
): CompiledQuery[] {
  if (!input.rows.length) return [];
  const json = JSON.stringify(input.rows.map((r) => [r.entryId, r.personId, r.logId]));
  return [
    sql`INSERT INTO core_journey_entry (id, journey_id, version_id, person_id, state, step,
        next_at, entered_at, entered_by, entered_by_user, cause_standing)
      SELECT json_extract(value, '$[0]'), ${input.journeyId}, ${input.versionId},
        json_extract(value, '$[1]'), 'active', ${input.firstStep}, ${input.now}, ${input.now},
        'person', ${input.userId}, ${input.standing}
      FROM json_each(${json})`.compile(db),
    sql`INSERT INTO core_journey_step_log (id, entry_id, step, at, what, detail)
      SELECT json_extract(value, '$[2]'), json_extract(value, '$[0]'), ${input.firstStep},
        ${input.now}, 'entered', ${JSON.stringify({ by: "person", standing: input.standing })}
      FROM json_each(${json})`.compile(db),
  ];
}

/**
 * Erase (ADR 0800, the spec's "Privacy, audit and erase"): the Person's entries and their step
 * log. Their message rows, preferences and consent are stage 30's; their signals step 2's.
 */
export function eraseJourneyStatements(
  db: Kysely<CoreDatabase>,
  personIds: readonly string[],
): CompiledQuery[] {
  if (!personIds.length) return [];
  const ids = jsonList(personIds);
  return [
    sql`DELETE FROM core_journey_step_log WHERE entry_id IN (SELECT e.id FROM core_journey_entry e
      WHERE e.person_id IN ${ids})`.compile(db),
    sql`DELETE FROM core_journey_entry WHERE person_id IN ${ids}`.compile(db),
  ];
}
