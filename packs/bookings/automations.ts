// The Bookings messages (stage 31a step 9, decision 16; ADR 0572). Members' email is routine mail
// (ADR 0590): fixed emails this pack declares (routine-mail.ts), which the host composes, sends
// to whoever the booking belongs to and sends without a person's approval, unless an admin turned
// the kind off or the host holds one for a person. These automations only decide which message,
// about which booking, with which declared choices; they add no rule of their own: every state
// they read was written by the host's behaviours, and they write no record (the pack's own storage
// holds which class changes are still to be told). One notice to staff goes in the app.
//
// Who is written to is the host's rule, the same for every message: the booking's Person, each of
// their live guardians (ADR 0540), or for a visitor's paid drop-in with no Person the order's own
// address (ADR 0560); nobody else, one recipient per email, so no email names another member.
// Not emailed (spec 31): a coach swap, and a booking the member cancelled themselves (the screen
// says so). Nothing here sends a push or a text.
//
// A send step retried after a failure part way sends nothing twice: the host keys each email by
// the run its chain began with, the kind, the message, the booking and the recipient.
import {
  type AutomationEvent,
  defineAutomation,
  type ExtensionContext,
  type RoutineSendInput,
} from "@composable-os/sdk";

const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const CLASS_TYPE = "bookings.classtype";

/**
 * The email-send connection the host sends from: a person binds it to each automation, which is
 * their consent to the pack's mail going out from that address.
 */
const MAIL = {
  id: "mail",
  gatekeeper: "email-send",
  purpose: "Email members about their bookings",
} as const;

/** How long a change to a class settles before it is told, so several edits make one email. */
const SETTLE = "2 minutes" as const;

interface RecordShape {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

const PAGE = 200;

/** The pack's settings (the booking rules), stored or default. */
async function settings(ctx: ExtensionContext): Promise<Record<string, unknown>> {
  // Each item names its extension as `extension` (extensionSettings.list's output): reading `id`
  // found none, so every setting read here was its default (found building stage 29 step 5).
  const { items } = await ctx.ops.call<{
    items: { extension: string; values: Record<string, unknown> }[];
  }>("extensionSettings.list", { extension: "bookings" });
  return items.find((item) => item.extension === "bookings")?.values ?? {};
}

/** Which declared words say why the host passed a waiter over (ADR 0520's reasons). */
export function passedOverChoice(
  reason: string | null,
): "noUsesLeft" | "notLive" | "notCovered" | "other" {
  switch (reason) {
    case "no_uses_left":
      return "noUsesLeft";
    case "ended":
    case "not_live":
      return "notLive";
    case "not_covered":
      return "notCovered";
    default:
      return "other";
  }
}

// --- What a message is about --------------------------------------------------------------------

interface ClassFacts {
  id: string;
  startsAt: string | null;
  state: string | null;
  classType: string | null;
}

async function classFacts(ctx: ExtensionContext, id: string): Promise<ClassFacts | null> {
  const found = await ctx.ops
    .call<RecordShape>("record.get", { object: CLASS, id })
    .catch(() => null);
  if (!found) return null;
  const v = found.values;
  return {
    id,
    startsAt: text(v.startsAt),
    state: text(v.state),
    classType: text(v.classType),
  };
}

/** One routine email to ask for: the host decides who it goes to and what it says. */
type Send = Omit<RoutineSendInput, "kind">;

/** Asks the host for each email of `kind`, in order. */
async function sendAll(
  ctx: ExtensionContext,
  kind: string,
  sends: Send[],
): Promise<{ sent: number; held: number; off: boolean }> {
  let sent = 0;
  let held = 0;
  let off = false;
  for (const send of sends) {
    const result = await ctx.routineMail.send({ kind, ...send });
    sent += result.sent;
    held += result.held;
    off ||= result.off;
  }
  return { sent, held, off };
}

/** Every booking of a class in some states, page by page. */
async function bookingsOf(
  ctx: ExtensionContext,
  classId: string,
  states: string[],
): Promise<RecordShape[]> {
  const out: RecordShape[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: RecordShape[]; nextCursor: string | null } = await ctx.ops.call(
      "record.list",
      {
        object: BOOKING,
        filter: {
          and: [
            { field: "class", op: "eq", value: classId },
            { field: "state", op: "in", value: states },
          ],
        },
        sort: { field: "createdAt", direction: "asc" },
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      },
    );
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** The run a chain of retries began with (ADR 0574): what a class's turn is held by. */
const chainOf = (event: AutomationEvent) => event.originalRunId ?? event.runId;

// --- Booked -------------------------------------------------------------------------------------

/**
 * Which booked message a change into `booked` is, or none. The record is read when the run starts,
 * which may be after later changes: a waiter created and then moved in, or a drop-in held and then
 * paid for, is booked by the time its creation's run reads it. Those are told by their own move's
 * run (`promoted`, `paid`), never by the creation's, so each booking gets one booked message. None
 * for a correction (ticked as come, then unticked).
 */
export function bookedKind(
  change: { action: string; diff: Record<string, { before: unknown; after: unknown }> } | undefined,
  values: Record<string, unknown>,
): "booked" | "moved" | "paid" | "promoted" | null {
  if (!change || change.action === "created") {
    if (text(values.movedFrom)) return "moved";
    // Made waiting and moved in since (the host records when), or held while its order was paid.
    if (text(values.promotedAt) || text(values.dropInOrder)) return null;
    return "booked";
  }
  const state = change.diff.state;
  if (state?.after !== "booked") return null;
  if (state.before === "pending") return "paid";
  if (state.before === "waiting") return "promoted";
  return null;
}

export const bookingConfirmed = defineAutomation({
  label: "Booking confirmed",
  description:
    "When a booking becomes booked (made by the member, a parent or staff; a drop-in paid for; " +
    "moved in from the waiting list; or moved by staff to another class), emails the member and " +
    "their parents or guardians the class, its time and room, with an add-to-calendar file (a " +
    "move also takes the old class off the calendar). Routine email: Booking confirmations.",
  trigger: { type: "record", object: BOOKING, on: ["created", "updated"] },
  conditions: { field: "state", op: "eq", value: "booked" },
  // Each change its own run: the message is read from the change (a waiter moved in, a drop-in
  // paid), which coalescing a record's updates into one run would lose.
  rails: { debounceSeconds: 0 },
  connections: [MAIL],
  steps: [
    { name: "compose", label: "Check the booking is still booked", reads: [BOOKING] },
    { name: "send", label: "Email the member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const id = event.record?.id;
    const values = event.record?.data ?? {};
    const kind = bookedKind(event.change, values);
    if (!id || !kind) return { skipped: "not a new booking" };
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      const booking = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id });
      if (text(booking.values.state) !== "booked") return [];
      return [{ record: id, message: kind }];
    });
    if (!sends.length) return { sent: 0, kind };
    return { ...(await step.do("send", () => sendAll(ctx, "confirmation", sends))), kind };
  },
});

// --- The waiting list ---------------------------------------------------------------------------

export const waitlistPassedOver = defineAutomation({
  label: "Passed over on the waiting list",
  description:
    "When a place came free but the first person waiting could not be moved in (nothing they " +
    "hold could pay for it), emails them why; they stay first on the waiting list. Routine " +
    "email: Waiting list news.",
  trigger: { type: "fieldChanged", object: BOOKING, field: "passedOverReason" },
  conditions: { field: "state", op: "eq", value: "waiting" },
  connections: [MAIL],
  steps: [
    { name: "compose", label: "Read why they were passed over", reads: [BOOKING] },
    { name: "send", label: "Email the member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const id = event.record?.id;
    if (!id) return { skipped: "no booking" };
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      const booking = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id });
      const reason = text(booking.values.passedOverReason);
      if (text(booking.values.state) !== "waiting" || !reason) return [];
      return [{ record: id, message: "passedOver", values: { why: passedOverChoice(reason) } }];
    });
    if (!sends.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, "waitingList", sends));
  },
});

/** The moment nobody is moved in from the waiting list any more: the class type's, else the org's. */
async function cutOff(ctx: ExtensionContext, cls: ClassFacts): Promise<number | null> {
  if (!cls.startsAt) return null;
  let minutes: number | null = null;
  if (cls.classType) {
    const type = await ctx.ops
      .call<RecordShape>("record.get", { object: CLASS_TYPE, id: cls.classType })
      .catch(() => null);
    const own = type?.values.promotionMinutes;
    if (typeof own === "number") minutes = own;
  }
  if (minutes === null) {
    const org = (await settings(ctx)).promotionMinutes;
    minutes = typeof org === "number" ? org : 120;
  }
  return Date.parse(cls.startsAt) - minutes * 60_000;
}

/**
 * Several runs for one class within a moment are told once (ADR 0572): each run takes the class's
 * turn in the pack's storage (`claimTurn`), waits for things to settle, and only the run that took
 * the turn last tells, with what is true then. A run never loses the turn without a later run
 * holding it, so the last change is always told. The turn is given up only after the send
 * (`releaseTurn`, its own step): a compose or send step retried after a failure still holds it.
 */
async function claimTurn<T extends Record<string, unknown>>(
  ctx: ExtensionContext,
  key: string,
  runId: string,
  merge: (before: T | null) => T,
): Promise<void> {
  const before = await ctx.storage.get<T & { turn: string }>(key);
  await ctx.storage.set(key, { ...merge(before), turn: runId });
}

/** What this run noted, while it still holds the turn; null when a later run took it. */
async function heldTurn<T>(
  ctx: ExtensionContext,
  key: string,
  runId: string,
): Promise<(T & { turn: string }) | null> {
  const held = await ctx.storage.get<T & { turn: string }>(key);
  return held?.turn === runId ? held : null;
}

/** Gives the turn up after telling, unless a later run has taken it meanwhile. */
async function releaseTurn(ctx: ExtensionContext, key: string, runId: string): Promise<void> {
  if (await heldTurn(ctx, key, runId)) await ctx.storage.delete(key);
}

export const placeFree = defineAutomation({
  label: "A place free after the waiting list stops",
  description:
    "When someone gives a place back after the class's waiting list has stopped (2 hours before " +
    "by default), emails everyone still waiting that a place is free: whoever books it first " +
    "gets it. Several places given back within two minutes make one email. Routine email: " +
    "Waiting list news.",
  trigger: {
    type: "fieldChanged",
    object: BOOKING,
    field: "state",
    from: "booked",
    to: { in: ["cancelled", "late_cancelled", "excused"] },
  },
  connections: [MAIL],
  steps: [
    { name: "note", label: "Note the class has a place to tell of" },
    { name: "settle", kind: "sleep", duration: SETTLE },
    {
      name: "compose",
      label: "Check the place is free and read who is waiting",
      reads: [BOOKING, CLASS, CLASS_TYPE],
      calls: ["capacity.get", "extensionSettings.list"],
    },
    { name: "send", label: "Email each person waiting" },
    { name: "release", label: "Give up the class's turn" },
  ],
  async run(event, step, ctx) {
    const classId = text(event.record?.data?.class);
    if (!classId) return { skipped: "no class" };
    const key = `free:${classId}`;
    await step.do("note", () => claimTurn(ctx, key, chainOf(event), () => ({ classId })));
    await step.sleep("settle", SETTLE);
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      if (!(await heldTurn(ctx, key, chainOf(event)))) return [];
      const cls = await classFacts(ctx, classId);
      if (cls?.state !== "scheduled" || !cls.startsAt) return [];
      const now = Date.now();
      const stops = await cutOff(ctx, cls);
      // Before the cut-off the place went to the waiting list (the host's): nothing to tell.
      if (stops === null || now < stops || now >= Date.parse(cls.startsAt)) return [];
      const places = await ctx.ops
        .call<{ available: number | null }>("capacity.get", { object: CLASS, id: classId })
        .catch(() => null);
      if (!places?.available || places.available < 1) return [];
      const waiting = await bookingsOf(ctx, classId, ["waiting"]);
      return waiting.map((b) => ({ record: b.id, message: "placeFree" }));
    });
    const sent = sends.length
      ? await step.do("send", () => sendAll(ctx, "waitingList", sends))
      : { sent: 0 };
    await step.do("release", () => releaseTurn(ctx, key, chainOf(event)));
    return sent;
  },
});

// --- A change or a cancellation by the gym ------------------------------------------------------

/** Bookings that a change to their class concerns: with a place, held while paying, or waiting. */
const LIVE = ["booked", "pending", "waiting"];

/** What the changes to a class since it was last told add up to (kept in the pack's storage). */
interface ClassChange extends Record<string, unknown> {
  /** Its start before the first change not yet told. */
  startsBefore: string | null;
  time: boolean;
  end: boolean;
  room: boolean;
}

export const classChanged = defineAutomation({
  label: "Class time or room changed",
  description:
    "When staff change a scheduled class's time, day, end or room (one class, or a series from a " +
    "date), emails everyone booked or waiting what it is now, with an updated add-to-calendar " +
    "file; several changes within two minutes make one email. A change of coach sends nothing. " +
    "Routine email: Class changes.",
  trigger: { type: "record", object: CLASS, on: ["updated"], includeBulk: true },
  conditions: { field: "state", op: "eq", value: "scheduled" },
  // Each change its own run: a coach swap then a new time a moment later must not coalesce into
  // one run that sees only the swap. The runs then agree among themselves which tells (claimTurn).
  rails: { debounceSeconds: 0 },
  connections: [MAIL],
  steps: [
    { name: "note", label: "Note what changed" },
    { name: "settle", kind: "sleep", duration: SETTLE },
    { name: "compose", label: "Read who is booked or waiting", reads: [BOOKING, CLASS] },
    { name: "send", label: "Email each member (and their guardians)" },
    { name: "release", label: "Give up the class's turn" },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    const diff = event.change?.diff ?? {};
    const changed = { time: "startsAt" in diff, end: "endsAt" in diff, room: "room" in diff };
    // A coach swap (decision 16), the places or the notes: nothing to tell.
    if (!classId || (!changed.time && !changed.end && !changed.room)) {
      return { skipped: "no time or room change" };
    }
    const key = `changed:${classId}`;
    await step.do("note", () =>
      claimTurn<ClassChange>(ctx, key, chainOf(event), (before) => ({
        startsBefore: before ? before.startsBefore : text(diff.startsAt?.before),
        time: Boolean(before?.time) || changed.time,
        end: Boolean(before?.end) || changed.end,
        room: Boolean(before?.room) || changed.room,
      })),
    );
    await step.sleep("settle", SETTLE);
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      // A later change took the turn: it tells, with everything changed since.
      const told = await heldTurn<ClassChange>(ctx, key, chainOf(event));
      if (!told) return [];
      const cls = await classFacts(ctx, classId);
      if (cls?.state !== "scheduled") return [];
      const before = told.startsBefore;
      const moved = told.time && (!before || Date.parse(before) !== Date.parse(cls.startsAt ?? ""));
      // Changed and changed back: nothing to tell.
      if (!moved && !told.end && !told.room) return [];
      const bookings = await bookingsOf(ctx, classId, LIVE);
      return bookings.map((booking) => {
        const waiting = text(booking.values.state) === "waiting";
        return {
          record: booking.id,
          message: "changed",
          values: {
            moved,
            notMoved: !moved,
            ...(moved && before ? { before } : {}),
            endChanged: told.end,
            roomChanged: told.room,
            stays: waiting ? "waiting" : "booking",
            keep: !waiting,
          },
        };
      });
    });
    const sent = sends.length
      ? await step.do("send", () => sendAll(ctx, "change", sends))
      : { sent: 0 };
    await step.do("release", () => releaseTurn(ctx, key, chainOf(event)));
    return sent;
  },
});

/** An order as order.get answers, the parts read here. */
interface OrderShape {
  state: string;
  paid?: number;
}

export const classCancelled = defineAutomation({
  label: "Class cancelled by the gym",
  description:
    "When the gym cancels a class (staff, a closure, or a series ended), emails everyone whose " +
    "booking it cancelled: the class, the reason, that nothing was used from their membership or " +
    "pass, and for a paid drop-in that the money goes back to their card once approved. Routine " +
    "email: Class cancellations.",
  trigger: {
    type: "fieldChanged",
    object: CLASS,
    field: "state",
    from: "scheduled",
    to: "cancelled",
    includeBulk: true,
  },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Read the bookings the cancel cancelled",
      reads: [BOOKING, CLASS],
      calls: ["order.get"],
    },
    { name: "send", label: "Email each member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    if (!classId) return { skipped: "no class" };
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      const cls = await classFacts(ctx, classId);
      if (cls?.state !== "cancelled") return [];
      const bookings = await bookingsOf(ctx, classId, ["cancelled_by_us"]);
      // Whether each drop-in's money was taken (its order paid), read once per order.
      const paid = new Map<string, boolean>();
      for (const booking of bookings) {
        const order = text(booking.values.dropInOrder);
        if (order && !paid.has(order)) {
          const found = await ctx.ops
            .call<OrderShape>("order.get", { id: order })
            .catch(() => null);
          paid.set(order, (found?.paid ?? 0) > 0);
        }
      }
      return bookings.map((booking) => {
        const order = text(booking.values.dropInOrder);
        const money = order ? (paid.get(order) ? "refund" : "unpaid") : "membership";
        return { record: booking.id, message: "cancelled", values: { money } };
      });
    });
    if (!sends.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, "cancellation", sends));
  },
});

// --- The reminder -------------------------------------------------------------------------------

export const classReminder = defineAutomation({
  label: "Class reminder",
  description:
    "Before each scheduled class (3 hours by default: the class type's reminder, else the " +
    "organisation's), emails everyone booked into it a reminder of the time and room, and a " +
    "visitor who paid for a place that staff have not yet confirmed. Routine email: Class " +
    "reminders.",
  trigger: {
    type: "dateRelative",
    object: CLASS,
    field: "startsAt",
    minutesBefore: { field: "classType.reminderMinutes", setting: "reminderMinutes" },
  },
  conditions: { field: "state", op: "eq", value: "scheduled" },
  connections: [MAIL],
  steps: [
    { name: "compose", label: "Read who is booked", reads: [BOOKING, CLASS] },
    { name: "send", label: "Email each member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    if (!classId) return { skipped: "no class" };
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      const cls = await classFacts(ctx, classId);
      // Cancelled (or done) since the run began: no reminder.
      if (cls?.state !== "scheduled") return [];
      // Run late for a class already started: no reminder.
      if (cls.startsAt && Date.parse(cls.startsAt) <= Date.now()) return [];
      // Booked; and a visitor's paid place held for staff to settle (the host sends nothing
      // about a hold nobody paid for).
      const bookings = (await bookingsOf(ctx, classId, ["booked", "pending"])).filter(
        (b) => text(b.values.state) === "booked" || !text(b.values.person),
      );
      return bookings.map((b) => ({ record: b.id, message: "reminder" }));
    });
    if (!sends.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, "reminder", sends));
  },
});

// --- A drop-in's payment and refund --------------------------------------------------------------

export const dropInOrder = defineAutomation({
  label: "Drop-in paid or refunded",
  description:
    "When a visitor pays for a class that staff still have to confirm (their address matches " +
    "several people on file), emails them at the order's address that their place is held; when " +
    "the refund of a paid drop-in has been made, emails the person who paid that their money is " +
    "back. Routine email: Drop-in payments and refunds.",
  trigger: {
    type: "fieldChanged",
    object: "order",
    field: "state",
    to: { in: ["paid", "refunded"] },
  },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Find the drop-in the order paid for",
      reads: [BOOKING],
      calls: ["order.get"],
    },
    { name: "send", label: "Email the person who paid" },
  ],
  async run(event, step, ctx) {
    const orderId = event.record?.id;
    if (!orderId) return { skipped: "no order" };
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      const found = await ctx.ops.call<{ items: RecordShape[] }>("record.list", {
        object: BOOKING,
        filter: { field: "dropInOrder", op: "eq", value: orderId },
        limit: 10,
      });
      // An order of something else: not ours to tell.
      const booking = found.items[0];
      if (!booking) return [];
      const order = await ctx.ops.call<OrderShape>("order.get", { id: orderId });
      // About the order (D3): the host sends it to the address that paid.
      if (order.state === "refunded") return [{ record: orderId, message: "refunded" }];
      // Paid, and still held with no Person: staff settle whose it is (ADR 0560). A booking
      // that became booked with its Person is told by bookingConfirmed instead.
      if (text(booking.values.state) !== "pending" || text(booking.values.person)) return [];
      return [{ record: orderId, message: "held" }];
    });
    if (!sends.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, "dropIn", sends));
  },
});

// --- Staff: classes with no attendance taken ----------------------------------------------------

export const noAttendanceTaken = defineAutomation({
  label: "No attendance taken",
  description:
    "An hour after a class ends, when people were booked but nobody on it was ticked as come or " +
    "marked as not come, tells the admins in the app, so someone takes the list (no-shows are " +
    "only written for a class whose list was taken).",
  trigger: { type: "dateRelative", object: CLASS, field: "endsAt", minutesAfter: 60 },
  conditions: { field: "state", op: "eq", value: "scheduled" },
  steps: [
    { name: "check", label: "Count who was booked and who was marked", reads: [BOOKING] },
    {
      name: "notify",
      label: "Tell the admins",
      notifies: [
        {
          to: "admins",
          message: "No attendance taken: {record}",
          body: "Nobody on this class was ticked as come or marked as not come.",
        },
      ],
    },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    if (!classId) return { skipped: "no class" };
    const counts = await step.do("check", async () => {
      const marked = await bookingsOf(ctx, classId, ["attended", "no_show"]);
      if (marked.length) return { booked: 0, marked: marked.length };
      const booked = await bookingsOf(ctx, classId, ["booked"]);
      return { booked: booked.length, marked: 0 };
    });
    if (counts.marked || !counts.booked) return { notified: false, ...counts };
    await step.do("notify", () =>
      ctx.notify("admins", {
        title: "No attendance taken: {record}",
        body: `${counts.booked} booked, nobody ticked as come or marked as not come.`,
        link: "record",
      }),
    );
    return { notified: true, ...counts };
  },
});

// --- Feedback after a class (stage 29 step 5, decision 4) ---------------------------------------

export const feedbackAfterClass = defineAutomation({
  label: "Feedback after a class",
  description:
    "A few hours after a member is ticked as come (the feedback setting, 3 hours by default), " +
    "when a feedback form is chosen, emails them (or a child's parents or guardians) a link to " +
    "it that works once and for a week. The host makes the link, sends it at most once a month " +
    "to a member, and never to someone who stopped these emails. Routine email: Feedback after " +
    "a class.",
  trigger: {
    type: "dateRelative",
    object: BOOKING,
    field: "markedAt",
    minutesAfter: { setting: "feedbackMinutes" },
  },
  conditions: { field: "state", op: "eq", value: "attended" },
  connections: [MAIL],
  steps: [
    { name: "compose", label: "Check a feedback form is chosen and they came", reads: [BOOKING] },
    { name: "send", label: "Email the member (or their guardians) the form's link" },
  ],
  async run(event, step, ctx) {
    const bookingId = event.record?.id;
    if (!bookingId) return { skipped: "no booking" };
    const sends = await step.do("compose", async (): Promise<Send[]> => {
      // No form chosen: nobody is asked. Which form, and whether the member may be asked, is the
      // host's to read again when it makes the link.
      if (!text((await settings(ctx)).feedbackForm)) return [];
      const booking = await ctx.ops
        .call<RecordShape>("record.get", { object: BOOKING, id: bookingId })
        .catch(() => null);
      // Unticked since: not asked.
      if (text(booking?.values.state) !== "attended") return [];
      return [{ record: bookingId, message: "ask" }];
    });
    if (!sends.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, "feedback", sends));
  },
});

export const bookingsAutomations = {
  bookingConfirmed,
  waitlistPassedOver,
  placeFree,
  classChanged,
  classCancelled,
  classReminder,
  dropInOrder,
  noAttendanceTaken,
  feedbackAfterClass,
};
