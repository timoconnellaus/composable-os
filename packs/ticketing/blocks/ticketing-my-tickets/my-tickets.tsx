// A signed-in customer's tickets, for a site (stage 27). Which tickets are theirs, and what of them
// they may see, is the host's (`useMyTickets` reads through the seam).
import type { TicketingHooks } from "@composable-os/pack-ticketing/client";
import { eventTime, ticketStateLabel } from "@composable-os/pack-ticketing/client";

export function MyTickets({
  ticketing,
  onShow,
}: {
  ticketing: Pick<TicketingHooks, "useMyTickets">;
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
          <span>
            {ticket.eventName ?? "Ticket"}
            {ticket.ticketTypeName ? ` · ${ticket.ticketTypeName}` : ""}
            {ticket.startsAt ? ` · ${eventTime(ticket)}` : ""}
          </span>
          <span>{ticketStateLabel(ticket.state)}</span>
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
