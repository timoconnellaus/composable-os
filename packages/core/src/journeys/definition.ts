// A journey's working copy and versions (stage 53 step 3, ADR 0800): the document's shape, the
// checks a publish runs on it, the plain-words summary the publisher is shown, and the hash.
//
// The shape is checked on every save (zod); what makes a copy publishable (the slots, the links,
// the words, the unsubscribe slot, the limits, no loop, a reply-to) is listed by `journeyProblems`,
// shown in the editor and refused at publish. The words follow routine mail's rules (ADR 0590):
// no address, phone number, link or markup in what the business typed; links only to its own site
// through `{site:<path>}`; the host's unsubscribe link in every message.
import { unroutineText, unroutineWords } from "@composable-os/sdk";
import { z } from "zod";
import { canonicalJson } from "../agreements/documents.ts";
import { sha256Hex } from "../digest.ts";

export const JOURNEY_KINDS = ["service", "promotional"] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];
export const JOURNEY_STATUSES = ["draft", "live", "paused", "archived"] as const;
export const ENTRY_STATES = ["active", "waiting", "held", "finished", "stopped"] as const;
/** The states of an entry still on its journey: at most one per Person per journey. */
export const LIVE_ENTRY_STATES = ["active", "waiting", "held"] as const;
/** Channels a send step may name. Text and push come with stage 30's gatekeepers (step 6). */
export const JOURNEY_CHANNELS = ["email"] as const;

/** At most this many steps, messages and branches in a version (the spec's limits). */
export const MAX_STEPS = 20;
export const MAX_SENDS = 8;
export const MAX_BRANCHES = 10;
/** A manual entry adds at most this many people at a time. */
export const MAX_MANUAL_ENTRY = 500;

/**
 * The slots a message may use (the spec's fixed list): the recipient's first name, the business's
 * name, the title of the record whose signal started the entry, and in a guardian's version the
 * member's first name. In a body, also `{site:<path>}` and `{unsubscribe}`. A plan's or a class
 * type's name comes with the signals that name them (stage 53 step 2's declarations).
 */
export const SUBJECT_SLOTS = ["firstName", "business", "record"] as const;
export const GUARDIAN_SLOTS = ["member"] as const;
export const UNSUBSCRIBE_SLOT = "unsubscribe";
const SITE_SLOT = /^site:(\/[A-Za-z0-9\-._~/]{0,200})$/;

/** A signal a pack declares (`memberships.started`): checked against the declarations at go-live. */
export const signalName = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$/, "A signal is <pack>.<name>")
  .describe("A signal a shipped pack declares, as <pack>.<name> (memberships.started)");

const stepId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,23}$/, "A step id is a short lowercase word")
  .describe("The step's id within the journey: branches name it");

/** One line a person reads, as in agreements: no control characters. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
    .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), "No control characters");

/** A declared condition (a branch's, or an entry's): the fixed list, so the host can explain it. */
export const conditionSchema = z.discriminatedUnion("test", [
  z.object({
    test: z.literal("liveMembership").describe("The Person holds a live membership"),
    not: z.boolean().default(false),
  }),
  z.object({
    test: z.literal("signalSinceEntry").describe("The Person had the signal since entering"),
    signal: signalName,
    not: z.boolean().default(false),
  }),
  z.object({
    test: z
      .literal("promotionalConsent")
      .describe("The Person has a recorded yes to promotional messages on the channel"),
    channel: z.enum(JOURNEY_CHANNELS),
    not: z.boolean().default(false),
  }),
]);
export type JourneyCondition = z.infer<typeof conditionSchema>;

export const entryRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("signal"), signal: signalName }),
  z.object({
    type: z.literal("quiet"),
    signal: signalName,
    days: z.number().int().min(1).max(365).describe("Days with no newer signal"),
  }),
  z.object({ type: z.literal("birthday") }),
  z.object({ type: z.literal("manual") }),
]);
export type EntryRule = z.infer<typeof entryRuleSchema>;

export const reentrySchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("once").describe("Once ever") }),
  z.object({
    rule: z.literal("after").describe("Not again within `days` of entering"),
    days: z.number().int().min(1).max(3650),
  }),
]);

const message = z.object({
  subject: z.string().max(150).describe("One line, with slots from the fixed list"),
  body: z.string().max(4000).describe("Plain text lines with slots; must hold {unsubscribe}"),
});

export const stepSchema = z.discriminatedUnion("type", [
  z.object({
    id: stepId,
    type: z.literal("send"),
    channel: z.enum(JOURNEY_CHANNELS),
    ...message.shape,
    guardian: message
      .optional()
      .describe("What a dependant's live guardians get instead (service journeys only)"),
  }),
  z.object({
    id: stepId,
    type: z.literal("wait"),
    days: z.number().int().min(0).max(365).default(0),
    hours: z.number().int().min(0).max(23).default(0),
    until: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM")
      .optional()
      .describe("Then until this time of day in the business's zone"),
    weekdaysOnly: z.boolean().default(false),
  }),
  z.object({
    id: stepId,
    type: z.literal("branch"),
    condition: conditionSchema,
    goTo: stepId.describe("The step to go to when the condition holds (a later one)"),
    otherwise: stepId.describe("The step to go to when it does not (a later one)"),
  }),
  z.object({
    id: stepId,
    type: z.literal("task"),
    title: line(200),
    assignee: z
      .string()
      .min(1)
      .max(64)
      .describe('"owner" (the journey\'s owner) or a staff user id'),
    dueDays: z.number().int().min(0).max(60).default(0),
  }),
  z.object({ id: stepId, type: z.literal("end") }),
]);
export type JourneyStep = z.infer<typeof stepSchema>;

export const definitionSchema = z.object({
  entry: entryRuleSchema,
  conditions: z.array(conditionSchema).max(5).default([]),
  exits: z.array(signalName).max(10).default([]).describe("Signals that take a Person off it"),
  reentry: reentrySchema.default({ rule: "once" }),
  includeBulk: z
    .boolean()
    .default(false)
    .describe("Whether a signal from a bulk write (an import, a bulk change) enters anyone"),
  replyTo: z
    .string()
    .max(254)
    .nullable()
    .default(null)
    .describe("Where replies go: one of the addresses a human admin allowed"),
  steps: z.array(stepSchema).min(1).max(40),
});
export type JourneyDefinition = z.infer<typeof definitionSchema>;

/** Every signal a definition names: its entry rule's, its exits, and its conditions' and branches'. */
export function signalsNamed(definition: JourneyDefinition): string[] {
  const out = new Set<string>(definition.exits);
  if (definition.entry.type === "signal" || definition.entry.type === "quiet") {
    out.add(definition.entry.signal);
  }
  const conditions = [
    ...definition.conditions,
    ...definition.steps.flatMap((s) => (s.type === "branch" ? [s.condition] : [])),
  ];
  for (const c of conditions) if (c.test === "signalSinceEntry") out.add(c.signal);
  return [...out].sort();
}

/** Parses a stored working copy or version. A row that does not parse is never run. */
export function parseDefinition(json: string): JourneyDefinition | null {
  try {
    const parsed = definitionSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A template's pieces: literal words and slots. */
export type Piece = { text: string } | { slot: string };

/** Splits a template into words and `{slot}`s; `error` when a brace is left open or stray. */
export function parseTemplate(template: string): { pieces: Piece[]; error: string | null } {
  const pieces: Piece[] = [];
  let error: string | null = null;
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    const close = template.indexOf("}", i);
    if (close !== -1 && (open === -1 || close < open)) {
      error ??= "A } with no { before it";
      pieces.push({ text: template.slice(i, close) });
      i = close + 1;
      continue;
    }
    if (open === -1) {
      pieces.push({ text: template.slice(i) });
      break;
    }
    if (open > i) pieces.push({ text: template.slice(i, open) });
    const end = template.indexOf("}", open);
    const nextOpen = template.indexOf("{", open + 1);
    if (end === -1 || (nextOpen !== -1 && nextOpen < end)) {
      error ??= "A { with no } after it";
      i = open + 1;
      continue;
    }
    pieces.push({ slot: template.slice(open + 1, end) });
    i = end + 1;
  }
  return { pieces, error };
}

export interface Problem {
  path: string;
  message: string;
}

/** Why a template cannot go into a journey message, as problems at `path`. */
function templateProblems(
  template: string,
  path: string,
  where: { body: boolean; guardian: boolean },
): Problem[] {
  const problems: Problem[] = [];
  const { pieces, error } = parseTemplate(template);
  if (error) problems.push({ path, message: error });
  const allowed = new Set<string>([
    ...SUBJECT_SLOTS,
    ...(where.guardian ? GUARDIAN_SLOTS : []),
    ...(where.body ? [UNSUBSCRIBE_SLOT] : []),
  ]);
  let unsubscribe = 0;
  for (const piece of pieces) {
    if (!("slot" in piece)) continue;
    if (piece.slot === UNSUBSCRIBE_SLOT && where.body) unsubscribe += 1;
    if (allowed.has(piece.slot)) continue;
    if (where.body && SITE_SLOT.test(piece.slot)) continue;
    problems.push({
      path,
      message: piece.slot.startsWith("site:")
        ? `"{${piece.slot}}" is not a path on the business's site (a link is {site:/path})`
        : `"{${piece.slot}}" is not one of the slots a journey message may use`,
    });
  }
  if (where.body && unsubscribe !== 1) {
    problems.push({
      path,
      message: "Every message carries the unsubscribe link once: put {unsubscribe} in its body",
    });
  }
  // The business's own words, line by line, with the slots taken out: routine mail's rules.
  const literal = pieces.map((p) => ("text" in p ? p.text : " ")).join("");
  const lines = literal.split("\n");
  if (!where.body && lines.length > 1) problems.push({ path, message: "A subject is one line" });
  for (const text of lines) {
    const why = unroutineText(text, 1000) ?? unroutineWords(text);
    if (why) {
      problems.push({
        path,
        message: `The words hold ${why}: links go only through {site:/path}, and no address or phone number is typed in`,
      });
      break;
    }
  }
  if (!pieces.some((p) => "text" in p && /\S/u.test(p.text))) {
    problems.push({ path, message: "A message needs words of its own" });
  }
  return problems;
}

/** The step a step goes on to when it does not branch: the next in the list, or none. */
function successors(step: JourneyStep, next: string | undefined): string[] {
  if (step.type === "end") return [];
  if (step.type === "branch") return [step.goTo, step.otherwise];
  return next ? [next] : [];
}

/**
 * What stops a working copy from being published (empty: it can be). The limits, every step id
 * once, branches only forward (so no loop), each message's slots, links and words, the guardian's
 * version only on a service journey, the unsubscribe slot in every body, a task's assignee, and a
 * reply-to among the addresses a human admin allowed.
 */
export function journeyProblems(
  definition: JourneyDefinition,
  kind: JourneyKind,
  context: { allowedReplyTo: readonly string[]; staffIds?: ReadonlySet<string> },
): Problem[] {
  const problems: Problem[] = [];
  const steps = definition.steps;
  if (steps.length > MAX_STEPS) {
    problems.push({ path: "steps", message: `At most ${MAX_STEPS} steps` });
  }
  const sends = steps.filter((s) => s.type === "send");
  if (sends.length > MAX_SENDS) {
    problems.push({ path: "steps", message: `At most ${MAX_SENDS} messages` });
  }
  if (!sends.length)
    problems.push({ path: "steps", message: "A journey sends at least one message" });
  if (steps.filter((s) => s.type === "branch").length > MAX_BRANCHES) {
    problems.push({ path: "steps", message: `At most ${MAX_BRANCHES} branches` });
  }
  const index = new Map<string, number>();
  steps.forEach((step, i) => {
    if (index.has(step.id)) {
      problems.push({ path: `steps.${i}.id`, message: `The step id "${step.id}" is used twice` });
    } else index.set(step.id, i);
  });
  steps.forEach((step, i) => {
    const path = `steps.${i}`;
    if (step.type === "branch") {
      for (const target of [step.goTo, step.otherwise]) {
        const at = index.get(target);
        if (at === undefined) {
          problems.push({ path, message: `The branch goes to "${target}", which is not a step` });
        } else if (at <= i) {
          // Forward only: a journey cannot go back to an earlier step, so it never loops.
          problems.push({
            path,
            message: `The branch goes back to "${target}": a journey never loops`,
          });
        }
      }
    }
    if (step.type === "wait" && step.days === 0 && step.hours === 0 && !step.until) {
      problems.push({ path, message: "A wait waits for some days, hours or until a time" });
    }
    if (step.type === "task") {
      if (step.assignee !== "owner" && context.staffIds && !context.staffIds.has(step.assignee)) {
        problems.push({ path, message: "A task goes to the journey's owner or a staff user" });
      }
    }
    if (step.type === "send") {
      problems.push(
        ...templateProblems(step.subject, `${path}.subject`, { body: false, guardian: false }),
        ...templateProblems(step.body, `${path}.body`, { body: true, guardian: false }),
      );
      if (step.guardian) {
        if (kind === "promotional") {
          problems.push({
            path: `${path}.guardian`,
            message:
              "A promotional journey is never sent about a child: it has no guardian's version",
          });
        }
        problems.push(
          ...templateProblems(step.guardian.subject, `${path}.guardian.subject`, {
            body: false,
            guardian: true,
          }),
          ...templateProblems(step.guardian.body, `${path}.guardian.body`, {
            body: true,
            guardian: true,
          }),
        );
      }
    }
  });
  // Every step is reached from the first (a step nothing leads to is a mistake in the editor).
  const reached = new Set<string>();
  const queue = steps[0] ? [steps[0].id] : [];
  while (queue.length) {
    const id = queue.shift() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    const at = index.get(id);
    if (at === undefined) continue;
    queue.push(...successors(steps[at] as JourneyStep, steps[at + 1]?.id));
  }
  steps.forEach((step, i) => {
    if (!reached.has(step.id)) {
      problems.push({ path: `steps.${i}`, message: `Nothing leads to the step "${step.id}"` });
    }
  });
  if (!definition.replyTo) {
    problems.push({
      path: "replyTo",
      message: "Choose where replies go (an address an admin allowed)",
    });
  } else if (!context.allowedReplyTo.includes(definition.replyTo.toLowerCase())) {
    problems.push({
      path: "replyTo",
      message: "Replies can only go to an address an admin allowed",
    });
  }
  return problems;
}

const describeCondition = (c: JourneyCondition): string => {
  const base =
    c.test === "liveMembership"
      ? "they hold a live membership"
      : c.test === "signalSinceEntry"
        ? `they had ${c.signal} since entering`
        : `they said yes to promotional ${c.channel}`;
  return c.not ? `not (${base})` : base;
};

const describeWait = (s: Extract<JourneyStep, { type: "wait" }>): string => {
  const parts = [
    s.days ? `${s.days} day${s.days === 1 ? "" : "s"}` : "",
    s.hours ? `${s.hours} hour${s.hours === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return [
    parts.length ? `Wait ${parts.join(" and ")}` : "Wait",
    s.until ? `, then until ${s.until} in the business's time zone` : "",
    s.weekdaysOnly ? ", on a weekday" : "",
  ].join("");
};

/**
 * The journey in plain words, as the publisher is shown it and the version keeps it: who it is
 * for, when it starts and stops, and every step in order.
 */
export function journeySummary(
  definition: JourneyDefinition,
  kind: JourneyKind,
  names: { staff?: ReadonlyMap<string, string> } = {},
): string {
  const entry = definition.entry;
  const out: string[] = [
    kind === "promotional"
      ? "A promotional journey: it sends only to people who said yes to promotional messages, and never about a child."
      : "A service journey: about something the member has or did; a child's messages go to their parents.",
    entry.type === "signal"
      ? `Starts when a Person gets ${entry.signal}.`
      : entry.type === "quiet"
        ? `Starts when a Person has had no ${entry.signal} for ${entry.days} days (found by the daily scan).`
        : entry.type === "birthday"
          ? "Starts on a Person's birthday, in the business's time zone."
          : "Starts when a member of staff adds people.",
  ];
  if (definition.conditions.length) {
    out.push(`Only while ${definition.conditions.map(describeCondition).join(" and ")}.`);
  }
  out.push(
    definition.includeBulk
      ? "A signal from an import or a bulk change enters people too."
      : "A signal from an import or a bulk change enters nobody.",
    definition.reentry.rule === "once"
      ? "A Person goes through it once ever."
      : `A Person does not enter again within ${definition.reentry.days} days.`,
  );
  out.push(
    `Stops when ${[
      ...definition.exits.map((s) => `they get ${s}`),
      "they turn automatic messages off",
      ...(kind === "promotional" ? ["they withdraw their yes"] : []),
      "they are erased",
      "staff stop it",
    ].join(", ")}.`,
  );
  out.push(definition.replyTo ? `Replies go to ${definition.replyTo}.` : "Replies go nowhere yet.");
  definition.steps.forEach((step, i) => {
    const n = `${i + 1}.`;
    if (step.type === "send") {
      out.push(
        `${n} Send an email "${step.subject}"${step.guardian ? " (a guardian's version for a child)" : ""}.`,
      );
    } else if (step.type === "wait") out.push(`${n} ${describeWait(step)}.`);
    else if (step.type === "branch") {
      out.push(
        `${n} If ${describeCondition(step.condition)}, go to "${step.goTo}"; otherwise to "${step.otherwise}".`,
      );
    } else if (step.type === "task") {
      const who =
        step.assignee === "owner"
          ? "the journey's owner"
          : (names.staff?.get(step.assignee) ?? "a member of staff");
      out.push(`${n} Give ${who} a task: "${step.title}".`);
    } else out.push(`${n} End.`);
  });
  return out.join("\n");
}

/** SHA-256 (hex) of the canonical JSON of the kind and the stored definition. */
export async function journeyHash(kind: JourneyKind, definitionJson: string): Promise<string> {
  let definition: unknown;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    definition = definitionJson;
  }
  return sha256Hex(canonicalJson({ kind, definition }));
}
