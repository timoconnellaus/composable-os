// Consent to be contacted for every caller's outbound action (stage 30, ADR 0678): what the
// integration host asks as an action is submitted (`contactAtSubmit`), what the approvals inbox
// and an approval ask again (`contactBlockedMany`), and the audit row of a refusal. Which actions
// send to people, and to whom, is integrations/sends.ts's; the rule is contact/senders.ts's.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import {
  checkSends,
  PURPOSE_REQUIRED_MESSAGE,
  RECIPIENT_STOPPED_MESSAGE,
  type SendAnswer,
  type SenderStanding,
  type SendPurpose,
  type SendQuestion,
  type Stoppable,
} from "../contact/senders.ts";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { ActingUser, Actor, Origin } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import type { OutboundDescription, OutboundInput } from "./outbound.ts";
import { type DescribedAction, type PeopleSend, peopleSendOf } from "./sends.ts";

/** How a caller's message to people was checked for consent (ADR 0678), and is asked again. */
export interface OutboundContact {
  sender: SenderStanding;
  /** Who sent it: an AI's one-to-one draft from a person's mailbox is that person's to approve. */
  actor: Actor;
  purpose: SendPurpose | null;
  /**
   * An AI's one-to-one email from a person's own mailbox: it always waits for that person, who
   * makes it their own message by approving it (the person's-own-message rule then applies).
   */
  personal?: true;
  /** A stoppable message's recipients who get a stop link when it goes (never the links). */
  stoppable?: Stoppable;
}

/** The audit row of a refused send (ADR 0678): for people only, as the adjudicator's verdicts. */
export const CONTACT_REFUSED_OPERATION = "contact.refused";

/** What an AI may draft from a person's mailbox for that person to approve. */
const DRAFTING_ACTORS: ReadonlySet<Actor> = new Set(["assistant", "mcp"]);

export const MAILBOX_REFUSED_MESSAGE =
  "Refused: purpose_required. An email to a person the CRM knows, sent from a mailbox connection by " +
  "an automation or extension code, or to several people by an AI, cannot carry the stop link it " +
  "needs. Save a draft for the person to send (Gmail `draftCreate`, Outlook drafts), write one " +
  "email to one person for them to approve, or send it through email-send with a purpose. Nothing " +
  "was sent or queued.";
export const INVITATION_REFUSED_MESSAGE =
  "Refused: purpose_required. A calendar invitation from an AI, an automation or extension code " +
  "cannot carry a stop link, so it does not go to a person the CRM knows, nor to attendees the " +
  'host cannot see (an update with `sendUpdates` other than "none"). Leave the people out and let ' +
  "a person invite them, or send updates to no one. Nothing was sent or queued.";
export const SCAN_REFUSED_MESSAGE =
  "Refused: purpose_required. This tool call names a person the CRM knows (an email address or a " +
  "phone number), and a message through a connected server cannot carry the stop link it needs. " +
  "Use email-send with a purpose, or let a person send it. Nothing was sent or queued.";

function refusalFor(shape: PeopleSend["shape"]): string {
  if (shape === "mailbox") return MAILBOX_REFUSED_MESSAGE;
  if (shape === "invitation") return INVITATION_REFUSED_MESSAGE;
  if (shape === "scan") return SCAN_REFUSED_MESSAGE;
  return PURPOSE_REQUIRED_MESSAGE;
}

/** The questions a send asks: its addresses, and a scan's numbers. */
function questionsOf(
  send: PeopleSend,
  sender: SenderStanding,
  purpose: SendPurpose | null,
  at: string,
): SendQuestion[] {
  const oneToOne = send.shape !== "scan" && send.to.length === 1 && !send.copied;
  const out: SendQuestion[] = [];
  if (send.emails.length) {
    out.push({ channel: "email", recipients: send.emails, sender, purpose, oneToOne, at });
  }
  if (send.numbers.length) {
    out.push({ channel: "text", recipients: send.numbers, sender, purpose, oneToOne: false, at });
  }
  return out;
}

/**
 * The consent check of a caller's outbound action as it is submitted (ADR 0678), at the one place
 * every gatekeeper's send passes. Null when it sends to no one the register knows. An outbox send
 * whose recipients the queue's own `contactCheck` vouched for just now keeps that check's purpose;
 * any other is checked here with no purpose. Refused (thrown, so the gatekeeper queues nothing)
 * when a recipient may not be contacted, when a machine's send names a Person it cannot carry a
 * stop link to, and when a machine's send would tell people the host cannot see.
 */
export async function contactAtSubmit(
  db: CrmDb,
  input: {
    vendor: string;
    description: OutboundDescription;
    sender: SenderStanding;
    actor: Actor;
    /** The addresses `contactCheck` allowed in this session: purpose, and the Person holding it. */
    vouched: ReadonlyMap<string, { purpose: SendPurpose | null; person: string | null }>;
    at: string;
  },
): Promise<OutboundContact | null> {
  const send = peopleSendOf(input.vendor, input.description);
  if (!send) return null;
  const base = { sender: input.sender, actor: input.actor };
  if (send.shape === "outbox" && send.emails.length) {
    const seen = send.emails.map((e) => input.vouched.get(e));
    const purposes = new Set(seen.map((v) => v?.purpose));
    const [purpose] = purposes;
    if (seen.every((v) => v !== undefined) && purposes.size === 1 && purpose !== undefined) {
      const recipients = send.emails.flatMap((to, i) => {
        const person = seen[i]?.person;
        return person ? [{ to, person }] : [];
      });
      return {
        ...base,
        purpose,
        ...(purpose && recipients.length ? { stoppable: { purpose, recipients } } : {}),
      };
    }
  }
  if (!send.complete) {
    if (input.sender === "other") throw new ValidationError(refusalFor(send.shape));
    return { ...base, purpose: null };
  }
  const answers = await checkSends(db.query, questionsOf(send, input.sender, null, input.at));
  // An AI's one email to one person, from a person's own mailbox: theirs once they approve it.
  if (
    input.sender === "other" &&
    send.shape === "mailbox" &&
    DRAFTING_ACTORS.has(input.actor) &&
    (await personalDraft(db.query, send, input.at))
  ) {
    return { ...base, purpose: null, personal: true };
  }
  if (answers.some((a) => a.purposeRequired)) throw new ValidationError(refusalFor(send.shape));
  if (answers.some((a) => a.dropped > 0)) throw new ValidationError(RECIPIENT_STOPPED_MESSAGE);
  return { ...base, purpose: null };
}

/**
 * Whether a mailbox send is an AI's one-to-one draft a person may make theirs: one `To`, no `Cc`
 * or `Bcc`, an address exactly one Person holds and no child holds, not on the suppression list.
 */
async function personalDraft(
  db: Kysely<CoreDatabase>,
  send: PeopleSend,
  at: string,
): Promise<boolean> {
  if (send.to.length !== 1 || send.copied || send.emails.length !== 1) return false;
  const [answer] = await checkSends(db, [
    // As a message to several (`oneToOne: false`): a child's address is not allowed.
    { channel: "email", recipients: send.emails, sender: "staff", oneToOne: false, at },
  ]);
  return answer?.dropped === 0 && answer.allowed[0]?.person != null;
}

/** A pending outbound action, as the inbox and an approval read it. */
export interface PendingOutbound {
  id: string;
  input: Partial<OutboundInput>;
  actor: Actor;
  origin: Partial<Origin>;
}

/**
 * How many recipients of each waiting outbound action may not be contacted now (ADR 0678): asked
 * when the approvals inbox shows them and again when a person approves one, so a stop taken while
 * it waited holds. Every action's recipients are read together (a few statements for the page).
 * An action queued before the host kept its check is checked by who sent it; the host's own mail
 * (origin `system`, a held routine message, which its own path asks) is 0.
 */
export async function contactBlockedMany(
  db: Kysely<CoreDatabase>,
  actions: readonly PendingOutbound[],
  at: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const plans: { id: string; send: PeopleSend; questions: SendQuestion[]; fixed?: number }[] = [];
  const legacy: string[] = [];
  for (const a of actions) {
    const send = peopleSendOf(a.input.vendor ?? "", a.input as DescribedAction);
    if (!send) continue;
    if (!a.input.contact) {
      if (a.origin.surface === "system") continue;
      legacy.push(a.id);
    }
    plans.push({ id: a.id, send, questions: [] });
  }
  const routine = legacy.length ? await heldRoutine(db, legacy) : new Set<string>();
  const questions: SendQuestion[] = [];
  const index: { plan: number; from: number; to: number }[] = [];
  for (const [i, plan] of plans.entries()) {
    const action = actions.find((a) => a.id === plan.id) as PendingOutbound;
    if (routine.has(plan.id)) continue;
    const contact = action.input.contact;
    // An AI's draft a person approves is theirs (the person's-own-message rule).
    const sender: SenderStanding = contact?.personal
      ? "staff"
      : (contact?.sender ?? (action.actor === "human" ? "staff" : "other"));
    if (!plan.send.complete && sender === "other") {
      plan.fixed = Math.max(1, plan.send.emails.length);
      continue;
    }
    const qs = contact?.personal
      ? questionsOf({ ...plan.send, copied: true }, "staff", null, at)
      : questionsOf(plan.send, sender, contact?.purpose ?? null, at);
    index.push({ plan: i, from: questions.length, to: questions.length + qs.length });
    questions.push(...qs);
  }
  const answers: SendAnswer[] = questions.length ? await checkSends(db, questions) : [];
  for (const plan of plans) if (plan.fixed) out.set(plan.id, plan.fixed);
  for (const { plan, from, to } of index) {
    const blocked = answers
      .slice(from, to)
      .reduce((n, a) => n + (a.purposeRequired ? a.allowed.length + a.dropped : a.dropped), 0);
    if (blocked > 0) out.set((plans[plan] as { id: string }).id, blocked);
  }
  return out;
}

/** Which of these pending actions are held routine messages (their own path asks consent). */
async function heldRoutine(db: Kysely<CoreDatabase>, ids: readonly string[]): Promise<Set<string>> {
  const rows = await db
    .selectFrom("core_routine_mail")
    .select("pending_action_id")
    .where("pending_action_id", "in", jsonList([...ids]))
    .execute();
  return new Set(rows.flatMap((r) => (r.pending_action_id ? [r.pending_action_id] : [])));
}

/**
 * The audit row of a send refused for consent (ADR 0678), for the caller's batch: who sent it
 * (actor, user, origin), through what, on which channel, and how many recipients cannot be
 * contacted, never who or why. `audit.list` shows it to people only.
 */
export function contactRefusedAudit(
  db: Kysely<CoreDatabase>,
  input: {
    actor: Actor;
    user: ActingUser;
    origin: Origin;
    vendor: string;
    connectionId: string;
    channel: "email" | "text";
    actionKind: string | null;
    refused: number;
    sent: boolean;
    at: string;
  },
): Compilable {
  return db.insertInto("core_audit").values({
    id: newId("audit"),
    at: input.at,
    operation: CONTACT_REFUSED_OPERATION,
    risk: "outbound",
    actor: input.actor,
    user_id: input.user.id,
    origin: JSON.stringify(input.origin),
    input: JSON.stringify({
      vendor: input.vendor,
      connectionId: input.connectionId,
      channel: input.channel,
      actionKind: input.actionKind,
      cannotBeContacted: input.refused,
      // Whether the rest of the send went (some dropped) or nothing did.
      restSent: input.sent,
    }),
    result: null,
    gate_decision: "deny",
    outcome: "denied",
    error: JSON.stringify({
      code: "recipient_stopped",
      message: "A recipient cannot be contacted this way",
    }),
    pending_action_id: null,
  });
}
