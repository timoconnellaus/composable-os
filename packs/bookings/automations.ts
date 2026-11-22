// The Bookings messages (stage 31a step 9, decision 16; ADR 0572). Email only, through the
// email-send gatekeeper (a connection a person binds when the pack is installed; each send is an
// outbound action the approval policy decides), and one notice to staff in the app. They add no
// rule of their own: every state they read was written by the host's behaviours, and they write
// nothing.
//
// Who is written to, for a booking (the same rule for every message):
//   - the booking's Person, when they have an email address;
//   - each guardian with a live family link to that Person (ADR 0540), when they have an email
//     address: a parent is told about their child's class, naming the child. A link that ended is
//     not live, so a parent who lost access to the child's bookings hears nothing more of them;
//   - nobody else, ever. Each email has one recipient and is about one booking, so no email names
//     another member or shows another member's address. A visitor's drop-in held while unpaid has
//     no Person (ADR 0560): it is nobody's, and nothing is sent about it until it is booked.
// Not emailed (spec 31): a coach swap, and a booking the member cancelled themselves (the screen
// says so). Nothing here sends a push or a text.
import { defineAutomation, type ExtensionContext } from "@composable-os/sdk";

const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const ROOM = "bookings.room";
const CLASS_TYPE = "programs.classtype";

/** The email-send connection every message goes through. */
const MAIL = {
  id: "mail",
  gatekeeper: "email-send",
  purpose: "Email members about their bookings",
} as const;

interface RecordShape {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

const PAGE = 200;

/** The pack's settings (the booking rules and the link in its emails), stored or default. */
async function settings(ctx: ExtensionContext): Promise<Record<string, unknown>> {
  const { items } = await ctx.ops.call<{
    items: { id: string; values: Record<string, unknown> }[];
  }>("extensionSettings.list");
  return items.find((item) => item.id === "bookings")?.values ?? {};
}

// --- Words --------------------------------------------------------------------------------------

/**
 * When a class starts, as members read it: the day and time in the class's own zone, and the zone,
 * so a reader on holiday elsewhere is not misled (ADR 0460).
 */
export function classTimeText(iso: string | null, zone: string | null): string {
  if (!iso) return "a time to be confirmed";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const timeZone = zone ?? "UTC";
  try {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
    return `${local} (${timeZone.replace(/_/g, " ")} time)`;
  } catch {
    return iso;
  }
}

/** Why the host passed a waiter over (ADR 0520's reasons), for whoever reads it. */
export function passedOverWords(reason: string | null): string {
  switch (reason) {
    case "no_uses_left":
      return "there are no classes left on the membership or pass for that week";
    case "ended":
    case "not_live":
      return "no membership or pass covers the class's date (ended, or paused)";
    case "not_covered":
      return "the membership or pass does not cover this class";
    default:
      return "nothing held could pay for it";
  }
}

// --- What a message is about --------------------------------------------------------------------

export interface ClassFacts {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  room: string | null;
  state: string | null;
  reason: string | null;
  classType: string | null;
}

async function classFacts(ctx: ExtensionContext, id: string): Promise<ClassFacts | null> {
  const found = await ctx.ops
    .call<RecordShape>("record.get", { object: CLASS, id })
    .catch(() => null);
  if (!found) return null;
  const v = found.values;
  const roomId = text(v.room);
  const room = roomId
    ? await ctx.ops.call<RecordShape>("record.get", { object: ROOM, id: roomId }).catch(() => null)
    : null;
  return {
    id,
    title: text(v.title) ?? found.title ?? "Your class",
    startsAt: text(v.startsAt),
    endsAt: text(v.endsAt),
    timezone: text(v.timezone),
    room: room ? text(room.values.name) : null,
    state: text(v.state),
    reason: text(v.cancelledReason),
    classType: text(v.classType),
  };
}

/** One person a booking's message goes to. */
export interface Addressee {
  email: string;
  /** The booking's own Person (else a guardian of theirs). */
  self: boolean;
  /** This addressee made the booking (`madeBy`, set by the host). */
  madeIt: boolean;
}

/**
 * Who hears about one booking: its Person and their live guardians, each with an address, one
 * entry per address. `madeBy` (host-set) only words the message ("You booked Sam"); it never adds
 * anyone, so a parent whose link ended is not written to however the booking was made.
 */
async function addresseesOf(
  ctx: ExtensionContext,
  booking: RecordShape,
): Promise<{ name: string | null; to: Addressee[] }> {
  const personId = text(booking.values.person);
  // A visitor's drop-in held while unpaid is nobody's (ADR 0560): no one to write to.
  if (!personId) return { name: null, to: [] };
  const madeBy = text(booking.values.madeBy);
  const person = await ctx.ops
    .call<PersonShape | null>("person.get", { id: personId })
    .catch(() => null);
  if (!person) return { name: null, to: [] };
  const to: Addressee[] = [];
  const seen = new Set<string>();
  const add = (email: string | null | undefined, self: boolean, madeIt: boolean) => {
    const address = text(email)?.toLowerCase();
    if (!address || seen.has(address)) return;
    seen.add(address);
    to.push({ email: address, self, madeIt });
  };
  add(primaryEmail(person), true, madeBy === personId);
  const links = await ctx.ops
    .call<{ items: { guardian: { id: string }; dependant: { id: string }; endedAt: string | null }[] }>(
      "person.link.list",
      { personId },
    )
    .catch(() => ({ items: [] }));
  for (const link of links.items) {
    if (link.dependant.id !== personId || link.endedAt) continue;
    const guardian = await ctx.ops
      .call<PersonShape | null>("person.get", { id: link.guardian.id })
      .catch(() => null);
    add(primaryEmail(guardian), false, madeBy === link.guardian.id);
  }
  return { name: text(person.displayName), to };
}

/** A Person as person.get answers: their addresses, the primary one marked. */
interface PersonShape {
  displayName?: string | null;
  emails?: { email: string; primary?: boolean | null }[] | null;
}

/** A Person's primary address, else their first; null when they have none (a child). */
export function primaryEmail(person: PersonShape | null): string | null {
  const emails = person?.emails ?? [];
  return text((emails.find((e) => e.primary) ?? emails[0])?.email);
}

/** "you" to the member; the child's name to a parent. */
const whom = (a: Addressee, name: string | null) => (a.self ? "you" : (name ?? "your child"));
/** "you are" to the member; "Sam is" to a parent. */
const whoIs = (a: Addressee, name: string | null) => (a.self ? "you are" : `${whom(a, name)} is`);
const your = (a: Addressee, name: string | null) => (a.self ? "your" : `${whom(a, name)}'s`);
const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** An "add to calendar" event for a booking (ADR 0571): the booking's id, so a change replaces it. */
function calendarOf(
  booking: RecordShape,
  cls: ClassFacts,
  link: string | null,
  change?: { cancelled?: boolean },
) {
  if (!cls.startsAt) return undefined;
  const start = Date.parse(cls.startsAt);
  const end = cls.endsAt ? Date.parse(cls.endsAt) : Number.NaN;
  if (Number.isNaN(start)) return undefined;
  return {
    uid: booking.id,
    start: new Date(start).toISOString(),
    end: new Date(Number.isNaN(end) || end <= start ? start + 3_600_000 : end).toISOString(),
    title: cls.title.slice(0, 200),
    ...(cls.room ? { location: cls.room.slice(0, 200) } : {}),
    ...(link ? { url: link } : {}),
    // A change replaces the event a calendar imported: a later sequence (minutes since 1970).
    ...(change ? { sequence: Math.floor(Date.now() / 60_000) } : {}),
    ...(change?.cancelled ? { cancelled: true } : {}),
  };
}

const httpsLink = (value: unknown): string | null => {
  const url = text(value);
  return url && /^https:\/\//.test(url) ? url : null;
};

/** Sends one email to one address through the bound email-send connection. */
async function sendMail(
  ctx: ExtensionContext,
  message: {
    to: string;
    subject: string;
    text: string;
    related: string[];
    calendar?: ReturnType<typeof calendarOf>;
  },
): Promise<void> {
  const gatekeeper = ctx.gatekeeper("email-send");
  const connections = await gatekeeper.connections();
  const resource =
    connections.find((c) => c.id === MAIL.id)?.resources[0]?.bindingName ??
    connections[0]?.resources[0]?.bindingName ??
    "SENDER";
  await gatekeeper.call(MAIL.id, resource, "send", {
    to: [message.to],
    subject: message.subject.slice(0, 200),
    text: message.text,
    relatedRecords: message.related.slice(0, 20),
    ...(message.calendar ? { calendar: message.calendar } : {}),
  });
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

/** One email per addressee of each booking, built by `compose`. */
interface Letter {
  to: string;
  subject: string;
  text: string;
  related: string[];
  calendar?: ReturnType<typeof calendarOf>;
}

async function lettersFor(
  ctx: ExtensionContext,
  bookings: RecordShape[],
  compose: (a: Addressee, name: string | null, booking: RecordShape) => Omit<Letter, "to"> | null,
): Promise<Letter[]> {
  const letters: Letter[] = [];
  for (const booking of bookings) {
    const { name, to } = await addresseesOf(ctx, booking);
    for (const a of to) {
      const letter = compose(a, name, booking);
      if (letter) letters.push({ ...letter, to: a.email });
    }
  }
  return letters;
}

async function sendAll(ctx: ExtensionContext, letters: Letter[]): Promise<{ sent: number }> {
  for (const letter of letters) await sendMail(ctx, letter);
  return { sent: letters.length };
}

const footer = (link: string | null) =>
  link ? ["", `Your bookings: ${link}`] : ["", "You can see your bookings when you sign in."];

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
  if (!state || state.after !== "booked") return null;
  if (state.before === "pending") return "paid";
  if (state.before === "waiting") return "promoted";
  return null;
}

export const bookingConfirmed = defineAutomation({
  label: "Booking confirmed",
  description:
    "When a booking becomes booked (made by the member, a parent or staff; a drop-in paid for; " +
    "moved in from the waiting list; or moved by staff to another class), emails the member and " +
    "their parents or guardians the class, its time and room, with an add-to-calendar file.",
  trigger: { type: "record", object: BOOKING, on: ["created", "updated"] },
  conditions: { field: "state", op: "eq", value: "booked" },
  // Each change its own run: the message is read from the change (a waiter moved in, a drop-in
  // paid), which coalescing a record's updates into one run would lose.
  rails: { debounceSeconds: 0 },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Read the class and who to tell",
      reads: [BOOKING, CLASS, ROOM, "person"],
      calls: ["person.link.list", "extensionSettings.list"],
    },
    { name: "send", label: "Email the member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const id = event.record?.id;
    const values = event.record?.data ?? {};
    const kind = bookedKind(event.change, values);
    if (!id || !kind) return { skipped: "not a new booking" };
    const letters = await step.do("compose", async () => {
      const booking = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id });
      if (text(booking.values.state) !== "booked") return [];
      const cls = await classFacts(ctx, String(booking.values.class));
      if (!cls) return [];
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      const when = classTimeText(cls.startsAt, cls.timezone);
      const where = cls.room ? `, in ${cls.room}` : "";
      return lettersFor(ctx, [booking], (a, name) => {
        const lead = {
          booked:
            a.madeIt && !a.self
              ? `You booked ${whom(a, name)} into ${cls.title} on ${when}${where}.`
              : `${capital(whoIs(a, name))} booked into ${cls.title} on ${when}${where}.`,
          paid: `Payment received: ${whoIs(a, name)} booked into ${cls.title} on ${when}${where}.`,
          promoted: `A place came free and ${whoIs(a, name)} now booked into ${cls.title} on ${when}${where}, moved in from the waiting list. It used one class from ${your(a, name)} membership or pass.`,
          moved: `The gym moved ${your(a, name)} booking to ${cls.title} on ${when}${where}.`,
        }[kind];
        const subject = {
          booked: `Booked: ${cls.title}`,
          paid: `Booked and paid: ${cls.title}`,
          promoted: `You're in: ${cls.title}`,
          moved: `Booking moved: ${cls.title}`,
        }[kind];
        return {
          subject: a.self ? subject : `${subject} (${whom(a, name)})`,
          text: [
            lead,
            "",
            "The attached file adds it to your calendar.",
            ...footer(link),
          ].join("\n"),
          related: [booking.id, cls.id],
          calendar: calendarOf(booking, cls, link, kind === "moved" ? {} : undefined),
        };
      });
    });
    if (!letters.length) return { sent: 0, kind };
    return { ...(await step.do("send", () => sendAll(ctx, letters))), kind };
  },
});

// --- The waiting list ---------------------------------------------------------------------------

export const waitlistPassedOver = defineAutomation({
  label: "Passed over on the waiting list",
  description:
    "When a place came free but the first person waiting could not be moved in (nothing they " +
    "hold could pay for it), emails them why; they stay first on the waiting list.",
  trigger: { type: "fieldChanged", object: BOOKING, field: "passedOverReason" },
  conditions: { field: "state", op: "eq", value: "waiting" },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Read the class and who to tell",
      reads: [BOOKING, CLASS, ROOM, "person"],
      calls: ["person.link.list", "extensionSettings.list"],
    },
    { name: "send", label: "Email the member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const id = event.record?.id;
    if (!id) return { skipped: "no booking" };
    const letters = await step.do("compose", async () => {
      const booking = await ctx.ops.call<RecordShape>("record.get", { object: BOOKING, id });
      const reason = text(booking.values.passedOverReason);
      if (text(booking.values.state) !== "waiting" || !reason) return [];
      const cls = await classFacts(ctx, String(booking.values.class));
      if (!cls) return [];
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      const when = classTimeText(cls.startsAt, cls.timezone);
      return lettersFor(ctx, [booking], (a, name) => ({
        subject: `A place came free: ${cls.title}`,
        text: [
          `A place came free on ${cls.title} on ${when}, but we could not move ${whom(a, name)} in: ${passedOverWords(reason)}.`,
          `${capital(whoIs(a, name))} still on the waiting list, and will be moved in when the next place comes free if it can be paid for then.`,
          ...footer(link),
        ].join("\n"),
        related: [booking.id, cls.id],
      }));
    });
    if (!letters.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, letters));
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
    const own = type?.values["bookings.promotionMinutes"] ?? type?.values.promotionMinutes;
    if (typeof own === "number") minutes = own;
  }
  if (minutes === null) {
    const org = (await settings(ctx)).promotionMinutes;
    minutes = typeof org === "number" ? org : 120;
  }
  return Date.parse(cls.startsAt) - minutes * 60_000;
}

export const placeFree = defineAutomation({
  label: "A place free after the waiting list stops",
  description:
    "When someone gives a place back after the class's waiting list has stopped (2 hours before " +
    "by default), emails everyone still waiting that a place is free: whoever books it first " +
    "gets it.",
  trigger: {
    type: "fieldChanged",
    object: BOOKING,
    field: "state",
    from: "booked",
    to: { in: ["cancelled", "late_cancelled", "excused"] },
  },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Check the place is free and read who is waiting",
      reads: [BOOKING, CLASS, ROOM, CLASS_TYPE, "person"],
      calls: ["capacity.get", "person.link.list", "extensionSettings.list"],
    },
    { name: "send", label: "Email each person waiting" },
  ],
  async run(event, step, ctx) {
    const classId = text(event.record?.data?.class);
    if (!classId) return { skipped: "no class" };
    const letters = await step.do("compose", async () => {
      const cls = await classFacts(ctx, classId);
      if (!cls || cls.state !== "scheduled" || !cls.startsAt) return [];
      const now = Date.now();
      const stops = await cutOff(ctx, cls);
      // Before the cut-off the place went to the waiting list (the host's): nothing to tell.
      if (stops === null || now < stops || now >= Date.parse(cls.startsAt)) return [];
      const places = await ctx.ops
        .call<{ available: number | null }>("capacity.get", { object: CLASS, id: classId })
        .catch(() => null);
      if (!places || !places.available || places.available < 1) return [];
      const waiting = await bookingsOf(ctx, classId, ["waiting"]);
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      const when = classTimeText(cls.startsAt, cls.timezone);
      return lettersFor(ctx, waiting, (a, name) => ({
        subject: `A place is free: ${cls.title}`,
        text: [
          `A place is free on ${cls.title} on ${when}. The waiting list has stopped for this class, so whoever books it first gets it.`,
          a.self
            ? "Book it now if you still want it."
            : `Book it for ${whom(a, name)} now if they still want it.`,
          ...footer(link),
        ].join("\n"),
        related: [cls.id],
      }));
    });
    if (!letters.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, letters));
  },
});

// --- A change or a cancellation by the gym ------------------------------------------------------

/** Bookings that a change to their class concerns: with a place, held while paying, or waiting. */
const LIVE = ["booked", "pending", "waiting"];

export const classChanged = defineAutomation({
  label: "Class time or room changed",
  description:
    "When staff change a scheduled class's time, day or room (one class, or a series from a " +
    "date), emails everyone booked or waiting the new time or room, with an updated " +
    "add-to-calendar file. A change of coach sends nothing.",
  trigger: { type: "record", object: CLASS, on: ["updated"], includeBulk: true },
  conditions: { field: "state", op: "eq", value: "scheduled" },
  // Each change its own run: a coach swap then a new time a moment later must not coalesce into
  // one run that sees only the swap.
  rails: { debounceSeconds: 0 },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Read who is booked or waiting",
      reads: [BOOKING, CLASS, ROOM, "person"],
      calls: ["person.link.list", "extensionSettings.list"],
    },
    { name: "send", label: "Email each member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    const diff = event.change?.diff ?? {};
    const timeChanged = "startsAt" in diff;
    const roomChanged = "room" in diff;
    // A coach swap (decision 16), the places or the notes: nothing to tell.
    if (!classId || (!timeChanged && !roomChanged)) return { skipped: "no time or room change" };
    const letters = await step.do("compose", async () => {
      const cls = await classFacts(ctx, classId);
      if (!cls || cls.state !== "scheduled") return [];
      const bookings = await bookingsOf(ctx, classId, LIVE);
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      const when = classTimeText(cls.startsAt, cls.timezone);
      const before = text(diff.startsAt?.before);
      return lettersFor(ctx, bookings, (a, name, booking) => {
        const lines = [
          timeChanged
            ? `${cls.title}${before ? ` on ${classTimeText(before, cls.timezone)}` : ""} has moved to ${when}.`
            : `${cls.title} on ${when} is now in ${cls.room ?? "another room"}.`,
          ...(timeChanged && roomChanged && cls.room ? [`It is now in ${cls.room}.`] : []),
          `${capital(your(a, name))} ${text(booking.values.state) === "waiting" ? "place on the waiting list stays" : "booking stays"} as it is. If the change does not suit, cancel it when you sign in.`,
        ];
        const keep = text(booking.values.state) === "booked";
        return {
          subject: `Class changed: ${cls.title}${a.self ? "" : ` (${whom(a, name)})`}`,
          text: [
            ...lines,
            ...(keep ? ["", "The attached file updates it in your calendar."] : []),
            ...footer(link),
          ].join("\n"),
          related: [booking.id, cls.id],
          ...(keep ? { calendar: calendarOf(booking, cls, link, {}) } : {}),
        };
      });
    });
    if (!letters.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, letters));
  },
});

export const classCancelled = defineAutomation({
  label: "Class cancelled by the gym",
  description:
    "When the gym cancels a class (staff, a closure, or a series ended), emails everyone whose " +
    "booking it cancelled: the class, the reason, that nothing was used from their membership or " +
    "pass, and for a paid drop-in that the money goes back to their card once approved.",
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
      reads: [BOOKING, CLASS, ROOM, "person"],
      calls: ["order.get", "person.link.list", "extensionSettings.list"],
    },
    { name: "send", label: "Email each member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    if (!classId) return { skipped: "no class" };
    const letters = await step.do("compose", async () => {
      const cls = await classFacts(ctx, classId);
      if (!cls || cls.state !== "cancelled") return [];
      const bookings = await bookingsOf(ctx, classId, ["cancelled_by_us"]);
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      const when = classTimeText(cls.startsAt, cls.timezone);
      // Whether each drop-in's money was taken (its order paid), read once per order.
      const paid = new Map<string, boolean>();
      for (const booking of bookings) {
        const order = text(booking.values.dropInOrder);
        if (!order || paid.has(order)) continue;
        const read = await ctx.ops
          .call<{ state: string; paid?: number }>("order.get", { id: order })
          .catch(() => null);
        paid.set(order, Boolean(read && (read.paid ?? 0) > 0));
      }
      return lettersFor(ctx, bookings, (a, name, booking) => {
        const order = text(booking.values.dropInOrder);
        const money = order
          ? paid.get(order)
            ? "The money paid for it goes back to the card it was paid with, once the gym approves the refund: you will get an email when it has been made."
            : "Nothing was charged."
          : `Nothing was used from ${your(a, name)} membership or pass.`;
        return {
          subject: `Cancelled by the gym: ${cls.title}${a.self ? "" : ` (${whom(a, name)})`}`,
          text: [
            `The gym has cancelled ${cls.title} on ${when}${a.self ? "" : `, which ${whom(a, name)} was booked into`}.`,
            ...(cls.reason ? [`The reason: ${cls.reason}`] : []),
            money,
            "",
            "The attached file takes it off your calendar.",
            ...footer(link),
          ].join("\n"),
          related: [booking.id, cls.id],
          calendar: calendarOf(booking, cls, link, { cancelled: true }),
        };
      });
    });
    if (!letters.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, letters));
  },
});

// --- The reminder -------------------------------------------------------------------------------

export const classReminder = defineAutomation({
  label: "Class reminder",
  description:
    "Before each scheduled class (3 hours by default: the class type's reminder, else the " +
    "organisation's), emails everyone booked into it a reminder of the time and room.",
  trigger: {
    type: "dateRelative",
    object: CLASS,
    field: "startsAt",
    minutesBefore: { field: "classType.reminderMinutes", setting: "reminderMinutes" },
  },
  conditions: { field: "state", op: "eq", value: "scheduled" },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Read who is booked",
      reads: [BOOKING, CLASS, ROOM, "person"],
      calls: ["person.link.list", "extensionSettings.list"],
    },
    { name: "send", label: "Email each member (and their guardians)" },
  ],
  async run(event, step, ctx) {
    const classId = event.record?.id;
    if (!classId) return { skipped: "no class" };
    const letters = await step.do("compose", async () => {
      const cls = await classFacts(ctx, classId);
      // Cancelled (or done) since the run began: no reminder.
      if (!cls || cls.state !== "scheduled") return [];
      // Run late for a class already started: no reminder.
      if (cls.startsAt && Date.parse(cls.startsAt) <= Date.now()) return [];
      const bookings = await bookingsOf(ctx, classId, ["booked"]);
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      const when = classTimeText(cls.startsAt, cls.timezone);
      return lettersFor(ctx, bookings, (a, name, booking) => ({
        subject: `Reminder: ${cls.title}${a.self ? "" : ` (${whom(a, name)})`}`,
        text: [
          `A reminder: ${whoIs(a, name)} booked into ${cls.title} on ${when}${cls.room ? `, in ${cls.room}` : ""}.`,
          "If you cannot come, cancel when you sign in, so someone waiting can have the place.",
          ...footer(link),
        ].join("\n"),
        related: [booking.id, cls.id],
      }));
    });
    if (!letters.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, letters));
  },
});

// --- A drop-in's refund made ---------------------------------------------------------------------

export const dropInRefunded = defineAutomation({
  label: "Drop-in refund made",
  description:
    "When the refund of a paid drop-in has been made (a person approved it and the payment " +
    "provider confirmed it), emails the person who paid that their money is back.",
  trigger: { type: "fieldChanged", object: "order", field: "state", to: "refunded" },
  connections: [MAIL],
  steps: [
    {
      name: "compose",
      label: "Find the drop-in the order paid for",
      reads: [BOOKING, CLASS, ROOM],
      calls: ["order.get", "extensionSettings.list"],
    },
    { name: "send", label: "Email the person who paid" },
  ],
  async run(event, step, ctx) {
    const orderId = event.record?.id;
    if (!orderId) return { skipped: "no order" };
    const letters = await step.do("compose", async () => {
      const found = await ctx.ops.call<{ items: RecordShape[] }>("record.list", {
        object: BOOKING,
        filter: { field: "dropInOrder", op: "eq", value: orderId },
        limit: 10,
      });
      // An order of something else: not ours to tell.
      if (!found.items.length) return [];
      const order = await ctx.ops.call<{ email: string | null; state: string }>("order.get", {
        id: orderId,
      });
      const email = text(order.email)?.toLowerCase();
      if (!email || order.state !== "refunded") return [];
      const booking = found.items[0] as RecordShape;
      const cls = await classFacts(ctx, String(booking.values.class));
      const link = httpsLink((await settings(ctx)).bookingsUrl);
      return [
        {
          to: email,
          subject: `Refund made${cls ? `: ${cls.title}` : ""}`,
          text: [
            `Your refund for ${cls ? `${cls.title} on ${classTimeText(cls.startsAt, cls.timezone)}` : "a class"} has been made to the card you paid with. Banks can take a few days to show it.`,
            ...footer(link),
          ].join("\n"),
          related: [orderId, booking.id],
        },
      ];
    });
    if (!letters.length) return { sent: 0 };
    return step.do("send", () => sendAll(ctx, letters));
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

export const bookingsAutomations = {
  bookingConfirmed,
  waitlistPassedOver,
  placeFree,
  classChanged,
  classCancelled,
  classReminder,
  dropInRefunded,
  noAttendanceTaken,
};
