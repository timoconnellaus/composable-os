import {
  createTicketingHooks,
  TICKETING_HOOKS_CALL,
  type TicketingOperations,
} from "@composable-os/pack-ticketing/client";
import { MyTickets } from "../../../packs/ticketing/blocks/ticketing-my-tickets/my-tickets.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { myTickets } from "./data/ticketing.ts";

const ticketing = createTicketingHooks(
  react,
  fakeClient<TicketingOperations>(TICKETING_HOOKS_CALL, { "x.ticketing.myTickets": myTickets }),
);

export const width = 640;

export default function Preview() {
  return <MyTickets ticketing={ticketing} onShow={() => undefined} />;
}
