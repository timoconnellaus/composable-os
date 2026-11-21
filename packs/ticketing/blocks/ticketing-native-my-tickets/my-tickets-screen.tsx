// A signed-in customer's tickets, for the mobile app's Tickets tab (stage 27). Which tickets are
// theirs, and what of them they may see, is the host's (`useMyTickets` reads through the seam).
import type { TicketingHooks } from "@composable-os/pack-ticketing/client";
import { Text } from "react-native";
import { List } from "../native-base/list.tsx";
import { Row } from "../native-base/row.tsx";
import { Screen } from "../native-base/screen.tsx";

const STATE = { valid: "Valid", used: "Used", void: "Cancelled" } as const;

export function MyTicketsScreen({
  ticketing,
  eventName,
  onOpen,
}: {
  ticketing: TicketingHooks;
  /** The event's name for an id, from the app's own list of events. */
  eventName?: (eventId: string | null) => string | null;
  /** Pushes the ticket's screen (TicketScreen) on the app's native stack. */
  onOpen: (ticket: { id: string; code: string | null; event: string | null }) => void;
}) {
  const { data, isPending, error } = ticketing.useMyTickets();
  return (
    <Screen title="Tickets">
      {isPending ? <Text accessibilityRole="progressbar">Loading your tickets…</Text> : null}
      {error ? <Text accessibilityRole="alert">We could not load your tickets.</Text> : null}
      {data ? (
        <List empty="You have no tickets yet.">
          {data.items.map((ticket) => (
            <Row
              key={ticket.id}
              title={eventName?.(ticket.event) ?? "Ticket"}
              detail={STATE[ticket.state as keyof typeof STATE] ?? ticket.state}
              onPress={ticket.state === "valid" ? () => onOpen(ticket) : undefined}
            />
          ))}
        </List>
      ) : null}
    </Screen>
  );
}
