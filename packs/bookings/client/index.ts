// The Bookings pack's headless entry (stage 31a step 3; ADR 0418): functions and hooks over the
// typed client, no markup. A client app imports it as `@composable-os/pack-bookings/client` and
// hands it its generated client; the bookings blocks (web and native) render what it returns.
// Web and native share this logic, not their screens.
//
// As every pack's entry: the operations are typed from the pack's own tool schemas, it takes the
// client and the app's `useQuery` and `useMutation` as arguments (no React or TanStack import),
// and it holds no rules. When booking opens, whether a cancel is late, whether a class type is
// booked by the gym, the places left and what a booking spends are the host's: a block shows the
// host's answer (`book`'s and `cancel`'s), never works one out.
import { type ClientHolding, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type {
  book,
  bookFor,
  buy,
  cancel,
  cancelClass,
  cancelFor,
  classGet,
  classList,
  day,
  family,
  findPeople,
  leaveWaitlist,
  markAll,
  markAttended,
  markNoShow,
  mine,
  move,
  returnUse,
  roster,
  timetable,
  undoAttended,
} from "../tools.ts";

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** The operations this entry calls, as the generated client types them. */
export type BookingsOperations = {
  "x.bookings.timetable": { kind: "query" } & Io<typeof timetable>;
  "x.bookings.classGet": { kind: "query" } & Io<typeof classGet>;
  "x.bookings.mine": { kind: "query" } & Io<typeof mine>;
  "x.bookings.family": { kind: "query" } & Io<typeof family>;
  "x.bookings.book": { kind: "mutation" } & Io<typeof book>;
  "x.bookings.cancel": { kind: "mutation" } & Io<typeof cancel>;
  "x.bookings.leaveWaitlist": { kind: "mutation" } & Io<typeof leaveWaitlist>;
  "x.bookings.day": { kind: "query" } & Io<typeof day>;
  "x.bookings.classList": { kind: "query" } & Io<typeof classList>;
  "x.bookings.bookFor": { kind: "mutation" } & Io<typeof bookFor>;
  "x.bookings.cancelFor": { kind: "mutation" } & Io<typeof cancelFor>;
  "x.bookings.returnUse": { kind: "mutation" } & Io<typeof returnUse>;
  "x.bookings.findPeople": { kind: "query" } & Io<typeof findPeople>;
  // A drop-in (ADR 0560): the booking held with its order, then the provider's page (web only).
  "x.bookings.buy": { kind: "mutation" } & Io<typeof buy>;
  "order.checkout": {
    kind: "mutation";
    input: { id: string; token?: string; returnUrl: string };
    output: { url: string };
  };
  "x.bookings.roster": { kind: "query" } & Io<typeof roster>;
  "x.bookings.markAttended": { kind: "mutation" } & Io<typeof markAttended>;
  "x.bookings.undoAttended": { kind: "mutation" } & Io<typeof undoAttended>;
  "x.bookings.markNoShow": { kind: "mutation" } & Io<typeof markNoShow>;
  "x.bookings.markAll": { kind: "mutation" } & Io<typeof markAll>;
  "x.bookings.move": { kind: "mutation" } & Io<typeof move>;
  "x.bookings.cancelClass": { kind: "mutation" } & Io<typeof cancelClass>;
};

type Name = keyof BookingsOperations & string;
type In<N extends Name> = BookingsOperations[N]["input"];
type Out<N extends Name> = BookingsOperations[N]["output"];

export type Timetable = Out<"x.bookings.timetable">;
export type TimetableClass = Timetable["classes"][number];
export type MyBookings = Out<"x.bookings.mine">;
export type MyBooking = MyBookings["bookings"][number];
export type Family = Out<"x.bookings.family">;
export type FamilyPerson = Family["people"][number];
export type BookResult = Out<"x.bookings.book">;
export type CancelResult = Out<"x.bookings.cancel">;
export type DayView = Out<"x.bookings.day">;
export type ClassListView = Out<"x.bookings.classList">;
export type RosterView = Out<"x.bookings.roster">;
export type MarkResult = Out<"x.bookings.markAttended">;
export type BookForResult = Out<"x.bookings.bookFor">;
export type BuyResult = Out<"x.bookings.buy">;
export type FoundPeople = Out<"x.bookings.findPeople">;

/** The client of every operation this entry calls (ADR 0453). */
export type BookingsClient = PackClient<BookingsOperations>;

// --- Plain functions (display only) --------------------------------------------------------------

/** A class's start and end in its own zone ("Tue 3 Mar, 06:00–07:00"), for display. */
export function classTime(
  klass: { startsAt: string | null; endsAt: string | null; timeZone: string | null },
  locale = "en-AU",
): string {
  if (!klass.startsAt) return "";
  const zone = klass.timeZone ?? undefined;
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(zone ? { timeZone: zone } : {}),
  }).format(new Date(klass.startsAt));
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}),
    }).format(new Date(iso));
  return `${day}, ${time(klass.startsAt)}${klass.endsAt ? `–${time(klass.endsAt)}` : ""}`;
}

/** What a class's places say ("5 places left", "Full"), from the host's numbers. */
export function placesLabel(places: TimetableClass["places"]): string {
  if (places.status === "sold_out") return "Full";
  if (places.available === undefined || places.available === null) return "Places available";
  return places.available === 1 ? "1 place left" : `${places.available} places left`;
}

/** The message to show for a refusal the host gave (with when booking opens, if it said). */
export function refusalMessage(
  result: { message: string; opensAt: string | null; reason: string },
  zone: string | null,
  locale = "en-AU",
): string {
  if (result.reason === "not_open" && result.opensAt) {
    const when = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}),
    }).format(new Date(result.opensAt));
    return `Booking opens ${when}.`;
  }
  return result.message;
}

/** The digits of a currency's minor unit (2 for AUD, 0 for JPY). */
function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** An amount the host gave in the minor unit, as a buyer reads it: `25.00 AUD`. Display only. */
export function formatAmount(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
}

/** The member's live booking of a class, if any (to show Cancel instead of Book). */
export function bookingFor(
  classId: string,
  bookings: readonly MyBooking[] | undefined,
): MyBooking | undefined {
  return bookings?.find((b) => b.classId === classId && b.state === "booked");
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
}) => { data: T | undefined; isPending: boolean; error: unknown; refetch?: () => unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
};

/**
 * The operations each hook calls (ADR 0453). A customer's client gets the member's hooks (the
 * timetable, book, cancel, mine), the public's only the timetable and a class, the staff client
 * all of them.
 */
export const BOOKINGS_HOOKS_CALL = {
  useTimetable: ["x.bookings.timetable"],
  useClass: ["x.bookings.classGet"],
  useMyBookings: ["x.bookings.mine"],
  useFamily: ["x.bookings.family"],
  useBook: ["x.bookings.book"],
  useCancel: ["x.bookings.cancel"],
  useLeaveWaitlist: ["x.bookings.leaveWaitlist"],
  useDay: ["x.bookings.day"],
  useClassList: ["x.bookings.classList"],
  useBookFor: ["x.bookings.bookFor"],
  useCancelFor: ["x.bookings.cancelFor"],
  useReturnUse: ["x.bookings.returnUse"],
  useFindPeople: ["x.bookings.findPeople"],
  // Paying for one class (a drop-in): a purchase, so web only (native blocks are noPurchase).
  useBuy: ["x.bookings.buy", "order.checkout"],
  useRoster: ["x.bookings.roster"],
  useMarkAttended: ["x.bookings.markAttended"],
  useUndoAttended: ["x.bookings.undoAttended"],
  useMarkNoShow: ["x.bookings.markNoShow"],
  useMarkAll: ["x.bookings.markAll"],
  useMove: ["x.bookings.move"],
  useCancelClass: ["x.bookings.cancelClass"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const bookings = createBookingsHooks({ useQuery, useMutation }, api)`. `api` is any generated
 * client: the customer's or the staff one. The hooks it cannot back are not there.
 */
export function createBookingsHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, BOOKINGS_HOOKS_CALL, (api: BookingsClient) =>
    allBookingsHooks(react, api),
  );
}

function allBookingsHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: BookingsClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** The timetable between two times (default: the next 7 days). */
    useTimetable(input: In<"x.bookings.timetable"> = {}) {
      return useQuery(api.query("x.bookings.timetable", input));
    },
    /** One scheduled class. */
    useClass(input: In<"x.bookings.classGet">) {
      return useQuery(api.query("x.bookings.classGet", input));
    },
    /** The signed-in member's own bookings, or (with personId) a child's linked to them. */
    useMyBookings(input: In<"x.bookings.mine"> = {}) {
      return useQuery(api.query("x.bookings.mine", input));
    },
    /** Who the member may book for: themselves and the children staff linked to them. */
    useFamily() {
      return useQuery(api.query("x.bookings.family", {}));
    },
    /** Books the member into a class; the host answers booked, waiting (full) or why not. */
    useBook() {
      return useMutation(api.mutation("x.bookings.book"));
    },
    /** Cancels a booking: first the host's preview (in time or late), then with confirm. */
    useCancel() {
      return useMutation(api.mutation("x.bookings.cancel"));
    },
    /** Takes the member off a class's waitlist (a booking that is waiting). */
    useLeaveWaitlist() {
      return useMutation(api.mutation("x.bookings.leaveWaitlist"));
    },
    /** Staff: one local date's classes. */
    useDay(input: In<"x.bookings.day">) {
      return useQuery(api.query("x.bookings.day", input));
    },
    /** Staff: a class's list. */
    useClassList(input: In<"x.bookings.classList">) {
      return useQuery(api.query("x.bookings.classList", input));
    },
    /** Staff: book anyone, a walk-in included. */
    useBookFor() {
      return useMutation(api.mutation("x.bookings.bookFor"));
    },
    /** Staff: cancel a booking, in time or late by the host's clock. */
    useCancelFor() {
      return useMutation(api.mutation("x.bookings.cancelFor"));
    },
    /** A person on the staff: give a booking's use back after the late point (destructive). */
    useReturnUse() {
      return useMutation(api.mutation("x.bookings.returnUse"));
    },
    /**
     * Pay for one class (a drop-in, web only): `start` has the host hold the place and start the
     * order; `checkout` opens the provider's page for it.
     */
    useBuy() {
      return {
        start: useMutation(api.mutation("x.bookings.buy")),
        checkout: useMutation(api.mutation("order.checkout")),
      };
    },
    /** Staff: People on file matching a name or email (at least two letters). */
    useFindPeople(input: In<"x.bookings.findPeople">) {
      return useQuery({
        ...api.query("x.bookings.findPeople", input),
        enabled: input.query.trim().length >= 2,
      });
    },
    /** A coach or staff: a class's list with names and marks (nothing of what anyone paid). */
    useRoster(input: In<"x.bookings.roster">) {
      return useQuery(api.query("x.bookings.roster", input));
    },
    /** A coach or staff: tick a name; the host says if someone ticked it first, and who. */
    useMarkAttended() {
      return useMutation(api.mutation("x.bookings.markAttended"));
    },
    /** A coach or staff: untick a name ticked by mistake. */
    useUndoAttended() {
      return useMutation(api.mutation("x.bookings.undoAttended"));
    },
    /** A coach or staff: mark a name as not come, once the class has started. */
    useMarkNoShow() {
      return useMutation(api.mutation("x.bookings.markNoShow"));
    },
    /** A coach or staff: tick everyone still booked on a class. */
    useMarkAll() {
      return useMutation(api.mutation("x.bookings.markAll"));
    },
    /** Staff: move a booking to another class with its use (refused whole when it cannot). */
    useMove() {
      return useMutation(api.mutation("x.bookings.move"));
    },
    /** A person on the staff: cancel a class and its bookings (an AI's call waits for one). */
    useCancelClass() {
      return useMutation(api.mutation("x.bookings.cancelClass"));
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<BookingsHooks, "useBook">`. */
export type BookingsHooks = ReturnType<typeof allBookingsHooks>;
