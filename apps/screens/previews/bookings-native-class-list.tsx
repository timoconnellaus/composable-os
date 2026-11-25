import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { ClassListScreen } from "../../../packs/bookings/blocks/bookings-native-class-list/class-list-screen.tsx";
import { fakeClient, react, TIME_ZONE, TODAY } from "../src/fake.ts";
import { hiitRoster, monday } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, {
    "x.bookings.day": monday,
    "x.bookings.roster": hiitRoster,
  }),
);

export default function Preview() {
  return <ClassListScreen bookings={bookings} date={TODAY} timeZone={TIME_ZONE} />;
}

/** The picture shows a class's list: the coach opens the first class. */
export const click = "Morning HIIT";
