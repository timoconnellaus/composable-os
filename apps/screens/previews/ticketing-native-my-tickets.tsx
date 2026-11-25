import {
  createTicketingHooks,
  TICKETING_HOOKS_CALL,
  type TicketingOperations,
} from "@composable-os/pack-ticketing/client";
import { MyTicketsScreen } from "../../../packs/ticketing/blocks/ticketing-native-my-tickets/my-tickets-screen.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { myTickets } from "./data/ticketing.ts";

const ticketing = createTicketingHooks(
  react,
  fakeClient<TicketingOperations>(TICKETING_HOOKS_CALL, { "x.ticketing.myTickets": myTickets }),
);

export default function Preview() {
  return <MyTicketsScreen ticketing={ticketing} onOpen={() => undefined} />;
}
