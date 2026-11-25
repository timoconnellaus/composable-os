import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { TimetableScreen } from "../../../packs/bookings/blocks/bookings-native-timetable/timetable-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { justMe, myWeek, week } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, {
    "x.bookings.timetable": week,
    "x.bookings.family": justMe,
    "x.bookings.mine": myWeek,
  }),
);

export default function Preview() {
  return <TimetableScreen bookings={bookings} />;
}
