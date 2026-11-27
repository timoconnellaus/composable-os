# Stage 57: Events and venue hire

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Orders, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md) (Event, Ticket type,
Ticket, Public scope, Pack role, Deposit, Shift, Checklist, Routine mail), stages
[27](27-ticketing-and-ghetto.md) (Ticketing), [31](31-bookings.md) (rooms, classes, cascades),
[34](34-offers.md) (the pricing seam `priceLines` and "an order paid another way"),
[44](44-agreements.md) (agreement points), [45](45-rostering.md) (`staffed`, the roster) and
[47](47-pack-screens.md) (pack screens); stage 48 (My account, PR
[#311](https://github.com/timoconnellaus/composable-os/pull/311), branch
`docs/stage-48-my-account`); and Appointments (stage 49, specced in parallel, not yet on main),
which defines the room claim this stage reuses. ADRs
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0438](../adr/0438-the-public-scope.md),
[0507](../adr/0507-what-the-bookings-review-needed-of-the-platform.md),
[0550](../adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md),
[0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md),
[0590](../adr/0590-routine-mail.md),
[0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md),
[0626](../adr/0626-the-rostering-pack-and-bookings-additions.md),
[0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) and
[0641](../adr/0641-agreement-points-a-pack-declares-documents-a-person-attaches.md).

Status: **spec agreed** (2026-11-24). The owner was not interviewed: every question the draft
raised was decided by the coordinator the same day under the owner's standing rule that
best-practice answers are decided, not asked (decisions 1 to 9 below). The owner may override any
of them. **Not on the first client's day-one list**: whether the first client hires out rooms at
all is not known; see "Suggested build order".

## Status

- **Step 1** — built — PR #421 — The room calendar: `occupies.provisional` and `title`, `rooms.week`, `rooms.check`, generation over a taken room
  (branch `feat/stage-57-provisional`, ADR 0844, no migration):
  `occupies.provisional` (live states shown as provisional; the claim is unchanged) and
  `occupies.title` (a text or select field, or `relation.field` of one of the extension's own
  records; the object's label otherwise), checked by the contract; `rooms.week` and `rooms.check`,
  tool-only staff reads of `core_thing_time` in `packages/core/src/occupancy/` (room, kind, record,
  title, own times, times taken with margins, provisional; a fixed role's caller gets the room and
  the times only; no names, no money; at most 62 days, 2,000 claims an answer, statements bounded
  by the occupying objects). Bookings' class declares `title: "title"`. Generation over a taken
  room is stage 49's rule, used unchanged (made without its room, rosterers told, the other record
  untouched), now also tested against a confirmed room use. Left: no shipped pack calls the reads
  yet (steps 5 and 6); stage 49's appointment declares its service as its title when built; each
  claim carries instants and the answer the organisation's zone, not a zone per claim.

- **Step 2** — built — PR #355 — Cascades widened
  (branch `feat/stage-57-cascades`, ADR 0841, no migration): a child that draws no places may `follows` a pool (a member of the pool, or a
  claimant of the parent or of a member, is still refused); a child may follow a parent in an
  extension it `requires`, with the parent's states checked by the host at install and on every
  upgrade of either extension (a runtime extension may not); the counter guard is queued only when
  a follower claims places on the parent; a follower made under the move fails it whole at commit;
  a follower is not restored from the Trash onto a parent that moved it; one call moves at most 80
  records across every parent and nested cascade, sized from the queries a follower costs (was
  500 a parent), and a tick of timed moves shares one budget. ADRs 0507 and 0550 amended. Left:
  one `from` list serves every state in `when`, so step 5's room use following a hire into
  `held`, `confirmed` and `released` from different states needs `follows` widened again.

- **Step 3** — not built — Money: `moves.waits` with deposit; the `sum` field (migrations 1250 to 1251)

- **Step 4** — not built — needs: step 2 — Ticketing: `listed`, the public calendar block, cues, crew roles and crew shifts

- **Step 5** — not built — needs: step 1, step 2, step 3 — Venue hire pack: spaces, rates, hires, lines, room uses, states, tools, agreement point, routine mail, views, dashboard
  (transfers after stage 34 step 3; step 2's note: `follows` needs widening again for room uses)

- **Step 6** — not built — needs: step 4, step 5 — Blocks and screens: room calendar, hire board, hire page, run sheet, the Hires section and `hold_to_confirm`
  (also after stage 48's shell)

- **Step 7** — not built — needs: stage 29 step 2, step 5 — The website enquiry: a Forms form with the hire as its destination

## Goal

A business with a room to spare, or a whole place, hires it out and runs its own events without a
spreadsheet beside the system. Someone sends a hire enquiry from the website; staff see at once
whether the time is free against the timetable, appointments and other hires; they send a price
built from the space's rates, hold the date for a week, and the hirer agrees to the hire terms and
pays a deposit, online by card or by bank transfer that a staff member marks as received. Paying the
deposit confirms the hire. The balance is chased like a ticket balance. **A hire can never land on
a class, and a class can never be put on a hire**: the database refuses it for every writer. For
its own events (a seminar, a competition, a camp, an open day) the business lists them on a public
calendar on its website, free ones included, keeps a timed run sheet for the day that its staff
share, and puts staff and volunteers on the event's shifts through the roster.

## Who it is for

- **Gyms and studios first.** A studio hired to an outside instructor or for a photo shoot; the
  whole gym hired for a party on a Sunday; a treatment room hired by the hour; the gym's own
  seminars, competitions and camps (Ticketing already sells these) with a run sheet and crew on the
  door. Hires must fit around a dense weekly timetable; most hirers are one-off individuals.
- **Trades and services (the next vertical)** rarely own a venue. What they reuse from this stage
  is the run sheet and crew shifts for a workshop or open day, and the listed free event. Quotes,
  deposits and invoices for their work are stage 35's documents, not a hire.

## What exists today (from the code, checked 2026-11-24)

- **Ticketing** (`packs/ticketing/index.ts`, `tools.ts`, `automations.ts`): `ticketing.event`
  (name, times, zone, `venue` as **free text**, tax address, states `draft`, `on_sale`, `ended`,
  `cancelled`, a `places` pool its ticket types draw from, public while `on_sale`),
  `ticketing.tickettype` (`sellable` with a sale window, deposit and balance due, grants tickets;
  `capacity` with `pool: "event"`), `ticketing.ticket`. The door pack role; an automation moves an
  on-sale event to `ended` the day after it ends.
- **Rooms** are Bookings' (`bookings.room`: name, places as "a guide for staff, not a limit",
  notes; the public reads the name). Bookings requires nothing since stage 78 (it required Programs when this was written). A class names its room. Today
  nothing stops two classes in one room at once.
- **The time claim is for people** (ADR 0621, `packages/sdk/src/staffed.ts`,
  `packages/core/src/staffing/`, migration `0811_staff_time.sql`): one row per live covered shift
  in `core_staff_time`, refused by reconciler-built triggers. The roster reads every `staffed`
  object on the host (ADR 0626), so a new staffed object appears on it with offers, warnings, pay
  totals and the calendar feed.
- **The room claim does not exist yet.** Appointments (stage 49) defines it: `occupies: { thing,
  starts, ends, live, before?, after? }` on any object, a core table `core_thing_time` keyed by
  the thing, reconciler-built triggers that refuse a second live occupant of one thing at an
  overlapping time (`core_thing_double_booked`), and classes occupying their room (stage 49's
  coordinator decision: a class in a private room blocks a session in it). This stage reuses it
  and adds two display-only keys (below).
- **Cascades** (`packages/sdk/src/states.ts`, ADR 0507): `follows` moves children when a parent
  moves, in the same batch. The contract allows it only for a parent **in the same extension**, and
  ADR 0550 refuses it on **a parent other records draw places from as a pool**. A Ticketing event
  is such a pool, so the draft's "crew shifts follow the event" would be refused today.
- **Money** (`packages/core/src/orders/`, `packages/sdk/src/sellable.ts`): orders priced only by
  the host (ADR 0427), deposit and balance due (stage 25), `sellable.moves` (ADR 0560) for a record
  the order itself makes `held`, which expires with its order (minutes). The contract refuses
  `deposit` with `moves`. Only the provider's verified payment marks an order paid. Stage 34 specs
  the second door, **an order paid another way** (`order.recordPayment`, `orders:payments`, ADR
  0694), built once by whichever of stage 34, stage 35 or the till goes first. No host-kept sum of
  child records exists (`packages/sdk/src/formula` works within one record).
- **Agreements** (stage 44): an agreement point on a sellable object is checked where it is bought.
- **Public writes**: only order starts. The public-write door (a form anyone may submit, the
  `intake` behaviour) is Forms' (stage 29), not built.
- Open `later` issues this touches: [#131](https://github.com/timoconnellaus/composable-os/issues/131)
  (seat maps and tables), [#134](https://github.com/timoconnellaus/composable-os/issues/134)
  (free tickets), [#124](https://github.com/timoconnellaus/composable-os/issues/124) (invoices
  beyond the provider's receipt).

## Decided at the interview (2026-11-24)

No interview was held. Each question in the draft was decided by the coordinator at its
recommendation, under the owner's standing rule. The owner may override any of them.

| # | Decision |
| --- | --- |
| 1 | **How hiring works today is not asked.** The draft's assumptions stand (one-off hires of a room or the whole place, by the hour or the day, priced from rates, paid by deposit then balance), to be checked with the business when it is set up |
| 2 | **Hirers pay online by card, or by bank transfer that a staff member marks as received.** Marking is "an order paid another way" (stage 34's shared step): a person with the right to record payments, never the assistant, and every one recorded |
| 3 | **A date held without a deposit is held for 7 days**, then freed on its own. Staff can extend a hold by hand; staff and the hirer are told the day before it runs out |
| 4 | **The website does not show free times.** It shows the spaces and an enquiry form, and staff reply |
| 5 | **No two things in one room at once.** Anything that overlaps in one room is refused. A room the business does use in halves is set up as two rooms |
| 6 | **No regular hires in the first version** (a weekly hire by an outside instructor). One-off hires only |
| 7 | **Before a hire is confirmed the hirer agrees to the hire terms online and pays a deposit.** No refundable bond. The business writes its own terms; what they say is for the business to confirm with its lawyer |
| 8 | **People send a hire enquiry from the website in the first version**, through Forms' public-write door (stage 29), with its limits against spam |
| 9 | **For its own events the business gets first: a public events calendar on the website, free events included; a run sheet, the timed plan for the day, shared with staff; and staff and volunteers on event shifts through the roster.** Tables and seating, sponsors, and stallholders wait |

## The design in one page

- **What is hired is a room, and the room claim is Appointments'.** Bookings' `bookings.room` is
  the one list of rooms; classes and appointments already occupy it (stage 49). A hire and an
  event occupy the same rooms through the same `occupies` and the same `core_thing_time`, so one
  set of database triggers refuses a hire on a class, a class on a hire, an appointment on either,
  for every writer and under races. No second claim table, no second list of rooms.
- **A hireable space is what the website shows and the rates price.** `venuehire.space` (Studio
  A; the whole gym) names one or more rooms, with a description, photos and rates. Hiring "the
  whole gym" occupies every room it names, so it clashes with any class in any of them.
- **A hire is the business around one hire**: enquiry, price, hold, agreement, deposit, balance,
  completed. Its **room uses** (one per room, with set-up and pack-down) occupy the rooms: not at
  enquiry, provisionally while held, firmly once confirmed. They follow the hire's state, so a
  hold, a lapse or a cancel moves every room in one batch, refused whole if any room is taken.
- **The hold is the hire's own state**, lapsed by a timed host move (ADR 0550) at its "hold
  until"; it is never an unpaid order (orders expire in minutes).
- **Money stays the host's.** The hire is the sellable record: its price is a total the host keeps
  as the sum of its hire lines, its deposit and balance due are its fields, and paying the deposit
  (or the whole) moves the existing hire to `confirmed` in the paid batch. An unpaid order expires
  without touching the hire. A transfer is recorded on the order through stage 34's shared step.
  Nothing charges a card on its own.
- **The business's own events stay Ticketing's events.** An event may be **listed** (on the public
  calendar, selling nothing), has a **run sheet** of timed cues and **crew shifts** that are
  `staffed` and so on the roster. An event that uses the business's rooms gets room uses too.
- **The enquiry is a Forms form** whose destination record is a hire in `enquiry` (Forms'
  `intake` behaviour). No second public-write door.
- **A customer sees hires in My account** (stage 48): a Hires section, and an attention item when
  a held date waits for them to agree and pay.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A `space` base record with parts and its own claim table** (the draft) | Appointments already claims `bookings.room` in `core_thing_time`. A second key or table would let a hire and an appointment share a room unseen. One list of rooms, one claim. The cost: Venue hire requires Bookings (and so Programs); a business that hires rooms and runs no classes is not a target yet |
| **Parts of a room** (the whole venue made of Studio A and B) | A hireable space naming several rooms does the same with nothing new in the claim. A room the business uses in halves is two rooms (decision 5) |
| **A warning instead of a refusal for a clash** | A double-booked hall is a refund and an angry hirer; the same reason ADR 0621 refuses a coach on two shifts |
| **Holding a date with an unpaid order** | Orders expire in minutes and a hold lasts days; a long order would hold the provider's checkout open |
| **Hires as Ticketing events** | Most hires sell no tickets, and their states are commercial. A hire may link an event when it needs a run sheet or crew |
| **A price typed by staff beside the lines** | The total would drift from its lines; the host prices orders. A host-kept sum |
| **The hire's price as stage 35's Quote** | Stage 35's quote is a numbered tax document for trades, not built. A hire's price is its lines; a business that needs a numbered quote or invoice issues one from stage 35 when it exists |
| **Crew shifts and room uses cancelled by an automation when the event is cancelled** | An automation runs after the batch; a cancelled event would still hold its rooms and its crew's time for a while, and a failed run would leave them held. A cascade, widened (below) |
| **Run sheets as checklists** | A checklist is ticks by one person on one shift; a run sheet is a timed list for many people. A crew shift may still carry a checklist (ADR 0650) |
| **Tables, sponsors and stalls now** | Decision 9: they matter for bigger events and wait |

## Platform work and pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| `occupies` and `core_thing_time`, classes occupying their room | **Platform, stage 49's** (reused, not redefined) | This stage waits for it |
| `occupies.provisional` (states shown as provisional) and `occupies.title` (what the calendar shows) | **Platform** (additive keys on stage 49's declaration; display only, the claim is unchanged) | A held hire is shown differently; a calendar must not show a client's name |
| `rooms.week` and `rooms.check`, tool-only reads over `core_thing_time` | **Platform** (`packages/core/src/occupancy/`, new) | One calendar across classes, appointments, hires and events without exposing who is on them |
| `follows` widened: a child that draws no places may follow a pooled parent; a child may follow a parent in a pack its pack requires | **Platform** (contract and the cascade, amends ADRs 0507 and 0550) | Crew shifts follow their event; room uses follow an event in Ticketing |
| A paid order confirms a record that waits (`sellable.moves.waits`), with `deposit` allowed | **Platform** (orders, amends ADR 0560) | The hire exists before it is paid; an unpaid order must not move it |
| A total the host keeps (`sum`: a read-only number field, the sum of a child object's amounts) | **Platform** (reconciler-built triggers) | A hire's price must be its lines |
| An attention kind `hold_to_confirm` | **Platform** (core vocabulary of stage 48) | The hirer must act before a date |
| An order paid another way | **Platform, stage 34's shared step** (built once; this stage only calls it) | Decision 2 |
| The public enquiry | **Platform and pack, stage 29's** (`intake` on the hire) | Decision 8 |
| Bookings: a class generated onto a taken room is made without its room | **Pack** (Bookings; stage 49's if it builds it first) | The timetable must never overwrite a confirmed hire |
| Ticketing: `listed`, the public calendar block, the run sheet, crew roles and crew shifts | **Pack** (Ticketing) | Composition of `states`, `public`, `staffed` |
| Venue hire: spaces, rates, hires, hire lines, room uses, tools, mail, views, dashboard, blocks, screens | **Pack** (new, `packs/venuehire`, requires `bookings` and `ticketing`) | Composition |

## The model

### Words (for CONTEXT.md)

**Hire** (someone else's use of the business's rooms for a time, for a price). **Hirer** (the
Person, and optionally the Organisation, who hires). **Hireable space** (what is offered for hire:
one or more rooms, with a description and rates). **Rate** (a space's price per hour, session or
day). **Hire line** (one priced line of a hire). **Hold** (a hire claiming its rooms until a date,
before its deposit). **Room use** (one room claimed for a time, by a hire, an event or a block).
**Provisional** (a claim by a hold, not yet firm). **Listed** (an event shown publicly that sells
nothing). **Run sheet** and **cue** (one timed line of it). **Crew role**, **crew shift**. Avoid:
booking (a class's), reservation, venue (the event's free text), quote (stage 35's document).

### Platform: the room claim, shown

- **Reused from stage 49:** `occupies: { thing, starts, ends, live, before?, after? }`; `thing`
  is a relation to the claimed record (here always `bookings.room`); `before` and `after` are
  minutes that enter the claim (set-up and pack-down count, unlike `staffed`'s pay-only minutes).
  Half-open ranges. Refused as `core_thing_double_booked` for every writer.
- **Added here:** `provisional?: string[]` (live states the calendar marks provisional; both
  provisional and firm claims refuse a clash) and `title?: string` (a field or `relation.field`
  the calendar shows; empty shows the object's label). An appointment's title is its service,
  never the client (stage 49's privacy rule).
- `rooms.week { from, to, roomIds? }` and `rooms.check { roomId, starts, ends }` (tool-only, host):
  each claim's object label, record id, title, times with margins, zone, provisional. At most 62
  days per call. A fixed-role account reads only "taken" and the times. No names, no money.

### Platform: cascades widened (ADRs 0507 and 0550 amended)

- A child object that declares no `capacity` drawing on a pooled parent may `follows` it: it moves
  no places, so the counter check ADR 0550 could not read does not arise. A child that draws
  places stays refused.
- A child may follow a parent in another extension **that its own extension requires** (the
  parent named in full, `ticketing.event`); the parent's states are checked at install and on
  every upgrade of either pack.
- The build proves both with the cascade tests ADR 0507 needed (every statement shape, the Trash,
  a parent move refused whole when a child's claim is refused). If either proves unsafe, the build
  stops and asks.

### Platform: a paid order confirms a record that waits (ADR 0560 amended)

`sellable.moves.waits: { state, paid, until? }`: the order is started for a record that already
exists in `state` (a held hire); the order's line is priced by the host from the record (through
`priceLines`, stage 34); paying the deposit (`part_paid`) or the whole (`paid`) moves the record to
`paid` (`confirmed`) in the paid batch; an order that expires or is cancelled unpaid leaves the
record where it is. `deposit` is allowed with `waits`. One live order per waiting record. A record
that leaves `state` another way (lapsed, cancelled) cancels its unpaid order. `until` (a date
field) is what the attention kind below reads.

### Platform: a total the host keeps

A number field may declare `sum: { object, link, amount, where? }`: the host keeps it as the sum
of `amount` over the live records of `object` whose `link` points at this record. Read-only to
every caller; written by reconciler-built triggers on the child's table in the child's batch;
integer minor units. Shipped packs and the org's own extensions only. A sum over another
extension's object is refused at the contract check.

### Platform: My account

A new attention kind, `hold_to_confirm` ("A date held for you: agree and pay the deposit by the
date to keep it"), computed in core from a waiting `sellable.moves.waits` record whose customer is
the caller, in its waiting state, with its `until` date. Shown until it leaves that state. The
`agree` and `balance_due` kinds stage 48 defines already cover the terms and the balance.

### Pack: Bookings (additions)

- Classes occupy their room (stage 49). The host's generation of classes from a series must never
  fail on a room clash: a date whose room is taken is made **without its room** and staff are
  told, so a hire confirmed first is never overwritten by the timetable. If stage 49's build
  settles generation over a taken room first, this stage uses its rule.

### Pack: Ticketing (additions)

| Object | What | Behaviours |
| --- | --- | --- |
| `ticketing.event` (extended) | New state `listed` (public, sells nothing; moves `draft`↔`listed`, `listed`→`ended`, `listed`→`cancelled`); an organiser text; the "ended" automation also ends listed events | `states`; `public` while `listed` or `on_sale`. Ticket types stay public only while the event is on sale, so a listed event's tickets are never sold |
| `ticketing.cue` | Its event, at (datetime), what, who (a staff account, optional), where (text), notes, order, done (with who and when, host-written) | none |
| `ticketing.crewrole` | Name (door, bar, set-up, first aid), colour | the `staffed` kind, so stage 45's qualifications say who may do it |
| `ticketing.crewshift` | Its event, a crew role, starts, ends, zone, staff (a user), state (`open`, `done`, `cancelled`) | `staffed` (`kind: crewrole`, `place: event.name`, live in `open` and `done`); `follows` the event to `cancelled` (widened cascade) |

- **The public calendar** is a web and native block over `public.list` of events listed or on
  sale, by date, with times, zone, the venue text, description and image. A hired event appears
  only when its hire says it may be listed (staff only). No public calendar feed in this stage.
- **The run sheet**: staff build an event's cues; staff and the event's crew read it; on the day,
  the staff app shows today's run sheet and ticks a cue (`x.ticketing.cueDone`, who and when).
- **Crew**: crew shifts are on the roster with offers, takes, warnings and pay periods (ADRs 0626,
  0627). Volunteers are staff accounts with a fixed role (the team role); a volunteer is counted
  for pay only if the business says so (the pay basis per person, ADR 0627). Recorded hours are
  Timesheets' (stage 58); this stage adds nothing to them.

### Pack: Venue hire (`packs/venuehire`, new, `requires: ["bookings", "ticketing"]`)

| Object | What | Behaviours |
| --- | --- | --- |
| `venuehire.space` | Name, rooms (relation, many, `bookings.room`), description, photos (media), guests it holds (a guide), set-up and pack-down minutes (defaults), public, active | `public` (name, description, photos, guests) while public and active |
| `venuehire.rate` | A space, name (hourly, half day, full day, evening), unit (hour, session, day), price (minor units), minimum units, days it applies | none; staff only |
| `venuehire.hire` | Hirer (Person), organisation (optional), space asked for, purpose, guests expected, requested start and end, source (website, phone, email, walk-in), state, hold until, total (`sum` of its lines), deposit, balance due, event (optional, `ticketing.event`), may be listed (yes or no), staff notes, order (host) | `states` (below); `sellable` (price `total`, `deposit`, `moves.waits`); `agreements` point `hire`; `customer: hirer`; `intake` (stage 29, a form's destination) |
| `venuehire.line` | Its hire, description, quantity, unit price, from a rate (optional), kind (room, extra, cleaning, other), amount (quantity × unit price) | summed into the hire's total |
| `venuehire.use` | A room, starts, ends, set-up, pack-down, state, and exactly one of: a hire, an event, a block reason | `occupies` the room (`live`: `held`, `confirmed`, `booked`, `blocked`; `provisional`: `held`); `follows` the hire (`held`, `confirmed`, `released`) or the event (`released` on cancel) |

**Hire states**

| From | To | By | In the same batch |
| --- | --- | --- | --- |
| (new) | `enquiry` | staff; the public and customers through the enquiry form | nothing claimed; its room uses (from the space's rooms) in `requested`, claiming nothing |
| `enquiry` | `priced` | staff (`sendPrice`) | the price email to the hirer (an outbound action under policy); lines locked while priced |
| `priced` | `enquiry` | staff (revise) | |
| `enquiry`, `priced` | `held` | staff (`hold`) | room uses follow to `held`: claimed provisionally, refused whole if any room is taken; hold until = today + the hold setting (7 days) |
| `held` | `held` | staff (`extendHold`) | hold until moved later |
| `held` | `lapsed` | host, at hold until (timed move) | room uses released (final) |
| `held` | `confirmed` | host, the deposit or the whole paid (card or a recorded transfer) | room uses follow to `confirmed` |
| `held` | `cancelled` | staff; the hirer while held | released; an unpaid order cancelled |
| `confirmed` | `cancelled` | staff | released; a refund of what was paid queued for a person with `orders:refund`, never an AI |
| `confirmed` | `completed` | host, the day after its last room use ends | |
| `enquiry`, `priced` | `declined` | staff | (final) |

- The hirer agrees to the documents attached to the `hire` point before paying, as any sellable
  purchase (stage 44). None ship.
- The balance is due by its date; reminders as Ticketing's; an unpaid balance at the due date tells
  staff, who chase, extend or cancel.
- Changing a confirmed hire's times or rooms is a staff tool that moves its room uses (refused if
  taken). A change to the price after the deposit is a new line paid as a second order.
- A transfer: staff with `orders:payments` use `recordTransfer { hireId, pay, reference,
  receivedOn }`, which starts the hire's order and records the payment through stage 34's
  `order.recordPayment` (method `recorded`, kind `transfer`). A person only.

**Tools (`x.venuehire.<tool>`)**

| Tool | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `enquiryAdd` (an enquiry by phone or email) | staff | `venuehire:manage` | write |
| `availability { roomIds or spaceId, starts, ends }` | staff | `venuehire:manage` | read |
| `priceSuggest { hireId }` (lines from rates and hours) | staff | `venuehire:manage` | read |
| `lineAdd`, `lineUpdate`, `lineRemove` | staff | `venuehire:manage` | write |
| `sendPrice`, `hold`, `extendHold`, `release`, `decline`, `cancel`, `moveTimes`, `blockRoom` | staff | `venuehire:manage` | write (send: outbound) |
| `recordTransfer` | staff | `venuehire:manage` and `orders:payments`, a person only | write (money) |
| `eventRooms { eventId, rooms, starts, ends }` | staff | Ticketing's staff and `venuehire:manage` | write |
| `myHires`, `myHire` | customer | the hirer, through the seam | read |
| `payStart { hireId, pay: deposit, whole or balance }` | customer | the hirer | write (starts an order; never charges) |
| `cancelMine` | customer | the hirer, only while held | write |
| `hireBoard`, `hireSummary` | staff | `venuehire:manage` | read |

`venuehire:manage` is a restricted pack permission (ADR 0625): held by admins and by grant.
Settings (human admins only): hold days (7, 1 to 60), balance reminder days, hire listed by
default (no).

### Screens

- **Web admin (pack screens, stage 47):** the **room calendar** (a week grid by room: classes,
  appointments, events, hires and blocks, provisional marked; click through to the record; select
  a free time to start a hold); the **hire board** (by state, holds about to lapse first); the
  **hire page** (requested times, lines from rates, hold until, send, the agreement and payments,
  record a transfer, the linked event); Settings → Hireable spaces and rates; on the event, the
  run sheet and the crew tab.
- **Customer web (blocks):** the hireable spaces page with the enquiry form (a Forms form); the
  public events calendar and event page; the **Hires** section in My account (stage 48's
  `portal` declaration, `has: ["venuehire.hire"]`): the price, agree, pay the deposit or the
  balance.
- **Native:** the staff app's today's run sheet (read, tick a cue); crew see their crew shifts in
  Rostering's screens (built); the events calendar block. Hirers use the web.
- Web and native share hooks (`packs/ticketing/client`, `packs/venuehire/client`), not screens.

### Notifications (routine mail, ADR 0590, each kind an admin's to turn off)

Staff: a new enquiry; a hold lapsing tomorrow; a hold lapsed; a deposit paid; a balance overdue.
Hirer: the price (staff-sent, an outbound action under policy, not routine); hold made with the
date it lapses; the day before it lapses; hire confirmed with a calendar file (ADR 0571); balance
reminders. Crew: Rostering's own notices. All are about a hire or a shift the person has, not
marketing; consent to be contacted is Notifications' (stage 30) and is not touched.

### What an AI may do

May: read the room calendar and availability; draft an enquiry from an email; suggest and draft
lines; draft the price email (a person sends it, or the approval policy queues it); draft a run
sheet and crew shifts; report hire and event summaries. May not: confirm a hire, record or waive a
payment, refund, change a price after a deposit, publish or attach agreement documents, change
spaces or rates, block a room, list a hirer's event publicly, or put a person on a shift without a
person approving (Rostering's `personApproves`). Approval policy is not AI-configurable.

### Privacy, audit and erase

- The room calendar shows titles to staff and only "taken" to fixed-role accounts; a hirer's
  name, contact details and money are `venuehire:manage`'s. The public sees public spaces and
  listed or on-sale events, never what else is on.
- Every hire move, price sent, payment, transfer recorded, refund and room block is audited.
  Prices are integer minor units in the deployment's currency.
- Erasing a hirer removes their Person as erase does; hires, lines and orders keep their amounts
  with the person removed, for the books (how long to keep financial records is for the business
  to confirm with its accountant). Cues and crew shifts keep the role, not a removed person's
  name. Merge re-points hires.
- Hire orders reach the books through Finance reports (stage 52) as any order does.

## Out of scope

- Tables and seating, selling a whole table, named seats (#131); sponsors; stallholders.
- Regular weekly hires (decision 6); a refundable bond (decision 7).
- Free times on the website and hirers booking and paying with no staff (decision 4).
- A public calendar feed of events (later, through the calendar-sync proposal's feed module).
- Showing the hirer the run sheet; catering, suppliers and floor plans.
- Parts of a room; rooms without Bookings; equipment hired out (the claim is general enough).
- Several locations (the multi-location proposal); RSVPs for listed events; free tickets (#134).
- Numbered quotes and invoices for a hire (stage 35); tax beyond the provider's checkout (#124).

## Acceptance criteria

1. **One claim:** a class, an appointment, an event's room use, a hire's room use and a room block
   on one room at overlapping times: the second is refused `core_thing_double_booked`, written by
   a person, MCP, the assistant after approval, an import or the host's generation.
2. **A space of several rooms:** holding "the whole gym" is refused over a class in any of its
   rooms; a class in one is refused over a held or confirmed hire of the whole.
3. **Set-up counts:** a hire 18:00 to 22:00 with 30 minutes' set-up clashes with a class 17:00 to
   17:45 and not with one ending 17:30.
4. **Races:** two staff holding the same time at once: exactly one hold commits, and its room uses
   are all claimed or none.
5. **Generation:** a series date whose room is taken by a confirmed hire makes that class without
   its room and tells staff; the hire is untouched.
6. **The calendar:** `rooms.week` lists every kind of claim with provisional marked and no names or
   money; an appointment shows its service; a fixed-role reader sees only "taken".
7. **Hold and lapse:** a held hire claims provisionally; at hold until the host moves it to
   `lapsed` and the rooms are free within a minute; staff and the hirer were told the day before;
   an extended hold lapses at its new date.
8. **Deposit confirms:** the hirer agrees to the attached terms, pays the deposit against the fake
   provider, and the hire is `confirmed` in the paid batch; an abandoned order leaves it held.
9. **Transfer:** a person with `orders:payments` records a transfer and the hire is confirmed; a
   caller without it, and the assistant, are refused.
10. **The total:** the hire's price is the sum of its lines; no caller can set it; a line changed
    after an order started never changes that order.
11. **Balance:** reminders go before the due date; an unpaid balance at the due date tells staff;
    the hirer sees `balance_due` in My account.
12. **Cancel and refund:** cancelling a confirmed hire frees the rooms and queues the refund for a
    person; an AI cannot approve it.
13. **Enquiry:** a website enquiry through the Forms form makes a hire in `enquiry` with the
    Person matched or made; spam checks are Forms'; nothing is claimed.
14. **My account:** a hirer sees only their own hires; a held hire shows `hold_to_confirm` until
    confirmed or lapsed; another customer's guesses return nothing.
15. **Listed events** show on the public calendar and sell nothing; draft events never show.
16. **Cascades:** cancelling an event cancels its crew shifts and releases its room uses in the
    same batch; a child that draws places from the pool is still refused `follows`.
17. **Crew:** a crew shift appears on the roster, refuses its person over an overlapping class,
    and counts in pay totals.
18. **Run sheet:** staff build cues; the app shows today's run sheet and ticks a cue with who and
    when; a customer reads nothing of it.
19. **AI:** over MCP, drafting lines and asking for availability work; confirming, refunding and
    recording a payment are refused.
20. Both packs pass `pnpm cos ext check` and `pnpm cos ext test`; the block lint passes; one e2e
    per journey (an enquiry to a confirmed hire; an event with a run sheet and crew); the ADRs
    below, `CONTEXT.md`, `docs/architecture.md`, `apps/marketing/SITE.md` checked.

## Dependencies

- **Built:** stages 25 (orders, deposits), 27 (Ticketing), 31a (rooms, cascades, timed moves,
  ADR 0560), 44 (agreements), 45 (`staffed`, the roster, pay periods).
- **Not built, needed first:** **stage 49** (Appointments) step 2, `occupies`, `core_thing_time`
  and classes occupying their room: this stage cannot claim a room without it. **Stage 34** step 3
  (or stage 35 or the till, whichever builds it first), an order paid another way, for transfers.
  **Stage 29** (Forms) step 2, the `intake` door, for the website enquiry; staff enquiries do not
  wait. **Stage 47** (pack screens, PR #303) for the staff screens. **Stage 48** (My account) for
  the Hires section and the attention kind.

## Migrations and numbers

Block **BS** (to be claimed in [`parallel-work.md`](../parallel-work.md) by the coordinator):
migrations 1250–1269, ADRs 0840–0849. Expected migrations: at most two (1250: the order's link to
a waiting record, if `orders/` needs a column for it; 1251: anything the sum triggers need beyond
the reconciler). The room claim's table is stage 49's migration, not this stage's. No `x_*` table
is touched by a migration. New permission: `venuehire:manage` (restricted, the pack's).

ADRs the build writes:

1. **0840** The Venue hire pack: hireable spaces, rates, hires, lines and room uses; what it
   requires.
2. **0841** Cascades widened: a non-drawing child of a pool, a parent in a required pack (amends
   0507 and 0550).
3. **0842** A paid order confirms a record that waits, with a deposit (amends 0560).
4. **0843** A total the host keeps (`sum`).
5. **0844** The room calendar (`rooms.week`, `rooms.check`) and the provisional and title keys on
   `occupies` (amends stage 49's room-claim ADR).
6. **0845** Ticketing: listed events, the run sheet, crew roles and crew shifts.
7. **0846** The `hold_to_confirm` attention kind (amends stage 48's attention ADR).

## Suggested build order

**Not on the first client's day-one list.** Whether the first client hires out rooms at all is not
known; check that with the business before step 4. Steps 1 to 3 are general platform pieces and
the Ticketing steps (5, 6) are useful to any business with its own events, so they may be built
whenever there is room; the hire steps wait for the answer.

| Step | What | Touches | Beside |
| --- | --- | --- | --- |
| 1 | `occupies.provisional` and `title`; `rooms.week`, `rooms.check`; generation over a taken room | `packages/sdk` (stage 49's `occupies` file), `packages/core/src/occupancy/` (new), `packages/core/src/recurring/` | After stage 49 step 2. **Collides** with stage 49 steps 2 and 7 and anyone in the reconciler's trigger code |
| 2 | Cascades widened | `packages/sdk/src/states.ts` (contract), `packages/core/src/records/states.ts` (the cascade) | Steps 1, 3. **Collides** with anything in the transition engine (stage 49 step 4) |
| 3 | Money: `moves.waits` with deposit; the `sum` field | `packages/sdk/src/sellable.ts`, `packages/core/src/orders/` (`moves.ts`, `payments.ts`), the reconciler, migrations 1250–1251 | Steps 1, 2. **Collides** with any work in `orders/` (stage 34 steps 1 and 3, stage 35, the till, stage 44 step 7, PR #299) |
| 4 | Ticketing: `listed`, the public calendar block, cues, crew roles and crew shifts | `packs/ticketing/` | After step 2 (crew shifts follow the event). Beside 3. Collides with any Ticketing follow-up |
| 5 | Venue hire pack: spaces, rates, hires, lines, room uses, states, tools, agreement point, routine mail, views, dashboard | `packs/venuehire/` (new), the product's pack list | After 1, 2, 3; beside 6. Transfers after stage 34 step 3 |
| 6 | Blocks and screens: room calendar, hire board, hire page, run sheet (web and native), the Hires section and `hold_to_confirm` | `packs/venuehire/blocks`, `client`, `packs/ticketing/blocks`, the `portal` declaration, `packages/core` (attention) | After 5 for hires, after 4 for the run sheet; after stage 47 merges and stage 48's shell. Collides with stage 48's attention code |
| 7 | The website enquiry | a Forms form with the hire as its destination (`intake` on `venuehire.hire`) | After stage 29 step 2 and step 5 |

**Up to three sessions at once** once stage 49 step 2 has merged: step 1, step 2 then 4, and step
3; then 5 with 6.

## Size

**Large.** Four platform pieces (the calendar read, cascades, the waiting order, the sum), one
pack grown and one new.

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| What is claimed | Bookings' rooms, through stage 49's `occupies` and `core_thing_time`. No space base record, no second table |
| The whole place | A hireable space naming several rooms; no parts |
| Clashes | Refused, never warned; set-up and pack-down count |
| A hold | Claims its rooms provisionally and lapses by itself after 7 days; an enquiry claims nothing |
| The pack | Venue hire is its own pack and requires Bookings and Ticketing; run sheet and crew live on the event, and a hire links an event when it needs them |
| Paying | Online through the existing payment provider, or a transfer recorded by a person with `orders:payments` (stage 34's step); terms agreed before paying |
| The class generated onto a taken room | Made without its room, staff told; never skipped, never over the hire |
| Rates | Staff only; the website shows spaces, not prices |
| The public calendar | A block over the public events list; no feed in this stage |
| Hirers | Use the web, not the app; see hires in My account |
| Volunteers | Staff accounts with the team role on crew shifts; counted for pay only where the business says so |
| Who records a transfer | Only a person holding both `venuehire:manage` and `orders:payments` |

## Questions for the owner

**Answered by the owner on 2026-11-25: the first client does hire out its space,** so steps 5 and 7
and the hire half of step 6 are to be built. As first written:

None open. Before step 5 is started, the coordinator checks with the business whether it hires out
rooms at all (a fact, not a design question; decision 1).

## Risks

- **Security:** stage 49's triggers carry the claim; the widened cascade is a new path across packs
  and must be tested on every statement shape. The enquiry is a public write and uses only Forms'
  door.
- **Privacy:** the room calendar must not leak a hirer's or a client's name to fixed-role accounts
  or the public.
- **Money:** a deposit that confirms an existing record is a new paid-batch path; a recorded
  transfer is money no provider confirms (restricted, audited, a person only); refunds stay a
  person's. Whether a hire's price or receipt serves as an invoice is for the business to confirm
  with its accountant.
- **Real data:** a timetable that already double-books a room is refused when classes start to
  occupy rooms (stage 49); the move (stage 33) reports those first.
- **Needs real things:** a real provider account in test mode for deposits and balances; a real
  venue's rooms and rates; a phone for the run sheet; a real hirer to try the enquiry, price and
  pay flow.
