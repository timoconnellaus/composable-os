# ADR 0862: The Equipment pack: items, faults, out of service by a tool and back by a person

Status: accepted, 2026-11-26 (stage 59, build step 3). Block BU. Builds on ADRs
[0425](0425-one-transition-engine-for-stages-and-states.md) (`states`), [0502](0502-declared-uniqueness.md)
(declared uniqueness), [0513](0513-a-granted-holder-keeps-what-it-was-granted.md) (a move only
named tools make), [0552](0552-a-tool-a-person-approves.md) (a tool a person approves),
[0600](0600-a-pack-role-and-its-grants-add-up.md) (grants on a pack role) and
[0625](0625-restricted-pack-permissions.md) (restricted permissions). No platform change, no
migration.

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
  extension code cannot read users).
- **The tag is unique** among live items (`unique: [{ fields: ["tag"] }]`): the database refuses
  the second, from a form, the assistant, MCP or the admin's import, so a second import of the same
  spreadsheet with "skip invalid rows" creates nothing twice. An item without a tag is not compared.
- **An item's states are moves only tools make** (ADR 0513), so no record write, board drag or
  import makes them:
  - `in_service` to `out_of_service`: `takeOut` and `reportFault` (with `takeOut`), permission
    `equipment:report`, requiring `outReason`; the tool sets `outSince` (read-only) to the time.
  - `out_of_service` to `in_service`: `putBack` only, permission `equipment:manage`, **`humanOnly`**:
    refused to the assistant, MCP clients, automations and other code, whatever the preset.
  - to `retired` (final): `retire` only, `equipment:manage`, requiring `notes` (why, added to the
    notes), unlisting the item for members in the same write.
- **A fault's moves after the report are `triage`'s**, `equipment:manage`: acknowledged, then
  fixed, not a fault or a duplicate (final), each close requiring `closedWhy`.
- **Permissions.** `equipment:report` (grantable) is every staff member's and opens the register,
  an item, reporting and taking out; an admin grants it to a coach or a cleaner on a pack role, who
  then reaches those four tools and nothing else of the pack. `equipment:manage` is restricted and
  grantable: admins, and whoever an admin grants it to.
- **What an AI may do.** It reads the register and an item. Taking out, reporting, retiring and
  triage are `personApproves` (ADR 0552): the assistant's or an MCP client's call waits for a person
  under every preset, and runs as asked once approved. It never puts an item back.

## Where this differs from the spec, and why
- **A fault report waits for a person when an AI makes it.** The spec lets the assistant report a
  fault and only asks that its take-out wait. A move only tools make needs each tool to be a
  person's act (`humanOnly` or `personApproves`, ADR 0513), and `reportFault` makes the take-out
  move, so it is `personApproves` as a whole. Splitting it would lose decision 3's one call. A
  per-input approval would be platform work for little gain: the report is the person's to confirm.
- **The report and the take-out are two writes, not one batch.** No operation writes records of
  two objects in one batch. The fault is written first, so a call stopped between them leaves the
  report and the item still in service (the answer says whether it was taken out), never an item
  out of service with nothing saying why.
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
  record's fields, and the warranty date is the item's. `item` and `reportFault` say whether the
  item's warranty covered the day of each report.
- **`outSince` is set by the tool**, not by a host behaviour stamping the time a state is entered:
  the field is read-only, and only the pack's own tools (which alone make the move) write it, as
  Ticketing's `checkIn` sets `usedAt`. The state history keeps every move's time as well.
- **An item's details are any member's to edit**, as any pack's records are: the platform has no
  write permission per object. Only the moves are guarded.
- **No product lists the pack.** The CRM's `packs` are Deals, Leads and Lifecycle; every release
  carries every pack ([ADR 0420](0420-packs-as-packages-as-built.md), amended), and a deployment turns Equipment on (it is optional).

## Consequences
- The pack holds no rule: uniqueness, every move, who makes it and what it needs are the host's,
  and hold for the record page, a board, the assistant, MCP and the import alike.
- Steps 4 and 5 add the plan, the maintenance and the member's report to these objects; the
  fault's repair link, the reporter (a Person, set by the host for a member), the item's
  `signedIn` read and the fault's `customer` declaration are theirs.

## Proof
`apps/runner/test/equipment.test.ts`: the tag refused twice by a write and by a second import; no
record write moving an item or a fault; a member taking an item out and refused putting it back; a
manager putting it back and retiring it; a coach on `bookings.coach` granted `equipment:report`
reporting a safety risk and taking the machine out in one call and refused everything else; triage
a manager's, each close with why; the assistant and an MCP client waiting for a person to report,
take out, retire and triage, and refused putting back under the balanced and autonomous presets;
the register one statement's read at 20 items and at 500. Each rule, taken out, fails a test
(listed in the pull request).
