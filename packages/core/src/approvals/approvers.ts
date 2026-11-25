// Who may approve which pending action (ADRs 0041, 0429, 0480, 0650, 0680, 0691, 0774, 0800,
// 0833, 0872, 0881): the host's approver rules that read nothing but the action and the approver,
// in one table. `approval.approve` (and `approval.decide`) refuse with the first rule a target
// breaks, in this order; Today's "Changes waiting for you" (stage 60, ADR 0874) counts the
// actions no rule refuses. The roster rule (`assertRosterApprover`, ADRs 0625 and 0626) reads the
// shift and the approver's grants, so it is kept apart and run between the two halves, as before.
import { ForbiddenError } from "../errors.ts";
import { ACCOUNTING_VOID_KINDS, READER_KINDS, REFUND_KINDS } from "../integrations/outbound.ts";
import { type Actor, holdsPermission, type Role, roleHasPermission } from "../principals.ts";
import { PUBLISH_OPERATIONS } from "../records/publish.ts";

/** What the rules read of a pending action. */
export interface ApproverTarget {
  readonly id: string;
  readonly operation: string;
  readonly risk: string;
  readonly connection_id: string | null;
  readonly input: string | null;
}

/** What the rules read of whoever approves. */
export interface Approver {
  readonly actor: Actor;
  readonly user: { readonly role: Role };
  readonly grants: readonly string[] | undefined;
  /** The call came from a staff device session (the company's app, ADR 0872). */
  readonly staffDevice: boolean;
}

/** An outbound action's kind (`payments.refund`, `accounting.void`); "" for any other action. */
export function actionKindOf(target: Pick<ApproverTarget, "connection_id" | "input">): string {
  if (target.connection_id === null || !target.input) return "";
  try {
    const input = JSON.parse(target.input) as { actionKind?: { tag?: unknown } | null };
    return typeof input?.actionKind?.tag === "string" ? input.actionKind.tag : "";
  } catch {
    return "";
  }
}

interface Rule {
  matches(target: ApproverTarget, kind: string): boolean;
  /** Why `approver` may not approve `target`, or null when it may. */
  refuse(approver: Approver, target: ApproverTarget): ForbiddenError | null;
}

const byPerson = (what: string, approver: Approver, target: ApproverTarget) =>
  approver.actor !== "human"
    ? new ForbiddenError(`${what}, never by an AI actor`, {
        actionId: target.id,
        actor: approver.actor,
      })
    : null;

/** A rule for an action only a person approves, who holds `permission` (by role or grant). */
const personHolding = (
  matches: Rule["matches"],
  what: string,
  permission: Parameters<typeof holdsPermission>[2],
  needs: string,
): Rule => ({
  matches,
  refuse: (approver, target) =>
    byPerson(what, approver, target) ??
    (holdsPermission(approver.user, approver.grants, permission)
      ? null
      : new ForbiddenError(needs, { actionId: target.id, permission })),
});

/** A rule for an action only a person approves, whose role holds `permission` (no grant gives it). */
const personWhoseRole = (
  matches: Rule["matches"],
  what: string,
  permission: Parameters<typeof roleHasPermission>[1],
  needs: string,
): Rule => ({
  matches,
  refuse: (approver, target) =>
    byPerson(what, approver, target) ??
    (roleHasPermission(approver.user.role, permission)
      ? null
      : new ForbiddenError(needs, { actionId: target.id, permission })),
});

/** The rules run before the roster rule, in the order `approval.approve` has always held them. */
const BEFORE_ROSTER: readonly Rule[] = [
  // Installing or upgrading an extension, or changing schema, needs an admin's approval: the
  // approver must hold the permission those operations need (ADR 0041). And a change to how the
  // system is set up is reviewed on a computer, never approved from the company's app on a phone
  // (stage 60 decision 8, ADR 0872): the host holds the rule, not the owner's screen that says so.
  {
    matches: (t) => t.risk === "extension" || t.risk === "schema",
    refuse: (approver, t) => {
      if (!roleHasPermission(approver.user.role, "extensions:manage")) {
        return new ForbiddenError(`Approving ${t.operation} needs an admin (extensions:manage)`, {
          actionId: t.id,
          permission: "extensions:manage",
        });
      }
      if (approver.staffDevice) {
        return new ForbiddenError(`Review ${t.operation} on a computer: it changes the setup`, {
          actionId: t.id,
          reason: "review_on_computer",
        });
      }
      return null;
    },
  },
  // A refund sends money back (ADR 0429): only a person approves one, and only a person who may
  // refund. No AI actor, under any policy, and not by relaying the person's words.
  personHolding(
    (_, kind) => REFUND_KINDS.has(kind),
    "A refund is approved by a person",
    "orders:refund",
    "Approving a refund needs the refund permission (orders:refund)",
  ),
  // A card reader registered to or removed from the payment account (stage 50, ADR 0774): a device
  // that takes money, so a person who is an admin (integrations:manage, which no grant gives)
  // approves it, never an AI actor.
  personWhoseRole(
    (_, kind) => READER_KINDS.has(kind),
    "A card reader is approved by a person",
    "integrations:manage",
    "Approving a card reader needs an admin (integrations:manage)",
  ),
  // A void of an entry the host posted to the books (stage 61, ADR 0881): it takes back what the
  // bookkeeper may already have reconciled, so a person who is an admin (integrations:manage,
  // which no grant gives) approves it, never an AI actor.
  personWhoseRole(
    (_, kind) => ACCOUNTING_VOID_KINDS.has(kind),
    "A void in the books is approved by a person",
    "integrations:manage",
    "Approving a void in the books needs an admin (integrations:manage)",
  ),
  // An AI actor's publish request (ADR 0480): only a person approves it, and only a person who
  // may publish (their role or a grant, ADR 0449). The requester's own authority (a member's
  // grant, an MCP token's scope) never stands in for the approver's, and no AI actor approves,
  // not even by relaying the person's words.
  personHolding(
    (t) => PUBLISH_OPERATIONS.has(t.operation),
    "A publish is approved by a person",
    "records:publish",
    "Approving a publish needs the publish permission (records:publish)",
  ),
  // An AI's journey publish (stage 53, ADR 0800): the approval of the wording members get without
  // anyone approving each send, so only a person who may publish journeys approves it.
  personHolding(
    (t) => t.operation === "journey.publish",
    "A journey is published by a person",
    "journeys:publish",
    "Approving a journey's publish needs the journeys publish permission (journeys:publish)",
  ),
  // An AI's manual journey entry (ADR 0800): the entry counts as a person's (its messages are
  // not held for the AI's cause) only because a person approved it, so the approver must be one
  // who could have added those people themselves.
  personHolding(
    (t) => t.operation === "journey.enter",
    "People are added to a journey by a person",
    "journeys:manage",
    "Approving people added to a journey needs the journeys permission (journeys:manage)",
  ),
];

/** The rules run after the roster rule. */
const AFTER_ROSTER: readonly Rule[] = [
  // An AI's checklist (stage 45 step 4b, ADR 0650): approved only by a person who may write
  // checklists themselves, so what staff are asked to follow is always a person's.
  personHolding(
    (t) => t.operation === "checklist.save",
    "A checklist is approved by a person",
    "checklists:write",
    "Approving a checklist needs the checklists permission (checklists:write)",
  ),
  // An AI's draft of a kind of note (stage 56, ADR 0833): approved only by a person who may keep
  // the kinds themselves, so what staff are asked to write is always a person's.
  personHolding(
    (t) => t.operation === "note.kinds.save",
    "A kind of note is approved by a person",
    "notes:manage",
    "Approving a kind of note needs the notes permission (notes:manage)",
  ),
  // An AI's opening stock or correction (stage 37, ADR 0680): approved only by a person who may
  // change stock themselves, so stock is never changed by an AI alone.
  personHolding(
    (t) => t.operation === "stock.adjust" || t.operation === "stock.opening",
    "A stock change is approved by a person",
    "stock:adjust",
    "Approving a stock change needs the stock permission (stock:adjust)",
  ),
  // A staff discount over the limit, or asked by an AI, and an AI's taking one off (stage 34,
  // ADR 0691): approved only by a human admin, so an order's price beyond what the owner allowed,
  // or an AI's change to it, is always the owner's decision.
  personWhoseRole(
    (t) => t.operation === "order.adjust" || t.operation === "order.unadjust",
    "A discount is approved by a person",
    "settings:manage",
    "Approving a discount over the limit needs an admin",
  ),
];

function check(rules: readonly Rule[], approver: Approver, targets: readonly ApproverTarget[]) {
  for (const rule of rules) {
    const target = targets.find((t) => rule.matches(t, actionKindOf(t)));
    const refusal = target ? rule.refuse(approver, target) : null;
    if (refusal) throw refusal;
  }
}

/** Refuses, with the first rule broken, an approval the rules before the roster's forbid. */
export function assertApproverBeforeRoster(
  approver: Approver,
  targets: readonly ApproverTarget[],
): void {
  check(BEFORE_ROSTER, approver, targets);
}

/** Refuses, with the first rule broken, an approval the rules after the roster's forbid. */
export function assertApproverAfterRoster(
  approver: Approver,
  targets: readonly ApproverTarget[],
): void {
  check(AFTER_ROSTER, approver, targets);
}

/**
 * Whether no rule of this table refuses `approver` the action `target` (the roster rule, which
 * reads the database, is the caller's to add).
 */
export function approverRulesAllow(approver: Approver, target: ApproverTarget): boolean {
  const kind = actionKindOf(target);
  return [...BEFORE_ROSTER, ...AFTER_ROSTER].every(
    (rule) => !rule.matches(target, kind) || rule.refuse(approver, target) === null,
  );
}

/**
 * An AI's one-to-one draft from a person's own mailbox (ADR 0678), which only that mailbox's
 * owner may send: approved by anyone else it is skipped, never sent. `approval.approve` and
 * Today's count ask the same question.
 */
export function othersPersonalDraft(
  input: { contact?: { personal?: unknown } | null | undefined },
  owner: string | null,
  approver: string,
): boolean {
  return !!input.contact?.personal && owner !== approver;
}
