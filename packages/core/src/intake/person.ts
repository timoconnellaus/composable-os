// The submitter's Person (stage 29 step 2, ADR 0721): whose a submission is, and how sure the host
// is of it. Signed in, it is the customer's own Person (`account`); entered by staff, the address
// they typed, matched (`staff`); otherwise the address a visitor typed, matched by the shared
// matcher (`address`): one match links it, none creates a Person, several link none and admins are
// told. Whatever the certainty, the host fills only a Person's empty fields from the answers: it
// never changes a name or a phone already there, never adds an address, and never touches a
// customer account (decision 7). An anonymous form has no Person at all (ADR 0725).
import type { Answers, IntakeCertainty, Questions } from "@composable-os/sdk";
import { personForAddress } from "../customers/address-person.ts";
import { type HandlerContext, type RecordChange, recordHostChange } from "../operation.ts";

/** The answers of the questions that map to the Person, by field. */
export interface PersonAnswers {
  name?: string;
  email?: string;
  phone?: string;
}

export function personAnswers(questions: Questions, answers: Answers): PersonAnswers {
  const out: PersonAnswers = {};
  for (const item of questions.items) {
    const map = "map" in item ? item.map : undefined;
    if (map?.to !== "person") continue;
    const answer = answers.answers.find((a) => a.key === item.key);
    if (answer && "value" in answer && typeof answer.value === "string" && answer.value.trim()) {
      out[map.field] = answer.value.trim();
    }
  }
  return out;
}

export interface Submitter {
  personId: string | null;
  certainty: IntakeCertainty;
  /** The address typed, normalised (for the per-mailbox count); null when none was. */
  email: string | null;
  /** True when the Person was made in this batch (its row cannot be read back yet). */
  created: boolean;
}

/**
 * Whose a submission is. A signed-in customer's is their own Person, whatever address they typed.
 * A visitor's and staff's come from the answer of the question that maps to the Person's email:
 * without one there is no Person (a survey with no address). Queues, in the call's batch, the
 * Person it creates, the empty fields it fills and the notice for an address several People have.
 */
export async function submitterOf(
  ctx: HandlerContext,
  given: PersonAnswers,
  asker: "public" | "customer" | "staff",
): Promise<Submitter> {
  const caller = ctx.onBehalfOf ?? ctx.principal;
  if (asker === "customer" && caller.kind === "customer") {
    await fillEmptyFields(ctx, caller.personId, given);
    return {
      personId: caller.personId,
      certainty: "account",
      email: given.email ?? null,
      created: false,
    };
  }
  const certainty: IntakeCertainty = asker === "staff" ? "staff" : "address";
  if (!given.email) return { personId: null, certainty, email: null, created: false };
  const found = await personForAddress(ctx, given.email, {
    several: {
      title: "A form was answered with an address several people have",
      body: (count, email) =>
        `${count} people have ${email}. The answers are kept and linked to none of them: merge ` +
        "them, then set the submission's person.",
      dedupeKey: `intake.several_people:${given.email.toLowerCase()}`,
    },
    create: {
      displayName: given.name && given.name.length <= 200 ? given.name : undefined,
      phone: given.phone && given.phone.length <= 50 ? given.phone : undefined,
    },
  });
  if (found.personId && !found.created) await fillEmptyFields(ctx, found.personId, given);
  return { personId: found.personId, certainty, email: found.email, created: found.created };
}

/**
 * A personal link's submitter (ADR 0723): the link's own Person, certainty `link`, whatever
 * address was typed (the bearer never chooses whose answers these are). Only their empty fields
 * fill, as for a signed-in customer.
 */
export async function linkSubmitter(
  ctx: HandlerContext,
  personId: string,
  given: PersonAnswers,
): Promise<Submitter> {
  await fillEmptyFields(ctx, personId, given);
  return { personId, certainty: "link", email: null, created: false };
}

/**
 * Fills the Person's name when it has none of its own (only an address shown as its name) and its
 * phone when it has none, as the host's change. Changes nothing that is there.
 */
async function fillEmptyFields(ctx: HandlerContext, personId: string, given: PersonAnswers) {
  if (!given.name && !given.phone) return;
  const person = await ctx.db
    .selectFrom("core_person")
    .select(["display_name", "given_name", "family_name", "deleted_at"])
    .where("id", "=", personId)
    .executeTakeFirst();
  if (!person || person.deleted_at) return;
  const emails = await ctx.db
    .selectFrom("core_person_emails")
    .select("email")
    .where("person_id", "=", personId)
    .execute();
  const phones = await ctx.db
    .selectFrom("core_person_phones")
    .select("number")
    .where("person_id", "=", personId)
    .execute();
  const unnamed =
    !person.given_name &&
    !person.family_name &&
    (!person.display_name || emails.some((e) => e.email === person.display_name));
  const changes: { displayName?: string; primaryPhone?: string } = {};
  // Within what a Person holds (person.update's limits): a longer answer stays in the answers only.
  if (given.name && unnamed && given.name.length <= 200) changes.displayName = given.name;
  if (given.phone && !phones.length && given.phone.length <= 50) changes.primaryPhone = given.phone;
  if (!Object.keys(changes).length) return;
  const { updatePerson } = await import("../operations/person.ts");
  // The host's change for the caller, judged here: only empty fields, nothing replaced.
  const asHost = Object.create(ctx, {
    recordChange: { value: (change: RecordChange) => recordHostChange(ctx, change) },
  }) as HandlerContext;
  await updatePerson(asHost, personId, changes);
}
