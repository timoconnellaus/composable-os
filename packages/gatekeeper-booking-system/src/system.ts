// The booking system behind a gatekeeper: what each one (the fake here, a named system in its own
// gatekeeper) implements, in the contract's own types. The shared reads (reads.ts) check every
// input, cap every list at the contract's limits and copy every answer into the contract's shape;
// a system only talks to its API. It throws `refuse(code, …)` for every failure it can name, and
// counts every call it makes to its API, failed ones too.

import type {
  BookingSystemBooking,
  BookingSystemClass,
  BookingSystemClassesQuery,
  BookingSystemClassType,
  BookingSystemHint,
  BookingSystemMembership,
  BookingSystemMembershipType,
  BookingSystemPage,
  BookingSystemPeopleQuery,
  BookingSystemPerson,
  BookingSystemSite,
  BookingSystemStaff,
  BookingSystemVisitsQuery,
} from "./types.js";

export interface BookingSystem {
  /** For people: "Fake booking system (development)", or the system's own name. */
  readonly title: string;
  describeSite(): Promise<BookingSystemSite>;
  listPeople(query: BookingSystemPeopleQuery): Promise<BookingSystemPage<BookingSystemPerson>>;
  listMembershipTypes(): Promise<BookingSystemMembershipType[]>;
  listMemberships(people: string[]): Promise<BookingSystemMembership[]>;
  listClassTypes(): Promise<BookingSystemClassType[]>;
  listClasses(query: BookingSystemClassesQuery): Promise<BookingSystemPage<BookingSystemClass>>;
  listBookings(classes: string[]): Promise<BookingSystemBooking[]>;
  listStaff(): Promise<BookingSystemStaff[]>;
  listVisits(query: BookingSystemVisitsQuery): Promise<BookingSystemPage<BookingSystemBooking>>;
  /** Removes and answers at most `max` hints, oldest first. */
  takeHints(max: number): Promise<BookingSystemHint[]>;
}
