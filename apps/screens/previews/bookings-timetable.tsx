import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { Timetable } from "../../../packs/bookings/blocks/bookings-timetable/timetable.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { family, myWeek, week } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, {
    "x.bookings.timetable": week,
    "me.family": family,
    "x.bookings.mine": myWeek,
  }),
);

export const width = 720;

export default function Preview() {
  return <Timetable bookings={bookings} payReturnUrl="https://studio.example.com/timetable" />;
}
