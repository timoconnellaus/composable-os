// Consent to be contacted (stage 30 step 5, ADR 0675): the operations that read and write the
// consent register. Every write appends a choice (the register is never rewritten) and none sends
// anything: the senders ask `contactDecision` at the moment of sending.
//
// - contact.stop (public and customer): the one-tap stop a stoppable email carries. Takes a token
//   the host signed for one Person, one channel and one scope, turns only that off, and answers
//   the same whether the token was good or not. Opening it to `public` was a reviewed change
//   (ADR 0402, open-operations.json): it can only ever turn something off.
// - me.contact.choices / me.contact.setChoices (customer): the member's Contact preferences, for
//   themselves and their live dependants. An essential kind's email cannot be turned off; news and
//   offers need a yes with the words shown, and never go to or about a child. The member may lift
//   their own stop.
// - person.contact.record (staff, a person only): a member asked by phone or on paper. Records
//   why; never lifts a stop (only the member does, in their account or by START).
// - contact.forPerson (staff): the register's current choices and history for a Person the
//   caller reads.
//
// No AI actor writes the register: the customer operations are not staff calls at all, and
// person.contact.record is `actors: ["human"]`.
import { channelsOf, essentialOf } from "@composable-os/sdk";
import { z } from "zod";
import {
  allows,
  appendChoice,
  CHOICE_HOWS,
  type ChoicesInForce,
  type ChoiceValue,
  CONTACT_CHANNELS,
  type ContactChannel,
  choiceHistory,
  choiceKey,
  choicesInForce,
  isPurposeScope,
  readStopToken,
  STOP_HOWS,
  valueProblem,
} from "../contact/index.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { CustomerPrincipal } from "../principals.ts";
import { type RoutineKind, routineKinds } from "../routine-mail/index.ts";
import {
  familyOf,
  hasLiveGuardian,
  isLiveDependant,
  livePersonAfterMerges,
} from "../visibility/guardians.ts";
import { visibleSource } from "../visibility/index.ts";

const channel = z.enum(CONTACT_CHANNELS);
const scope = z
  .string()
  .min(1)
  .max(80)
  .describe(
    "A kind of message: a routine message kind (bookings.reminder), follow_up, or news_and_offers",
  );
const value = z
  .enum(["on", "off", "yes", "no"])
  .describe("on or off; for news_and_offers, yes or no");

const choiceIn = z.object({ scope, channel, value }).strict();

const lineChannel = z.object({
  channel,
  value: z.enum(["on", "off", "yes", "no"]).describe("What is in force (a default when unset)"),
  fixed: z.boolean().describe("Cannot be changed here: an essential kind's email always goes"),
  stopped: z.boolean().describe("Stopped by a stop link or a STOP reply"),
  since: z.string().nullable().describe("When the choice in force was made; null: the default"),
});
const line = z.object({
  scope: z.string(),
  label: z.string(),
  description: z.string(),
  purpose: z.enum(["account", "follow_up", "news_and_offers"]),
  essential: z.boolean().describe("Its email always goes"),
  channels: z.array(lineChannel),
});
type Line = z.infer<typeof line>;

const personChoices = z.object({
  personId: z.string(),
  name: z.string(),
  self: z.boolean().describe("The caller's own Person (false: a child they act for)"),
  child: z.boolean().describe("A child: news and offers never go to them"),
  lines: z.array(line),
});

const PURPOSE_LINES = [
  {
    scope: "follow_up",
    label: "Follow-ups",
    description:
      "Automatic messages that are not about something you booked or bought: a welcome, a check-in when we have not seen you, a request for a review.",
    purpose: "follow_up" as const,
  },
  {
    scope: "news_and_offers",
    label: "News and offers",
    description: "News, offers and promotions. Only with your yes.",
    purpose: "news_and_offers" as const,
  },
];

/** The kinds a person may see and choose for: the routine kinds that are on now. */
function choosableKinds(kinds: readonly RoutineKind[]): RoutineKind[] {
  return kinds.filter((k) => k.on && k.packOn);
}

/** The channels a kind may reach someone on now: email, and what an admin switched on. */
function kindChannels(kind: RoutineKind): ContactChannel[] {
  return [
    "email",
    ...(kind.channels.push ? (["push"] as const) : []),
    ...(kind.channels.text ? (["text"] as const) : []),
  ];
}

/** What a Person can choose, with what is in force for each channel. */
function linesOf(
  personId: string,
  child: boolean,
  kinds: readonly RoutineKind[],
  inForce: ChoicesInForce,
): Line[] {
  const mine = inForce.get(personId);
  const state = (
    ch: ContactChannel,
    s: string,
    fallback: ChoiceValue,
    fixed: boolean,
  ): z.infer<typeof lineChannel> => {
    const c = fixed ? undefined : mine?.get(choiceKey(ch, s));
    return {
      channel: ch,
      value: c?.value ?? fallback,
      fixed,
      stopped: c ? !allows(c.value) && STOP_HOWS.has(c.how) : false,
      since: c?.at ?? null,
    };
  };
  const out: Line[] = [];
  for (const kind of choosableKinds(kinds)) {
    const purpose = kind.spec.purpose ?? "account";
    const essential = essentialOf(kind.spec);
    out.push({
      scope: kind.id,
      label: kind.spec.label,
      description: kind.spec.description,
      purpose,
      essential,
      channels: kindChannels(kind).map((ch) =>
        state(ch, kind.id, "on", essential && ch === "email"),
      ),
    });
  }
  for (const p of PURPOSE_LINES) {
    if (p.scope === "news_and_offers" && child) continue;
    out.push({
      ...p,
      essential: false,
      channels: CONTACT_CHANNELS.map((ch) =>
        state(ch, p.scope, p.scope === "news_and_offers" ? "no" : "on", false),
      ),
    });
  }
  return out;
}

interface Written {
  personId: string;
  choices: { scope: string; channel: ContactChannel; value: ChoiceValue }[];
  how: (typeof CHOICE_HOWS)[number];
  byId: string;
  reason?: string | null;
  wording?: string | null;
  /** Staff: never lift a stop. */
  mayLiftStop: boolean;
}

/**
 * Checks and queues the choices: a kind that exists and goes on the channel, the value its scope
 * takes, an essential kind's email never off, a yes with its words and never for a child, a stop
 * lifted only by the member. A choice equal to the one in force writes nothing.
 */
async function writeChoices(ctx: HandlerContext, w: Written): Promise<number> {
  const kinds = new Map((await routineKinds(ctx.db)).map((k) => [k.id, k]));
  const inForce = (await choicesInForce(ctx.db, [w.personId])).get(w.personId);
  const child = await hasLiveGuardian(ctx.db, w.personId);
  let written = 0;
  const seen = new Set<string>();
  for (const c of w.choices) {
    const key = choiceKey(c.channel, c.scope);
    if (seen.has(key)) throw new ValidationError(`${c.scope} by ${c.channel} is given twice`);
    seen.add(key);
    const problem = valueProblem(c.scope, c.value);
    if (problem) throw new ValidationError(problem, { scope: c.scope });
    if (!isPurposeScope(c.scope)) {
      const kind = kinds.get(c.scope);
      if (!kind) throw new ValidationError(`No kind of message ${c.scope}`, { scope: c.scope });
      if (!channelsOf(kind.spec).includes(c.channel)) {
        throw new ValidationError(`${kind.spec.label} does not go by ${c.channel}`, {
          scope: c.scope,
          channel: c.channel,
        });
      }
      if (c.channel === "email" && c.value === "off" && essentialOf(kind.spec)) {
        throw new ValidationError(
          `${kind.spec.label} is always emailed: it is about something booked or paid for`,
          { scope: c.scope },
        );
      }
    }
    if (c.value === "yes") {
      if (child) {
        throw new ValidationError("News and offers never go to a child", { scope: c.scope });
      }
      if (!w.wording?.trim()) {
        throw new ValidationError("A yes to news and offers keeps the words the person was shown", {
          field: "wording",
        });
      }
    }
    const current = inForce?.get(key);
    if (current?.value === c.value) continue;
    if (
      !w.mayLiftStop &&
      allows(c.value) &&
      current &&
      !allows(current.value) &&
      STOP_HOWS.has(current.how)
    ) {
      throw new ForbiddenError(
        "They stopped these themselves: only they can turn them back on, in their account or by replying START",
        { scope: c.scope, channel: c.channel },
      );
    }
    ctx.write(
      appendChoice(ctx.db, {
        personId: w.personId,
        channel: c.channel,
        scope: c.scope,
        value: c.value,
        how: w.how,
        at: ctx.now,
        byId: w.byId,
        reason: w.reason ?? null,
        wording: c.value === "yes" ? (w.wording?.trim() ?? null) : null,
      }),
    );
    written += 1;
  }
  return written;
}

function customerOf(ctx: HandlerContext): CustomerPrincipal {
  if (ctx.principal.kind !== "customer") {
    throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
  }
  return ctx.principal;
}

/** The member themselves, or a live dependant of theirs; else not found. */
async function ownOrDependant(ctx: HandlerContext, personId: string | undefined): Promise<string> {
  const me = customerOf(ctx).personId;
  if (personId === undefined || personId === me) return me;
  if (!(await isLiveDependant(ctx.db, me, personId))) throw new NotFoundError("person", personId);
  return personId;
}

// ---------------------------------------------------------------------------------------------

export const contactStop = defineOperation({
  name: "contact.stop",
  description:
    "The one-tap stop in an email: turns off the one kind of message, on the one channel, that " +
    "the link's token names, for the one Person it names. It can only turn something off. The " +
    "answer is the same whether the token was good or not.",
  input: z
    .object({
      token: z.string().max(400).describe("The token from the stop link (its t parameter)"),
    })
    .strict(),
  output: z.object({ done: z.literal(true) }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer", "public"],
  // Not counted per call (ADR 0940): a mail provider's few servers send everyone's one-click
  // stops. Only tokens that are not valid count against the client address, at the flood level.
  publicLimit: { tier: "write", addressCounts: "invalid" },
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const named = await readStopToken(ctx.db, input.token);
    if (!named) {
      // A token that is not valid counts against the address (ADR 0940); over the flood level, the
      // same refusal any limited call gets. Otherwise the answer is a good token's.
      await ctx.refused?.();
      return { done: true as const };
    }
    // An essential kind's email always goes: no link stops it (the host makes none for it).
    if (!isPurposeScope(named.scope)) {
      const kind = (await routineKinds(ctx.db)).find((k) => k.id === named.scope);
      if (!kind || (named.channel === "email" && essentialOf(kind.spec))) {
        return { done: true as const };
      }
    }
    // The Person the link named, or the one they were merged into since; nobody for one erased,
    // or in the Trash and not merged: then nothing is written.
    const person = await livePersonAfterMerges(ctx.db, named.person);
    if (!person) return { done: true as const };
    const value: ChoiceValue = named.scope === "news_and_offers" ? "no" : "off";
    const current = (await choicesInForce(ctx.db, [person]))
      .get(person)
      ?.get(choiceKey(named.channel, named.scope));
    if (current && !allows(current.value) && STOP_HOWS.has(current.how)) {
      return { done: true as const };
    }
    ctx.write(
      appendChoice(ctx.db, {
        personId: person,
        channel: named.channel,
        scope: named.scope,
        value,
        how: "stop_link",
        at: ctx.now,
      }),
    );
    return { done: true as const };
  },
});

export const meContactChoices = defineOperation({
  name: "me.contact.choices",
  description:
    "Your contact preferences, as a signed-in customer, and those of each child you act for: each " +
    "kind of message you may get, on each channel it goes by (email, text, push), with what is " +
    "in force. Messages about something booked or paid for are always emailed (fixed); " +
    "follow-ups and news and offers are per channel. Read-only.",
  input: z.object({}).strict(),
  output: z.object({ people: z.array(personChoices) }),
  permission: "records:read",
  risk: "read",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    // Themselves and their live dependants, as the seam's family says (ADR 0540).
    const family = await familyOf(ctx);
    const self = family.self;
    if (!self) throw new OperationError("internal", `${ctx.operation} is for a customer's call`);
    const everyone = [self, ...family.dependants];
    const [kinds, inForce, selfChild] = await Promise.all([
      routineKinds(ctx.db),
      choicesInForce(
        ctx.db,
        everyone.map((p) => p.personId),
      ),
      hasLiveGuardian(ctx.db, self.personId),
    ]);
    const people = everyone.map((p) => {
      const isSelf = p.personId === self.personId;
      const child = isSelf ? selfChild : true;
      return {
        personId: p.personId,
        name: p.name,
        self: isSelf,
        child,
        lines: linesOf(p.personId, child, kinds, inForce),
      };
    });
    return { people };
  },
});

export const meContactSetChoices = defineOperation({
  name: "me.contact.setChoices",
  description:
    "Changes your contact preferences, as a signed-in customer, or those of a child you act for " +
    "(personId). Each choice is a kind of message, a channel and on or off (news_and_offers: yes " +
    "or no, with the words you were shown). A booking's or a payment's email cannot be turned " +
    "off. You may turn back on what you stopped by a link or a STOP reply.",
  input: z
    .object({
      personId: z.string().min(1).max(64).optional().describe("A child you act for; default you"),
      choices: z.array(choiceIn).min(1).max(40),
      wording: z
        .string()
        .max(1000)
        .optional()
        .describe("For a yes to news and offers: the words you were shown"),
    })
    .strict(),
  output: z.object({ changed: z.number().int() }),
  permission: "records:write",
  risk: "write",
  audiences: ["customer"],
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const who = customerOf(ctx);
    const personId = await ownOrDependant(ctx, input.personId);
    const changed = await writeChoices(ctx, {
      personId,
      choices: input.choices,
      how: "member",
      byId: who.customerId,
      wording: input.wording ?? null,
      mayLiftStop: true,
    });
    return { changed };
  },
});

export const personContactRecord = defineOperation({
  name: "person.contact.record",
  description:
    "Records a member's contact choice they gave by phone or on paper: a kind of message, a " +
    "channel and on or off (news_and_offers: yes or no, with the words they agreed to). Says why. " +
    "A person only, never an AI. It cannot turn back on what the member stopped themselves.",
  input: z
    .object({
      personId: z.string().min(1).max(64),
      choices: z.array(choiceIn).min(1).max(40),
      how: z
        .enum(["staff_on_request", "staff_from_paper"])
        .describe("They asked (by phone, at the desk), or on a paper form"),
      reason: z.string().trim().min(3).max(500).describe("Why, in a few words"),
      wording: z
        .string()
        .max(1000)
        .optional()
        .describe("For a yes to news and offers: the words they agreed to"),
    })
    .strict(),
  output: z.object({ changed: z.number().int() }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const found = await ctx.db
      .selectFrom(visibleSource(ctx, "person"))
      .select("id")
      .where("id", "=", input.personId)
      .executeTakeFirst();
    if (!found) throw new NotFoundError("person", input.personId);
    const changed = await writeChoices(ctx, {
      personId: input.personId,
      choices: input.choices,
      how: input.how,
      byId: ctx.user.id,
      reason: input.reason,
      wording: input.wording ?? null,
      mayLiftStop: false,
    });
    return { changed };
  },
});

const historyRow = z.object({
  scope: z.string(),
  channel,
  value: z.enum(["on", "off", "yes", "no"]),
  at: z.string(),
  how: z.enum(CHOICE_HOWS),
  by: z.string().nullable().describe("The staff user or customer account who made it, if any"),
  reason: z.string().nullable(),
  wording: z.string().nullable().describe("The words shown when they said yes"),
});

export const contactForPerson = defineOperation({
  name: "contact.forPerson",
  description:
    "A Person's contact choices: each kind of message they may get on each channel with what is " +
    "in force, and the history of every choice (when, how, by whom, why). Read-only.",
  input: z.object({ personId: z.string().min(1).max(64) }).strict(),
  output: z.object({ child: z.boolean(), lines: z.array(line), history: z.array(historyRow) }),
  permission: "records:read",
  risk: "read",
  async handler(input, ctx) {
    const found = await ctx.db
      .selectFrom(visibleSource(ctx, "person"))
      .select("id")
      .where("id", "=", input.personId)
      .executeTakeFirst();
    if (!found) throw new NotFoundError("person", input.personId);
    const [kinds, inForce, history, child] = await Promise.all([
      routineKinds(ctx.db),
      choicesInForce(ctx.db, [input.personId]),
      choiceHistory(ctx.db, input.personId, 100),
      hasLiveGuardian(ctx.db, input.personId),
    ]);
    return {
      child,
      lines: linesOf(input.personId, child, kinds, inForce),
      history: history.map((c) => ({
        scope: c.scope,
        channel: c.channel,
        value: c.value,
        at: c.at,
        how: c.how,
        by: c.byId,
        reason: c.reason,
        wording: c.wording,
      })),
    };
  },
});

export const contactOperations = [
  contactStop,
  meContactChoices,
  meContactSetChoices,
  personContactRecord,
  contactForPerson,
] as const;
