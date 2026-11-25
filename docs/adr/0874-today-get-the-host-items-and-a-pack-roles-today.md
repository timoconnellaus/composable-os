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
  - changes waiting are the pending, unexpired actions this person can approve and that would
    apply: those passing the approver rules (one table in `approvals/approvers.ts`, which
    `approval.approve` now holds too: the same rules, the same order, the same refusals), the
    restricted-tool rule (ADR 0625, any installed extension's tool, a runtime one's too), and the
    roster's (ADR 0626: for someone who does not roster, an update or restore of a staffed object
    is left out without reading the shift; `approval.approve` decides it on the record); and not a
    message approving would not send: one to a recipient who may not be contacted now (asked
    together, as the approvals inbox asks), nor an AI's draft from another person's own mailbox
    (`othersPersonalDraft`, the question approving asks, ADR 0678). At most 500 are read; with
    more waiting the item says "500+ waiting: the oldest 500 counted". A held routine message is
    judged by its own path when approved (as the inbox shows it). A setup change is counted and
    its row says "Review on a computer" (ADR 0872);
  - shifts with nobody on them are `uncoveredShifts` over the roster's window, attention when one
    starts within 24 hours; checklists are the shifts' runs missed today and still open past
    their end, attention when one was missed (at most 200 counted; more say "200+"); notices are
    `unreadCount`.
  - `host.paymentsFailing` waits for Finance reports' Money owed (stage 52 step 5, the failing
    renewal's amount due kept): declared (`HOST_ITEMS_WAITING`) and listed for nobody until then.
- **An AI actor** (the assistant, MCP) gets the pack items and the money its user's rights and its
  scopes allow, never a person's own items: changes waiting, checklists, shifts with nobody on them
  and the inbox. Approving stays `actors: ["human"]`.
- **Every pack role reaches `today.get` and `today.rows`** (`PACK_ROLE_TODAY` in `pack-roles.ts`,
  passing the today, looks-after and "mine" limits, which Today holds itself). They answer for the
  account itself. SQL cannot carry a role's limits, so the host decides from the views an item's
  SQL reads (`roleReach` in `today/pack.ts`):
  - no host item: no money (`finance:read` is never a fixed role's, ADR 0600), no approvals, no
    roster or checklist, no inbox (none of the gating operations is a pack role's);
  - a pack item only when every tool of its gate is allowed by the role or a grant, an every-staff
    tool (`anyStaff`, ADR 0652) counting for nothing: its host operation decides by its own rule;
  - an item the role itself opens reads only views of objects in the role's `read`; any other
    view (another object of its pack, a Person, an order) hides it;
  - whatever opened the item (the role, or a grant: a limited role's grant is held to the limit,
    as the pipeline holds a tool's nested calls), one reading a view of an object the role reaches
    only for the People its holder looks after (ADR 0889) or through the records naming it
    (ADR 0755) is hidden, and one reading an object the role reaches only on today (ADR 0553) is
    shown only when its SQL binds today's window (`:today_from` and `:today_to`), and never with
    its comparison, which reads another day;
  - its rows only when they name records of an object the role reads and read only views of
    objects it reads (and bind today's window over a today-limited one); otherwise the item is its
    count alone and `today.rows` gives no rows.
  The views are judged by name: what an item's SQL does with a view it may read (a filter that
  is not today's) is the pack's reviewed code. `packages/core/test/today-reach.test.ts` crosses every shipped
  pack's item with every shipped pack role. No exception is declared on an item: an item a role
  should see over an object it does not read needs the role to read it, or a reviewed exception
  added to the declaration then.
  - Notices are not a pack role's: `notification.list` is not reached by one (its own inbox is
    read in the admin it signs in to, ADR 0660, and not through a role client), so the spec's
    "everyone" holds for every staff account without a pack role.
- **Cost.** `today.get` makes a bounded number of statements whatever the data: the zone, the
  account's rights and the shipped manifests; the pack items as columns of one statement (each a
  `json_array` of its value today and the value compared, at most 90 items and 90,000 characters a
  statement, the same nine parameters whatever it holds; `validateReadOnlySql` takes a longer limit
  only for SQL the host combined from checked parts, `MAX_COMBINED_SQL_LENGTH`); and each host
  item's own few reads (Finance's for takings, one per staffed object for the shifts). An item that
  fails at run time is read alone once and left out for 60 seconds (in the isolate, as the cache
  may be a no-op), its error logged once and listed to admins (`host.unreadable`): one bad item
  costs one failed statement, not one per item on every call. A Today item's SQL has no `;`,
  checked at install, and the comparison is built from the checked SQL.
- **The cache.** The pack items' statement and the takings are kept 60 seconds (the widget cache,
  ADR 0057): the statement by its SQL (which names exactly the items the caller may see), the
  windows, the zone and the caller's visibility scope; takings by the day and zone, for
  `finance:read` holders. The person's own items (changes waiting, the inbox, the roster and
  checklists) are read on every call, so a decision shows at once. Neither key holds the
  organisation: one deployment is one organisation (ADR 0001). Stage 66 (one host, many clients)
  must add it (its step 5, module-level caches).
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
