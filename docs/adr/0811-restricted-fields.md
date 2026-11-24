# ADR 0811: Restricted fields: a text only a named grant reads, kept out of every bulk path

Status: accepted, 2026-11-24 (stage 54, build step 2: platform piece P2). Generalises
[ADR 0643](0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md) (health
answers in a core table, read by a person with a permission, every read audited). Builds on
[ADR 0625](0625-restricted-pack-permissions.md) (restricted pack permissions),
[ADR 0402](0402-staff-and-customers.md) and [ADR 0414](0414-pack-tools-run-as-the-customer.md)
(the customer's writes through the seam), [ADR 0019](0019-audit-redaction-for-erasure.md) and
[ADR 0320](0320-erase-reaches-every-store.md) (erasure). Stage 54's spec, P2 and decision 5.

## Context
A review's private feedback ("tell us what went wrong") is for the owner, admins and whoever they
choose. As an ordinary field it would be a column of the object's `x_*` table and so in its
`rec_*` view: in `query.sql`, dashboards, exports, search, embeddings, the assistant's record
reads and summaries, the timeline and every audit change, for every member. ADR 0643 solved the
same problem for health answers with a core table of their own and one audited read; Reviews, and
Forms' answers "for owners and managers only", need it for a pack's field.

## Decision
- **The declaration.** A field of a pack's own object may say `restricted: "<pack>:<word>"`,
  naming one of the pack's restricted permissions (ADR 0625). The contract (`validateManifest`,
  `packages/sdk/src/restricted-fields.ts`) holds: a `text` or `longText` field; on an object that
  declares a customer, who reads and writes it (`customer.read` and `customer.write`); not the
  customer field; no `required`, `readOnly`, `default`, `defaultSetting`, `track`,
  `personApproves` or `renamedFrom`; named by nothing else of the object (its title, an index, a
  uniqueness rule, `requireOneOf`, an option's `requires`, `public.read`, `signedIn.read`,
  `customerVia.read`, `publishable.content`, a seed); never on another object (`fields`); no
  formula reads it. A tool whose input has a property, at any depth, named as one of the pack's
  restricted fields lists it in `redact`; a tool that takes the words under another name and writes
  them into the field must redact that name itself (the contract cannot see it). A runtime extension cannot declare one (it cannot declare a restricted
  permission), nor list `record.readRestricted`.
- **Where it is kept.** `core_restricted_value` (migration 1190): the record (its object's
  registry name and id), the field's registry name, the value (1 to 4,000 characters; a `text`
  field 1,000) and when it was written. The field has no column (the reconciler gives it none), is
  no registry field (`buildRegistry` leaves it out of `fields`; the object lists it under
  `restricted`, with its permission) and has no field storage, so no record operation, list,
  filter, sort, search entry, export, dashboard, view or record change (timeline, audit changes,
  webhooks, automations' `fieldChanged`) can see it. A field cannot become restricted, or stop
  being, by changing its declaration (`restricted_change`): a new field and a person's copy.
- **Who writes it: its author.** The seam's customer writes (`createVisible`, `updateVisible`:
  `my.create`, `my.update`, and stage 29's door after it) split the restricted values from the
  rest, check each (text of its length; an empty one removes it) and queue them in the same batch
  as the record. Only on the caller's own record: a guardian acting for a dependant writes none.
  A change of only restricted values does not touch the record (its `updated_at` stays). Staff,
  imports, bulk changes, MCP and the assistant have no way to write it: to them it is an unknown
  field.
- **Who reads it.** The author, their own: a customer's `my.get` and `my.list` (and a pack tool's
  `ctx.records` reads) add the restricted fields `customer.read` lists, of the records whose
  customer is their own Person only (not a dependant's, not one shared with every signed-in
  customer), in one read per page. Staff: only `record.readRestricted { object, field, ids }`
  (at most 50 live records): actors `extension` only, from a tool of the pack that declares the
  field, a tool that is `humanOnly` and names the field's permission and no other (a tool naming several
  opens to a holder of any one, ADR 0600), called by a person
  themselves (`calledBy.actor` is `human`, not an approval of another actor's call). The pipeline
  already held that person to the permission when the tool was called (ADR 0625: an admin, or one
  an admin granted it), so no assistant, MCP client, automation, other pack or member without the
  grant reads it, whatever they hold. It is not on MCP.
- **Every staff read is audited** (`auditReads`): the object, the field and the ids read, and how
  many, never a value (`redactResult`), and `audit.list` shows those rows to people only (ADR
  0643's `AUDITED_READS`).
- **No audit row holds a value.** The pipeline adds the restricted fields of the object an
  operation's input names (`input.object`) to the operation's `redact`, wherever they appear in
  the input: a customer's write, a refused staff write, an import's rows. Errors name the field,
  never the value. A customer's write is audited with `[redacted]` in the field's place: staff see
  that a value was written (or removed), never what it said.
- **Erase, purge and drop.** Erasing a Person deletes every restricted value of a record whose
  customer is them, in the Trash or not and whatever becomes of the record (read before the
  erase's batch clears or deletes those records); any other value that mentions their terms is
  scrubbed as free text is, or deleted when it is only their address or id. Purging a Person from
  the Trash deletes what they wrote, as erasing does. Dropping a hidden restricted field, or its
  object (`extension.dropHidden`), drops its values. A merge moves the records, and the values
  follow their record's id; an object's rename (`renamedFrom`) renames its values' `object_type`
  with its links and tags. A record the erase deletes (a required relation to the subject, a
  waiter) loses its restricted values whoever wrote them.

## Why
- A table of the host's own is the only place no bulk path reaches by construction: every one of
  them reads views or the registry, and a restricted field is in neither. Excluding it from a list
  of paths would leave the next path open.
- The tool is the place a person meets the data (Reviews' `reviews.feedback`), and restricted
  permissions already decide who may call one. Requiring `humanOnly`, the permission's name on the
  tool and the tool's own pack lets the host check all three from what the runtime set, never the
  input, as ADR 0643's amended `agreement.listHealthNotes` does.
- The author writes it through the seam that already proves whose record it is, so no new write
  door is needed; stage 29's door reaches it the same way.

## Consequences
- A restricted value is not searchable, sortable, filterable, exportable or shown on a record
  page; the pack's screens show it only to holders, by calling its tool.
- `reviews.review.privateFeedback` (step 4) is the first user. Its 2,000 characters are the pack's
  input limit; the host's is 4,000.
- Stage 14a's staff scopes do not change this: the read is decided by the tool, not by a view.

## Proof
`packages/core/test/restricted-fields.test.ts`: the contract's refusals; no column, no view column,
no registry field; the declaration cannot swap; the author writes and reads their own, another
customer sees nothing, an empty value removes it, a too-long one is refused without the value, a
change of it alone leaves the record's time; `record.get`, `record.update`, `record.list`'s
filter, `query.sql` (the table refused, no view names it), `search.global`, `export.csv`, the
audit, its changes and the timeline hold none of it; the pack's humanOnly tool naming the
permission reads it and the audit row names the records and no value; an absent tool, a tool not
`humanOnly`, an assistant's or no caller, an approval, another permission, another pack, and a
direct call by a person, an assistant or MCP are refused; at most 50 ids; erase deletes the
author's values and scrubs another's that named them; purge deletes them; dropping the hidden
field drops them; an object's rename keeps them readable and erasable; a record an erase deletes
through a required relation loses another author's values; a tool naming another permission beside
the field's is refused; a nested input property named as the field must be redacted.
