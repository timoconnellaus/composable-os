// The booking-system contract (stage 65, ADR 0920): the session every booking-system gatekeeper
// serves, whatever system a business's members book in. Only the host calls it, for the one
// connection a human admin made. It is read only: there is no write of any kind, no outbound
// action and nothing to approve. Times are ISO 8601 with an offset; a date is `YYYY-MM-DD`; a time
// zone is IANA. Each item carries the system's `ref` (stable for the life of the record) and
// `modifiedAt` where the system has one. Nothing else about a person is ever returned: no postal
// address, phone, birth date, card or note.

/** What kinds the system can say changed, and how it sends hints. */
export interface BookingSystemOffers {
  /** Whether `listPeople` and `listClasses` take `modifiedSince`. Without it, it is refused. */
  modifiedSince: { people: boolean; classes: boolean };
  /** `webhooks`: `takeHints` answers what the system said changed. `none`: always empty. */
  hints: "webhooks" | "none";
  /** The most items one page holds. */
  largestPage: number;
}

/** The calls made to the system this month, as the gatekeeper counts them. */
export interface BookingSystemCalls {
  /** `YYYY-MM`, in UTC. */
  month: string;
  used: number;
  /** Past it every read is refused `over_budget`. `null`: no budget. */
  budget: number | null;
  byMethod: Record<string, number>;
}

export interface BookingSystemLocation {
  ref: string;
  name: string;
}

/** The site as a whole. Answered from what the gatekeeper holds, even over budget. */
export interface BookingSystemSite {
  name: string;
  timeZone: string;
  locations: BookingSystemLocation[];
  offers: BookingSystemOffers;
  calls: BookingSystemCalls;
}

/** The system's own member status for a person, mapped. */
export type BookingSystemMemberStatus =
  | "member"
  | "not_member"
  | "suspended"
  | "expired"
  | "ended"
  | "declined";

export interface BookingSystemPerson {
  ref: string;
  /** As the system holds it, not normalised. An address on file is not proof. */
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  memberStatus: BookingSystemMemberStatus;
  active: boolean;
  modifiedAt: string | null;
}

export type BookingSystemMembershipKind = "membership" | "pass";

/** Something the business sells that grants membership (`membership`) or uses (`pass`). */
export interface BookingSystemMembershipType {
  ref: string;
  name: string;
  kind: BookingSystemMembershipKind;
  active: boolean;
}

export type BookingSystemMembershipStatus = "live" | "paused" | "ended" | "cancelled";

/** A membership or a pass one person holds. */
export interface BookingSystemMembership {
  ref: string;
  /** The person's ref. */
  person: string;
  /** The membership type's ref. */
  type: string;
  name: string;
  kind: BookingSystemMembershipKind;
  status: BookingSystemMembershipStatus;
  /** Dates; `null` where the system has none. */
  from: string | null;
  until: string | null;
  /** A pass's uses; `null` for a membership or an unlimited pass. */
  usesTotal: number | null;
  usesLeft: number | null;
  /** Whether it charges again. */
  renews: boolean;
}

export interface BookingSystemClassType {
  ref: string;
  name: string;
  /** Short; at most 500 characters. */
  description: string | null;
  active: boolean;
}

/** One scheduled class. */
export interface BookingSystemClass {
  ref: string;
  /** The class type's ref. */
  classType: string;
  title: string;
  startsAt: string;
  endsAt: string;
  /** A location's ref from `describeSite`. */
  location: string | null;
  /** The staff member's ref. */
  staff: string | null;
  /** `null`: no limit. */
  places: number | null;
  booked: number;
  waiting: number;
  cancelled: boolean;
  modifiedAt: string | null;
}

export type BookingSystemBookingState =
  | "booked"
  | "waiting"
  | "attended"
  | "late_cancelled"
  | "no_show"
  | "cancelled";

export interface BookingSystemBooking {
  ref: string;
  /** The class's ref. */
  class: string;
  /** The person's ref. */
  person: string;
  state: BookingSystemBookingState;
  modifiedAt: string | null;
}

/** Only a display name and, where the system gives it, an address. Nothing else about them. */
export interface BookingSystemStaff {
  ref: string;
  displayName: string;
  email: string | null;
  active: boolean;
}

export type BookingSystemHintKind =
  | "person"
  | "membership"
  | "class"
  | "booking"
  | "staff"
  | "site";

/** Says what to read again. Never the data itself. */
export interface BookingSystemHint {
  kind: BookingSystemHintKind;
  refs: string[];
}

/** A page of a list. `cursor` asks for the next one with the same filter; `null`: the last page. */
export interface BookingSystemPage<T> {
  items: T[];
  cursor: string | null;
}

export interface BookingSystemPeopleQuery {
  /** Only people modified at or after this time. */
  modifiedSince?: string;
  /** Only these people, at most 200. */
  refs?: string[];
  cursor?: string;
}

export interface BookingSystemClassesQuery {
  /** Classes starting at or after `from` and before `until`: at most 35 days. */
  from: string;
  until: string;
  modifiedSince?: string;
  cursor?: string;
}

export interface BookingSystemVisitsQuery {
  person: string;
  /** At most 366 days. */
  from: string;
  until: string;
  cursor?: string;
}

/**
 * Why a read was refused, at the start of the error's message as `[booking-system:<code>] `.
 * `rate_limited` and `unavailable` are transient; `unauthorised` and `not_activated` mean the
 * connection's credentials no longer reach the site.
 */
export type BookingSystemRefusalCode =
  | "unauthorised"
  | "not_activated"
  | "rate_limited"
  | "over_budget"
  | "unavailable"
  | "invalid";

export interface BookingSystemSession {
  describeSite(): Promise<BookingSystemSite>;
  listPeople(query?: BookingSystemPeopleQuery): Promise<BookingSystemPage<BookingSystemPerson>>;
  listMembershipTypes(): Promise<BookingSystemMembershipType[]>;
  /** For 1 to 200 people. */
  listMemberships(input: { people: string[] }): Promise<BookingSystemMembership[]>;
  listClassTypes(): Promise<BookingSystemClassType[]>;
  listClasses(query: BookingSystemClassesQuery): Promise<BookingSystemPage<BookingSystemClass>>;
  /** For 1 to 50 classes. */
  listBookings(input: { classes: string[] }): Promise<BookingSystemBooking[]>;
  listStaff(): Promise<BookingSystemStaff[]>;
  /** One person's past bookings, in their final states only. For a move away; never synced. */
  listVisits(query: BookingSystemVisitsQuery): Promise<BookingSystemPage<BookingSystemBooking>>;
  /** The hints received since the last take, at most `max` (1 to 100); each is taken once. */
  takeHints(input: { max: number }): Promise<BookingSystemHint[]>;
}
