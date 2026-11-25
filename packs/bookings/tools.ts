// The Bookings tools (stage 31a steps 3 to 7). They become operations x.bookings.<tool>, run in the
// sandbox, and reach the host only through ctx.ops. None of them holds a rule: when booking opens
// and closes, whether a cancel is late, which class types only staff book, the places left, one
// booking per person per class and the use a booking spends are all the host's (index.ts). A tool
// asks, and reports what the host answered, in words a member can be shown.
import { defineTool, type ExtensionContext, OpsCallError, z } from "@composable-os/sdk";

const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const COACH = "bookings.coach";
const ROOM = "bookings.room";
const CLASS_TYPE = "programs.classtype";

interface RecordShape {
  id: string;
  title?: string | null;
  values: Record<string, unknown>;
}

interface ListShape {
  items: RecordShape[];
  nextCursor?: string | null;
}

type Ctx = ExtensionContext;

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : value == null || value === "" ? null : Number(value);
const flag = (value: unknown): boolean => value === true || value === 1 || value === "1";

/** A class's own time zone: its times are this zone's (ADR 0460). */
const timeZone = z
  .string()
  .nullable()
  .describe("The class's IANA time zone: show its times in this zone.");

const places = z.object({
  status: z.enum(["available", "low", "sold_out"]),
  available: z.number().nullable().optional().describe("Places left; null when unlimited"),
});

const named = z.object({ id: z.string(), name: z.string().nullable() }).nullable();

const classOutput = z.object({
  id: z.string(),
  title: z.string().nullable().describe("The class's name (its class type's, unless renamed)"),
  classType: z.string().nullable(),
  startsAt: z.string().nullable().describe("When it starts (ISO 8601, UTC)"),
  endsAt: z.string().nullable(),
  timeZone,
  room: named,
  coach: named.and(z.object({ photo: z.string().nullable() }).partial()).nullable(),
  notes: z.string().nullable(),
  places,
});
type ClassOut = z.infer<typeof classOutput>;

/** Records of `object` by id, through a read operation the caller may use (public, my or staff's). */
async function byIds(
  ctx: Ctx,
  operation: "public.list" | "my.list" | "record.list",
  object: string,
  ids: (string | null)[],
): Promise<Map<string, Record<string, unknown>>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const found = await ctx.ops.call<ListShape>(operation, {
    object,
    filter: { field: "id", op: "in", value: wanted },
    limit: Math.min(wanted.length, 200),
  });
  return new Map(found.items.map((item) => [item.id, item.values]));
}

/** What the host says of a class's places, as an outsider may be told (`show: "exact"`). */
async function placesOf(ctx: Ctx, id: string): Promise<ClassOut["places"]> {
  const view = await ctx.ops.call<{
    status: "available" | "low" | "sold_out";
    available?: number | null;
  }>("capacity.get", { object: CLASS, id });
  return {
    status: view.status,
    ...(view.available === undefined ? {} : { available: view.available }),
  };
}

async function describeClasses(ctx: Ctx, classes: RecordShape[]): Promise<ClassOut[]> {
  // Coaches and rooms are public (their names); a class's other people are never read here.
  const coaches = await byIds(
    ctx,
    "public.list",
    COACH,
    classes.map((c) => text(c.values.coach)),
  );
  const rooms = await byIds(
    ctx,
    "public.list",
    ROOM,
    classes.map((c) => text(c.values.room)),
  );
  const out: ClassOut[] = [];
  for (const klass of classes) {
    const v = klass.values;
    const coachId = text(v.coach);
    const roomId = text(v.room);
    const coach = coachId ? coaches.get(coachId) : undefined;
    const room = roomId ? rooms.get(roomId) : undefined;
    out.push({
      id: klass.id,
      title: text(v.title) ?? text(klass.title),
      classType: text(v.classType),
      startsAt: text(v.startsAt),
      endsAt: text(v.endsAt),
      timeZone: text(v.timezone),
      room: roomId ? { id: roomId, name: text(room?.name) } : null,
      coach: coachId ? { id: coachId, name: text(coach?.name), photo: text(coach?.photo) } : null,
      notes: text(v.notes),
      places: await placesOf(ctx, klass.id),
    });
  }
  return out;
}

// --- Why the host refused -------------------------------------------------------------------------

const refusalReason = z
  .enum([
    "not_open",
    "closed",
    "staff_only",
    "no_use",
    "already_booked",
    "full",
    "too_late",
    "not_found",
    "changed",
    "not_running",
    "person_exists",
    "possible_duplicates",
    "waitlist_closed",
    "no_drop_in",
    "ask_desk",
    "try_later",
  ])
  .describe(
    "no_drop_in: the class cannot be paid for online (no drop-in price). ask_desk: the address " +
      "given cannot be used. try_later: too many places are held for payment just now. " +
      "waitlist_closed: the class is full and it is too close to the start to wait for a place " +
      "(nobody is moved in from the waitlist then). " +
      "not_open: booking has not opened yet (see opensAt). closed: booking has closed. " +
      "not_running: the class was cancelled or is over. person_exists: someone on file has that " +
      "email (see people). possible_duplicates: people on file may be this person (see people; " +
      "book one of them, or ask again with confirmNew). " +
      "staff_only: this class is booked by the gym. no_use: nothing the " +
      "member holds can pay for it (see detail). already_booked: they already have a place. " +
      "full: no places left. too_late: the class has started, so it cannot be cancelled. " +
      "not_found: no such class or booking of theirs. changed: it changed meanwhile; try again.",
  );

const refused = z.object({
  result: z.literal("refused"),
  reason: refusalReason,
  message: z.string(),
  detail: z
    .string()
    .nullable()
    .describe("The host's reason for an allowance refusal (no_uses_left, ended, not_covered…)"),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  people: z
    .array(z.object({ id: z.string(), name: z.string(), reasons: z.array(z.string()) }))
    .optional()
    .describe("For person_exists and possible_duplicates: who is already on file"),
});
type Refused = z.infer<typeof refused>;

/** What a host refusal says of itself (its rule, reason…); nothing for any other error. */
function detailsOf(error: unknown): Record<string, unknown> {
  if (!(error instanceof OpsCallError)) return {};
  const { details } = error;
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

/** A refusal answered with no booking times (a refusal the host gave times for is refusalOf's). */
const refuse = <R extends string>(reason: R, message: string) => ({
  result: "refused" as const,
  reason,
  message,
  detail: null,
  opensAt: null,
  closesAt: null,
});

/** A host refusal as a member can be told it, or the error itself when it is not one. */
function refusalOf(
  error: unknown,
  what: "book" | "cancel",
  expect?: "cancelled" | "late_cancelled",
): Refused {
  if (!(error instanceof OpsCallError)) throw error;
  const details = detailsOf(error);
  const rule = typeof details.rule === "string" ? details.rule : "";
  // Something must be agreed to first, or what is due changed while booking (stage 44, ADR
  // 0644): the host's own refusal goes back as it is, with its documents, so the block shows
  // what is due inline (the agreements entry in @composable-os/client reads it) and, for a
  // change, asks again and tries once more. Never dressed up as "changed".
  if (rule === "agreements_due" || rule === "agreements_changed") throw error;
  const times = {
    opensAt: text(details.opensAt),
    closesAt: text(details.closesAt),
  };
  const out = (reason: Refused["reason"], message: string, detail: string | null = null) => ({
    result: "refused" as const,
    reason,
    message,
    detail,
    ...times,
  });
  if (error.code === "not_found") {
    // A Person they may not book for (not a child linked to them, or a link that has ended) is
    // answered as one that does not exist (ADR 0540).
    if (details.object === "person") {
      return out("not_found", "You cannot book for that person.");
    }
    return out("not_found", what === "book" ? "That class cannot be booked." : "No such booking.");
  }
  if (rule === "state_window_not_open") {
    // A cancel asked for as late, before the late point: it is in time, say so (not "opens").
    if (what === "cancel" && expect === "late_cancelled") {
      return out(
        "changed",
        "It is not late yet: cancelling now is in time and gives the class back. Look again.",
      );
    }
    return out("not_open", "Booking for this class has not opened yet.");
  }
  if (rule === "state_closed") {
    return out("not_running", "This class was cancelled or is over: it cannot be booked.");
  }
  if (rule === "person_exists" || rule === "possible_duplicates") {
    const people = Array.isArray(details.people)
      ? (details.people as { id?: unknown; title?: unknown; reasons?: unknown }[]).map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.title ?? ""),
          reasons: Array.isArray(p.reasons) ? p.reasons.map(String) : [],
        }))
      : [];
    return {
      ...out(
        rule,
        rule === "person_exists"
          ? "Someone on file already has that email address: book them instead."
          : "This may be someone already on file: book them, or confirm this is someone new.",
      ),
      people,
    };
  }
  if (rule === "state_window_closed" || rule === "state_window_unknown") {
    return what === "book"
      ? out("closed", "Booking for this class has closed.")
      : out("too_late", "The class has started: it can no longer be cancelled.");
  }
  if (rule === "state_request_refused") {
    return out("too_late", "This booking can no longer be cancelled.");
  }
  if (rule === "state_staff_only") {
    return out("staff_only", "This class is booked by the gym. Ask at the desk.");
  }
  if (rule === "allowance") {
    const reason = text(details.reason);
    return out(
      "no_use",
      reason === "no_uses_left"
        ? "There are no classes left on your membership or pass for that week or period."
        : "Nothing you hold can pay for this class.",
      reason,
    );
  }
  if (rule === "waitlist") {
    return details.reason === "closed"
      ? out(
          "waitlist_closed",
          "This class is full, and it is too close to the start to join its waitlist.",
        )
      : out("changed", "A place came free meanwhile. Try booking again.");
  }
  if (rule === "unique") {
    return out("already_booked", "You already have a place in this class, or are waiting for one.");
  }
  if (rule === "capacity") return out("full", "This class is full.");
  // A cancel that found the booking already in a final state: another write moved it first (a
  // race). Any other undeclared move is a fault and is not dressed up as one.
  if (what === "cancel" && rule === "state_final") {
    return out("changed", "It changed meanwhile: it is no longer booked. Look again.");
  }
  if (error.code === "conflict") {
    return out("changed", "It changed while you were booking. Look again and try once more.");
  }
  throw error;
}

// --- The timetable (members and the public) --------------------------------------------------------

const DAY = 86_400_000;

export const timetable = defineTool({
  description:
    "The gym's timetable: its scheduled classes between two times (default: the next 7 days), " +
    "soonest first, each with its name, class type, start and end in its own time zone, coach, " +
    "room, notes for members and how many places are left. Filter by class type or coach. Only " +
    "what the public may read: never who is booked. Booking rules (when booking opens, whether " +
    "the gym books it) are the host's: book answers with them. Read-only.",
  input: z.object({
    from: z.string().datetime().optional().describe("From this time (ISO 8601). Default: now"),
    to: z.string().datetime().optional().describe("Until this time. Default: 7 days after from"),
    classType: z.string().min(1).max(64).optional(),
    coach: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ classes: z.array(classOutput) }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    const from = input.from ?? new Date().toISOString();
    const to = input.to ?? new Date(Date.parse(from) + 7 * DAY).toISOString();
    const conditions = [
      { field: "startsAt", op: "gte", value: from },
      { field: "startsAt", op: "lt", value: to },
      ...(input.classType ? [{ field: "classType", op: "eq", value: input.classType }] : []),
      ...(input.coach ? [{ field: "coach", op: "eq", value: input.coach }] : []),
    ];
    // The seam decides which classes: the public reads a class only while it is scheduled.
    const page = await ctx.ops.call<ListShape>("public.list", {
      object: CLASS,
      filter: { and: conditions },
      sort: { field: "startsAt", direction: "asc" },
      limit: input.limit,
    });
    return { classes: await describeClasses(ctx, page.items) };
  },
});

export const classGet = defineTool({
  description:
    "One scheduled class of the timetable: its name, class type, start and end in its own time " +
    "zone, coach, room, notes for members and how many places are left. Not found once it is " +
    "not scheduled. Never who is booked. Read-only.",
  input: z.object({ classId: z.string().min(1).max(64) }),
  output: z.object({ class: classOutput }),
  risk: "read",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    const klass = await ctx.ops.call<RecordShape>("public.get", {
      object: CLASS,
      id: input.classId,
    });
    const [described] = await describeClasses(ctx, [klass]);
    return { class: described as ClassOut };
  },
});

// --- Booking and cancelling (a signed-in member) ----------------------------------------------------

interface FamilyShape {
  self: { personId: string; name: string };
  dependants: { personId: string; name: string }[];
}

/** The member and the children staff linked to them, as the host says (ADR 0540). */
const familyOf = (ctx: Ctx) => ctx.ops.call<FamilyShape>("me.family", {});

const forPerson = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    "A child of theirs to book for instead (a dependant the gym linked to them; see family). " +
      "The child's own membership or pass pays, never the parent's.",
  );

export const family = defineTool({
  description:
    "Who the signed-in member may book for: themselves, and the children (dependants) the gym " +
    "has linked to them, each with their name and id. Pass a child's id as book's forPersonId " +
    "and mine's personId. Only the gym's staff link a parent to a child. Read-only.",
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({ personId: z.string(), name: z.string(), self: z.boolean() })),
  }),
  risk: "read",
  audiences: ["customer"],
  async handler(_input, ctx) {
    const found = await familyOf(ctx);
    return {
      people: [
        { ...found.self, self: true },
        ...found.dependants.map((d) => ({ ...d, self: false })),
      ],
    };
  },
});

const booked = z.object({
  result: z.literal("booked"),
  bookingId: z.string(),
  classId: z.string(),
  holderId: z
    .string()
    .nullable()
    .describe("The membership or pass a use was spent from; null when paid at the desk"),
});

const waiting = z.object({
  result: z.literal("waiting"),
  bookingId: z.string(),
  classId: z.string(),
  position: z.number().nullable().describe("Their place in the queue: 1 is next"),
  waiting: z.number().nullable().describe("How many are waiting, them included"),
  message: z.string(),
});

/** Where a waiting booking stands, as the host says (their own only, for a member). */
async function positionOf(ctx: Ctx, bookingId: string) {
  const at = await ctx.ops.call<{ position: number | null; waiting: number | null }>(
    "waitlist.position",
    { object: BOOKING, id: bookingId },
  );
  return { position: at.position, waiting: at.waiting };
}

/**
 * Makes a booking through `operation` (my.create for a member, record.create for staff): booked
 * if a place is free, else, when asked, on the class's waitlist. Both are the host's to allow:
 * the places, and joining only while the class is full and before its cut-off. Joining spends
 * nothing, so someone whose booking was refused for want of a use may still wait on a full class
 * (decision 7: they are passed over at promotion if they still cannot pay). A place that came
 * free between the two is booked (once).
 */
async function bookOrWait(
  ctx: Ctx,
  operation: "my.create" | "record.create",
  values: Record<string, unknown>,
  wait: boolean,
  forPersonId?: string,
): Promise<{ made: RecordShape; waiting: boolean }> {
  // For a member's dependant (ADR 0540): the host checks the link in the write.
  const whose = operation === "my.create" && forPersonId ? { forPersonId } : {};
  for (let attempt = 0; ; attempt++) {
    let refusal: unknown;
    try {
      const made = await ctx.ops.call<RecordShape>(operation, {
        object: BOOKING,
        values,
        ...whose,
      });
      return { made, waiting: false };
    } catch (error) {
      const rule = detailsOf(error).rule;
      if (!wait || (rule !== "capacity" && rule !== "allowance")) throw error;
      refusal = error;
    }
    try {
      const made = await ctx.ops.call<RecordShape>(operation, {
        object: BOOKING,
        values: { ...values, state: "waiting" },
        ...whose,
      });
      return { made, waiting: true };
    } catch (error) {
      const join = detailsOf(error);
      const first = detailsOf(refusal).rule;
      // Full a moment ago, and a place came free: book it (once).
      if (join.reason === "not_full" && first === "capacity" && attempt === 0) {
        continue;
      }
      // Nothing to pay with, and no waitlist to join (it is not full, or has closed): that is the
      // answer. Any other refusal of the join (already booked or waiting…) is the true reason.
      if (first === "allowance" && join.rule === "waitlist") throw refusal;
      throw error;
    }
  }
}

/**
 * A member already waiting on the class asked to book it: when a place is free (after the
 * cut-off, after the queue was passed over, or more places), they take it themselves, spending
 * then; a place held for the queue is the host's to give (ADR 0520). Null when they are not
 * waiting on it; otherwise booked, or still waiting with where they stand.
 */
async function takeFreePlace(
  ctx: Ctx,
  classId: string,
  personId: string,
): Promise<z.infer<typeof booked> | z.infer<typeof waiting> | null> {
  const mine = await ctx.ops.call<ListShape>("my.list", {
    object: BOOKING,
    filter: {
      and: [
        { field: "class", op: "eq", value: classId },
        { field: "person", op: "eq", value: personId },
        { field: "state", op: "eq", value: "waiting" },
      ],
    },
    limit: 1,
  });
  const queued = mine.items[0];
  if (!queued) return null;
  try {
    const after = await ctx.ops.call<RecordShape>("my.update", {
      object: BOOKING,
      id: queued.id,
      from: "waiting",
      values: { state: "booked" },
    });
    return {
      result: "booked",
      bookingId: queued.id,
      classId,
      holderId: text(after.values.holder),
    };
  } catch (error) {
    if (detailsOf(error).rule !== "capacity") throw error;
    const at = await positionOf(ctx, queued.id);
    return {
      result: "waiting",
      bookingId: queued.id,
      classId,
      ...at,
      message: `You are already on this class's waitlist${at.position === null ? "" : `, number ${at.position}`}: no place is free for you yet.`,
    };
  }
}

const waitingMessage = (position: number | null) =>
  position === null
    ? "The class is full: you are on its waitlist."
    : `The class is full: you are number ${position} on its waitlist. If a place frees in time, you are moved in and it is paid from your membership or pass then.`;

/** What bookOrWait made, as book and bookFor answer it: booked, or waiting with where they stand. */
async function answerOf(
  ctx: Ctx,
  classId: string,
  { made, waiting: queued }: { made: RecordShape; waiting: boolean },
): Promise<z.infer<typeof booked> | z.infer<typeof waiting>> {
  if (!queued) {
    return {
      result: "booked",
      bookingId: made.id,
      classId,
      holderId: text(made.values.holder),
    };
  }
  const at = await positionOf(ctx, made.id);
  return {
    result: "waiting",
    bookingId: made.id,
    classId,
    ...at,
    message: waitingMessage(at.position),
  };
}

export const book = defineTool({
  description:
    "Book the signed-in member into a class with what they already hold (a membership or a " +
    "pass): the host spends one use of the one whose use would lapse first, or of `holderId` " +
    "when they name one. No money moves. When the class is full they join its waitlist " +
    "(unless `waitlist` is false): that spends nothing, and if a place frees before the class " +
    "type's cut-off the host moves the first waiter in and spends their use then. Asked again " +
    "by a member already waiting, it books them if a place is free to them (never one held for " +
    "the queue), else says where they stand. Answers " +
    "booked, waiting (with their position), or refused with the reason the host gave: booking " +
    "not open yet (with when it opens), closed, booked by the gym only, nothing to pay with, " +
    "already booked or waiting, full, or too close to the start to wait. A parent books a " +
    "child the gym linked to them with forPersonId (see family): the same rules, and the " +
    "child's own membership or pass pays.",
  input: z.object({
    classId: z.string().min(1).max(64),
    forPersonId: forPerson,
    holderId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A membership or pass of theirs to spend, when they hold several"),
    waitlist: z
      .boolean()
      .default(true)
      .describe("When the class is full, join its waitlist (default) rather than be refused"),
  }),
  output: z.union([booked, waiting, refused]),
  risk: "write",
  audiences: ["customer"],
  async handler(input, ctx) {
    try {
      // The host sets whose it is (the caller), checks the class is one they may see, and holds
      // the windows, the staff-only rule, the place, the one-per-class rule, the spend and when
      // a waitlist may be joined.
      const made = await bookOrWait(
        ctx,
        "my.create",
        {
          class: input.classId,
          ...(input.holderId ? { holder: input.holderId } : {}),
        },
        input.waitlist,
        input.forPersonId,
      );
      return await answerOf(ctx, input.classId, made);
    } catch (error) {
      if (detailsOf(error).rule === "unique") {
        // Already waiting on it: take a free place if there is one (finding 5, ADR 0520).
        try {
          const whose = input.forPersonId ?? (await familyOf(ctx)).self.personId;
          const taken = await takeFreePlace(ctx, input.classId, whose);
          if (taken) return taken;
        } catch (inner) {
          return refusalOf(inner, "book");
        }
      }
      return refusalOf(error, "book");
    }
  },
});

// --- A drop-in: one class paid for on the website (decision 8, ADR 0560) --------------------------

export const buy = defineTool({
  description:
    "Pay for one class (a drop-in), on the website: for a visitor, or a member with nothing to " +
    "spend on it. The host makes the booking held while it is paid for (a place kept), prices it " +
    "from the class's drop-in price, and starts its order; nothing is paid here. The buyer then " +
    "calls order.checkout with the order's id (and a guest's token) to pay on the provider's " +
    "page: the verified payment books them; an order left unpaid expires after a few minutes and " +
    "the place goes back. The same rules as booking hold (when booking opens and closes, booked " +
    "by the gym only, one booking per person per class); a full class is refused (only members " +
    "with a membership or pass wait for a place). A signed-in member buys as themselves, or for a " +
    "child the gym linked to them (forPersonId; they pay, it is the child's booking); a guest " +
    "gives their email address. Cancelled in time, or by the gym, the money goes back to the " +
    "card once a member of staff approves the refund; cancelled late, it is kept. Amounts in the " +
    "currency's minor unit.",
  input: z.object({
    classId: z.string().min(1).max(64),
    forPersonId: forPerson,
    email: z.string().trim().max(320).optional().describe("A guest's email address"),
    agreements: z
      .array(z.record(z.string(), z.unknown()))
      .max(20)
      .optional()
      .describe(
        "A guest only: their acceptances of what is due, passed on to the host as they are (each " +
          "{ versionId, typedName, signature?, answers? }); the host checks and records them. A " +
          "signed-in member agrees first.",
      ),
  }),
  output: z.union([
    z.object({
      result: z.literal("pending"),
      bookingId: z.string(),
      classId: z.string(),
      orderId: z.string(),
      total: z.number(),
      currency: z.string(),
      expiresAt: z.string().nullable().describe("When the held place goes back if unpaid"),
      token: z.string().nullable().describe("A guest's key to this order, shown once"),
    }),
    refused,
  ]),
  risk: "write",
  audiences: ["customer", "public"],
  async handler(input, ctx) {
    try {
      // The host makes the booking, held, as the caller's own (or their child's), prices it, and
      // holds every rule: the class's windows and staff-only rule, its places, one per person.
      const order = await ctx.ops.call<{
        id: string;
        total: number;
        currency: string;
        expiresAt: string | null;
        recordId: string;
        token: string | null;
      }>("order.startHeld", {
        object: BOOKING,
        values: { class: input.classId },
        ...(input.forPersonId ? { forPersonId: input.forPersonId } : {}),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.agreements === undefined ? {} : { agreements: input.agreements }),
      });
      return {
        result: "pending" as const,
        bookingId: order.recordId,
        classId: input.classId,
        orderId: order.id,
        total: order.total,
        currency: order.currency,
        expiresAt: order.expiresAt,
        token: order.token ?? null,
      };
    } catch (error) {
      if (error instanceof OpsCallError) {
        const details = detailsOf(error);
        if (details.rule === "no_price" || details.rule === "not_for_sale") {
          return refuse("no_drop_in", "This class cannot be paid for online. Ask at the desk.");
        }
        if (details.rule === "try_later" || error.code === "rate_limited") {
          return refuse(
            "try_later",
            "Too many places are being held for payment just now: try again shortly.",
          );
        }
        if (details.rule === "buyer_unclear") {
          return refuse(
            "ask_desk",
            "We could not tell who you are from that address. Ask at the desk.",
          );
        }
        if (details.field === "email") return refuse("ask_desk", error.message);
      }
      return refusalOf(error, "book");
    }
  },
});

export const leaveWaitlist = defineTool({
  description:
    "Take the signed-in member off a class's waitlist (one of their bookings that is waiting). " +
    "Nothing was spent, so nothing is given back. Refused when it is no longer waiting (they " +
    "were moved in meanwhile: cancel that booking instead).",
  input: z.object({ bookingId: z.string().min(1).max(64) }),
  output: z.union([z.object({ result: z.literal("left"), bookingId: z.string() }), refused]),
  risk: "write",
  audiences: ["customer"],
  async handler(input, ctx) {
    try {
      // From waiting, or not at all (ADR 0437): a promotion and a leave at once, one wins.
      await ctx.ops.call<RecordShape>("my.update", {
        object: BOOKING,
        id: input.bookingId,
        from: "waiting",
        values: { state: "left" },
      });
      return { result: "left" as const, bookingId: input.bookingId };
    } catch (error) {
      if (error instanceof OpsCallError && error.code === "conflict") {
        return refuse(
          "changed",
          "This booking is no longer waiting: look at it again (you may have been moved in).",
        );
      }
      return refusalOf(error, "cancel");
    }
  },
});

export const cancel = defineTool({
  description:
    "Cancel one of the signed-in member's bookings. First without `confirm`: the host says " +
    "whether a cancel now is in time (`cancelled`, the class's use given back) or late " +
    "(`late_cancelled`, the use kept), by its clock. Then with `confirm: true` and `expect` set " +
    "to that answer: cancelled as said, or refused if it has become late meanwhile, so a member " +
    "never loses a use they were told they would keep. After the class starts it cannot be " +
    "cancelled.",
  input: z.object({
    bookingId: z.string().min(1).max(64),
    confirm: z.boolean().default(false),
    expect: z
      .enum(["cancelled", "late_cancelled"])
      .optional()
      .describe("What the preview said; with confirm, cancel only into this state"),
  }),
  output: z.union([
    z.object({
      result: z.enum(["preview", "cancelled", "late_cancelled"]),
      state: z.enum(["cancelled", "late_cancelled"]),
      late: z.boolean().describe("A late cancel keeps the use the booking spent"),
      dropIn: z
        .boolean()
        .describe("Paid for on its own: in time, the money goes back once staff approve it"),
      message: z.string(),
    }),
    refused,
  ]),
  risk: "write",
  audiences: ["customer"],
  async handler(input, ctx) {
    // A drop-in (ADR 0560) gets its money back, not a use: read which this booking is.
    let dropIn = false;
    const say = (state: "cancelled" | "late_cancelled", done: boolean) => ({
      result: done ? state : ("preview" as const),
      state,
      late: state === "late_cancelled",
      dropIn,
      message: dropIn
        ? state === "cancelled"
          ? done
            ? "Cancelled. Your payment is refunded to your card once the gym approves it."
            : "Cancelling now is in time: your payment is refunded to your card once the gym approves it."
          : done
            ? "Cancelled late. The payment is kept."
            : "Cancelling now is late: the payment is kept."
        : state === "cancelled"
          ? done
            ? "Cancelled. The class is back on your membership or pass."
            : "Cancelling now is in time: the class goes back on your membership or pass."
          : done
            ? "Cancelled late. The class stays used."
            : "Cancelling now is late: the class stays used.",
    });
    try {
      const own = await ctx.ops.call<RecordShape>("my.get", {
        object: BOOKING,
        id: input.bookingId,
      });
      dropIn = text(own.values.dropInOrder) !== null;
      if (!input.confirm) {
        // The host's dry run: the state "cancel" would enter now (ADR 0503).
        const resolved = await ctx.ops.call<{ state: string }>("state.resolve", {
          object: BOOKING,
          id: input.bookingId,
          request: "cancel",
        });
        return say(resolved.state === "late_cancelled" ? "late_cancelled" : "cancelled", false);
      }
      // From booked, or not at all (ADR 0437); into the state they were told, or the host's pick.
      const after = await ctx.ops.call<RecordShape>("my.update", {
        object: BOOKING,
        id: input.bookingId,
        from: "booked",
        values: { state: input.expect ?? "cancel" },
      });
      return say(after.values.state === "late_cancelled" ? "late_cancelled" : "cancelled", true);
    } catch (error) {
      const refusal = refusalOf(error, "cancel", input.expect);
      // Asked for "in time" and it is now late: say so, so they can confirm the late cancel.
      if (refusal.reason === "too_late" && input.expect === "cancelled") {
        return {
          ...refusal,
          reason: "changed" as const,
          message: "It is now too late to cancel in time. Cancelling now keeps the class used.",
        };
      }
      return refusal;
    }
  },
});

export const mine = defineTool({
  description:
    "The signed-in member's own bookings, soonest class first: each with its state (booked, " +
    "waiting, cancelled, cancelled late…), for one waiting its place on the waitlist, the " +
    "membership or pass it spent from, and its class (name, start and end in its own time " +
    "zone, coach, room, whether it still runs). With personId, a child's the gym linked to " +
    "them instead (see family). Only their own and their children's bookings exist here. " +
    "Read-only.",
  input: z.object({
    personId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A child of theirs (see family); left out, their own"),
    state: z
      .enum(["booked", "pending", "waiting", "cancelled", "late_cancelled", "left"])
      .optional(),
    upcoming: z.boolean().default(true).describe("Only classes that have not started"),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    bookings: z.array(
      z.object({
        id: z.string(),
        personId: z.string().nullable().describe("Whose booking it is: theirs, or their child's"),
        state: z.string().nullable(),
        position: z
          .number()
          .nullable()
          .describe("While waiting: their place on the waitlist (1 is next); otherwise null"),
        holderId: z.string().nullable(),
        dropInOrderId: z
          .string()
          .nullable()
          .describe("A drop-in's order (pending: pay it with order.checkout); null otherwise"),
        classId: z.string().nullable(),
        title: z.string().nullable(),
        startsAt: z.string().nullable(),
        endsAt: z.string().nullable(),
        timeZone,
        classState: z.string().nullable().describe("scheduled, cancelled or done"),
        coach: z.string().nullable(),
        room: z.string().nullable(),
      }),
    ),
  }),
  risk: "read",
  audiences: ["customer"],
  async handler(input, ctx) {
    // The seam gives a member their own bookings and their children's only; the filter picks
    // whose of those (a Person they may not read gives nothing, as one that does not exist).
    const whose = input.personId ?? (await familyOf(ctx)).self.personId;
    const page = await ctx.ops.call<ListShape>("my.list", {
      object: BOOKING,
      filter: {
        and: [
          { field: "person", op: "eq", value: whose },
          ...(input.state ? [{ field: "state", op: "eq", value: input.state }] : []),
        ],
      },
      limit: input.limit,
    });
    // Their bookings' classes, whatever the class's state (customerVia), and only those.
    const classes = await byIds(
      ctx,
      "my.list",
      CLASS,
      page.items.map((b) => text(b.values.class)),
    );
    const waitingIds = page.items.filter((b) => b.values.state === "waiting").map((b) => b.id);
    const [coaches, rooms, waitingAt] = await Promise.all([
      byIds(
        ctx,
        "public.list",
        COACH,
        [...classes.values()].map((c) => text(c.coach)),
      ),
      byIds(
        ctx,
        "public.list",
        ROOM,
        [...classes.values()].map((c) => text(c.room)),
      ),
      Promise.all(waitingIds.map((id) => positionOf(ctx, id))),
    ]);
    const now = Date.now();
    const positions = new Map(waitingIds.map((id, i) => [id, waitingAt[i]?.position ?? null]));
    const bookings = page.items
      .map((booking) => {
        const classId = text(booking.values.class);
        const klass = (classId && classes.get(classId)) || {};
        const coachId = text(klass.coach);
        const roomId = text(klass.room);
        return {
          id: booking.id,
          personId: text(booking.values.person),
          state: text(booking.values.state),
          position: positions.get(booking.id) ?? null,
          holderId: text(booking.values.holder),
          dropInOrderId: text(booking.values.dropInOrder),
          classId,
          title: text(klass.title),
          startsAt: text(klass.startsAt),
          endsAt: text(klass.endsAt),
          timeZone: text(klass.timezone),
          classState: text(klass.state),
          coach: coachId ? text(coaches.get(coachId)?.name) : null,
          room: roomId ? text(rooms.get(roomId)?.name) : null,
        };
      })
      .filter((b) => !input.upcoming || (b.startsAt !== null && Date.parse(b.startsAt) > now))
      .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
    return { bookings };
  },
});

// --- Staff ----------------------------------------------------------------------------------------

export const findPeople = defineTool({
  description:
    "Staff look a person up before booking them: People on file whose name or email contains " +
    "the text, at most 10, with their email. Use it at the desk before adding a walk-in, so a " +
    "member is booked as themselves. Read-only.",
  input: z.object({ query: z.string().trim().min(2).max(100) }),
  output: z.object({
    people: z.array(
      z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    ),
  }),
  risk: "read",
  // The front desk (ADR 0600): any staff member holds it as any tool; a coach is granted it.
  permission: "bookings:desk",
  async handler(input, ctx) {
    const found = new Map<string, { id: string; name: string | null; email: string | null }>();
    for (const filter of [
      { field: "displayName", op: "contains", value: input.query },
      { field: "emails", op: "contains", value: input.query.toLowerCase() },
    ]) {
      const page = await ctx.ops.call<{
        items: { id: string; displayName?: string | null; primaryEmail?: string | null }[];
      }>("person.list", { filter, limit: 10 });
      for (const p of page.items) {
        if (found.size >= 10) break;
        found.set(p.id, { id: p.id, name: p.displayName ?? null, email: p.primaryEmail ?? null });
      }
    }
    return { people: [...found.values()] };
  },
});

export const bookFor = defineTool({
  description:
    "Staff book a person into a class: someone on file (`personId`; look them up with " +
    "findPeople first), or a walk-in not on file yet (`newPerson`). A walk-in and their booking " +
    "are made in one batch, so a refused booking leaves nobody behind; the platform's duplicate " +
    "check runs first, and a match is answered (person_exists or possible_duplicates, with who) " +
    "rather than made twice: book them, or pass confirmNew when you checked it is someone else. " +
    "Staff are not bound by the booking windows or by 'booked by staff only'; a class that was " +
    "cancelled or is over, the places, one booking per person per class and the use it spends " +
    "still hold. With `paidAtDesk` it spends no use (they paid at the desk). With `waitlist`, " +
    "a person on file is put on a full class's waitlist instead of being refused (it spends " +
    "nothing until the host moves them in). Audited.",
  input: z.object({
    classId: z.string().min(1).max(64),
    personId: z.string().min(1).max(64).optional(),
    newPerson: z
      .object({
        givenName: z.string().trim().min(1).max(100),
        familyName: z.string().trim().max(100).optional(),
        email: z.string().trim().email().max(320).optional(),
      })
      .optional()
      .describe("A walk-in who is not on file yet"),
    confirmNew: z
      .boolean()
      .default(false)
      .describe("The possible duplicates were checked: this is someone new"),
    holderId: z.string().min(1).max(64).optional(),
    paidAtDesk: z.boolean().default(false),
    waitlist: z
      .boolean()
      .default(false)
      .describe("A person on file, a full class: put them on its waitlist instead"),
    note: z.string().max(2000).optional(),
  }),
  output: z.union([
    booked.extend({ personId: z.string() }),
    waiting.extend({ personId: z.string() }),
    refused,
  ]),
  risk: "write",
  // The front desk (ADR 0600): any staff member holds it as any tool; a coach is granted it.
  permission: "bookings:desk",
  async handler(input, ctx) {
    if (!input.personId && !input.newPerson) {
      throw new OpsCallError("invalid_input", "Give personId, or newPerson for a walk-in");
    }
    // Paid at the desk is for a place they take now: nobody pays at the desk for a place they
    // may never get, and a promotion later would then spend nothing (ADR 0520).
    if (input.paidAtDesk && input.waitlist) {
      throw new OpsCallError(
        "invalid_input",
        "paidAtDesk is for a free place taken now; put them on the waitlist without it",
      );
    }
    const staff = ctx.caller?.kind === "staff" ? ctx.caller : null;
    const values = {
      class: input.classId,
      ...(input.holderId ? { holder: input.holderId } : {}),
      ...(input.paidAtDesk ? { paidOtherwise: true } : {}),
      ...(staff?.userId ? { bookedBy: staff.userId } : {}),
      ...(input.note ? { note: input.note } : {}),
    };
    try {
      if (input.personId) {
        const made = await bookOrWait(
          ctx,
          "record.create",
          { ...values, person: input.personId },
          input.waitlist,
        );
        return { ...(await answerOf(ctx, input.classId, made)), personId: input.personId };
      }
      const walkIn = input.newPerson as NonNullable<typeof input.newPerson>;
      // The person and the booking in one batch, after the duplicate check (ADR 0507).
      const made = await ctx.ops.call<{ personId: string; id: string }>("person.createWith", {
        person: {
          givenName: walkIn.givenName,
          ...(walkIn.familyName ? { familyName: walkIn.familyName } : {}),
          ...(walkIn.email ? { emails: [{ email: walkIn.email }] } : {}),
        },
        object: BOOKING,
        field: "person",
        values,
        allowDuplicates: input.confirmNew,
      });
      const booking = await ctx.ops.call<RecordShape>("record.get", {
        object: BOOKING,
        id: made.id,
      });
      return {
        result: "booked" as const,
        bookingId: made.id,
        classId: input.classId,
        personId: made.personId,
        holderId: text(booking.values.holder),
      };
    } catch (error) {
      return refusalOf(error, "book");
    }
  },
});

const cancelled = z.object({
  result: z.enum(["cancelled", "late_cancelled"]),
  bookingId: z.string(),
  late: z.boolean().describe("A late cancel keeps the use the booking spent"),
});

export const cancelFor = defineTool({
  description:
    "Staff cancel a booking, decided by the host's clock as a member's own cancel is: in time " +
    "(`cancelled`, the use given back) until the class type's late-cancel time, late " +
    "(`late_cancelled`, the use kept) after it, not at all once the class has started. With " +
    "`keepUse` it is cancelled late whatever the time. To give a use back after the late point, a " +
    "person uses returnUse. The place is given back either way. Only a booked booking can be " +
    "cancelled; one that has moved on is reported as changed.",
  input: z.object({
    bookingId: z.string().min(1).max(64),
    keepUse: z.boolean().default(false),
    note: z.string().max(2000).optional(),
  }),
  output: z.union([cancelled, refused]),
  risk: "write",
  // The front desk (ADR 0600): any staff member holds it as any tool; a coach is granted it.
  permission: "bookings:desk",
  async handler(input, ctx) {
    try {
      // `cancel` is resolved by the host: this tool's calls are never a person's (ADR 0507).
      const after = await ctx.ops.call<RecordShape>("record.update", {
        object: BOOKING,
        id: input.bookingId,
        from: "booked",
        values: {
          state: input.keepUse ? "late_cancelled" : "cancel",
          ...(input.note ? { note: input.note } : {}),
        },
      });
      const state: "cancelled" | "late_cancelled" =
        after.values.state === "late_cancelled" ? "late_cancelled" : "cancelled";
      return { result: state, bookingId: input.bookingId, late: state === "late_cancelled" };
    } catch (error) {
      return refusalOf(error, "cancel");
    }
  },
});

export const returnUse = defineTool({
  description:
    "A person on the staff cancels a booking and gives its use back whatever the time: after " +
    "the late-cancel point, or after the class (a member who was ill, a class the coach missed). " +
    "A person's own act: the assistant, MCP clients, automations and other code cannot call it. " +
    "The reason is kept on the booking and in the audit log. Only a booked booking.",
  input: z.object({
    bookingId: z.string().min(1).max(64),
    reason: z.string().trim().min(3).max(2000),
  }),
  output: z.union([
    z.object({ result: z.literal("excused"), bookingId: z.string(), late: z.literal(false) }),
    refused,
  ]),
  risk: "destructive",
  // Only a person calls it, with the pack's permission (ADR 0513); the move it makes is open to
  // no other staff write. The desk's (ADR 0600; it was `bookings:returns`, which nothing held).
  humanOnly: true,
  permission: "bookings:desk",
  async handler(input, ctx) {
    try {
      await ctx.ops.call("record.update", {
        object: BOOKING,
        id: input.bookingId,
        from: "booked",
        values: { state: "excused", note: `Use given back: ${input.reason}` },
      });
      return { result: "excused" as const, bookingId: input.bookingId, late: false as const };
    } catch (error) {
      return refusalOf(error, "cancel");
    }
  },
});

/** The instant a local date's midnight is in `zone` (display only: which classes a day lists). */
export function localMidnight(date: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return asUtc - instant;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

const staffClass = z.object({
  id: z.string(),
  title: z.string().nullable(),
  classType: named,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  timeZone,
  coach: z.string().nullable(),
  room: z.string().nullable(),
  places: z.number().nullable(),
  booked: z.number().describe("Places taken"),
  held: z.number(),
  available: z.number().nullable(),
  state: z.string().nullable(),
  staffOnly: z.boolean().describe("Its class type is booked by staff only"),
});

async function staffClasses(ctx: Ctx, classes: RecordShape[]) {
  const of = (object: string, field: string) =>
    byIds(
      ctx,
      "record.list",
      object,
      classes.map((c) => text(c.values[field])),
    );
  const types = await of(CLASS_TYPE, "classType");
  const coaches = await of(COACH, "coach");
  const rooms = await of(ROOM, "room");
  const name = (found: Map<string, Record<string, unknown>>, id: unknown) =>
    text(found.get(text(id) ?? "")?.name);
  return classes.map((klass) => {
    const v = klass.values;
    const typeId = text(v.classType);
    const type = typeId ? types.get(typeId) : undefined;
    return {
      id: klass.id,
      title: text(v.title) ?? text(klass.title),
      classType: typeId ? { id: typeId, name: text(type?.name) } : null,
      startsAt: text(v.startsAt),
      endsAt: text(v.endsAt),
      timeZone: text(v.timezone),
      coach: name(coaches, v.coach),
      room: name(rooms, v.room),
      places: num(v.places),
      booked: num(v.taken) ?? 0,
      held: num(v.held) ?? 0,
      available: num(v.available),
      state: text(v.state),
      // Bookings' own field on Programs' class type (registry name `bookings.staffOnly`).
      staffOnly: flag(type?.["bookings.staffOnly"] ?? type?.staffOnly),
    };
  });
}

export const day = defineTool({
  description:
    "Staff's day view: every class on one local date (scheduled, cancelled or done), in start " +
    "order, with its class type, coach, room, places, how many are booked and held, and whether " +
    "its class type is booked by staff only. For the front desk and coaches. Read-only.",
  input: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("The local date, YYYY-MM-DD"),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .default("UTC")
      .describe("The zone the date is in (the gym's, e.g. Australia/Sydney)"),
  }),
  output: z.object({ date: z.string(), classes: z.array(staffClass) }),
  risk: "read",
  // The coach role holds it (ADR 0436), today's only; the desk any day, so a coach granted the
  // desk reaches it through the grant (ADR 0600); staff hold it as any read tool.
  permission: ["bookings:coach", "bookings:desk"],
  // On purpose: a coach granted the desk sees any day's classes here (ADR 0600).
  grantLiftsRoleLimits: true,
  async handler(input, ctx) {
    const from = localMidnight(input.date, input.timeZone);
    const next = new Date(Date.parse(`${input.date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    const to = localMidnight(next, input.timeZone);
    const page = await ctx.ops.call<ListShape>("record.list", {
      object: CLASS,
      filter: {
        and: [
          { field: "startsAt", op: "gte", value: new Date(from).toISOString() },
          { field: "startsAt", op: "lt", value: new Date(to).toISOString() },
        ],
      },
      sort: { field: "startsAt", direction: "asc" },
      limit: 200,
    });
    return { date: input.date, classes: await staffClasses(ctx, page.items) };
  },
});

const healthNote = z
  .boolean()
  .nullable()
  .describe(
    "A yes on their current health form: a mark only (staff who may read health answers open " +
      "it from the Person page). Null when not shown.",
  );

export const classList = defineTool({
  description:
    "A class's list for staff and coaches: the class (as on the day view) and every booking of " +
    "it with the person's name, its state (booked, waiting, cancelled, cancelled late…), " +
    "whether they paid at the desk, the membership or pass it spent from, who booked it, and " +
    "for the waitlist when they were moved in or why they were passed over. Waiters are in " +
    "the order they joined. Read-only.",
  input: z.object({ classId: z.string().min(1).max(64) }),
  output: z.object({
    class: staffClass,
    bookings: z.array(
      z.object({
        id: z.string(),
        person: named,
        state: z.string().nullable(),
        paidAtDesk: z.boolean(),
        holderId: z.string().nullable(),
        bookedBy: z.string().nullable(),
        promotedAt: z.string().nullable().describe("When they were moved in from the waitlist"),
        healthNote,
        passedOver: z
          .string()
          .nullable()
          .describe("While waiting: why a free place could not be theirs (what they hold)"),
      }),
    ),
  }),
  risk: "read",
  // The front desk (ADR 0600): any staff member holds it as any tool; a coach is granted it.
  permission: "bookings:desk",
  async handler(input, ctx) {
    const { klass, bookings, names } = await listOf(ctx, input.classId);
    const notes = await healthNotesOf(ctx, klass.id, names);
    return {
      class: klass,
      bookings: bookings.map((booking) => {
        const personId = text(booking.values.person);
        return {
          id: booking.id,
          person: personId ? { id: personId, name: names.get(personId) ?? null } : null,
          state: text(booking.values.state),
          healthNote: notes && personId ? notes.has(personId) : null,
          paidAtDesk: flag(booking.values.paidOtherwise),
          holderId: text(booking.values.holder),
          bookedBy: text(booking.values.bookedBy),
          promotedAt: text(booking.values.promotedAt),
          passedOver: text(booking.values.passedOverReason),
        };
      }),
    };
  },
});

// --- Attendance, the coach's list (step 7) --------------------------------------------------------

/** Who is marking a list: the staff member who called the tool (never from the input). */
function marker(ctx: Ctx) {
  const staff = ctx.caller?.kind === "staff" ? ctx.caller : null;
  return { markedBy: staff?.userId ?? null, markedByName: staff?.name || null };
}

const marked = z.object({
  result: z.enum(["attended", "no_show", "booked"]),
  bookingId: z.string(),
  message: z.string(),
});

const alreadyMarked = z.object({
  result: z.literal("already"),
  bookingId: z.string(),
  state: z.string().nullable().describe("What the booking is now"),
  markedAt: z.string().nullable(),
  markedBy: z.string().nullable().describe("The name of who marked it first"),
  message: z.string(),
});

const listRefused = z.object({
  result: z.literal("refused"),
  reason: z
    .enum(["not_found", "not_started", "not_booked", "changed"])
    .describe(
      "not_started: the list opens an hour before the class (see opensAt). not_booked: the " +
        "booking is not one that can be marked (cancelled, waiting, moved…; see state). changed: " +
        "it changed meanwhile; look again.",
    ),
  state: z.string().nullable(),
  opensAt: z.string().nullable(),
  message: z.string(),
});

const STATE_WORDS: Record<string, string> = {
  booked: "booked",
  attended: "ticked as come",
  no_show: "marked as not come",
  waiting: "on the waitlist",
  cancelled: "cancelled",
  late_cancelled: "cancelled late",
  excused: "cancelled with the class given back",
  cancelled_by_us: "cancelled with the class",
  moved: "moved to another class",
  left: "off the waitlist",
  pending: "held while paying",
  expired: "expired",
};
const words = (state: string | null) => STATE_WORDS[state ?? ""] ?? state ?? "unknown";

type MarkOut = z.infer<typeof marked> | z.infer<typeof alreadyMarked> | z.infer<typeof listRefused>;

/**
 * Marks one booking as `to` from where it is (one of `from`), from that position or not at all
 * (ADR 0437): of two coaches marking one name at once, one is made and the other is told who was
 * first. The host holds when a list may be marked (from an hour before the class) and which moves
 * a booking may make.
 */
async function markBooking(
  ctx: Ctx,
  bookingId: string,
  to: "attended" | "no_show" | "booked",
  from: readonly string[],
): Promise<MarkOut> {
  const no = (
    reason: z.infer<typeof listRefused>["reason"],
    message: string,
    state: string | null = null,
    opensAt: string | null = null,
  ) => ({ result: "refused" as const, reason, state, opensAt, message });
  let record: RecordShape;
  try {
    record = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id: bookingId });
  } catch (error) {
    if (error instanceof OpsCallError && error.code === "not_found") {
      return no("not_found", "No such booking.");
    }
    throw error;
  }
  const already = (now: RecordShape) => {
    const state = text(now.values.state);
    const by = text(now.values.markedByName);
    return {
      result: "already" as const,
      bookingId,
      state,
      markedAt: text(now.values.markedAt),
      markedBy: by,
      message: `Already ${words(state)}${by ? ` by ${by}` : ""}.`,
    };
  };
  const state = text(record.values.state) ?? "";
  if (state === to) return already(record);
  if (!from.includes(state)) {
    return no("not_booked", `This booking is ${words(state)}: it cannot be marked.`, state);
  }
  const values =
    to === "booked"
      ? { state: to, markedAt: null, markedBy: null, markedByName: null }
      : { state: to, markedAt: new Date().toISOString(), ...marker(ctx) };
  try {
    await ctx.ops.call("record.update", { object: BOOKING, id: bookingId, from: state, values });
  } catch (error) {
    if (!(error instanceof OpsCallError)) throw error;
    const details = detailsOf(error);
    if (details.rule === "state_window_not_open") {
      return no(
        "not_started",
        to === "no_show"
          ? "A no-show is marked once the class has started."
          : "The class's list opens an hour before it starts.",
        state,
        text(details.opensAt),
      );
    }
    if (error.code === "conflict") {
      // Someone marked it first (or it moved): say who, from what it is now.
      const now = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id: bookingId });
      if (text(now.values.state) === to) return already(now);
      const is = text(now.values.state);
      return no("changed", `It changed meanwhile: it is now ${words(is)}.`, is);
    }
    if (details.rule === "state_move_not_declared" || details.rule === "state_final") {
      return no("not_booked", "This booking cannot be marked.", state);
    }
    throw error;
  }
  return {
    result: to,
    bookingId,
    message:
      to === "attended"
        ? "Ticked: they came."
        : to === "no_show"
          ? "Marked: they did not come. The class stays used."
          : "Unticked: booked again.",
  };
}

const markOutput = z.union([marked, alreadyMarked, listRefused]);

export const markAttended = defineTool({
  description:
    "Tick a booking on a class's list: they came. From an hour before the class, and any time " +
    "after it (a late correction: a no-show ticked becomes attended). Of two coaches ticking one " +
    "name at once, one tick is made and the other is told who was first. A booking that is " +
    "cancelled, waiting or moved cannot be ticked. The use it spent stays spent.",
  input: z.object({ bookingId: z.string().min(1).max(64) }),
  output: markOutput,
  risk: "write",
  permission: "bookings:coach",
  handler: (input, ctx) => markBooking(ctx, input.bookingId, "attended", ["booked", "no_show"]),
});

export const undoAttended = defineTool({
  description:
    "Untick a booking ticked by mistake: it is booked again (and, once the class is 30 minutes " +
    "over with others ticked, the host makes it a no-show). Who ticked it and when are cleared.",
  input: z.object({ bookingId: z.string().min(1).max(64) }),
  output: markOutput,
  risk: "write",
  permission: "bookings:coach",
  handler: (input, ctx) => markBooking(ctx, input.bookingId, "booked", ["attended"]),
});

export const markNoShow = defineTool({
  description:
    "Mark a booked booking as not come (a no-show), once the class has started. The class stays " +
    "used (no money, nothing else follows). The host does this itself for everyone still booked " +
    "30 minutes after the class ends, if anyone on the list was marked.",
  input: z.object({ bookingId: z.string().min(1).max(64) }),
  output: markOutput,
  risk: "write",
  permission: "bookings:coach",
  handler: (input, ctx) => markBooking(ctx, input.bookingId, "no_show", ["booked"]),
});

export const markAll = defineTool({
  description:
    "Tick everyone still booked on a class's list at once (from an hour before the class). Each " +
    "name is ticked from where it is or not at all, so a name another coach ticked meanwhile is " +
    "counted as already ticked, not twice.",
  input: z.object({ classId: z.string().min(1).max(64) }),
  output: z.union([
    z.object({
      result: z.literal("marked"),
      classId: z.string(),
      ticked: z.number().describe("Names ticked now"),
      already: z.number().describe("Names someone else ticked meanwhile"),
      skipped: z.number().describe("Names that changed meanwhile (cancelled, moved…)"),
    }),
    listRefused,
  ]),
  risk: "write",
  permission: "bookings:coach",
  async handler(input, ctx) {
    const page = await ctx.ops.call<ListShape>("record.list", {
      object: BOOKING,
      filter: {
        and: [
          { field: "class", op: "eq", value: input.classId },
          { field: "state", op: "eq", value: "booked" },
        ],
      },
      sort: { field: "createdAt", direction: "asc" },
      limit: 200,
    });
    let ticked = 0;
    let already = 0;
    let skipped = 0;
    for (const booking of page.items) {
      const out = await markBooking(ctx, booking.id, "attended", ["booked"]);
      if (out.result === "attended") ticked += 1;
      else if (out.result === "already") already += 1;
      else if (out.result === "refused" && out.reason === "not_started") return out;
      else skipped += 1;
    }
    return { result: "marked" as const, classId: input.classId, ticked, already, skipped };
  },
});

/** A class as staff see it, its bookings in the order they were made, and their people's names. */
async function listOf(ctx: Ctx, classId: string) {
  const record = await ctx.ops.call<RecordShape>("record.get", { object: CLASS, id: classId });
  const [klass] = await staffClasses(ctx, [record]);
  const page = await ctx.ops.call<ListShape>("record.list", {
    object: BOOKING,
    filter: { field: "class", op: "eq", value: record.id },
    sort: { field: "createdAt", direction: "asc" },
    limit: 200,
  });
  const names = new Map<string, string | null>();
  for (const id of new Set(page.items.map((b) => text(b.values.person)).filter(Boolean))) {
    try {
      const person = await ctx.ops.call<{ displayName?: string | null } | null>("person.get", {
        id,
      });
      names.set(id as string, person?.displayName ?? null);
    } catch (error) {
      if (!(error instanceof OpsCallError) || error.code !== "not_found") throw error;
      names.set(id as string, null);
    }
  }
  return { klass: klass as z.infer<typeof staffClass>, bookings: page.items, names };
}

/**
 * Who on a class's list answered yes on their current health form (stage 44, decision 18): a
 * mark, no content. The host reads the People from the class's bookings itself (never ids from
 * here). Null when the host gives none: a list the assistant reads, or an approved AI's call.
 */
async function healthNotesOf(ctx: Ctx, classId: string, names: Map<string, string | null>) {
  if (!names.size) return null;
  try {
    const { notes } = await ctx.ops.call<{ notes: { personId: string; healthNote: boolean }[] }>(
      "agreement.listHealthNotes",
      { records: BOOKING, value: classId },
    );
    return new Set(notes.filter((n) => n.healthNote).map((n) => n.personId));
  } catch (error) {
    if (error instanceof OpsCallError && error.code === "forbidden") return null;
    throw error;
  }
}

export const roster = defineTool({
  description:
    "A class's list for its coach: the class (as on the day view) and every booking of it with " +
    "the person's name and its state (booked, ticked, not come, waiting in the order they " +
    "joined, cancelled…), who marked it and when. Nothing about what anyone paid with. Read-only.",
  input: z.object({ classId: z.string().min(1).max(64) }),
  output: z.object({
    class: staffClass,
    bookings: z.array(
      z.object({
        id: z.string(),
        person: named,
        state: z.string().nullable(),
        markedAt: z.string().nullable(),
        markedBy: z.string().nullable().describe("The name of who marked it"),
        promotedAt: z.string().nullable().describe("When they were moved in from the waitlist"),
        healthNote,
      }),
    ),
  }),
  risk: "read",
  permission: "bookings:coach",
  async handler(input, ctx) {
    const { klass, bookings, names } = await listOf(ctx, input.classId);
    const notes = await healthNotesOf(ctx, klass.id, names);
    return {
      class: klass,
      bookings: bookings.map((booking) => {
        const personId = text(booking.values.person);
        return {
          id: booking.id,
          person: personId ? { id: personId, name: names.get(personId) ?? null } : null,
          state: text(booking.values.state),
          markedAt: text(booking.values.markedAt),
          markedBy: text(booking.values.markedByName),
          promotedAt: text(booking.values.promotedAt),
          healthNote: notes && personId ? notes.has(personId) : null,
        };
      }),
    };
  },
});

// --- Moving people and cancelling a class (step 7) ------------------------------------------------

const moveRefusal = z
  .enum(["not_booked", "same_class", "started"])
  .describe(
    "not_booked: only a booked booking moves. same_class: it is already on that class. started: " +
      "its class has started; giving its use back is returnUse's.",
  );

export const move = defineTool({
  description:
    "Staff move a member's booking to another class, with the use it spent, in one batch: the " +
    "old booking is moved (its place given back, to the waitlist first before its cut-off), a " +
    "new booking is made on the other class, and the use is spent again on it from the same " +
    "membership or pass. Refused whole, with nothing changed, when the other class is full " +
    "(places held for its waitlist included: raise its places first), was cancelled or is over, " +
    "they are already booked on it, or the use cannot be spent in that class's week or period. " +
    "Only a booked booking, before its class starts. A booking paid at the desk moves paid at " +
    "the desk. Audited.",
  input: z.object({
    bookingId: z.string().min(1).max(64),
    toClassId: z.string().min(1).max(64),
    note: z.string().max(2000).optional(),
  }),
  output: z.union([
    z.object({
      result: z.literal("moved"),
      fromBookingId: z.string(),
      bookingId: z.string().describe("The new booking"),
      classId: z.string(),
      holderId: z.string().nullable().describe("The membership or pass the use is spent from"),
    }),
    refused,
    refused.extend({ reason: moveRefusal }),
  ]),
  risk: "write",
  // The front desk (ADR 0600): any staff member holds it as any tool; a coach is granted it.
  permission: "bookings:desk",
  async handler(input, ctx) {
    const no = (reason: z.infer<typeof moveRefusal>, message: string) => refuse(reason, message);
    let old: RecordShape;
    try {
      old = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id: input.bookingId });
    } catch (error) {
      if (error instanceof OpsCallError && error.code === "not_found") {
        return refusalOf(error, "cancel");
      }
      throw error;
    }
    const state = text(old.values.state);
    if (state !== "booked") {
      return no("not_booked", `This booking is ${words(state)}: only a booked one moves.`);
    }
    if (text(old.values.class) === input.toClassId) {
      return no("same_class", "It is already booked on that class.");
    }
    const staff = ctx.caller?.kind === "staff" ? ctx.caller : null;
    try {
      // The host moves the old booking in this create's batch (the allowance's `movedFrom`): its
      // place given back, the use spent again here from the same holder; or nothing at all.
      const made = await ctx.ops.call<RecordShape>("record.create", {
        object: BOOKING,
        values: {
          class: input.toClassId,
          person: text(old.values.person),
          movedFrom: old.id,
          ...(staff?.userId ? { bookedBy: staff.userId } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });
      return {
        result: "moved" as const,
        fromBookingId: old.id,
        bookingId: made.id,
        classId: input.toClassId,
        holderId: text(made.values.holder),
      };
    } catch (error) {
      const { rule } = detailsOf(error);
      // The old booking moved to a final state meanwhile (the member cancelled it): a race.
      if (rule === "state_final") {
        return refuse("changed", "It changed meanwhile: it is no longer booked. Look again.");
      }
      // The old booking's own move has a window: until its class starts.
      if (rule === "state_window_closed") {
        return no(
          "started",
          "Its class has started: it can no longer be moved. A person can give its use back (returnUse).",
        );
      }
      return refusalOf(error, "book");
    }
  },
});

export const cancelClass = defineTool({
  description:
    "Cancel a scheduled class that has not ended, with a reason: in the same batch every booking " +
    "of it holding a place or a use (booked, waiting, held while paying, ticked as come, marked " +
    "not come, cancelled late) is cancelled by the gym, each place given back and each use " +
    "returned once. A person's act: the assistant, MCP clients and automations may ask, and it " +
    "waits for a person to approve it. When it cannot be done (no such class, not scheduled, " +
    "already ended, or it changed twice while being done) it fails with the reason, so an " +
    "approved request shows it did not apply. (Emails to the members, and refunds of paid " +
    "drop-ins, come in a later release.)",
  input: z.object({
    classId: z.string().min(1).max(64),
    reason: z.string().trim().min(3).max(2000),
  }),
  output: z.object({
    result: z.literal("cancelled"),
    classId: z.string(),
    bookingsCancelled: z.number().describe("Bookings cancelled with the class"),
  }),
  risk: "destructive",
  // Anyone but a person waits for a person's approval (ADR 0552); the class's move into
  // cancelled is made by this tool and the host only.
  personApproves: true,
  permission: "bookings:cancelClasses",
  async handler(input, ctx) {
    // A refusal is an error, never an answer: an approved request that cannot apply must show
    // that it did not (ADR 0553).
    const fail = (code: string, reason: string, message: string): never => {
      throw new OpsCallError(code, message, { reason });
    };
    // A race (a booking landing under the cancel, another write moving the class) is tried once
    // more from a fresh read; anything else is the answer.
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.ops.call("record.update", {
          object: CLASS,
          id: input.classId,
          from: "scheduled",
          values: { state: "cancelled", cancelledReason: input.reason },
        });
        break;
      } catch (error) {
        if (!(error instanceof OpsCallError)) throw error;
        if (error.code === "not_found") fail("not_found", "not_found", "No such class.");
        const details = detailsOf(error);
        if (details.reason === "not_in_position") {
          fail(
            "conflict",
            "not_scheduled",
            "This class is not scheduled (it was cancelled or is over).",
          );
        }
        if (details.rule === "state_window_closed") {
          fail(
            "invalid_input",
            "ended",
            "This class has ended: a class that happened is not cancelled. A person can give a booking's use back (returnUse).",
          );
        }
        if (details.rule === "state_window_unknown") {
          fail(
            "invalid_input",
            "no_end",
            "This class has no end time, so whether it has ended cannot be told: give it one first.",
          );
        }
        if (error.code === "conflict" && attempt === 0) continue;
        if (error.code === "conflict") {
          fail(
            "conflict",
            "changed",
            "The class or its bookings changed while it was being cancelled. Look again.",
          );
        }
        throw error;
      }
    }
    const page = await ctx.ops.call<ListShape>("record.list", {
      object: BOOKING,
      filter: {
        and: [
          { field: "class", op: "eq", value: input.classId },
          { field: "state", op: "eq", value: "cancelled_by_us" },
        ],
      },
      limit: 200,
    });
    return {
      result: "cancelled" as const,
      classId: input.classId,
      bookingsCancelled: page.items.length,
    };
  },
});

// --- Appointments, booked by staff (stage 49 step 5, ADR 0764) -------------------------------------
//
// One-to-one sessions. Every rule is the host's (index.ts): one coach never on two things at once
// (classes, duties, appointments) with the service's buffer, a private room taken once, a coach
// with an account, the session a pass or membership pays for and when it is given back, when a
// cancel is late, who may give a session back or cancel for the business. These tools ask, and say
// what the host answered.

const APPOINTMENT = "bookings.appointment";
const SERVICE = "bookings.service";
const MINUTE = 60_000;

const appointmentRefusal = z
  .enum([
    "not_found",
    "double_booked",
    "room_taken",
    "no_account",
    "no_coach_free",
    "no_use",
    "not_offered",
    "not_booked",
    "too_late",
    "started",
    "not_started",
    "same_time",
    "changed",
  ])
  .describe(
    "double_booked: the coach is on something else then (a class, a duty or another session, " +
      "buffers included; see message). room_taken: no room the service may use is free then. " +
      "no_account: the coach has no staff account, so cannot be booked. no_coach_free: nobody " +
      "qualified is free at that time (any coach). no_use: nothing the client holds pays for this " +
      "service (see detail): book it paid at the desk. not_offered: the service is no longer " +
      "offered. not_booked: it is not booked (see state). too_late: it has started. started: it " +
      "has started, so it cannot be moved. not_started: it can be marked once it has started. " +
      "same_time: it is already at that time with that coach. changed: it changed meanwhile.",
  );

const appointmentRefused = z.object({
  result: z.literal("refused"),
  reason: appointmentRefusal,
  message: z.string(),
  detail: z
    .string()
    .nullable()
    .describe("The host's reason for an allowance refusal (no_uses_left, not_covered…)"),
  state: z.string().nullable().describe("What the appointment is now, when that is the reason"),
});
type AppointmentRefused = z.infer<typeof appointmentRefused>;

const noAppointment = (
  reason: AppointmentRefused["reason"],
  message: string,
  detail: string | null = null,
  state: string | null = null,
): AppointmentRefused => ({ result: "refused", reason, message, detail, state });

/** A host refusal of an appointment write, as staff can be told it; any other error is thrown. */
function appointmentRefusalOf(
  error: unknown,
  what: "book" | "cancel" | "mark",
): AppointmentRefused {
  if (!(error instanceof OpsCallError)) throw error;
  const details = detailsOf(error);
  const rule = typeof details.rule === "string" ? details.rule : "";
  // What must be agreed first goes back as it is (stage 44, ADR 0644), as for a class.
  if (rule === "agreements_due" || rule === "agreements_changed") throw error;
  if (error.code === "not_found")
    return noAppointment("not_found", "No such appointment, service or coach.");
  if (rule === "double_booked") return noAppointment("double_booked", error.message);
  if (rule === "room_taken") return noAppointment("room_taken", error.message);
  if (rule === "staffed_account") return noAppointment("no_account", error.message);
  if (rule === "state_closed") {
    return noAppointment("not_offered", "This service is no longer offered: it cannot be booked.");
  }
  if (rule === "allowance") {
    const reason = text(details.reason);
    return noAppointment(
      "no_use",
      reason === "no_uses_left"
        ? "There are no sessions left on their pass or membership for that period."
        : "Nothing they hold pays for this service. Book it paid at the desk instead.",
      reason,
    );
  }
  if (rule === "state_window_not_open" && what === "mark") {
    return noAppointment("not_started", "It can be marked once it has started.");
  }
  if (rule === "state_window_closed" || rule === "state_window_unknown") {
    return what === "mark"
      ? noAppointment(
          "too_late",
          "It is more than 7 days since it ended: it can no longer be changed.",
        )
      : noAppointment("too_late", "It has started: it can no longer be cancelled or moved.");
  }
  if (rule === "state_request_refused") {
    return noAppointment("too_late", "It can no longer be cancelled.");
  }
  if (rule === "state_final" || rule === "state_move_not_declared" || error.code === "conflict") {
    return noAppointment("changed", "It changed meanwhile. Look again.");
  }
  throw error;
}

const appointmentWarning = z.object({
  code: z.string().describe("unavailable, not_qualified, outside_hours, client_busy, uncovered"),
  message: z.string(),
});

/** The warnings the host made a staff write with (ADRs 0622, 0763): made anyway, and said so. */
function warningsIn(record: RecordShape & { warnings?: unknown }) {
  return Array.isArray(record.warnings)
    ? (record.warnings as { code?: unknown; message?: unknown }[]).map((w) => ({
        code: String(w.code ?? ""),
        message: String(w.message ?? ""),
      }))
    : [];
}

const appointmentBooked = z.object({
  result: z.literal("booked"),
  appointmentId: z.string(),
  coachId: z.string().nullable(),
  roomId: z.string().nullable().describe("The room it takes: the first of the service's free"),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  holderId: z
    .string()
    .nullable()
    .describe("The pass or membership a session was spent from; null when paid at the desk"),
  paidAtDesk: z.boolean(),
  warnings: z
    .array(appointmentWarning)
    .describe("Made anyway: the coach away, not qualified, outside their open hours, client busy"),
});

/** How an appointment's write is answered: its time, coach, room, how it was paid, warnings. */
function bookedAnswer(made: RecordShape & { warnings?: unknown }) {
  const v = made.values;
  return {
    result: "booked" as const,
    appointmentId: made.id,
    coachId: text(v.coach),
    roomId: text(v.room),
    startsAt: text(v.startsAt),
    endsAt: text(v.endsAt),
    holderId: text(v.holder),
    paidAtDesk: flag(v.paidOtherwise),
    warnings: warningsIn(made),
  };
}

/** A service, as staff may read it, with its length in minutes (or a refusal). */
async function serviceOf(ctx: Ctx, id: string) {
  const service = await ctx.ops.call<RecordShape>("record.get", { object: SERVICE, id });
  return { service, length: num(service.values.length) ?? 0 };
}

/**
 * "Any coach": the first qualified coach the host says is free for the service at exactly that
 * start (open hours, time off, their other shifts with buffers, a room), or null.
 */
async function firstFreeCoach(
  ctx: Ctx,
  serviceId: string,
  startsAt: number,
  personId: string,
): Promise<string | null> {
  const free = await ctx.ops.call<{ times: { startsAt: string; providers: string[] }[] }>(
    "staffing.free",
    {
      object: APPOINTMENT,
      kind: serviceId,
      from: new Date(startsAt).toISOString(),
      to: new Date(startsAt + MINUTE).toISOString(),
      client: personId,
    },
  );
  const at = free.times.find((t) => Date.parse(t.startsAt) === startsAt);
  return at?.providers[0] ?? null;
}

/** The staff member calling (never from the input). */
const staffCaller = (ctx: Ctx) => (ctx.caller?.kind === "staff" ? ctx.caller : null);

export const bookAppointment = defineTool({
  description:
    "Staff book a one-to-one session (an appointment) for a client: a service, a start time, " +
    "a coach (or none: the first qualified coach free then), and the client (personId; look " +
    "them up with findPeople). It ends after the service's length. The host refuses it when the " +
    "coach is on anything else then (a class, a duty or another session, the service's buffer " +
    "included), when no room the service needs is free, when the coach has no staff account, " +
    "or when nothing the client holds pays for the service; staff may book any time, outside " +
    "the booking windows and the coach's open hours, and are told what it was made with " +
    "(warnings: the coach away, not qualified, outside open hours, the client busy). It spends " +
    "one session of a pass or membership covering the service, unless paidAtDesk. The room is " +
    "the first of the service's rooms free then unless roomId names one. Audited.",
  input: z.object({
    serviceId: z.string().min(1).max(64),
    startsAt: z.string().datetime().describe("When it starts (ISO 8601)"),
    personId: z.string().min(1).max(64).describe("The client"),
    coachId: z.string().min(1).max(64).optional().describe("Left out: any coach free then"),
    roomId: z.string().min(1).max(64).optional(),
    holderId: z.string().min(1).max(64).optional().describe("A pass or membership to spend"),
    paidAtDesk: z.boolean().default(false).describe("Paid at the desk: it spends no session"),
    note: z.string().max(2000).optional().describe("A staff note, never shown to the client"),
  }),
  output: z.union([appointmentBooked, appointmentRefused]),
  risk: "write",
  // The desk books them (ADR 0600), as a manager of the coaches does (ADR 0764).
  permission: ["bookings:desk", "bookings:appointments"],
  async handler(input, ctx) {
    try {
      const { length } = await serviceOf(ctx, input.serviceId);
      const starts = Date.parse(input.startsAt);
      const coach =
        input.coachId ?? (await firstFreeCoach(ctx, input.serviceId, starts, input.personId));
      if (!coach) {
        return noAppointment(
          "no_coach_free",
          "No qualified coach is free for this service at that time. Pick a coach to book them anyway.",
        );
      }
      const staff = staffCaller(ctx);
      const made = await ctx.ops.call<RecordShape>("record.create", {
        object: APPOINTMENT,
        values: {
          service: input.serviceId,
          person: input.personId,
          coach,
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(starts + length * MINUTE).toISOString(),
          ...(input.roomId ? { room: input.roomId } : {}),
          ...(input.holderId ? { holder: input.holderId } : {}),
          ...(input.paidAtDesk ? { paidOtherwise: true } : {}),
          ...(staff?.userId ? { bookedBy: staff.userId } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      });
      return bookedAnswer(made);
    } catch (error) {
      return appointmentRefusalOf(error, "book");
    }
  },
});

/** An appointment as staff read it, or a refusal when there is none. */
async function appointmentOf(ctx: Ctx, id: string): Promise<RecordShape | AppointmentRefused> {
  try {
    return await ctx.ops.call<RecordShape>("record.get", { object: APPOINTMENT, id });
  } catch (error) {
    if (error instanceof OpsCallError && error.code === "not_found") {
      return noAppointment("not_found", "No such appointment.");
    }
    throw error;
  }
}
const isRefusal = (v: RecordShape | AppointmentRefused): v is AppointmentRefused =>
  (v as AppointmentRefused).result === "refused";

const APPOINTMENT_WORDS: Record<string, string> = {
  booked: "booked",
  pending: "held while paying",
  unpaid: "not paid yet",
  cancelled: "cancelled",
  late_cancelled: "cancelled late",
  excused: "cancelled with the session given back",
  attended: "attended",
  no_show: "a no-show",
  cancelled_by_us: "cancelled by the business",
  moved: "moved",
  expired: "expired",
};
const appointmentWords = (state: string | null) =>
  APPOINTMENT_WORDS[state ?? ""] ?? state ?? "unknown";

export const moveAppointment = defineTool({
  description:
    "Staff move a booked appointment to another start time, or another coach, or both, in one " +
    "batch: a new appointment is made at the new time and the old one is moved, the session it " +
    "spent moving with it (a session paid at the desk stays paid). The host refuses it whole, " +
    "nothing changed, when the coach is on anything else then, no room is free, or it has " +
    "started. Same warnings as booking. Only a booked appointment, before it starts.",
  input: z.object({
    appointmentId: z.string().min(1).max(64),
    startsAt: z.string().datetime().describe("The new start (ISO 8601)"),
    coachId: z.string().min(1).max(64).optional().describe("Left out: the same coach"),
    note: z.string().max(2000).optional(),
  }),
  output: z.union([
    appointmentBooked.extend({ fromAppointmentId: z.string() }),
    appointmentRefused,
  ]),
  risk: "write",
  permission: ["bookings:desk", "bookings:appointments"],
  async handler(input, ctx) {
    const old = await appointmentOf(ctx, input.appointmentId);
    if (isRefusal(old)) return old;
    const state = text(old.values.state);
    if (state !== "booked") {
      return noAppointment(
        "not_booked",
        `This appointment is ${appointmentWords(state)}: only a booked one moves.`,
        null,
        state,
      );
    }
    const serviceId = text(old.values.service) as string;
    const coach = input.coachId ?? text(old.values.coach);
    const starts = Date.parse(input.startsAt);
    if (
      starts === Date.parse(text(old.values.startsAt) ?? "") &&
      coach === text(old.values.coach)
    ) {
      return noAppointment("same_time", "It is already at that time with that coach.");
    }
    const staff = staffCaller(ctx);
    try {
      const { length } = await serviceOf(ctx, serviceId);
      const values = {
        service: serviceId,
        person: text(old.values.person),
        coach,
        startsAt: new Date(starts).toISOString(),
        endsAt: new Date(starts + length * MINUTE).toISOString(),
        movedFrom: old.id,
        ...(staff?.userId ? { bookedBy: staff.userId } : {}),
        ...(input.note ? { note: input.note } : {}),
      };
      const room = text(old.values.room);
      let made: RecordShape;
      try {
        // Its own room first (the old claim goes in the same batch); if that is taken then, the
        // host gives it the first of the service's rooms that is free.
        made = await ctx.ops.call<RecordShape>("record.create", {
          object: APPOINTMENT,
          values: { ...values, ...(room ? { room } : {}) },
        });
      } catch (error) {
        if (!room || detailsOf(error).rule !== "room_taken") throw error;
        made = await ctx.ops.call<RecordShape>("record.create", { object: APPOINTMENT, values });
      }
      return { ...bookedAnswer(made), fromAppointmentId: old.id };
    } catch (error) {
      const refusal = appointmentRefusalOf(error, "book");
      if (refusal.reason === "too_late") {
        return noAppointment("started", "It has started: it can no longer be moved.");
      }
      return refusal;
    }
  },
});

export const cancelAppointment = defineTool({
  description:
    "Staff cancel a booked appointment, in time or late by the host's clock: before the " +
    "service's late-cancel point (24 hours before unless the service sets its own) it is " +
    "cancelled and its session given back; from then until it starts it is cancelled late and " +
    "the session is used, with no fee. With keepUse it is cancelled late whatever the time. " +
    "After it starts it cannot be cancelled. To give a session back after the late point a " +
    "person excuses it (excuseAppointment); the business cancelling its own appointment is " +
    "cancelAppointmentByUs. Without confirm it only says which it would be.",
  input: z.object({
    appointmentId: z.string().min(1).max(64),
    confirm: z.boolean().default(false),
    keepUse: z.boolean().default(false),
    note: z.string().max(2000).optional(),
  }),
  output: z.union([
    z.object({
      result: z.enum(["preview", "cancelled", "late_cancelled"]),
      appointmentId: z.string(),
      state: z.enum(["cancelled", "late_cancelled"]),
      late: z.boolean().describe("A late cancel keeps the session it spent"),
    }),
    appointmentRefused,
  ]),
  risk: "write",
  permission: ["bookings:desk", "bookings:appointments"],
  async handler(input, ctx) {
    const say = (state: "cancelled" | "late_cancelled", done: boolean) => ({
      result: done ? state : ("preview" as const),
      appointmentId: input.appointmentId,
      state,
      late: state === "late_cancelled",
    });
    try {
      if (!input.confirm) {
        if (input.keepUse) return say("late_cancelled", false);
        // The host's dry run: the state "cancel" would enter now (ADR 0503).
        const resolved = await ctx.ops.call<{ state: string }>("state.resolve", {
          object: APPOINTMENT,
          id: input.appointmentId,
          request: "cancel",
        });
        return say(resolved.state === "late_cancelled" ? "late_cancelled" : "cancelled", false);
      }
      const after = await ctx.ops.call<RecordShape>("record.update", {
        object: APPOINTMENT,
        id: input.appointmentId,
        from: "booked",
        values: {
          state: input.keepUse ? "late_cancelled" : "cancel",
          ...(input.note ? { note: input.note } : {}),
        },
      });
      return say(after.values.state === "late_cancelled" ? "late_cancelled" : "cancelled", true);
    } catch (error) {
      return appointmentRefusalOf(error, "cancel");
    }
  },
});

export const cancelAppointmentByUs = defineTool({
  description:
    "The business cancels an appointment that is booked, held while paying or not paid yet " +
    "(the coach is ill, the room is closed): it is cancelled by the business and the session " +
    "it spent is given back, whatever the time, with the reason kept. A person's act: the " +
    "assistant, MCP clients and automations may ask, and it waits for a person to approve it. " +
    "Fails with the reason when it cannot be done, so an approved request shows it did not " +
    "apply. (The client's email comes in a later release.)",
  input: z.object({
    appointmentId: z.string().min(1).max(64),
    reason: z.string().trim().min(3).max(2000),
  }),
  output: z.object({ result: z.literal("cancelled_by_us"), appointmentId: z.string() }),
  risk: "destructive",
  personApproves: true,
  permission: "bookings:appointments",
  async handler(input, ctx) {
    const old = await appointmentOf(ctx, input.appointmentId);
    if (isRefusal(old)) throw new OpsCallError("not_found", old.message, { reason: "not_found" });
    const state = text(old.values.state) ?? "";
    if (!["booked", "pending", "unpaid"].includes(state)) {
      throw new OpsCallError(
        "conflict",
        `This appointment is ${appointmentWords(state)}: only one still to come is cancelled by the business.`,
        { reason: "not_live", state },
      );
    }
    await ctx.ops.call("record.update", {
      object: APPOINTMENT,
      id: input.appointmentId,
      from: state,
      values: { state: "cancelled_by_us", cancelledReason: input.reason },
    });
    return { result: "cancelled_by_us" as const, appointmentId: input.appointmentId };
  },
});

export const markAppointment = defineTool({
  description:
    "Mark an appointment once it has started: attended (they came) or no_show (they did not; " +
    "the session is used, with no fee). Either may be corrected into the other for 7 days " +
    "after it ends. The host marks one nobody marked as attended 30 minutes after it ends. " +
    "Who marked it and when are kept. To give a no-show's session back a person excuses it.",
  input: z.object({
    appointmentId: z.string().min(1).max(64),
    mark: z.enum(["attended", "no_show"]),
  }),
  output: z.union([
    z.object({
      result: z.enum(["attended", "no_show"]),
      appointmentId: z.string(),
      message: z.string(),
    }),
    appointmentRefused,
  ]),
  risk: "write",
  permission: ["bookings:desk", "bookings:appointments"],
  async handler(input, ctx) {
    const record = await appointmentOf(ctx, input.appointmentId);
    if (isRefusal(record)) return record;
    const state = text(record.values.state) ?? "";
    const from = input.mark === "attended" ? ["booked", "no_show"] : ["booked", "attended"];
    if (state === input.mark) {
      return {
        result: input.mark,
        appointmentId: record.id,
        message: `Already marked ${appointmentWords(state)}.`,
      };
    }
    if (!from.includes(state)) {
      return noAppointment(
        "not_booked",
        `This appointment is ${appointmentWords(state)}: it cannot be marked.`,
        null,
        state,
      );
    }
    const staff = staffCaller(ctx);
    try {
      await ctx.ops.call("record.update", {
        object: APPOINTMENT,
        id: record.id,
        from: state,
        values: {
          state: input.mark,
          markedAt: new Date().toISOString(),
          markedBy: staff?.userId ?? null,
          markedByName: staff?.name || null,
        },
      });
    } catch (error) {
      return appointmentRefusalOf(error, "mark");
    }
    return {
      result: input.mark,
      appointmentId: record.id,
      message:
        input.mark === "attended"
          ? "Marked: they came."
          : "Marked: they did not come. The session stays used, with no fee.",
    };
  },
});

export const excuseAppointment = defineTool({
  description:
    "A person on the staff gives the session back for a late cancel or a no-show (a client " +
    "who was ill): it becomes excused and the pass or membership gets its session back. A " +
    "person's own act: the assistant, MCP clients, automations and other code cannot call it. " +
    "The reason is kept on the appointment and in the audit log.",
  input: z.object({
    appointmentId: z.string().min(1).max(64),
    reason: z.string().trim().min(3).max(2000),
  }),
  output: z.union([
    z.object({ result: z.literal("excused"), appointmentId: z.string() }),
    appointmentRefused,
  ]),
  risk: "destructive",
  humanOnly: true,
  permission: ["bookings:desk", "bookings:appointments"],
  async handler(input, ctx) {
    const record = await appointmentOf(ctx, input.appointmentId);
    if (isRefusal(record)) return record;
    const state = text(record.values.state) ?? "";
    if (state !== "late_cancelled" && state !== "no_show") {
      return noAppointment(
        "not_booked",
        `This appointment is ${appointmentWords(state)}: only a late cancel or a no-show is excused.`,
        null,
        state,
      );
    }
    try {
      await ctx.ops.call("record.update", {
        object: APPOINTMENT,
        id: record.id,
        from: state,
        values: { state: "excused", cancelledReason: `Session given back: ${input.reason}` },
      });
      return { result: "excused" as const, appointmentId: record.id };
    } catch (error) {
      return appointmentRefusalOf(error, "cancel");
    }
  },
});

export const reassignAppointment = defineTool({
  description:
    "Give an appointment still to come to another coach (decision 7: the coach is off or " +
    "away), keeping its time, room and how it was paid. The host refuses it when that coach is " +
    "on anything else then (buffers included) or has no staff account, and says what it was " +
    "made with (warnings: not qualified for the service, away, outside their open hours). " +
    "(The client's email comes in a later release.)",
  input: z.object({
    appointmentId: z.string().min(1).max(64),
    coachId: z.string().min(1).max(64),
  }),
  output: z.union([appointmentBooked, appointmentRefused]),
  risk: "write",
  // Who works a session is a person's to change (ADR 0626): an AI's call waits for a person.
  personApproves: true,
  permission: "bookings:appointments",
  async handler(input, ctx) {
    const record = await appointmentOf(ctx, input.appointmentId);
    if (isRefusal(record)) return record;
    const state = text(record.values.state) ?? "";
    if (!["booked", "pending", "unpaid"].includes(state)) {
      return noAppointment(
        "not_booked",
        `This appointment is ${appointmentWords(state)}: only one still to come is reassigned.`,
        null,
        state,
      );
    }
    if (Date.parse(text(record.values.startsAt) ?? "") <= Date.now()) {
      return noAppointment("started", "It has started: it can no longer be reassigned.");
    }
    if (text(record.values.coach) === input.coachId) {
      return noAppointment("same_time", "It is already with that coach.");
    }
    try {
      const after = await ctx.ops.call<RecordShape>("record.update", {
        object: APPOINTMENT,
        id: record.id,
        values: { coach: input.coachId },
      });
      return bookedAnswer(after);
    } catch (error) {
      return appointmentRefusalOf(error, "book");
    }
  },
});

// --- The coach's day ------------------------------------------------------------------------------

const dayItem = z.object({
  kind: z.enum(["class", "appointment", "shift"]),
  object: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  room: z.string().nullable(),
  state: z.string().nullable(),
  service: z.string().nullable().describe("An appointment's service"),
  client: named.describe("An appointment's client"),
});

interface RosterShift {
  object: string;
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  place: string | null;
  account: string | null;
}

export const coachDay = defineTool({
  description:
    "The coaches' day for staff: for each coach (or one, with coachId), their classes, " +
    "appointments (service, client, room, state) and other shifts (duties) on one local date " +
    "of the organisation, in start order. Classes and appointments cancelled, moved or done " +
    "are left out but for attended and no-show sessions. Read-only.",
  input: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("The local date, YYYY-MM-DD"),
    coachId: z.string().min(1).max(64).optional(),
  }),
  output: z.object({
    date: z.string(),
    timeZone: z.string(),
    coaches: z.array(
      z.object({
        coachId: z.string(),
        name: z.string().nullable(),
        items: z.array(dayItem),
      }),
    ),
  }),
  risk: "read",
  permission: ["bookings:desk", "bookings:appointments"],
  async handler(input, ctx) {
    const coachFilter = input.coachId ? [{ field: "id", op: "eq", value: input.coachId }] : [];
    const coaches = await ctx.ops.call<ListShape>("record.list", {
      object: COACH,
      filter: input.coachId ? { and: coachFilter } : { field: "active", op: "eq", value: true },
      sort: { field: "name", direction: "asc" },
      limit: 100,
    });
    const account = input.coachId ? text(coaches.items[0]?.values.user) : null;
    // The roster (ADR 0626): every live shift of the day, whatever object, in the org's zone. A
    // coach's duties come from it; its appointments show their service, never the client.
    const roster = await ctx.ops.call<{ shifts: RosterShift[]; zone: string }>("staffing.week", {
      from: input.date,
      to: input.date,
      ...(account ? { account } : {}),
    });
    const zone = roster.zone;
    const next = new Date(Date.parse(`${input.date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    const range = [
      {
        field: "startsAt",
        op: "gte",
        value: new Date(localMidnight(input.date, zone)).toISOString(),
      },
      { field: "startsAt", op: "lt", value: new Date(localMidnight(next, zone)).toISOString() },
    ];
    const ids = coaches.items.map((c) => c.id);
    const byCoach = ids.length ? [{ field: "coach", op: "in", value: ids }] : [];
    const [classes, appointments] = ids.length
      ? await Promise.all(
          [CLASS, APPOINTMENT].map((object) =>
            ctx.ops.call<ListShape>("record.list", {
              object,
              filter: { and: [...range, ...byCoach] },
              sort: { field: "startsAt", direction: "asc" },
              limit: 200,
            }),
          ),
        )
      : [{ items: [] }, { items: [] }];
    const rooms = await byIds(
      ctx,
      "record.list",
      ROOM,
      [...(classes?.items ?? []), ...(appointments?.items ?? [])].map((r) => text(r.values.room)),
    );
    const services = await byIds(
      ctx,
      "record.list",
      SERVICE,
      (appointments?.items ?? []).map((a) => text(a.values.service)),
    );
    const names = new Map<string, string | null>();
    for (const id of new Set((appointments?.items ?? []).map((a) => text(a.values.person)))) {
      if (!id) continue;
      try {
        const person = await ctx.ops.call<{ displayName?: string | null } | null>("person.get", {
          id,
        });
        names.set(id, person?.displayName ?? null);
      } catch (error) {
        if (!(error instanceof OpsCallError) || error.code !== "not_found") throw error;
        names.set(id, null);
      }
    }
    const roomName = (id: unknown) => text(rooms.get(text(id) ?? "")?.name);
    const shown = (object: string, state: string | null) =>
      object === CLASS
        ? state !== "cancelled"
        : ["booked", "pending", "unpaid", "attended", "no_show"].includes(state ?? "");
    const items = new Map<string, z.infer<typeof dayItem>[]>(ids.map((id) => [id, []]));
    for (const [object, page] of [
      [CLASS, classes],
      [APPOINTMENT, appointments],
    ] as const) {
      for (const r of page?.items ?? []) {
        const v = r.values;
        const coachId = text(v.coach);
        const state = text(v.state);
        if (!coachId || !shown(object, state)) continue;
        const personId = text(v.person);
        items.get(coachId)?.push({
          kind: object === CLASS ? "class" : "appointment",
          object,
          id: r.id,
          title: text(v.title) ?? text(r.title),
          startsAt: text(v.startsAt),
          endsAt: text(v.endsAt),
          room: roomName(v.room),
          state,
          service: object === APPOINTMENT ? text(services.get(text(v.service) ?? "")?.title) : null,
          client:
            object === APPOINTMENT && personId
              ? { id: personId, name: names.get(personId) ?? null }
              : null,
        });
      }
    }
    // Other packs' shifts (a duty), by the coach profile's staff account.
    const byAccount = new Map(
      coaches.items
        .map((c) => [text(c.values.user), c.id] as const)
        .filter((pair): pair is readonly [string, string] => pair[0] !== null),
    );
    for (const s of roster.shifts) {
      if (s.object.startsWith("bookings.") || !s.account) continue;
      const coachId = byAccount.get(s.account);
      if (!coachId) continue;
      items.get(coachId)?.push({
        kind: "shift",
        object: s.object,
        id: s.id,
        title: s.title,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        room: s.place,
        state: null,
        service: null,
        client: null,
      });
    }
    return {
      date: input.date,
      timeZone: zone,
      coaches: coaches.items.map((c) => ({
        coachId: c.id,
        name: text(c.values.name),
        items: (items.get(c.id) ?? []).sort((a, b) =>
          (a.startsAt ?? "").localeCompare(b.startsAt ?? ""),
        ),
      })),
    };
  },
});
