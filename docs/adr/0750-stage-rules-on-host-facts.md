# ADR 0750: Stage rules on host facts

Status: accepted, 2026-11-24 (stage 39, build step 1). Amends
[ADR 0100](0100-stage-behaviour-and-object-contract-additions.md) (stage rules) and
[ADR 0425](0425-one-transition-engine-for-stages-and-states.md) (the transition engine).

## Context
A job in the Jobs pack (stage 39) moves through stages an admin edits, as a deal does. Three of
its steps are facts, not opinions: Accepted means the customer accepted a quote, Signed off means
the customer signed the work off, Invoiced means an invoice exists. If a person, an import or the
assistant can drag a job into Accepted, the board says something nobody did.

ADR 0100 already holds that entering a stage needs the fields the stage lists and
`requiredByType[type]`, for every actor, in `record.create`, `record.update` and the CSV import.
But the contract check (`packages/sdk/src/behaviour.ts`) accepted only **writable** fields there,
so a stage could not require a fact only the host sets. `states` allows a read-only `requires`
only on a move made by the host alone (ADR 0425), because there the move and the fact are one
act; a stage is entered by staff too, once the fact is recorded.

## Decision
- **A stage may require a read-only field.** A stage's `requiredFields` options and
  `requiredByType` may name any field of the object except a formula, the stage field and the
  fields the behaviour keeps itself (`status`, `closedDate`, `probability.field` and
  `probability.overridden`): requiring one of those either always holds or, for a closed date on
  an open stage, never can. Such a field is a **host fact** (`stageFacts` in
  `packages/core/src/records/host-facts.ts`).
- **Who writes a host fact: the host, or a person's own act.** As for a holder's terms (ADR
  0513), the declaring extension writes it only from a tool that only a person may call
  (`humanOnly`) or approve (`personApproves`), with a permission (`personsTool`): Jobs'
  `recordAcceptance`. Its other code, an automation or a tool an AI may call, is refused like
  every other caller ("is set automatically and cannot be written"). This narrows ADR 0246 for
  these fields only.
- **Who changes the stages a host fact gates: an admin, in person, or the host.** The stage
  records are data: a member or an AI that could edit them could drop the fact from Accepted,
  turn Paid into an open stage so `requiredByType.won` no longer applies, or make a stage of its
  own called Accepted, and then make the move. So a create, update, Trash or restore of a record
  of a stage object that any object's stages wait on a host fact through is refused
  (`forbidden`, `details: { rule: "stage_settings_admin_only", object, gates }`) unless the
  caller is a person (`actor: "human"`) whose role is admin, or the host. An assistant or MCP
  client acting for an admin, an automation and an extension are refused, as `policy.update` is
  a person's. Seeds are inserted at install and are not writes. Stage objects with no host fact
  (Deals') are unchanged.
- **The engine is unchanged in what it refuses**: entering the stage, or creating a record in it,
  with a required field empty fails with `stage_required_fields` for every caller of the record
  operations (tested: people, MCP clients applied or queued for approval, an extension's code, the
  CSV import and the host itself). Once the fact is set, staff may make the move; platform code,
  or a person's tool, may set the fact and make the move in the one write (the act's own batch).
  While the record is in the stage, a write that empties the fact is refused, the host's
  included.
- **The refusal names the fact first.** The missing read-only fields come first in `fields` (so
  `field`, which a UI asks for, is the fact), the details carry `setByHost: [...]`, and the
  message reads "Accepted needs Accepted at; Accepted at is set by the act it records, not by a
  move". The board's missing-field dialog offers only writable fields (`missingFieldOf`), so for
  a host fact it shows the message instead. `setByHost` is added by the engine, so a `states`
  refusal for a host move missing its read-only field carries it too; the `states` contract rule
  of ADR 0425 is unchanged.

## Consequences
- No migration. A write to any record now looks through the registry's objects for a stage
  object it gates (in memory, no statement); the rule otherwise costs what a stage rule did.
- The guarantee is per pipeline as an admin set it up: an admin, in person, may still remove the
  fact from a stage or add a stage without it. That is the business's setting, made by the
  people who may change settings, and audited as a record change.
- A business whose members edit stages today keeps doing so for Deals; a Jobs pipeline's stages
  are an admin's.
- Jobs (step 5) declares `acceptedAt`, `signedOffAt` and `invoicedAt` read-only and lists them in
  the seeded Accepted, Signed off and Invoiced stages. The acts that set them are later steps:
  Jobs' `recordAcceptance` (step 5, a `humanOnly` tool), the acceptance of a record (step 4),
  stage 35's invoice (the host).
- Tests: `packages/core/test/stage-host-facts.test.ts`.

## Amended 2026-11-24 (review of PR #350)
The first version let any code of the declaring extension write a host fact, and let any caller
with `records:write` edit, add or remove the gated stages; it called removing a fact "an admin's
choice", which was not true. Both are closed above; the contract also refuses the behaviour's own
kept fields.
