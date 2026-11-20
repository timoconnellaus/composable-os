# Stage 27: Ticketing, and Ghetto Movement as the first client

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0400](../adr/0400-a-general-host-and-products.md) to
[0404](../adr/0404-behaviours-are-the-vocabulary.md), stages [22](22-customers-and-audiences.md)
to [26](26-capacity-and-holds.md), the Deals pack as the model for a pack, and in
`~/repos/ghetto`: `README.md`, `src/pages/events/`, `src/config/booking.ts`, `src/pages/api/app/`,
`mobile/` (`src/api.ts`, `src/SignIn.tsx`, `src/screens/`), `src/pages/staff/`, `src/connector/`.

Status: spec proposed. Builds on stages 24, 25 and 26. This is the first product that is not a
CRM. Expect it to send changes back to the stages it builds on.

## Goal

Ghetto Movement sells tickets to an event. A visitor opens the event's page on the gym's site,
picks tickets, pays, and gets them by email. A member sees their tickets in the Ghetto app, each
with a code. At the door a coach scans the code with the staff app and the ticket is marked used.
Liam can ask Claude how sales are going or to add a ticket type, and sees every buyer as a person
in the same system as the gym's leads. All of it is the Ticketing pack, which any other product
can turn on.

## What exists today (from the code)

- **Ghetto's site** is Astro on a Worker (`ghetto-website`) in the gym's Cloudflare account, with
  its own D1. Event pages are hand-written (`src/pages/events/index.astro`,
  `phuket-2027.astro`). Bookings and checkout are Mindbody widgets (`src/config/booking.ts`).
- **Ghetto's app** is Expo (`mobile/`), with a tab bar and native stack, calling
  `/api/app/<path>` on the site with a token in secure storage.
- **Ghetto's accounts** are its own Better Auth users in its own database: clients and coaches.
- **Ghetto's staff area** is a PWA under `src/pages/staff/`, and its Claude connector
  (`src/connector/`) has its own tools.
- **On the platform,** after stages 22 to 26: customers, the HTTP surface and typed client, client
  apps and blocks, orders and payments, capacity and holds. No pack sells anything yet.

## Scope: the `sellable` behaviour

The last piece ticketing needs from the host (ADR 0404).

- An object declares `sellable`: its price field and currency; optionally the fields for when it is
  on sale (`from`, `until`) and the most one order may hold (`maxPerOrder`); and **what a paid
  line grants**: records the host creates when the order is paid, in the same batch as the `paid`
  move, with fields set from the line, the item and the order.
- An order line may point only at a record whose object is sellable. The host refuses a line
  outside the sale window or over `maxPerOrder`, with details naming the rule.
- When an order is refunded in full, what it granted is moved to a declared state (`void`), in
  the same batch.
- Granting is declarative. No extension code runs in the paid batch.

## Scope: the Ticketing pack (`packs/ticketing`)

### Objects
| Object | What | Behaviours |
| --- | --- | --- |
| `ticketing.event` | Name, start and end, venue, description, image, status | `states` (draft, on sale, ended, cancelled); `capacity` (the pool, optional) |
| `ticketing.ticketType` | Its event, name, price, places, sale window, most per order | `sellable` (grants tickets); `capacity` (pool: its event) |
| `ticketing.ticket` | Its ticket type and event, its holder (a Person), its order, a code, its state, when it was used and by whom | `states` (valid, used, void); `customer: holder` |

- A ticket's **code** is long, random and unguessable, made by the host when the ticket is granted.
  The QR shown to the holder carries only the code.
- A ticket declares what its holder may read: event, ticket type, code, state. Nothing a customer
  may write.
- An event's and a ticket type's public fields (name, times, venue, description, price,
  availability) are readable by the public while the event is on sale.

### Tools (operations)
- `ticketing.events.onSale` (public): events on sale with their ticket types and availability.
- `ticketing.order.start { lines: [{ ticketTypeId, quantity }] }` (customer, public): creates the
  order through the host, which prices it, holds the places and returns the order. The buyer then
  calls stage 25's `order.checkout`.
- `ticketing.myTickets` (customer): the caller's tickets, through the seam.
- `ticketing.checkIn { code }` (staff, risk `write`): finds the ticket, refuses one that is used
  or void with who and when, and otherwise moves it to `used`. Safe to call twice: the second call
  reports the first.
- `ticketing.undoCheckIn { ticketId }` (staff).
- `ticketing.salesSummary { eventId }` (staff, read): sold, held, remaining and revenue per ticket
  type, for the dashboard and for Claude.

### Automations
- **Tickets by email:** on `order.paid`, send the buyer their tickets through the email-send
  gatekeeper.
- **Reminder:** the day before an event, to holders of valid tickets.
- **Event ended:** the day after, the event's state moves to `ended`.

### Staff side, from the host
- Events, ticket types, tickets and orders in the admin with lists, record pages and saved views
  ("On sale", "This week's events", "Unused tickets").
- A **Ticket sales** dashboard: revenue and tickets sold by event and by day, places remaining.
- A buyer's Person page gets a Tickets tab; orders and check-ins post to their timeline.

### Headless hooks (`packs/ticketing/client`)
`useEventsOnSale`, `useTicketPicker` (quantities, limits, running total from the host's prices),
`useStartOrder`, `useMyTickets`, `useCheckIn`.

### Blocks
| Block | Skin | What |
| --- | --- | --- |
| Event list, event page section | web | On-sale events and one event's details |
| Ticket picker and checkout | web | Pick quantities, start the order, go to the provider's page |
| Order confirmation | web | The return page: shows the order's real state, waits while pending |
| My tickets | web, native | A customer's tickets |
| Ticket with code | native | One ticket, its QR, brightness up while shown |
| Door scanner | native | Camera scan, a clear valid or refused result with the reason, a count for the event |

## Scope: Ghetto Movement

- **A deployment of the platform in the gym's Cloudflare account,** beside `ghetto-website`, as the
  product `ghetto` with the Ticketing pack on. Its `product.ts` lives in Ghetto's repository.
- **The site stays Astro in this stage.** Its Worker gets a service binding to the host and uses
  the typed client; the ticketing web blocks are copied into `src/` as React islands and styled to
  the site.
- **The app** gets a Tickets tab (my tickets, a ticket with its code) and, for coaches, the door
  scanner. It must feel native: a tab, native stack screens, sheets, haptics on a scan.
- **Staff** use the host's admin for events and sales. The gym's connector to Claude gains the
  host's MCP surface, so Claude can create an event, add a ticket type and report sales.
- **Buyers are people.** Every buyer is a Person on the host, with their orders and tickets.
- **One real event is sold end to end** in the provider's test mode, then live.

## Out of scope
- Seat selection, tables, or any ticket for a named place.
- Transferring a ticket to someone else. Named attendees other than the buyer.
- Discounts, promo codes, member prices, free tickets given by staff.
- Scanning without a connection.
- Apple and Google wallet passes.
- Moving Ghetto's site to TanStack Start, its blog (stage 28), or its programmes, workouts and chat
  onto the platform.
- Class bookings and anything in Mindbody.
- The TV app showing events.

## Acceptance criteria
1. **Pack on the contract:** Ticketing is built only on the public contract and the typed client.
   It passes `pnpm ext check` and `pnpm ext test`. Turning it on in a product adds its objects,
   views, dashboard and tab; a product without it has none of them.
2. **Buy:** against the fake provider, a visitor starts an order for two ticket types, pays, and
   has the right number of valid tickets, each with a distinct code, granted in the batch that
   marked the order paid. The buyer got one email.
3. **The host's rules:** a line outside the sale window, over `maxPerOrder`, or for more places
   than remain is refused with details; no order exists afterwards.
4. **Never oversold:** stage 26's concurrency test, run through `ticketing.order.start` for a
   ticket type inside an event pool.
5. **Abandoned:** an unpaid order expires, its places return, and no ticket was granted.
6. **Refund:** a full refund voids the order's tickets and, by default, returns the places.
7. **Check-in:** a valid code is accepted once; a second scan reports who used it and when; a void
   ticket and an unknown code are refused with different, clear reasons; two scanners scanning the
   same code at once accept it once.
8. **Isolation:** the stage 22 isolation test covers tickets: a customer never sees another's
   ticket or code, and guessing codes through `myTickets` returns nothing.
9. **Public reads:** the public sees only on-sale events and only the declared fields.
10. **Ghetto, web:** on a staging deployment in the gym's account, the event page sells a ticket
    in test mode from a phone browser, start to finish.
11. **Ghetto, app:** the ticket shows in the app's Tickets tab; a coach's scan marks it used; the
    screens pass a review against the app's existing native feel.
12. **Ghetto, Claude:** over MCP, creating an event with two ticket types and asking for a sales
    summary both work, with the usual approvals.
13. **Blocks hold no rules:** the stage 24 lint passes for every ticketing block.
14. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Event, Ticket type,
    Ticket, Check-in) and `docs/architecture.md` (Ticketing as the first non-CRM pack) are updated.
    A list of what this stage changed in stages 22 to 26 is in the PR.

## Dependencies
- Stages 24, 25 and 26, and through them 22 and 23.

## Migrations and numbers
Migrations 0450 to 0459 (the `sellable` behaviour's core tables only; the pack's own tables come
from the reconciler). ADRs 0435 to 0439.

## Suggested build order
1. `sellable` in the SDK and the host: the line checks and granting in the paid batch.
2. The pack's objects and tools; the buy, refuse, expire and refund tests.
3. Check-in.
4. Automations, views, the dashboard, the Person tab.
5. Hooks, then the web blocks, then the native blocks.
6. Ghetto: the deployment, the site's event page, the app's tab and scanner, a test-mode sale.
7. The live sale.

## To settle at the interview
- **How Ghetto's existing accounts meet the platform's customers.** The app's members are in
  Ghetto's own Better Auth. Three ways: the app signs in to the host as well (two sign-ins, poor);
  the host becomes the sign-in for the app's customers, with existing users linked by verified
  email at their next sign-in (proposed, and the first step of moving Ghetto onto the platform);
  or tickets are shown on the web only for now. This is the largest open question in the stage.
- **Coaches as staff.** The door scanner is a staff operation. Coaches need staff accounts on the
  host, and a role that can check in and little else, which leans on stage 14a's roles.
- **Which event is sold first,** and when it needs to be on sale. That date sets the pace of
  stages 22 to 26.
- **Guest checkout or an account first** (with stage 25's question).
- **Who can refund,** and whether a refund always returns the place.
- **Is `sellable` this stage's or stage 25's.** It is here because ticketing is the first thing
  sold; it could move earlier.
