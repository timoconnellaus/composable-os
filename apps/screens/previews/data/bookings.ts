// Dummy data the Bookings previews share: one studio's Monday.
import type { BookingsOperations } from "@composable-os/pack-bookings/client";
import { at, dayAfter, TIME_ZONE, TODAY } from "../../src/fake.ts";

type Out<K extends keyof BookingsOperations> = BookingsOperations[K]["output"];
type StaffClass = Out<"x.bookings.day">["classes"][number];

function staffClass(c: Partial<StaffClass> & Pick<StaffClass, "id" | "title">): StaffClass {
  return {
    classType: { id: `ct_${c.id}`, name: c.title },
    startsAt: at("09:00"),
    endsAt: at("10:00"),
    timeZone: TIME_ZONE,
    coach: "Sam Rivera",
    room: "Studio 1",
    places: 16,
    booked: 0,
    held: 0,
    available: 16,
    state: "scheduled",
    staffOnly: false,
    ...c,
  };
}

export const monday: Out<"x.bookings.day"> = {
  date: TODAY,
  classes: [
    staffClass({
      id: "cls_1",
      title: "Morning HIIT",
      startsAt: at("06:30"),
      endsAt: at("07:15"),
      booked: 14,
      available: 2,
    }),
    staffClass({
      id: "cls_2",
      title: "Strength Foundations",
      startsAt: at("09:30"),
      endsAt: at("10:30"),
      coach: "Alex Chen",
      booked: 8,
      available: 8,
    }),
    staffClass({
      id: "cls_3",
      title: "Lunchtime Yoga",
      startsAt: at("12:15"),
      endsAt: at("13:00"),
      room: "Studio 2",
      coach: "Priya Shah",
      places: 20,
      booked: 20,
      available: 0,
    }),
    staffClass({
      id: "cls_4",
      title: "Evening Spin",
      startsAt: at("18:00"),
      endsAt: at("18:45"),
      room: "Bike room",
      booked: 11,
      available: 5,
    }),
  ],
};

const person = (id: string, name: string) => ({ id, name });

export const hiitRoster: Out<"x.bookings.roster"> = {
  class: monday.classes[0] as StaffClass,
  bookings: [
    {
      id: "bk_1",
      person: person("p_1", "Jordan Lee"),
      state: "attended",
      markedAt: at("06:24"),
      markedBy: "Sam Rivera",
      promotedAt: null,
      healthNote: false,
    },
    {
      id: "bk_2",
      person: person("p_2", "Maya Patel"),
      state: "attended",
      markedAt: at("06:26"),
      markedBy: "Sam Rivera",
      promotedAt: null,
      healthNote: true,
    },
    {
      id: "bk_3",
      person: person("p_3", "Chris Okafor"),
      state: "booked",
      markedAt: null,
      markedBy: null,
      promotedAt: null,
      healthNote: false,
    },
    {
      id: "bk_4",
      person: person("p_4", "Ella Novak"),
      state: "booked",
      markedAt: null,
      markedBy: null,
      promotedAt: null,
      healthNote: false,
    },
    {
      id: "bk_5",
      person: person("p_5", "Tom Becker"),
      state: "no_show",
      markedAt: at("06:40"),
      markedBy: "Sam Rivera",
      promotedAt: null,
      healthNote: false,
    },
    {
      id: "bk_6",
      person: person("p_6", "Ana Silva"),
      state: "waiting",
      markedAt: null,
      markedBy: null,
      promotedAt: null,
      healthNote: false,
    },
  ],
};

// --- The member's week (the timetable, the drop-in) ------------------------------------------------

type MemberClass = Out<"x.bookings.timetable">["classes"][number];

function memberClass(
  c: Pick<MemberClass, "id" | "title"> & {
    day: number;
    from: string;
    to: string;
    coach: string;
    room: string;
    left: number | null;
  },
): MemberClass {
  const date = dayAfter(c.day);
  return {
    id: c.id,
    title: c.title,
    classType: c.title,
    startsAt: at(c.from, date),
    endsAt: at(c.to, date),
    timeZone: TIME_ZONE,
    room: { id: `rm_${c.room}`, name: c.room },
    coach: { id: `co_${c.coach}`, name: c.coach, photo: null },
    notes: null,
    places:
      c.left === 0
        ? { status: "sold_out", available: 0 }
        : { status: c.left !== null && c.left <= 3 ? "low" : "available", available: c.left },
  };
}

export const week: Out<"x.bookings.timetable"> = {
  classes: [
    memberClass({
      id: "cls_4",
      title: "Evening Spin",
      day: 0,
      from: "18:00",
      to: "18:45",
      coach: "Sam Rivera",
      room: "Bike room",
      left: 5,
    }),
    memberClass({
      id: "cls_5",
      title: "Morning HIIT",
      day: 1,
      from: "06:30",
      to: "07:15",
      coach: "Sam Rivera",
      room: "Studio 1",
      left: 2,
    }),
    memberClass({
      id: "cls_6",
      title: "Mobility Flow",
      day: 1,
      from: "12:15",
      to: "13:00",
      coach: "Priya Shah",
      room: "Studio 2",
      left: 11,
    }),
    memberClass({
      id: "cls_7",
      title: "Strength Foundations",
      day: 2,
      from: "07:00",
      to: "08:00",
      coach: "Alex Chen",
      room: "Studio 1",
      left: 0,
    }),
    memberClass({
      id: "cls_8",
      title: "Boxing Basics",
      day: 2,
      from: "18:30",
      to: "19:30",
      coach: "Dani Moreau",
      room: "Studio 1",
      left: 7,
    }),
    memberClass({
      id: "cls_9",
      title: "Lunchtime Yoga",
      day: 3,
      from: "12:15",
      to: "13:00",
      coach: "Priya Shah",
      room: "Studio 2",
      left: 9,
    }),
  ],
};

/** Whom the member acts for (`me.family`, which the Bookings blocks read). */
export const family: Out<"me.family"> = {
  self: { personId: "p_10", name: "Rachel Moore" },
  dependants: [{ personId: "p_11", name: "Leo Moore" }],
  guardians: [],
};

export const justMe: Out<"me.family"> = {
  self: { personId: "p_10", name: "Rachel Moore" },
  dependants: [],
  guardians: [],
};

type MyBooking = Out<"x.bookings.mine">["bookings"][number];

function myBooking(id: string, klass: MemberClass): MyBooking {
  return {
    id,
    personId: "p_10",
    state: "booked",
    position: null,
    holderId: "hold_1",
    dropInOrderId: null,
    classId: klass.id,
    title: klass.title,
    startsAt: klass.startsAt,
    endsAt: klass.endsAt,
    timeZone: klass.timeZone,
    classState: "scheduled",
    coach: klass.coach?.name ?? null,
    room: klass.room?.name ?? null,
  };
}

export const myWeek: Out<"x.bookings.mine"> = {
  bookings: [
    myBooking("bk_20", week.classes[1] as MemberClass),
    myBooking("bk_21", week.classes[4] as MemberClass),
  ],
};

// --- The front desk ---------------------------------------------------------------------------------

export const deskDay: Out<"x.bookings.day"> = {
  date: TODAY,
  classes: [
    { ...(monday.classes[0] as StaffClass), state: "done" },
    ...monday.classes.slice(1, 3),
    staffClass({
      id: "cls_10",
      title: "Personal Training",
      startsAt: at("15:00"),
      endsAt: at("16:00"),
      coach: "Alex Chen",
      places: 1,
      booked: 1,
      available: 0,
      staffOnly: true,
    }),
    ...monday.classes.slice(3),
  ],
};

export const foundPeople: Out<"x.bookings.findPeople"> = {
  people: [
    { id: "p_20", name: "Hannah Brooks", email: "hannah.brooks@example.com" },
    { id: "p_21", name: "Hannah Lindqvist", email: "h.lindqvist@example.com" },
  ],
};
