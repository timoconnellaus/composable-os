// The Bookings tools (stage 31a steps 3 to 5). They become operations x.bookings.<tool>, run in the
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

/** Records of `object` by id, through a read operation the caller may use (public or my). */
async function byIds(
  ctx: Ctx,
  operation: "public.list" | "my.list",
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
  ])
  .describe(
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

/** A host refusal as a member can be told it, or the error itself when it is not one. */
function refusalOf(
  error: unknown,
  what: "book" | "cancel",
  expect?: "cancelled" | "late_cancelled",
): Refused {
  if (!(error instanceof OpsCallError)) throw error;
  const details = (error.details ?? {}) as Record<string, unknown>;
  const rule = typeof details.rule === "string" ? details.rule : "";
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
): Promise<{ made: RecordShape; waiting: boolean }> {
  const ruleOf = (error: unknown) =>
    error instanceof OpsCallError
      ? ((error.details ?? {}) as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  for (let attempt = 0; ; attempt++) {
    let refusal: unknown;
    try {
      const made = await ctx.ops.call<RecordShape>(operation, { object: BOOKING, values });
      return { made, waiting: false };
    } catch (error) {
      const rule = ruleOf(error).rule;
      if (!wait || (rule !== "capacity" && rule !== "allowance")) throw error;
      refusal = error;
    }
    try {
      const made = await ctx.ops.call<RecordShape>(operation, {
        object: BOOKING,
        values: { ...values, state: "waiting" },
      });
      return { made, waiting: true };
    } catch (error) {
      const join = ruleOf(error);
      // Full a moment ago, and a place came free: book it (once).
      if (join.reason === "not_full" && ruleOf(refusal).rule === "capacity" && attempt === 0) {
        continue;
      }
      // Nothing to pay with, and no waitlist to join (it is not full, or has closed): that is the
      // answer. Any other refusal of the join (already booked or waiting…) is the true reason.
      if (ruleOf(refusal).rule === "allowance" && join.rule === "waitlist") throw refusal;
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
): Promise<
  | { result: "booked"; bookingId: string; classId: string; holderId: string | null }
  | z.infer<typeof waiting>
  | null
> {
  const mine = await ctx.ops.call<ListShape>("my.list", {
    object: BOOKING,
    filter: {
      and: [
        { field: "class", op: "eq", value: classId },
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
    const rule = error instanceof OpsCallError ? (error.details as { rule?: unknown })?.rule : null;
    if (rule !== "capacity") throw error;
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
    "already booked or waiting, full, or too close to the start to wait.",
  input: z.object({
    classId: z.string().min(1).max(64),
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
      const { made, waiting: queued } = await bookOrWait(
        ctx,
        "my.create",
        {
          class: input.classId,
          ...(input.holderId ? { holder: input.holderId } : {}),
        },
        input.waitlist,
      );
      if (queued) {
        const at = await positionOf(ctx, made.id);
        return {
          result: "waiting" as const,
          bookingId: made.id,
          classId: input.classId,
          ...at,
          message: waitingMessage(at.position),
        };
      }
      return {
        result: "booked" as const,
        bookingId: made.id,
        classId: input.classId,
        holderId: text(made.values.holder),
      };
    } catch (error) {
      const unique =
        error instanceof OpsCallError &&
        (error.details as { rule?: unknown } | undefined)?.rule === "unique";
      if (unique) {
        // Already waiting on it: take a free place if there is one (finding 5, ADR 0520).
        try {
          const taken = await takeFreePlace(ctx, input.classId);
          if (taken) return taken;
        } catch (inner) {
          return refusalOf(inner, "book");
        }
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
        return {
          result: "refused" as const,
          reason: "changed" as const,
          message:
            "This booking is no longer waiting: look at it again (you may have been moved in).",
          detail: null,
          opensAt: null,
          closesAt: null,
        };
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
      message: z.string(),
    }),
    refused,
  ]),
  risk: "write",
  audiences: ["customer"],
  async handler(input, ctx) {
    const say = (state: "cancelled" | "late_cancelled", done: boolean) => ({
      result: done ? state : ("preview" as const),
      state,
      late: state === "late_cancelled",
      message:
        state === "cancelled"
          ? done
            ? "Cancelled. The class is back on your membership or pass."
            : "Cancelling now is in time: the class goes back on your membership or pass."
          : done
            ? "Cancelled late. The class stays used."
            : "Cancelling now is late: the class stays used.",
    });
    try {
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
    "zone, coach, room, whether it still runs). Only their own bookings exist here. Read-only.",
  input: z.object({
    state: z.enum(["booked", "waiting", "cancelled", "late_cancelled", "left"]).optional(),
    upcoming: z.boolean().default(true).describe("Only classes that have not started"),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    bookings: z.array(
      z.object({
        id: z.string(),
        state: z.string().nullable(),
        position: z
          .number()
          .nullable()
          .describe("While waiting: their place on the waitlist (1 is next); otherwise null"),
        holderId: z.string().nullable(),
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
    // The seam gives a member their own bookings only; no filter here decides whose they are.
    const page = await ctx.ops.call<ListShape>("my.list", {
      object: BOOKING,
      ...(input.state ? { filter: { field: "state", op: "eq", value: input.state } } : {}),
      limit: input.limit,
    });
    // Their bookings' classes, whatever the class's state (customerVia), and only those.
    const classes = await byIds(
      ctx,
      "my.list",
      CLASS,
      page.items.map((b) => text(b.values.class)),
    );
    const coaches = await byIds(
      ctx,
      "public.list",
      COACH,
      [...classes.values()].map((c) => text(c.coach)),
    );
    const rooms = await byIds(
      ctx,
      "public.list",
      ROOM,
      [...classes.values()].map((c) => text(c.room)),
    );
    const now = Date.now();
    const positions = new Map<string, number | null>();
    for (const booking of page.items) {
      if (booking.values.state === "waiting") {
        positions.set(booking.id, (await positionOf(ctx, booking.id)).position);
      }
    }
    const bookings = page.items
      .map((booking) => {
        const classId = text(booking.values.class);
        const klass = (classId && classes.get(classId)) || {};
        const coachId = text(klass.coach);
        const roomId = text(klass.room);
        return {
          id: booking.id,
          state: text(booking.values.state),
          position: positions.get(booking.id) ?? null,
          holderId: text(booking.values.holder),
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
        const { made, waiting: queued } = await bookOrWait(
          ctx,
          "record.create",
          { ...values, person: input.personId },
          input.waitlist,
        );
        if (queued) {
          const at = await positionOf(ctx, made.id);
          return {
            result: "waiting" as const,
            bookingId: made.id,
            classId: input.classId,
            personId: input.personId,
            ...at,
            message: waitingMessage(at.position),
          };
        }
        return {
          result: "booked" as const,
          bookingId: made.id,
          classId: input.classId,
          personId: input.personId,
          holderId: text(made.values.holder),
        };
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
  // no other staff write.
  humanOnly: true,
  permission: "bookings:returns",
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
  const types = new Map<string, Record<string, unknown>>();
  const typeIds = [...new Set(classes.map((c) => text(c.values.classType)).filter(Boolean))];
  if (typeIds.length) {
    const found = await ctx.ops.call<ListShape>("record.list", {
      object: CLASS_TYPE,
      filter: { field: "id", op: "in", value: typeIds },
      limit: typeIds.length,
    });
    for (const item of found.items) types.set(item.id, item.values);
  }
  const names = async (object: string, field: string) => {
    const ids = [...new Set(classes.map((c) => text(c.values[field])).filter(Boolean))];
    if (!ids.length) return new Map<string, string | null>();
    const found = await ctx.ops.call<ListShape>("record.list", {
      object,
      filter: { field: "id", op: "in", value: ids },
      limit: ids.length,
    });
    return new Map(found.items.map((item) => [item.id, text(item.values.name)]));
  };
  const coaches = await names(COACH, "coach");
  const rooms = await names(ROOM, "room");
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
      coach: coaches.get(text(v.coach) ?? "") ?? null,
      room: rooms.get(text(v.room) ?? "") ?? null,
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
        passedOver: z
          .string()
          .nullable()
          .describe("While waiting: why a free place could not be theirs (what they hold)"),
      }),
    ),
  }),
  risk: "read",
  async handler(input, ctx) {
    const klass = await ctx.ops.call<RecordShape>("record.get", {
      object: CLASS,
      id: input.classId,
    });
    const [described] = await staffClasses(ctx, [klass]);
    const page = await ctx.ops.call<ListShape>("record.list", {
      object: BOOKING,
      filter: { field: "class", op: "eq", value: klass.id },
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
    return {
      class: described as z.infer<typeof staffClass>,
      bookings: page.items.map((booking) => {
        const personId = text(booking.values.person);
        return {
          id: booking.id,
          person: personId ? { id: personId, name: names.get(personId) ?? null } : null,
          state: text(booking.values.state),
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
