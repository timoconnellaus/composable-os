# ADR 0844: The room calendar (`rooms.week`, `rooms.check`) and the provisional and title keys on `occupies`

Status: accepted, 2026-11-24 (stage 57, build step 1). Amends
[ADR 0765](0765-occupies-the-claim-on-a-thing.md) (`occupies`, the claim on a thing). Follows the
roster read of [ADR 0626](0626-the-rostering-pack-and-bookings-additions.md) and the privacy rule
of [ADR 0761](0761-a-shift-that-names-a-client-kept-off-the-roster-and-the-feed.md).

## Context
Stage 57 (Events and venue hire) needs one calendar of a business's rooms across everything that
takes them: classes, appointments, a hire's room uses, an event's, a room blocked by staff. Stage
49 made them all one claim (`core_thing_time`), refused by the database, but nothing read it back:
a screen could only read each object's records and guess which took a room. A hire held before its
deposit must show differently from a confirmed one, and a calendar must never show who is on it
(an appointment's client, a hirer's name, money). A coach or the door, on a pack's fixed role,
may need to see that a room is busy and nothing more.

## Decision
- **Two display-only keys on `occupies`** (`packages/sdk/src/occupies.ts`):
  - `provisional?: string[]`, those of `live` in which the calendar marks a claim provisional (a
    hold). The claim is the same: a provisional claim refuses a clash as a firm one does, and the
    triggers read neither key. The contract requires each to be one of `live`, listed once.
  - `title?: string`, what the calendar shows: a text or select field of the object, or
    `relation.field`, a text or select field of a record a relation of the object names (another
    of the extension's own objects, as the margins are): an appointment's service, never its
    client. Left out, or empty on a record, the calendar shows the object's label ("Room use").
    A select shows its option's label. A relation to a Person or an account is never a title (it
    is not one of the extension's objects), so the calendar names nobody through the declaration.
- **`rooms.week { from, to, roomIds? }` and `rooms.check { roomId, starts, ends }`**
  (`packages/core/src/occupancy/`, `operations/rooms.ts`): staff-only, **tool-only** reads (as the
  roster's `staffing.week`), reached only from a shipped pack's tool run called for a staff
  account, never by a person, MCP or the assistant directly. `rooms.week` takes local dates in the
  organisation's zone, both included, at most 62 days; `rooms.check` takes two instants, half-open,
  and answers whether the room is free and what takes it. Each claim gives the room (its name),
  the occupying object and its label, the record id (for a click-through), the title, the record's
  own times, the times it takes with its margins (set-up, pack-down, a buffer), and whether it is
  provisional. The organisation's zone is given once for the answer (claims carry instants).
- **A fixed role reads only "taken".** When the tool's caller holds a pack role ([ADR 0436](0436-pack-roles-and-the-door-role.md)), every
  claim comes back with the room and the times it takes, and nothing else (no object, record,
  title, own times or provisional), whatever the tool is.
- **Only claimed things are on it.** The calendar reads `core_thing_time`, so a room that is not
  "one booking at a time" (a shared floor) shows nothing, because nothing is claimed on it.
- **Bounded cost.** One read of the claims (by thing and start when rooms are named), then one read
  per occupying object that has claims in the answer, one more when its title is another record's,
  and one per kind of thing for the names; every id list is one JSON value (D1's 100 bound
  variables). At most 2,000 claims an answer (`truncated` beyond). A week of 600 claims over 30
  rooms is under 20 statements, the pipeline's own included (`packages/core/test/rooms-calendar.test.ts`).
- **A free answer is a guide.** Neither read reserves anything; the database still decides when the
  record is written, and a race is refused there.
- **Generation over a taken room is stage 49's rule**, used unchanged: a series' date whose room any
  other record takes (a confirmed hire's room use included) is made without its room and the
  rosterers are told; the other record is untouched. The spec allowed for this ("if stage 49's
  build settles generation over a taken room first, this stage uses its rule").

## Consequences
- Bookings' class declares `title: "title"`. Stage 49's appointment declares its
  service's name as its title when it is built (step 5); Venue hire's room use declares `provisional: ["held"]`.
- Venue hire's room calendar, availability and Ticketing's event rooms (stage 57 steps 5 and 6)
  call these from their tools; until then no shipped pack lists them, so nothing reaches them yet.
- The answer names no Person, so it needs no visibility seam; what the title field holds is the
  declaring pack's choice, reviewed with the pack.
- A room's claims are read from the index by thing and start when rooms are named; without them,
  the read scans the claims of every claimed thing, which `roomIds` avoids for a large history.

## Amends ADR 0765
"What it is not" said stage 57 adds what it needs by amending ADR 0765: `provisional` and `title`
are those additions, and they change no trigger or claim.
