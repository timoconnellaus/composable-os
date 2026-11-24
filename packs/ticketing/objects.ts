// What the tools and the automations name and read back from the host: the pack's objects as the
// host calls them, a record and a page of them, and the refusal of a write made only from a state.
import { OpsCallError } from "@composable-os/sdk";

export const EVENT = "ticketing.event";
export const TICKET_TYPE = "ticketing.tickettype";
export const TICKET = "ticketing.ticket";

/** A record as record.get, record.list, my.list and public.list return it. */
export interface HostRecord {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

/** A page of records. */
export interface HostPage {
  items: HostRecord[];
  nextCursor?: string | null;
  /** On a sellable object's records (a ticket type): the currency its prices are in. */
  currency?: string | null;
}

/** The host refused a move `from` a state the record is no longer in (ADR 0437). */
export function isConflict(error: unknown): boolean {
  return error instanceof OpsCallError && error.code === "conflict";
}
