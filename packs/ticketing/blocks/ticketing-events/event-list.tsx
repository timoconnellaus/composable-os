// The events on sale, and one event's details, for a site's events page (stage 27). Built on the
// web base layer. What is on sale, the prices and the places left are the host's
// (`useEventsOnSale`); this lays them out.
import type { EventOnSale, TicketingHooks } from "@composable-os/pack-ticketing/client";
import { availabilityLabel, formatPrice } from "@composable-os/pack-ticketing/client";
import type { ReactNode } from "react";
import { Button } from "../ui-button/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-card/card.tsx";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;

/** Every event on sale, soonest first, each with a button to open it. */
export function EventList({
  ticketing,
  onOpen,
}: {
  ticketing: TicketingHooks;
  onOpen: (event: EventOnSale) => void;
}) {
  const { data, isPending, error } = ticketing.useEventsOnSale();
  if (isPending) return <p aria-busy="true">Loading events…</p>;
  if (error) return <p role="alert">We could not load the events. Try again in a moment.</p>;
  if (!data?.events.length) return <p>Nothing is on sale right now.</p>;
  return (
    <ul className="grid gap-4">
      {data.events.map((event) => (
        <li key={event.id}>
          <Card>
            <CardHeader>
              <CardTitle>{event.name}</CardTitle>
              <CardDescription>
                {[when(event.startsAt), event.venue].filter(Boolean).join(" · ")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {availabilityLabel(event.availability) ? (
                <p>{availabilityLabel(event.availability)}</p>
              ) : null}
              <Button onClick={() => onOpen(event)}>Tickets</Button>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/**
 * One event's details and its ticket types, with room for the picker below. Prices show in the
 * currency the host gives with them.
 */
export function EventSection({ event, children }: { event: EventOnSale; children?: ReactNode }) {
  return (
    <section aria-labelledby={`event-${event.id}`} className="grid gap-4">
      {event.image ? <img src={event.image} alt="" className="w-full rounded-lg" /> : null}
      <h2 id={`event-${event.id}`} className="text-2xl font-semibold">
        {event.name}
      </h2>
      <p className="text-muted-foreground">
        {[when(event.startsAt), when(event.endsAt), event.venue].filter(Boolean).join(" · ")}
      </p>
      {event.description ? <p className="whitespace-pre-line">{event.description}</p> : null}
      <ul className="grid gap-2">
        {event.ticketTypes.map((type) => (
          <li key={type.id} className="flex justify-between gap-4">
            <span>{type.name}</span>
            <span>
              {formatPrice(type.price, type.currency)}
              {availabilityLabel(type.availability)
                ? ` · ${availabilityLabel(type.availability)}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
      {children}
    </section>
  );
}
