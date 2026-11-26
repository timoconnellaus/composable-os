# ADR 0862: The Equipment pack: items, faults, out of service by a tool and back by a person

Status: accepted, 2026-11-26 (stage 59, build step 3). Block BU. Builds on ADRs
[0425](0425-one-transition-engine-for-stages-and-states.md) (`states`), [0502](0502-declared-uniqueness.md)
(declared uniqueness), [0513](0513-a-granted-holder-keeps-what-it-was-granted.md) (a move only
named tools make), [0552](0552-a-tool-a-person-approves.md) (a tool a person approves),
[0600](0600-a-pack-role-and-its-grants-add-up.md) (grants on a pack role) and
[0625](0625-restricted-pack-permissions.md) (restricted permissions). Its two platform changes,
made in the review of PR #491, are ADRs [0863](0863-a-state-only-tools-leave-keeps-its-record-out-of-the-trash.md)
(the Trash held to the moves) and [0864](0864-uniqueness-that-folds-case-and-spaces.md) (uniqueness
that folds case and spaces). No migration.

## Context
Stage 59 gives a business a register of what it owns and must look after, and a way for the people
on the floor to say something is broken and stop anyone using it. Step 3 is the pack's spine: the
register's items, the faults staff report, the item's states, the tag's uniqueness, the
permissions and the staff tools. Service plans and maintenance (step 4), the member's report and
what members read (step 5), the automations, dashboard and views (step 6) and the blocks (step 7)
come later. The spec's decisions 3 and 4 are the heart of it: any staff member may take an item out
of use, a staff reporter in the same step as the report, and only a manager puts it back, a
person's own act.

## Decision
- **A new pack, `equipment`**, needing no other. Two objects in this step: `equipment.item` and
  `equipment.fault`, with the fields of the spec's model (the fault also has a `title`, left empty
  to read "<item> fault"; who reported it is kept as an account and a name, both read-only, since
  extension code cannot read users; and a read-only report key, below).
- **The tag is unique among items in or out of service, ignoring case and outer spaces**
  (`unique: [{ fields: ["tag"], states: ["in_service", "out_of_service"], fold: true }]`, ADR
  0864): the host keeps it trimmed and in upper case, and the database refuses the second, from a
  form, the assistant, MCP or the admin's import, so a second import of the same spreadsheet with
  "skip invalid rows", even re-exported with other case or stray spaces, creates nothing twice. An
  item without a tag is not compared.
- **A retired item gives its tag up.** When a gym replaces a worn treadmill, the new one wears the
  old sticker: the register should take the tag for it without anyone first editing the retired
  item. The retired item keeps the tag on its record, as history; only items in or out of service
  are compared.
- **An item's states are moves only tools make** (ADR 0513), so no record write, board drag or
  import makes them:
  - `in_service` to `out_of_service`: `takeOut` and `reportFault` (with `takeOut`), permission
    `equipment:report`, requiring `outReason`; the tool sets `outSince` (read-only) to the time.
  - `out_of_service` to `in_service`: `putBack` only, permission `equipment:manage`, **`humanOnly`**:
    refused to the assistant, MCP clients, automations and other code, whatever the preset.
  - to `retired` (final): `retire` only, `equipment:manage`, requiring `notes` (why, added to the
    notes), unlisting the item for members and clearing why and since when it was out, in the same
    write.
- **A fault's moves after the report are `triage`'s**, `equipment:manage`: acknowledged, then
  fixed, not a fault or a duplicate (final), each close requiring `closedWhy`. No fault is made on a
  retired item (`states.create.closed: "item.retiredFlag"`, a formula of the item): the host refuses
  it to everyone, the tools included.
- **What the floor trusts is written by the tools only** (read-only fields, which only the pack's
  own code writes): why an item is out of service (`outReason`), and a fault's severity and words.
  So nobody rewrites "Cable frayed" to "Fine now, use it" while the item is out, and nobody lowers
  a safety risk to "worn" to take it off the register's count. A manager corrects them with
  `correctOutReason` and `correctFault` (`equipment:manage`, `personApproves`). A fault is
  therefore made only through the report tools, never by a record write.
- **The Trash is held to the moves** (ADR 0863, a platform rule of `states`): an item out of
  service and an open fault are put in the Trash only by a person who holds `equipment:manage`
  (the permission of `putBack`, `retire` and `triage`), never by the assistant or an MCP client;
  an item in service by any member (who holds `takeOut`'s permission).
- **A report is made once.** Each fault carries a report key (read-only): the caller's `requestId`
  when given, else the reporter, the item, the severity and a digest of the words. Before making
  the fault the tool looks for an open one with the key, and the database refuses a second open
  fault with it (`unique: [{ fields: ["reportKey"], states: ["reported", "acknowledged"] }]`), so a
  retry of a call stopped part way, or a double tap, finds the fault already made and goes on to
  the take-out. The answer says `alreadyReported`.
- **Permissions.** `equipment:report` (grantable) is every staff member's and opens the register,
  an item, the two report tools and taking out; an admin grants it to a coach or a cleaner on a
  pack role, who then reaches those and nothing else of the pack. `equipment:manage` is restricted
  and grantable: admins, and whoever an admin grants it to.
- **What an AI may do.** It reads the register and an item, and reports a fault with
  `reportFaultOnly`, an ordinary write (it changes nothing but the new fault: no member sees a
  report, and nothing is taken out). Reporting with a take-out (`reportFault`), taking out,
  retiring, triage and corrections are `personApproves` (ADR 0552): its call waits for a person
  under every preset, and runs as asked once approved. It never puts an item back.

## What a member without `equipment:manage` may still do
The spec gives `equipment:manage` "items". The platform has no write permission per object, so
the build holds what matters and leaves the rest as for every pack's records. A member may:
- **create an item**, and **edit its details**: name, category, place, tag (unique), make, model,
  serial, dates, cost, supplier, warranty, photo, keeper, who has it, renewal date, listed for
  members, notes;
- **Trash an item in service** (it hides no danger: an item that must not be used is out of service,
  and that one only a manager Trashes); **Trash a closed fault**;
- report faults (through the tools) and take items out of service.
A member may **not**: put an item back, retire it, triage, write why an item is out or a fault's
severity or words, Trash an item out of service or an open fault, or make any move by a record
write.

This is acceptable for step 3 because every rule that keeps people safe is the host's: an item that
must not be used stays out until a manager puts it back, and what the out-of-order list and the
register show about it cannot be changed by a member. What a member can still change are the
register's details, which the whole staff keeps up in practice (a coach moves a bike and updates
its place). Two details matter later and are recorded here for those steps: **listed for members**
(step 5's out-of-order list reads it; a member unlisting an out-of-service item hides it from
members) and **keeper** (step 6's notices go to the keeper). Holding those, or items as a whole,
to `equipment:manage` needs a write permission per field or per object, which is platform work;
step 5 decides it for `listForMembers` before members read the list.

## Where this differs from the spec, and why
- **A fault report with a take-out waits for a person when an AI makes it.** A move only tools
  make needs each tool to be a person's act (`humanOnly` or `personApproves`, ADR 0513), and
  `reportFault` makes the take-out move, so it is `personApproves` as a whole. The spec's "the AI
  may report a fault" is `reportFaultOnly`, beside it, with no approval.
- **The report and the take-out are two writes, not one batch.** No operation writes records of
  two objects in one batch. The fault is written first, so a call stopped between them leaves the
  report and the item still in service; a retry finds the report (above) and takes the item out.
  When the take-out fails, the answer says so: "The fault is recorded, but it could not be taken
  out of service (...); take it out with takeOut" (`takeOutFailed`).
- **The item's keeper does not triage yet.** The spec lets "the item's keeper" acknowledge and close
  its faults as well as the managers. A move made by whoever a record's (or a related record's)
  user field names is not a behaviour the host has; checking it in `triage` would be a rule in a
  tool (ADR 0405). Until that behaviour exists, triage is the managers', and a keeper who should
  triage is granted `equipment:manage`. Step 4 needs the same behaviour ("the assignee or a
  manager" marks a maintenance done), so it is platform work for step 4 or before.
- **`fixed` requires `closedWhy`.** The spec has it require "the repair or why". The repair is a
  maintenance, step 4's object; a move's `requires` is all of its fields, not one of them. Step 4
  decides whether a repair link satisfies it (platform: a move requiring one of several fields) or
  why stays required.
- **"Under warranty" is answered by the tools, not a stored formula.** A formula reads only its own
  record's fields, and the warranty date is the item's. `item` and the report tools say whether
  the item's warranty covered the day of each report.
- **`outSince` and `outReason` are set by the tools**, not by a host behaviour stamping a state's
  entry: read-only fields that only the pack's own tools (which alone make the move) write, as
  Ticketing's `checkIn` sets `usedAt`. The state history keeps every move's time as well.
- **A fault's severity and words are read-only to staff**, where step 5 will have a member write
  them through `my.create` (`customer.write`); step 5 decides how the seam's create and these
  read-only fields fit (a customer's `createOnly` fields are the seam's to set).
- **No product lists the pack.** The CRM's `packs` are Deals, Leads and Lifecycle; every release
  carries every pack ([ADR 0420](0420-packs-as-packages-as-built.md), amended), and a deployment
  turns Equipment on (it is optional).

## Consequences
- The pack holds no rule: uniqueness, every move, who makes it and what it needs are the host's,
  and hold for the record page, a board, the assistant, MCP and the import alike.
- Steps 4 and 5 add the plan, the maintenance and the member's report to these objects; the
  fault's repair link, the reporter (a Person, set by the host for a member), the item's
  `signedIn` read and the fault's `customer` declaration are theirs.

## Proof
`apps/runner/test/equipment.test.ts`: the tag refused twice by a write and by a second import,
whatever its case and outer spaces, and given up by a retired item; no record write moving an item
or a fault, nor writing why an item is out or a fault's severity and words; the Trash held to the
moves; a report made once, and refused on a retired item; a member taking an item out and refused putting it back; a
manager putting it back and retiring it; a coach on `bookings.coach` granted `equipment:report`
reporting a safety risk and taking the machine out in one call and refused everything else; triage
a manager's, each close with why; the assistant and an MCP client waiting for a person to report with a
take-out, take out, retire and triage, reporting alone with no approval, and refused putting back,
under the balanced and autonomous presets;
the register one statement's read at 20 items and at 500. Each rule, taken out, fails a test
(listed in the pull request).
