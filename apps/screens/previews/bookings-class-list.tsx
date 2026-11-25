import {
  BOOKINGS_HOOKS_CALL,
  type BookingsOperations,
  createBookingsHooks,
} from "@composable-os/pack-bookings/client";
import { ClassList } from "../../../packs/bookings/blocks/bookings-class-list/class-list.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { hiitRoster } from "./data/bookings.ts";

const bookings = createBookingsHooks(
  react,
  fakeClient<BookingsOperations>(BOOKINGS_HOOKS_CALL, { "x.bookings.roster": hiitRoster }),
);

export const width = 720;

export default function Preview() {
  return <ClassList bookings={bookings} classId="cls_1" />;
}
