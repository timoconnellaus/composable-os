import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { FrontDesk } from "../../../packs/bookings/blocks/bookings-desk/desk.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { deskDay, foundPeople } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, {
    "x.bookings.day": deskDay,
    // Nothing typed yet: the host finds no one for an empty search.
    "x.bookings.findPeople": ({ query }) => (query.length >= 2 ? foundPeople : { people: [] }),
  }),
);

export const width = 720;

export default function Preview() {
  return <FrontDesk bookings={bookings} />;
}
