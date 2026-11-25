import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { DropIn } from "../../../packs/bookings/blocks/bookings-drop-in/drop-in.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { week } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, { "x.bookings.timetable": week }),
);

export const width = 720;

export default function Preview() {
  return (
    <DropIn
      bookings={bookings}
      signedIn={false}
      returnUrl="https://studio.example.com/drop-in/thanks"
    />
  );
}
