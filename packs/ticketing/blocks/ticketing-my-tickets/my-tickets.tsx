// A signed-in customer's tickets, for a site (stage 27). Which tickets are theirs, and what of them
// they may see, is the host's (`useMyTickets` reads through the seam).
import type { TicketingHooks } from "@composable-os/pack-ticketing/client";

const STATE = { valid: "Valid", used: "Used", void: "Cancelled" } as const;

export function MyTickets({
  ticketing,
  eventName,
  onShow,
}: {
  ticketing: TicketingHooks;
  /** The event's name for an id, from the app's own list of events (useEventsOnSale). */
  eventName?: (eventId: string | null) => string | null;
  /** Opens one ticket with its code (a QR the app draws). */
  onShow?: (ticket: { id: string; code: string | null }) => void;
}) {
  const { data, isPending, error } = ticketing.useMyTickets();
  if (isPending) return <p aria-busy="true">Loading your tickets…</p>;
  if (error) return <p role="alert">We could not load your tickets.</p>;
  if (!data?.items.length) return <p>You have no tickets yet.</p>;
  return (
    <ul className="grid gap-2">
      {data.items.map((ticket) => (
        <li key={ticket.id} className="flex justify-between gap-4">
          <span>{eventName?.(ticket.event) ?? "Ticket"}</span>
          <span>{STATE[ticket.state as keyof typeof STATE] ?? ticket.state}</span>
          {onShow && ticket.state === "valid" ? (
            <button type="button" onClick={() => onShow({ id: ticket.id, code: ticket.code })}>
              Show code
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
