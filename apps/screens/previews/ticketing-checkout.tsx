import {
  createTicketingHooks,
  type Quantities,
  TICKETING_HOOKS_CALL,
  type TicketingOperations,
} from "@composable-os/pack-ticketing/client";
import { useState } from "react";
import { TicketPicker } from "../../../packs/ticketing/blocks/ticketing-checkout/ticket-picker.tsx";
import { fakeClient, react } from "../src/fake.ts";
import { retreat } from "./data/ticketing.ts";

/** What the buyer has chosen when the picture is taken: two places in a shared room. */
const chosen: Quantities = { tt_shared: 2 };

/**
 * The app's useState, except that the picker's quantities (the one state the hooks factory keeps,
 * starting as `{}`) start as `chosen`: the picker as it looks once the buyer has chosen.
 */
function useStateChosen<T>(initial: T) {
  const isQuantities =
    typeof initial === "object" && initial !== null && Object.keys(initial).length === 0;
  return useState<T>(isQuantities ? (chosen as unknown as T) : initial);
}

const ticketing = createTicketingHooks(
  { ...react, useState: useStateChosen },
  fakeClient<TicketingOperations>(TICKETING_HOOKS_CALL, {}),
);

export const width = 560;

export default function Preview() {
  return (
    <TicketPicker
      ticketing={ticketing}
      event={retreat}
      signedIn={false}
      returnUrl="https://example.com/orders"
      onStarted={() => undefined}
    />
  );
}
