import {
  createTicketingHooks,
  TICKETING_HOOKS_CALL,
  type TicketingOperations,
} from "@composable-os/pack-ticketing/client";
import { OrderConfirmation } from "../../../packs/ticketing/blocks/ticketing-order/order-confirmation.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { supperOrder } from "./data/ticketing.ts";

const ticketing = createTicketingHooks(
  react,
  fakeClient<TicketingOperations>(TICKETING_HOOKS_CALL, { "order.get": supperOrder }),
);

export const width = 640;

export default function Preview() {
  return <OrderConfirmation ticketing={ticketing} order={{ id: supperOrder.id }} />;
}
