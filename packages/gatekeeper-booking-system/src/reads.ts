// The contract's reads over a system: each input checked (validate.ts), each answer copied into
// the contract's shape and held to its limits. The gatekeeper's session (session.ts) and the
// direct session (direct.ts) both serve exactly this; the session also records each read as an
// observation first, through `before`.

import type { BookingSystem } from "./system.js";
import type { BookingSystemSession } from "./types.js";
import {
  MAX_HINTS,
  parseBookingsInput,
  parseClassesQuery,
  parseHintsInput,
  parseMembershipsInput,
  parsePeopleQuery,
  parseVisitsQuery,
  shapeBooking,
  shapeClass,
  shapeClassType,
  shapeHint,
  shapeMembership,
  shapeMembershipType,
  shapePage,
  shapePerson,
  shapeSite,
  shapeStaff,
} from "./validate.js";

/** What a read is, for a person reading the observations: a title and what was asked. */
export type ReadNote = { title: string; description: string };

export function checkedReads(
  system: () => BookingSystem,
  before: (note: ReadNote) => Promise<void> = async () => {},
): BookingSystemSession {
  return {
    async describeSite() {
      const s = system();
      await before({ title: "Read the booking system's site", description: "Read the site" });
      return shapeSite(await s.describeSite());
    },
    async listPeople(query) {
      const parsed = parsePeopleQuery(query);
      const s = system();
      await before({
        title: "Read people in the booking system",
        description: parsed.refs
          ? `Read ${parsed.refs.length} named person(s)`
          : parsed.modifiedSince
            ? `Read people changed since ${parsed.modifiedSince}`
            : "Read a page of people",
      });
      return shapePage(await s.listPeople(parsed), shapePerson);
    },
    async listMembershipTypes() {
      const s = system();
      await before({
        title: "Read the booking system's membership types",
        description: "Read what the business sells as memberships and passes",
      });
      return (await s.listMembershipTypes()).map(shapeMembershipType);
    },
    async listMemberships(input) {
      const { people } = parseMembershipsInput(input);
      const s = system();
      await before({
        title: "Read memberships in the booking system",
        description: `Read the memberships and passes of ${people.length} person(s)`,
      });
      const asked = new Set(people);
      return (await s.listMemberships(people))
        .filter((m) => asked.has(m.person))
        .map(shapeMembership);
    },
    async listClassTypes() {
      const s = system();
      await before({
        title: "Read the booking system's class types",
        description: "Read class types",
      });
      return (await s.listClassTypes()).map(shapeClassType);
    },
    async listClasses(query) {
      const parsed = parseClassesQuery(query);
      const s = system();
      await before({
        title: "Read classes in the booking system",
        description: `Read classes from ${parsed.from} to ${parsed.until}`,
      });
      return shapePage(await s.listClasses(parsed), shapeClass);
    },
    async listBookings(input) {
      const { classes } = parseBookingsInput(input);
      const s = system();
      await before({
        title: "Read bookings in the booking system",
        description: `Read who is booked in ${classes.length} class(es)`,
      });
      const asked = new Set(classes);
      return (await s.listBookings(classes)).filter((b) => asked.has(b.class)).map(shapeBooking);
    },
    async listStaff() {
      const s = system();
      await before({ title: "Read the booking system's staff", description: "Read staff names" });
      return (await s.listStaff()).map(shapeStaff);
    },
    async listVisits(query) {
      const parsed = parseVisitsQuery(query);
      const s = system();
      await before({
        title: "Read a person's visits in the booking system",
        description: `Read ${parsed.person}'s visits from ${parsed.from} to ${parsed.until}`,
      });
      const page = shapePage(await s.listVisits(parsed), shapeBooking);
      return { ...page, items: page.items.filter((b) => b.person === parsed.person) };
    },
    async takeHints(input) {
      const { max } = parseHintsInput(input);
      const s = system();
      await before({ title: "Take the booking system's hints", description: "Took what changed" });
      return (await s.takeHints(max)).slice(0, Math.min(max, MAX_HINTS)).map(shapeHint);
    },
  };
}
