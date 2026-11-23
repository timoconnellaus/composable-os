// The Rostering tools (stage 45 step 4, ADR 0626). They become operations x.rostering.<tool>, run in
// the sandbox, and reach the host only through ctx.ops. None of them holds a rule: who is on two
// shifts at once (refused), who may take an offer, the cut-off, who is warned about what, who may
// roster and who learns that someone is away are all the host's (the `staffed` behaviour and its
// tool-only `staffing.*` operations, ADRs 0621 to 0625). Each operation acts for the staff account
// the host verified as this tool's caller, never for anything in the input; a tool asks, and
// passes on what the host answered.
//
// Who may call which (the spec's "What an AI may do"):
// - the team's tools (`rostering:team`, the team role's; `rostering:roster`, granted to an account
//   with another pack role, such as a coach): reading the roster and one's own offers and time off
//   is open to an assistant acting for them; offering, taking, withdrawing, saying one is away and
//   back are a person's own acts (`humanOnly`);
// - the rosterers' tools (`rostering:manage`, restricted: admins, and anyone an admin grants it):
//   reading the roster's warnings, qualifications and the uncovered shifts is open to an assistant;
//   putting someone on a shift and saying who is qualified wait for a person (`personApproves`);
//   saying someone else is away, and reading everyone's time off, are a person's (`humanOnly`).
import { defineTool, z } from "@composable-os/sdk";

/** The team's tools: the role's permission, or the same tools granted to another role's account. */
const TEAM = ["rostering:team", "rostering:roster"] as const;
/** The rosterers' tools: restricted (held by admins and by grant only, ADR 0625). */
const MANAGE = "rostering:manage";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD");
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "a local date and time, YYYY-MM-DDTHH:MM");
const localTime = z.string().regex(/^[0-2]\d:[0-5]\d$/, "a time, HH:MM");
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const warning = z.object({
  code: z.enum(["unavailable", "not_qualified", "uncovered"]),
  object: z.string(),
  id: z.string(),
  account: z.string().nullable(),
  message: z.string(),
});

const shift = z.object({
  object: z.string().describe("The kind of record: a class (bookings.class) or a duty shift"),
  id: z.string(),
  title: z.string(),
  kind: z.object({ object: z.string(), id: z.string(), name: z.string() }).nullable(),
  startsAt: z.string().describe("ISO 8601, UTC: show it in `zone`"),
  endsAt: z.string().nullable(),
  zone: z.string().nullable(),
  place: z.string().nullable(),
  uncovered: z.boolean().describe("Nobody is on it"),
  noAccount: z.boolean().describe("Its person has no staff account (a visiting coach)"),
  account: z.string().nullable(),
  name: z.string().nullable().describe("Who is on it"),
  mine: z.boolean().describe("It is the caller's"),
  offer: z
    .object({ id: z.string(), to: z.string().nullable(), from: z.string().nullable() })
    .nullable(),
  warnings: z.array(warning).nullable().describe("For someone who rosters only"),
});

const roster = z.object({
  shifts: z.array(shift),
  zone: z.string(),
  truncated: z
    .boolean()
    .describe("Cut short: more shifts than one answer holds; ask for fewer days"),
});

const summary = z.object({
  object: z.string(),
  id: z.string(),
  title: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});

const offerShape = z.object({
  id: z.string(),
  shift: summary,
  from: z.string().nullable(),
  fromName: z.string().nullable(),
  to: z.string().nullable(),
  state: z.enum(["open", "taken", "withdrawn", "cancelled", "lapsed"]),
  madeAt: z.string(),
  takenBy: z.string().nullable(),
  takenAt: z.string().nullable(),
  closesAt: z.string().nullable(),
});

const awayShape = z.object({
  id: z.string(),
  account: z.string(),
  name: z.string(),
  kind: z.enum(["leave", "regular", "other"]),
  note: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  weekdays: z.array(z.string()),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  fromDate: z.string().nullable(),
  untilDate: z.string().nullable(),
  zone: z.string(),
});

const awayInput = {
  kind: z
    .enum(["leave", "other", "regular"])
    .describe("leave or other: a one-off time; regular: every week"),
  note: z.string().max(500).optional(),
  startsAt: localDateTime.optional().describe("A one-off time's start, local"),
  endsAt: localDateTime.optional().describe("A one-off time's end, local"),
  weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional().describe("A regular time's days"),
  startTime: localTime.optional(),
  endTime: localTime.optional(),
  fromDate: localDate.optional().describe("A regular time's first date"),
  untilDate: localDate.optional().describe("A regular time's last date; empty: ongoing"),
  zone: z.string().min(1).max(64).optional().describe("IANA zone; the organisation's if left out"),
};

const awayAnswer = z.object({
  id: z.string(),
  shifts: z.array(summary).describe("Your shifts it covers, to offer"),
  count: z.number(),
});

/** Today's date (UTC) and `days` later: the default range when none is given. */
function range(input: { from?: string | undefined; to?: string | undefined }, days: number) {
  const from = input.from ?? new Date().toISOString().slice(0, 10);
  const to =
    input.to ??
    new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

// --- The team's tools ------------------------------------------------------------------------------

export const week = defineTool({
  description:
    "The roster: every shift from `from` to `to` (local dates, both included, at most 62 days; " +
    "a week from today when left out), classes and duty shifts alike, each with its kind, time, " +
    "place and who is on it (or nobody), and its open offer. Someone who rosters also sees each " +
    "shift's warnings. Shows nothing of a class's bookings or members.",
  input: z.object({ from: localDate.optional(), to: localDate.optional() }),
  output: roster,
  risk: "read",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  handler: async (input, ctx) => roster.parse(await ctx.ops.call("staffing.week", range(input, 7))),
});

export const mine = defineTool({
  description:
    "Your own shifts from `from` to `to` (local dates, both included, at most 62 days; four weeks " +
    "from today when left out), each with its time, place and open offer.",
  input: z.object({ from: localDate.optional(), to: localDate.optional() }),
  output: roster,
  risk: "read",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  handler: async (input, ctx) =>
    roster.parse(await ctx.ops.call("staffing.week", { ...range(input, 28), mine: true })),
});

export const offers = defineTool({
  description:
    "Shifts offered that you could take now (you are qualified for the kind of work, free then, " +
    "and it is before the cut-off; `unavailable` says you said you are away then), and your own " +
    "open offers.",
  input: z.object({}),
  output: z.object({
    open: z.array(offerShape.extend({ unavailable: z.boolean() })),
    mine: z.array(offerShape),
  }),
  risk: "read",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  handler: async (_input, ctx) => (await ctx.ops.call("staffing.offers", {})) as never,
});

export const offer = defineTool({
  description:
    "Offer one of your shifts for someone else to take: to everyone who could take it, or to one " +
    "named person (`to`). It stays yours, in your list and your pay, until someone takes it. " +
    "Offers close at the cut-off before the shift starts. Whoever rosters may offer any shift, " +
    "and one with nobody on it. A person's own act.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    to: z.string().min(1).max(64).optional().describe("A staff account: offer it to them only"),
  }),
  output: z.object({ offer: offerShape, told: z.number().nullable() }),
  risk: "write",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.offer", input)) as never,
});

export const withdraw = defineTool({
  description: "Withdraw an open offer you made. The shift stays yours. A person's own act.",
  input: z.object({ offer: z.string().min(1).max(64) }),
  output: z.object({ offer: offerShape }),
  risk: "write",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.withdraw", input)) as never,
});

export const take = defineTool({
  description:
    "Take an offered shift: it becomes yours at once and nobody approves it, because you must be " +
    "qualified for it and free then (otherwise it is refused). If you said you are away then, " +
    "confirm with confirmUnavailable. Of several people taking one shift at once, one gets it; " +
    "the others are told who took it. The person who offered it and whoever rosters are told. A " +
    "person's own act.",
  input: z.object({
    offer: z.string().min(1).max(64),
    confirmUnavailable: z.boolean().optional(),
  }),
  output: z.object({ offer: z.string(), shift: summary, warnings: z.array(warning) }),
  risk: "write",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.take", input)) as never,
});

export const away = defineTool({
  description:
    "Say when you cannot work: leave or another one-off time (startsAt and endsAt, local), or a " +
    "regular time off (weekdays with a start and end time, from a date). Nobody approves it. " +
    "Shifts you are already on stay yours: the answer lists them, to offer, and whoever rosters " +
    "is told. Only you and whoever rosters ever see it. A person's own act.",
  input: z.object(awayInput),
  output: awayAnswer,
  risk: "write",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  humanOnly: true,
  // What someone writes about their leave never reaches the audit log.
  redact: ["note"],
  handler: async (input, ctx) => (await ctx.ops.call("staffing.away", input)) as never,
});

export const back = defineTool({
  description:
    "Remove a time you said you cannot work (you are back, or it was wrong). Whoever rosters may " +
    "remove anyone's. A person's own act.",
  input: z.object({ id: z.string().min(1).max(64) }),
  output: z.object({ id: z.string() }),
  risk: "write",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.back", input)) as never,
});

export const myAway = defineTool({
  description:
    "The times you said you cannot work, from `from` (today when left out) to `to`, with your " +
    "notes (shown to you only: an assistant reading them gets no notes).",
  input: z.object({ from: localDate.optional(), to: localDate.optional() }),
  output: z.object({ items: z.array(awayShape) }),
  risk: "read",
  permission: [...TEAM],
  grantLiftsRoleLimits: true,
  handler: async (input, ctx) => {
    // Your own: the account is the host-verified caller, never one the input names.
    const caller = ctx.caller;
    if (caller?.kind !== "staff") return { items: [] };
    return (await ctx.ops.call("staffing.awayList", { ...input, account: caller.userId })) as never;
  },
});

// --- The rosterers' tools --------------------------------------------------------------------------

export const assign = defineTool({
  description:
    "Put a member of staff on a shift (a class or a duty shift), or nobody (account null). Made " +
    "with its warnings (away, not qualified, nobody on it), which `check` shows first; refused " +
    "if they are on another shift then. A shift of a weekly pattern keeps it as its own. The " +
    "people on and off it are told; its open offer is cancelled. Whoever rosters; an assistant " +
    "may ask, and a person applies it.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    account: z.string().min(1).max(64).nullable(),
  }),
  output: z.object({ shift: summary, warnings: z.array(warning) }),
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.assign", input)) as never,
});

export const check = defineTool({
  description:
    "What putting someone (account; null for nobody; left out for the shift as it is) on a " +
    "shift would be made with: its warnings (away, not qualified, nobody on it) and the other " +
    "shift it would clash with (refused). Changes nothing. Whoever rosters.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    account: z.string().min(1).max(64).nullable().optional(),
  }),
  output: z.object({
    warnings: z.array(warning),
    clash: z
      .object({
        object: z.string(),
        id: z.string(),
        title: z.string(),
        startsAt: z.string(),
        endsAt: z.string(),
      })
      .nullable(),
  }),
  risk: "read",
  permission: MANAGE,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.check", input)) as never,
});

export const qualify = defineTool({
  description:
    "Say whether a member of staff may do a kind of work (a class type, a duty): qualified people " +
    "may take an offered shift of it without anybody approving, and putting someone else on it " +
    "is warned about. Whoever rosters; an assistant may ask, and a person applies it.",
  input: z.object({
    account: z.string().min(1).max(64),
    kind: z.object({
      object: z.string().min(1).max(81).describe("programs.classtype or rostering.duty"),
      id: z.string().min(1).max(64),
    }),
    qualified: z.boolean().default(true),
  }),
  output: z.object({
    account: z.string(),
    kind: z.object({ object: z.string(), id: z.string() }),
    qualified: z.boolean(),
    changed: z.boolean(),
  }),
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.qualify", input)) as never,
});

export const qualifications = defineTool({
  description:
    "Who may do which kind of work: everyone's, or one person's (account), or one kind of " +
    "work's (kindObject). Whoever rosters.",
  input: z.object({
    account: z.string().min(1).max(64).optional(),
    kindObject: z.string().min(1).max(81).optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        kind: z.object({ object: z.string(), id: z.string(), name: z.string() }),
        setBy: z.string(),
        setAt: z.string(),
      }),
    ),
  }),
  risk: "read",
  permission: MANAGE,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.qualifications", input)) as never,
});

export const awayFor = defineTool({
  description:
    "Say when someone else cannot work (their leave, a regular time off), as they would " +
    "themselves. Their shifts stay theirs, with a warning; the answer lists them. Whoever " +
    "rosters, a person only.",
  input: z.object({ account: z.string().min(1).max(64), ...awayInput }),
  output: awayAnswer,
  risk: "write",
  permission: MANAGE,
  humanOnly: true,
  redact: ["note"],
  handler: async (input, ctx) => (await ctx.ops.call("staffing.away", input)) as never,
});

export const awayList = defineTool({
  description:
    "Everyone's times they cannot work (or one person's, account), with their notes, from `from` " +
    "(today when left out) to `to`. Whoever rosters, a person only: never read by an assistant.",
  input: z.object({
    account: z.string().min(1).max(64).optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  }),
  output: z.object({ items: z.array(awayShape) }),
  risk: "read",
  permission: MANAGE,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.awayList", input)) as never,
});

export const uncovered = defineTool({
  description:
    "Shifts with nobody on them from now for `days` days (the uncovered window, a setting, when " +
    "left out; at most 62), and whether each is offered. Whoever rosters.",
  input: z.object({ days: z.number().int().min(1).max(62).optional() }),
  output: z.object({ items: z.array(summary.extend({ offered: z.boolean() })) }),
  risk: "read",
  permission: MANAGE,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.uncovered", input)) as never,
});

export const markNotWorked = defineTool({
  description:
    "Mark a shift that has started as not worked, with why (nobody ran the class, they did not " +
    "come in), so it counts for nothing in its pay period; notWorked false clears the mark. A " +
    "shift in a locked pay period is refused until the period is reopened. Whoever rosters; an " +
    "assistant may ask, and a person applies it.",
  input: z.object({
    object: z.string().min(1).max(81),
    id: z.string().min(1).max(64),
    notWorked: z.boolean().default(true),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({
    object: z.string(),
    id: z.string(),
    notWorked: z.boolean(),
    changed: z.boolean(),
  }),
  risk: "write",
  permission: MANAGE,
  personApproves: true,
  // Why someone did not work a shift is theirs: kept with the mark, not in the audit log.
  redact: ["reason"],
  handler: async (input, ctx) => (await ctx.ops.call("staffing.markNotWorked", input)) as never,
});

// --- Pay (restricted, a person only: never an assistant, whatever is granted) ---------------------

/** Pay: restricted (held by admins and by grant only, ADR 0625), and every tool `humanOnly`. */
const PAY = "rostering:pay";
const basis = z.enum(["by_time", "by_class", "not_counted"]);

export const payBasis = defineTool({
  description:
    "Say how a member of staff is counted for pay from a date on (today when left out): " +
    "by_time (their hours), by_class (their classes and shifts) or not_counted (salaried, the " +
    "default). No rates are kept: payroll applies them. Whoever handles pay, a person only.",
  input: z.object({ account: z.string().min(1).max(64), basis, from: localDate.optional() }),
  output: z.object({ account: z.string(), from: z.string(), changed: z.boolean() }),
  risk: "write",
  permission: PAY,
  humanOnly: true,
  // How someone is counted is pay: the audit log says whose and from when, not how.
  redact: ["basis"],
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payBasis", input)) as never,
});

export const payBases = defineTool({
  description:
    "Who is counted for pay and how (by time, by class, not counted), today and from which " +
    "dates. Whoever handles pay, a person only.",
  input: z.object({ account: z.string().min(1).max(64).optional() }),
  output: z.object({
    today: z.string(),
    items: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        basis,
        history: z.array(
          z.object({ from: z.string(), basis, setBy: z.string(), setAt: z.string() }),
        ),
      }),
    ),
  }),
  risk: "read",
  permission: PAY,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payBases", input)) as never,
});

const version = z.object({
  id: z.string(),
  version: z.number(),
  state: z.enum(["locked", "reopened"]),
  lockedBy: z.string(),
  lockedByName: z.string(),
  lockedAt: z.string(),
  reopenedBy: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenReason: z.string().nullable(),
});

export const periods = defineTool({
  description:
    "The pay periods (the pay period setting: fortnightly by default): the current one and the " +
    "`count` before it, each open or locked, with its versions. Whoever handles pay, a person only.",
  input: z.object({ count: z.number().int().min(1).max(60).optional() }),
  output: z.object({
    setting: z.object({
      period: z.enum(["weekly", "fortnightly", "monthly"]),
      start: z.string().nullable(),
      day: z.number(),
      zone: z.string(),
    }),
    set: z.boolean().describe("False until the date a period starts is set: nothing is totalled"),
    periods: z.array(
      z.object({
        start: z.string(),
        end: z.string(),
        zone: z.string(),
        state: z.enum(["open", "locked"]),
        ended: z.boolean(),
        versions: z.array(version),
      }),
    ),
  }),
  risk: "read",
  permission: PAY,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payPeriod.list", input)) as never,
});

const kindRef = z.object({ object: z.string(), id: z.string() }).nullable();

export const periodTotals = defineTool({
  description:
    "One pay period's totals: per counted person and kind of work, the shifts and the hours " +
    "(whole minutes, and hours to two places), and one line per shift with its evidence (its " +
    "class list taken, by whom, flagged for review when not by its person). A locked period's " +
    "are its locked lines; an open one's are a preview from the roster as it stands. Whoever " +
    "handles pay, a person only.",
  input: z.object({ start: localDate, version: z.number().int().min(1).optional() }),
  output: z.object({
    period: z.object({
      start: z.string(),
      end: z.string(),
      zone: z.string(),
      locked: z.boolean(),
      preview: z.boolean(),
      version: version.nullable(),
    }),
    totals: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        email: z.string(),
        basis: z.enum(["by_time", "by_class"]),
        kind: kindRef,
        kindName: z.string(),
        shifts: z.number(),
        minutes: z.number(),
        hours: z.string(),
        notWorked: z.number(),
        flagged: z.number(),
      }),
    ),
    lines: z.array(
      z.object({
        account: z.string(),
        name: z.string(),
        email: z.string(),
        basis: z.enum(["by_time", "by_class"]),
        object: z.string(),
        id: z.string(),
        kind: kindRef,
        kindName: z.string(),
        title: z.string(),
        place: z.string().nullable(),
        localDate: z.string(),
        localStart: z.string(),
        localEnd: z.string(),
        shiftMinutes: z.number(),
        beforeMinutes: z.number(),
        afterMinutes: z.number(),
        countedMinutes: z.number(),
        counted: z.boolean(),
        notWorkedReason: z.string().nullable(),
        listTaken: z.boolean().nullable(),
        markedBy: z.string().nullable(),
        flagged: z.boolean(),
      }),
    ),
    minutes: z.number(),
    hours: z.string(),
  }),
  risk: "read",
  permission: PAY,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payPeriod.totals", input)) as never,
});

export const lock = defineTool({
  description:
    "Lock a pay period that has ended: its totals are written from the roster as it stands and " +
    "never change; shifts inside it can no longer be changed until it is reopened. Correct the " +
    "roster first (reassign, mark not worked). Whoever handles pay, a person only.",
  input: z.object({ start: localDate }),
  output: z.object({ id: z.string(), start: z.string(), end: z.string(), version: z.number() }),
  risk: "write",
  permission: PAY,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payPeriod.lock", input)) as never,
});

export const reopen = defineTool({
  description:
    "Reopen a locked pay period, saying why, to correct its shifts; its locked version is kept. " +
    "Lock it again for a new version. Whoever handles pay, a person only.",
  input: z.object({ start: localDate, reason: z.string().trim().min(1).max(500) }),
  output: z.object({ id: z.string(), start: z.string(), version: z.number() }),
  risk: "write",
  permission: PAY,
  humanOnly: true,
  redact: ["reason"],
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payPeriod.reopen", input)) as never,
});

export const exportPeriod = defineTool({
  description:
    "A pay period as a CSV file for payroll: a summary row per person and kind of work (shifts, " +
    "hours as a decimal and in minutes), then a row per shift. From its locked version, or a " +
    "preview of an open period, marked as such. No rates and no money. Whoever handles pay, a " +
    "person only.",
  input: z.object({ start: localDate, version: z.number().int().min(1).optional() }),
  output: z.object({
    filename: z.string(),
    contentType: z.literal("text/csv"),
    csv: z.string(),
    locked: z.boolean(),
    version: z.number().nullable(),
  }),
  risk: "read",
  permission: PAY,
  humanOnly: true,
  handler: async (input, ctx) => (await ctx.ops.call("staffing.payPeriod.export", input)) as never,
});
