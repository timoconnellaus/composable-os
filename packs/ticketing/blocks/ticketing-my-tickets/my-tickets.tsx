// A signed-in customer's tickets, for a site (stage 27). Which tickets are theirs, and what of them
// they may see, is the host's (`useMyTickets` reads through the seam).
import type { TicketingHooks } from "@composable-os/pack-ticketing/client";
import { eventTime, ticketStateLabel } from "@composable-os/pack-ticketing/client";
import { Button } from "../ui-button/button.tsx";

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
    <ul className="grid gap-2" aria-label="Your tickets">
      {data.items.map((ticket) => (
        <li
          key={ticket.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
        >
          <div className="grid gap-1">
            <strong>{ticket.eventName ?? "Ticket"}</strong>
            <span className="text-muted-foreground text-sm">
              {[
                ticket.ticketTypeName,
                ticket.startsAt ? eventTime(ticket) : null,
                ticketStateLabel(ticket.state),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          {onShow && ticket.state === "valid" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onShow({ id: ticket.id, code: ticket.code })}
            >
              Show code
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
