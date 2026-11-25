// The consent register (stage 30 step 5, ADR 0675): a Person's contact choices, per channel and
// scope, with when, how and by whom. One row per choice, never changed: the latest for (Person,
// channel, scope) is in force, the earlier ones its history (migration 0913).
//
// A scope is one of two things:
// - a purpose: `follow_up` (on or off) or `news_and_offers` (yes or no, a yes carrying the words
//   the person was shown);
// - a routine message kind (`bookings.reminder`): on or off. `account` is not a scope of its own:
//   a person turns off an optional kind, never "everything about what I booked".
//
// Nobody writes the register but the operations and host code in this folder (contact.stop,
// me.contact.setChoices, person.contact.record, recordFromForm, a merge), and nobody reads it but
// `contactDecision` and the screens' reads (me.contact.choices, contact.forPerson).
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, type Selectable, sql } from "kysely";
import { newId } from "../ids.ts";

type Db = Kysely<CoreDatabase>;

/** The channels a Person may be reached on. */
export const CONTACT_CHANNELS = ["email", "text", "push"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * What a message is for, as far as consent goes (a fixed core vocabulary): about something the
 * person has or did; an automatic message that is neither that nor an offer; or promotional.
 */
export const CONTACT_PURPOSES = ["account", "follow_up", "news_and_offers"] as const;
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];

/** The purposes that are scopes of their own on the register. */
export const PURPOSE_SCOPES = ["follow_up", "news_and_offers"] as const;
export type PurposeScope = (typeof PURPOSE_SCOPES)[number];

/** Where a choice came from. */
export const CHOICE_HOWS = [
  "member",
  "staff_on_request",
  "staff_from_paper",
  "form",
  "checkout",
  "stop_link",
  "stop_reply",
  "start_reply",
  "import",
  "merge",
] as const;
export type ChoiceHow = (typeof CHOICE_HOWS)[number];

/** The ways of saying "no more of these" that only the person themselves may lift. */
export const STOP_HOWS: ReadonlySet<ChoiceHow> = new Set(["stop_link", "stop_reply"]);

export type ChoiceValue = "on" | "off" | "yes" | "no";

/** A routine kind's id as a scope: `<extension>.<kind>`. */
const KIND_SCOPE = /^[a-z][a-z0-9_-]{0,39}\.[a-z][a-zA-Z0-9]{0,39}$/;

export function isPurposeScope(scope: string): scope is PurposeScope {
  return (PURPOSE_SCOPES as readonly string[]).includes(scope);
}

export function isKindScope(scope: string): boolean {
  return KIND_SCOPE.test(scope);
}

/** What is wrong with a value for a scope, or null: yes or no for news and offers, else on or off. */
export function valueProblem(scope: string, value: ChoiceValue): string | null {
  if (!isPurposeScope(scope) && !isKindScope(scope)) return `${scope} is not a kind of message`;
  const yesNo = scope === "news_and_offers";
  if (yesNo && value !== "yes" && value !== "no") return "news and offers take yes or no";
  if (!yesNo && value !== "on" && value !== "off") return `${scope} takes on or off`;
  return null;
}

/** Whether a value lets messages of its scope go. */
export function allows(value: ChoiceValue): boolean {
  return value === "on" || value === "yes";
}

/** One choice in force (or of the history). */
export interface ContactChoice {
  id: string;
  personId: string;
  channel: ContactChannel;
  scope: string;
  value: ChoiceValue;
  at: string;
  how: ChoiceHow;
  byId: string | null;
  reason: string | null;
  wording: string | null;
}

type Row = Selectable<CoreDatabase["core_contact_choice"]>;

function choiceOf(row: Row): ContactChoice {
  return {
    id: row.id,
    personId: row.person_id,
    channel: row.channel,
    scope: row.scope,
    value: row.value,
    at: row.at,
    how: row.how,
    byId: row.by_id,
    reason: row.reason,
    wording: row.wording,
  };
}

/** The choices in force for a batch of People, by Person, then by `<channel>:<scope>`. */
export type ChoicesInForce = ReadonlyMap<string, ReadonlyMap<string, ContactChoice>>;

export const choiceKey = (channel: ContactChannel, scope: string) => `${channel}:${scope}`;

/** Binds per statement: D1 allows 100; one per Person. */
const PEOPLE_PER_STATEMENT = 90;

/**
 * The choices in force for `personIds`: one statement per 90 People, whatever their history
 * (the latest row per Person, channel and scope, picked in SQL). What a sender reads once for a
 * batch of recipients and passes to `contactDecision`.
 */
export async function choicesInForce(
  db: Db,
  personIds: readonly string[],
): Promise<ChoicesInForce> {
  const out = new Map<string, Map<string, ContactChoice>>();
  const ids = [...new Set(personIds)];
  for (let i = 0; i < ids.length; i += PEOPLE_PER_STATEMENT) {
    const chunk = ids.slice(i, i + PEOPLE_PER_STATEMENT);
    const { rows } = await sql<Row>`SELECT seq, id, person_id, channel, scope, value, at, how,
        by_id, reason, wording
      FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY person_id, channel, scope
          ORDER BY at DESC, seq DESC) AS n
        FROM core_contact_choice WHERE person_id IN (${sql.join(chunk)}))
      WHERE n = 1`.execute(db);
    for (const row of rows) {
      const mine = out.get(row.person_id) ?? new Map<string, ContactChoice>();
      mine.set(choiceKey(row.channel, row.scope), choiceOf(row));
      out.set(row.person_id, mine);
    }
  }
  return out;
}

/** A Person's whole register, newest first (at most `limit` rows): contact.forPerson's history. */
export async function choiceHistory(
  db: Db,
  personId: string,
  limit = 200,
): Promise<ContactChoice[]> {
  const rows = await db
    .selectFrom("core_contact_choice")
    .selectAll()
    .where("person_id", "=", personId)
    .orderBy("at", "desc")
    .orderBy("seq", "desc")
    .limit(limit)
    .execute();
  return rows.map(choiceOf);
}

export interface NewChoice {
  personId: string;
  channel: ContactChannel;
  scope: string;
  value: ChoiceValue;
  how: ChoiceHow;
  at: string;
  byId?: string | null;
  reason?: string | null;
  wording?: string | null;
}

/**
 * The statement that appends one choice: written only while the Person exists, so a stop for
 * someone erased (or never there) writes nothing and fails nothing. Queue it in the caller's
 * batch (`ctx.write`) or execute it.
 */
export function appendChoice(db: Db, choice: NewChoice) {
  const id = newId("contactChoice");
  return db
    .insertInto("core_contact_choice")
    .columns([
      "id",
      "person_id",
      "channel",
      "scope",
      "value",
      "at",
      "how",
      "by_id",
      "reason",
      "wording",
    ])
    .expression(
      sql`SELECT ${id}, ${choice.personId}, ${choice.channel}, ${choice.scope}, ${choice.value},
          ${choice.at}, ${choice.how}, ${choice.byId ?? null}, ${choice.reason ?? null},
          ${choice.wording ?? null}
        WHERE EXISTS (SELECT 1 FROM core_person WHERE id = ${choice.personId})`,
    );
}

/**
 * A merge (person.merge): the duplicate's choices move to the survivor, as history; the later
 * choice wins, except that a stop or a no on either side stays in force (a "no" is never lost to
 * a merge). Where the latest moved row would undo one, a `merge` row puts it back on top.
 * Returns the statements, for the merge's batch.
 */
export async function mergeChoiceStatements(
  db: Db,
  survivorId: string,
  mergedId: string,
  now: string,
) {
  const inForce = await choicesInForce(db, [survivorId, mergedId]);
  const survivor = inForce.get(survivorId) ?? new Map<string, ContactChoice>();
  const merged = inForce.get(mergedId) ?? new Map<string, ContactChoice>();
  const statements: ReturnType<typeof appendChoice | typeof moveRows>[] = [moveRows()];
  for (const key of new Set([...survivor.keys(), ...merged.keys()])) {
    const a = survivor.get(key);
    const b = merged.get(key);
    if (!a || !b) continue;
    const later = a.at > b.at || (a.at === b.at && a.id > b.id) ? a : b;
    const refusal = [a, b].find((c) => !allows(c.value));
    if (!refusal || !allows(later.value)) continue;
    statements.push(
      appendChoice(db, {
        personId: survivorId,
        channel: refusal.channel,
        scope: refusal.scope,
        value: refusal.value,
        how: "merge",
        at: now,
        byId: null,
        reason: null,
        wording: null,
      }),
    );
  }
  return statements;

  function moveRows() {
    return db
      .updateTable("core_contact_choice")
      .set({ person_id: survivorId })
      .where("person_id", "=", mergedId);
  }
}
