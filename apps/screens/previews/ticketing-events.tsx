import {
  createTicketingHooks,
  TICKETING_HOOKS_CALL,
  type TicketingOperations,
} from "@composable-os/pack-ticketing/client";
import { EventList } from "../../../packs/ticketing/blocks/ticketing-events/event-list.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { onSale } from "./data/ticketing.ts";

const ticketing = createTicketingHooks(
  react,
  fakeClient<TicketingOperations>(TICKETING_HOOKS_CALL, { "x.ticketing.eventsOnSale": onSale }),
);

export const width = 720;

export default function Preview() {
  return <EventList ticketing={ticketing} onOpen={() => undefined} />;
}
