# ADR 0874: `today.get`, the host's items and a pack role's Today

Status: accepted, 2026-11-26 (stage 60, build step 3; the spec's "Host items", "Operations" and
"What an AI may do", decisions 3, 7 and 11). Amends ADRs
[0870](0870-todays-items-and-the-today-items-declaration.md) (the items are now run),
[0436](0436-pack-roles-and-the-door-role.md) (every pack role reaches its own Today) and
[0057](0057-dashboards-params-cache-and-click-through.md) (a statement of many items, the 60-second
cache). Builds on ADRs [0871](0871-day-windows-in-the-business-zone.md) (the business's day),
[0600](0600-a-pack-role-and-its-grants-add-up.md), [0625](0625-restricted-pack-permissions.md) and
[0660](0660-pack-screens-in-the-admin.md) (the gate). No migration.

## Context
The owner's Today shows, for the business's local day, the numbers one person may see: what is
happening, what needs a decision, what went wrong. Some are the host's (takings, the approval queue,
the roster, checklists, the inbox) and read host data no `rec_*` view shows; the others are
declared by shipped packs (`todayItems`, ADR 0870) as read-only SQL. The phone's owner's client
(ADR 0872) lets any staff account sign in, a coach's included, so the answer must be decided for
the caller by the host. A coach, the door or a cleaner holds a pack role, which until now reached
no core read but its own screens and read-and-understood list.

## Decision
- **Two staff reads.** `today.get` returns `{ day, zone, items }`: each item a key (`host.<item>`
  or `<pack>.<item>`), label, format (`count`, `percent`, or `money` for the host's own), value,
  currency, a second line, a comparison (`yesterday` or `lastWeek`), `ok` or `attention`, and a
  target (`rows`, `approvals`, `notices`, or on the web a pack screen the person may open),
  attention first, then by place. `today.rows` returns at most 50 rows behind one item (a name, a
  line, the record it opens). An item `today.get` would not list is not found by `today.rows`.
  Both `records:read`, `risk: read`, staff only, exposed to MCP and the assistant.
- **The day is the organisation's.** Today's window is `localDay(now, org_timezone)`; the
  comparison binds the window a day or a week earlier and `:now` at the same local time
  (`localDaysBefore`), so a 23- or 25-hour day is right.
- **Every item is gated by what the caller could already call**, with the pipeline's own rule
  (`staffAuthority`: role, grants, pack role, restricted permissions), the caller's actor and an
  MCP token's scopes (`mayCall` in `packages/core/src/today/items.ts`):
  - a pack item, by every tool in its `opens` (ADR 0870); its pack installed, active and shipped;
  - `host.takings`, by `finance.report` (`finance:read`, decision 3);
  - `host.approvals`, by `approval.approve`, and then only the actions no approver rule refuses
    this person (below);
  - `host.uncovered`, by `staffing.uncovered` and being someone who rosters, where an installed
    pack declares `staffed`;
  - `host.checklists`, by `checklist.runs` and being someone who rosters, where one declares
    `checklists`;
  - `host.notices`, by `notification.list`.
  The gate is judged on every call before anything is read or served from the cache, so a grant
  taken away removes the money from the next call.
- **The host's items read through the code the operation they stand for reads through**
  (`packages/core/src/today/host.ts`), never a view and never a second calculation:
  - takings is Finance reports' Sales net (sold less refunded, tax inside) from the local
    midnight (`salesTotal` in `finance/reports.ts`: the book `finance.report` reads, totalled the
    same way), with the number of payments, compared with the same time last week; its rows are
    Sales' items. Nothing in `today/` sums an order or a payment;
  - changes waiting are the pending, unexpired actions (at most 500 read) that pass the approver
    rules: one table in `approvals/approvers.ts`, which `approval.approve` now holds too (the same
    rules, the same order, the same refusals), the restricted-tool rule (ADR 0625), and the
    roster's (ADR 0626): for someone who does not roster, an update or restore of a staffed object
    is left out without reading the shift (`approval.approve` decides it on the record). A setup
    change is counted and its row says "Review on a computer" (ADR 0872);
  - shifts with nobody on them are `uncoveredShifts` over the roster's window, attention when one
    starts within 24 hours; checklists are the shifts' runs missed today and still open past
    their end, attention when one was missed; notices are `unreadCount`.
  - `host.paymentsFailing` waits for Finance reports' Money owed (stage 52 step 5, the failing
    renewal's amount due kept): declared (`HOST_ITEMS_WAITING`) and listed for nobody until then.
- **An AI actor** (the assistant, MCP) gets the pack items and the money its user's rights and its
  scopes allow, never a person's own items: changes waiting, checklists, shifts with nobody on them
  and the inbox. Approving stays `actors: ["human"]`.
- **Every pack role reaches `today.get` and `today.rows`** (`PACK_ROLE_TODAY` in `pack-roles.ts`,
  passing the looks-after and "mine" limits, which Today holds itself). They answer for the account
  itself, and a pack role gains nothing else through them:
  - no money (`finance:read` is never a fixed role's, ADR 0600), no approvals, no roster or
    checklist, no inbox (none of the gating operations is a pack role's);
  - a pack item only when every tool of its gate is allowed by the role or a grant, an every-staff
    tool (`anyStaff`, ADR 0652) counting for nothing: its host operation decides by its own rule;
  - not an item the role allows that reads the view of an object the role reaches only for the
    People its holder looks after (ADR 0889) or through the records naming it (ADR 0755): SQL
    cannot carry those limits;
  - a row's record linked only when the role reads that object (`record.get`); else the row is a
    name and a line.
- **Cost.** `today.get` makes a bounded number of statements whatever the data: the zone, the
  account's rights and the shipped manifests; the pack items as columns of one statement (each a
  `json_array` of its value today and the value compared, at most 90 items and 90,000 characters a
  statement, the same nine parameters whatever it holds; `validateReadOnlySql` takes a longer limit
  only for SQL the host combined from checked parts, `MAX_COMBINED_SQL_LENGTH`); and each host
  item's own few reads (Finance's for takings, one per staffed object for the shifts). An item that
  fails at run time is read alone and only it is left out.
- **The cache.** The pack items' statement and the takings are kept 60 seconds (the widget cache,
  ADR 0057): the statement by its SQL (which names exactly the items the caller may see), the
  windows, the zone and the caller's visibility scope; takings by the day and zone, for
  `finance:read` holders. The person's own items (changes waiting, the inbox, the roster and
  checklists) are read on every call, so a decision shows at once.
- **Audit.** `today.get` is not audited one by one; `today.rows` of a money item writes the read's
  audit row naming the item and the number of rows, never a figure.

## Considered
- **A Today dashboard of widgets, and pack SQL for the host's numbers.** Refused by the spec:
  approvals, checklists and the roster are in no `rec_*` view, and checklists are never an AI's.
- **One statement per item.** The count would grow with the packs installed and their items; two
  reviews hit D1's limits that way (`me.attention` at six sources). A compound `UNION ALL` of the
  items is limited to five terms on D1.
- **Reading each waiting roster change's shift to count it exactly.** A statement per action; a
  non-rosterer's count leaves out what might be a roster change instead, and the approval itself
  still decides.
- **Gating the shifts and checklists by Rostering's own tools.** The host's items are the host's;
  gating by the core read they stand for holds whatever pack declares the behaviour. A coach
  granted Rostering's roster tools reads the shifts there, not on Today.

## Consequences
- The generated role clients and the owner's client gain `today.get` and `today.rows`
  (`roles.json`).
- A pack's item is visible exactly where its tools are; a pack declaring items (step 4) chooses
  `opens` so that whoever may call them may see what the item counts and its rows name.
- Takings appears for an admin from the first day, `0` with no sales. Payments failing joins when
  stage 52 keeps the amount due.

## Tests
`packages/core/test/today.test.ts` (the day ten hours ahead of UTC, against a widget's today
preset and UTC, across a change of clocks; a count equal to its rows for an admin and a pack
role, and for the changes waiting by an admin's and a member's rules; a pack role's items and the
looks-after rule; money for `finance:read`, gone with the grant though cached; an assistant's and
an MCP token's items; attention first; takings equal to `finance.report`'s Sales net with a refund
today of an older sale, and its audited rows; a pack disabled or a runtime extension contributing
nothing; the statement count with 52 more items and many more records, and the cache per viewer);
`apps/runner/test/today.test.ts` (with Programs, Bookings, Memberships, Ticketing and Rostering in
the real host: Bookings' items and the host's shifts and checklists, each count equal to its rows;
a coach's Today holding only its role's items, today's names it can read on the class lists,
linked only to classes; a door account and a cleaner with nothing; the statement count with more
records); the pack-role registry walks in `screens.test.ts`, `api-contract.test.ts`,
`rostering.test.ts`, `ticketing.test.ts` and `programs-coach.test.ts`.
