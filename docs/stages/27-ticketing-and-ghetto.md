# Stage 27: Ticketing, and Ghetto Movement as the first client

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0400](../adr/0400-a-general-host-and-products.md) to
[0404](../adr/0404-behaviours-are-the-vocabulary.md), stages [22](22-customers-and-audiences.md)
to [26](26-capacity-and-holds.md), the Deals pack as the model for a pack, and in
`~/repos/ghetto`: `README.md`, `src/pages/events/`, `src/config/booking.ts`, `src/pages/api/app/`,
`mobile/` (`src/api.ts`, `src/SignIn.tsx`, `src/screens/`), `src/pages/staff/`, `src/connector/`.

Status: **spec agreed** (interview 2026-11-21). Builds on stages 24, 25 and 26. This is the first product that is not a
CRM. Expect it to send changes back to the stages it builds on.

## Goal

Ghetto Movement sells tickets to an event. A visitor opens the event's page on the gym's site,
picks tickets, pays, and gets them by email. A member sees their tickets in the Ghetto app, each
with a code. At the door a coach scans the code with the staff app and the ticket is marked used.
Liam can ask Claude how sales are going or to add a ticket type, and sees every buyer as a person
in the same system as the gym's leads. All of it is the Ticketing pack, which any other product
can turn on.

## Decided at the interview (2026-11-21)

| Question | Decision |
| --- | --- |
| The first event | **The next Gains in the Ghetto,** some months away. It sets the shape: several packages, a deposit, no fixed date yet |
| Packages | Ticket types, each with its own places (for a camp: room types). One ticket is one person, in a shared room too |
| Paying | In full, or **a deposit with the balance due by a date** (stage 25, "Paying by deposit"). No stored card, no scheduled instalments |
| A balance unpaid at the due date | Staff are told and decide: chase, extend, or cancel and release the place |
| Fees | **No fee line.** The price is the price; the gym sets prices to cover card costs |
| The app's existing accounts | **The platform becomes the sign-in for the app's customers.** Existing members are linked by their verified email the next time they sign in |
| Coaches at the door | **Staff accounts with a door-only role:** check tickets in and see the event's ticket list, nothing else. One fixed role, built here; full roles and teams stay with stage 14a |
| Where money goes | The gym's own Stripe account, which exists |
| Guest checkout, refunds | As stage 25 decided: buying needs no account; staff with the refund permission refund, and a refund returns the place unless the object says no (stage 26) |
| `sellable` | Stays in this stage |
| Left out | Free tickets given by staff; member prices and promo codes; transferring a ticket or naming other attendees; scanning without a connection; wallet passes; seat or table selection. Each is an issue labelled `later` |
| After tickets | The gym's online program moves next, before bookings. It needs Programs (an exercise bank and programs built from it, shared by the online program, private and semi-private training and classes) and Courses; both are on the roadmap, not specced |

## What exists today (from the code)

- **Ghetto's site** is Astro on a Worker (`ghetto-website`) in the gym's Cloudflare account, with
  its own D1. Event pages are hand-written (`src/pages/events/index.astro`,
  `phuket-2027.astro`). Bookings and checkout are its current booking system's widgets (`src/config/booking.ts`).
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
  on sale (`from`, `until`), the most one order may hold (`maxPerOrder`), and a deposit (the
  fields holding the deposit amount and the date the balance is due, stage 25); and **what a paid
  line grants**: records the host creates when the order is first paid, in the same batch as the move to
  `paid` or, for a deposit, to `part_paid`, with fields set from the line, the item and the order.
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
| `ticketing.tickettype` | Its event, name, price, places, sale window, most per order | `sellable` (grants tickets); `capacity` (pool: its event) |
| `ticketing.ticket` | Its ticket type and event, its holder (a Person), its order, a code, its state, when it was used and by whom | `states` (valid, used, void); `customer: holder` |

- A ticket's **code** is long, random and unguessable, made by the host when the ticket is granted.
  The QR shown to the holder carries only the code.
- A ticket declares what its holder may read: event, ticket type, code, state. Nothing a customer
  may write.
- An event's and a ticket type's public fields (name, times, venue, description, price,
  availability) are readable by the public while the event is on sale.

### Tools (operations)
Tools are operations named `x.ticketing.<tool>`.

- `x.ticketing.eventsOnSale` (public): events on sale with their ticket types and availability.
- `x.ticketing.orderStart { lines: [{ ticketTypeId, quantity }] }` (customer, public): creates the
  order through the host, which prices it, holds the places and returns the order. The buyer then
  calls stage 25's `order.checkout`.
- `x.ticketing.myTickets` (customer): the caller's tickets, through the seam.
- `x.ticketing.checkIn { code }` (staff, risk `write`, permission `ticketing:checkin`): finds the
  ticket, refuses one that is used or void with who and when, and otherwise moves it to `used`.
  When the ticket's order still has a balance owing, the result says so and how much; it does not
  refuse. Safe to call twice: the second call
  reports the first.
- `x.ticketing.undoCheckIn { ticketId }` (staff).
- `x.ticketing.salesSummary { eventId }` (staff, read): sold, held, remaining and revenue per ticket
  type, for the dashboard and for Claude.

### The door role
- One fixed staff role, `door`, holding `ticketing:checkin` and read access to events, ticket
  types and tickets, and nothing else: no people, orders, leads or settings. An admin gives it to
  a staff account. It is declared by the pack and enforced by the host's permission check on
  every operation; it is not a general roles feature (stage 14a).

### Automations
- **Balance reminders:** to the buyer of a `part_paid` order, a week and a day before the balance
  is due, with the link to pay.
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
- **The app signs in through the platform.** The host is the sign-in for the app's customers, by
  emailed code. A member's existing account is linked to their Person by verified email the first
  time they sign in this way; nothing is copied in bulk and no password moves. The app's other
  features keep working against the site's own API with the same person.
- **Buyers are people.** Every buyer is a Person on the host, with their orders and tickets.
- **One real event is sold end to end** in the provider's test mode, then live.

## Out of scope
- Seat selection, tables, or any ticket for a named place.
- Transferring a ticket to someone else. Named attendees other than the buyer.
- Discounts, promo codes, member prices, free tickets given by staff.
- Stored cards, scheduled instalments, a fee line at checkout.
- Scanning without a connection.
- Apple and Google wallet passes.
- Moving Ghetto's site to TanStack Start, its blog (stage 28), or its programmes, workouts and chat
  onto the platform.
- Class bookings and anything in its current booking system.
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
4. **Never oversold:** stage 26's concurrency test, run through `x.ticketing.orderStart` for a
   ticket type inside an event pool.
5. **Abandoned:** an unpaid order expires, its places return, and no ticket was granted.
6. **Refund:** a full refund voids the order's tickets and, by default, returns the places.
6a. **Deposit:** a ticket type with a deposit is bought by deposit; the ticket is granted at the
    first payment; the order shows the balance and its due date; paying the rest in two parts
    makes it paid; check-in on a ticket with a balance owing succeeds and reports the balance; an
    order cancelled by staff after the due date voids its ticket and returns the place.
6b. **The door role:** a staff account with only `door` can check in and list an event's tickets,
    and is refused every other operation, tested over the whole registry.
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

## Step 1, `sellable`, as built (2026-11-21)
ADR 0435, migration 0450. Where the build read the spec one way, or decided what it left open:

- **The declaration:** `sellable: { price, currency?, saleWindow?: { from?, until? },
  maxPerOrder?, deposit?: { amount, balanceDue }, grants?: { object, set, void } }`, every rule a
  field of the record. `grants.set` maps the granted object's fields to `item`, `item.<field>`,
  `order`, `order.person`, `order.email`, `line`, `line.title`, `line.unitPrice` or `code`.
- **One granted record per unit** bought. The code is 26 characters of Crockford base32 (130
  random bits), in a read-only field; `core_order_grant` keeps it unique and finds an order's
  grants and a code's record.
- **Granted at the first payment:** `pending` or `expired` (honoured late) to `paid` or
  `part_paid`. **Voided** on `refunded` and on `cancelled`, as the host, from any state but void
  and the final ones; the declaration must give the host a move into void from each.
- **The fixture** is the box office (`packages/core/test/fixtures/boxoffice`: an event, a ticket
  type, a ticket), used by the host's tests, the runner's payment test and the orders e2e, which
  installs it as local dev's own org extension (`scripts/dev-setup.mjs`). Deals is not sellable;
  `ORDERS_DEV_SELLABLE` and `dev-sellable.ts` are gone.
- **After review:** only a pack or the org's own extension may declare `sellable` (a runtime one
  is refused at check and install); a granted object's `owner`, `requireOneOf` and choice
  requirements are held to what the grant always fills; `order.setPerson` gives the order's grants
  their holder; a granting line holds at most its `maxPerOrder` or 10, and an order 100 grants
  (5 statements each, measured); a field named with an SQL keyword (`order`, `group`, `select`)
  works, with the column `<word>_`.

## Steps 2 and 3, the pack, check-in and the door role, as built (2026-11-21)
ADRs 0436 to 0438, migration 0451, and amendments to ADRs 0025, 0245, 0425, 0433 and 0435.
Where the build read the spec one way, or decided what it left open:

- **Names.** Object names are lowercase letters and digits in the contract, so the ticket type is
  `ticketing.tickettype`. Tools are operations `x.ticketing.<tool>`. The text above now says so.
- **Public reads** (decided at review): the public scope on the seam (ADR 0438), brought forward
  from stage 28. An object declares `public: { read, when? }`; an event is public while on sale, a
  ticket type while its event is. The public reach records only through a pack's tool, which
  calls the tool-only `public.list` and `public.get`; a customer reads them too. `capacity.get`
  answers outsiders only for records they may read. `x.ticketing.eventsOnSale` is built on it
  (criterion 9).
- **Buying only what you may read** (decided at review): a customer or a guest cannot start an
  order for a record their scope does not show them (a ticket type of a draft event), answered as
  a record that does not exist. Staff can.
- **Quarantine** (decided at review): a host refusal a tool lets escape (`not_found`, `conflict`,
  `forbidden`, `invalid_input`, `rate_limited`) no longer counts towards a pack's quarantine
  (ADR 0025, amended).
- **The door role** is a pack role (ADR 0436): `roles` in the manifest, `permission` on a tool,
  `core_user.pack_role`, checked by the pipeline on every staff call whatever the input.
  `user.setPackRole` and `user.packRoles` are human-admin operations. The MCP tool list shows a
  door account only what the role could allow; the admin's navigation does not yet (an issue).
- **Check-in is a compare-and-set in the host** (ADR 0437): the history close is conditioned on
  the record's position, and `record.update { from: "valid" }` makes the move the point.
- **Who checked a ticket in** comes from the host (`ctx.caller`, ADR 0436). No extension may read
  users, so the ticket keeps the name as it was then (`usedByName`) beside the user (`usedBy`).
- **The pack is not optional:** a product that lists it installs it at boot. The CRM does not
  list it.
- **What the door sees:** a ticket's holder relation, so holders' names on the list; nothing else
  of a person. The ticket has no email field.

## Steps 4 and 5, as built (2026-11-21)
- **Automations** (`packs/ticketing/automations.ts`): tickets by email on an order's first
  payment (an order may now start an extension's automation, ADR 0427 amended); the reminder the
  day before an event on sale; the event moved to `ended` the day after (with `from: "on_sale"`);
  balance reminders every morning for part-paid ticket orders due in 7 days or tomorrow (a
  schedule over `rec_order`; a `dateRelative` trigger on an order's due date was not tried). Every mail goes
  through the pack's `email-send` connection, which an admin binds; each send is an outbound
  action the approval policy decides. The links come from two settings, `ticketsUrl` and
  `payUrl`, with `?order=<id>`: a guest pays a balance by signing in with the order's address
  (their order is already their Person's), because the host's guest token is not readable by an
  automation.
- **Views** "On sale", "This week's events" (relative filters gain `startOfWeek` and
  `startOfNextWeek`, Monday, UTC) and "Unused tickets"; the **Ticket sales** dashboard (revenue,
  tickets sold, valid tickets not yet used, sold by event and by day, places left from
  `rec_capacity`); the **Tickets** tab on a Person. Check-ins post to the holder's timeline through
  the ticket's tracked state and its `timelineLinks`; orders already do (ADR 0429).
- **Hooks** (`packs/ticketing/client`): `useEventsOnSale`, `useTicketPicker` (quantities kept
  within what the picker offers; `estimate` is a preview of the host's price, the host's total is
  what is paid), `useStartOrder`, `useCheckout`, `useOrder` (asks again every 2 s while
  pending), `useMyTickets`, `useCheckIn`, `useUndoCheckIn`, and display helpers
  (`formatMoney`, `availabilityLabel`, `orderStatus`, `minorFromInput`).
- **Blocks** (`packs/ticketing/blocks`): web `ticketing-events` (event list, event section),
  `ticketing-checkout` (picker and checkout, full or deposit, and paying a balance in full or in
  part), `ticketing-order` (confirmation from the real state), `ticketing-my-tickets`; native
  `ticketing-native-my-tickets`, `ticketing-native-ticket` (QR, brightness up while shown),
  `ticketing-native-scanner` (camera, haptics, the verdict and its reason, a count on the device).
  Native blocks take the camera, QR drawing, brightness and haptics as props, so they depend on
  no device package; the app passes its own. The block lint passes for all of them.
- **The scanner's count** is of who was let in on that device. An event-wide count needs a read
  the door role has (it can list the event's tickets); the block does not make it.
- **Naming a deployment after the client's product (#155)** is not built: see the PR.

## After the first client's build (2026-11-21, `fix/ticketing-client-gaps`)
Gaps the gym's own repository ran into, fixed on the platform:
- **Linking members by verified email:** `me.get` returns `signInEmail` and `signInEmailVerified`,
  the account's sign-in address, distinct from the Person's `primaryEmail`. A company's server
  checks a native app's customer by calling `me.get` on the host's public HTTPS surface with the
  customer's bearer token; the binding stays cookies-only (ADR 0421, amended).
- **Prices with their currency:** the seam returns `currency` beside a sellable object's records;
  `eventsOnSale` gives each ticket type's `currency`, `salesSummary` the deployment's; the blocks
  take no `currency` prop (ADR 0435, amended).
- **A holder's tickets name their event:** `customerVia` (ADR 0439) on the event and the ticket
  type; `myTickets` returns the event's name, dates, zone, venue and state and the type's name,
  live, whatever the event's state. The blocks no longer take an `eventName` prop. The order page
  already named its lines (a line keeps its title).
- **Events have a time zone:** a required `timezone` field (the deployment's zone by default), in
  `eventsOnSale` and `myTickets`, the emails, and the reminder and "ended" days (ADR 0460).
