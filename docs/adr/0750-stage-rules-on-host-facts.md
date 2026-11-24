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
  `requiredByType` may name any field of the object except a formula and the stage field itself.
  A read-only field is a **host fact**: only the host, or the declaring extension's own code (ADR
  0246: its own act, such as Jobs' `recordAcceptance`, a person's tool), writes it. Every other
  write that names it is refused before the engine runs ("is set automatically and cannot be
  written").
- **The engine is unchanged in what it refuses**: entering the stage, or creating a record in it,
  with a required field empty fails with `stage_required_fields` for every caller of the record
  operations (tested: people, MCP clients applied or queued for approval, an extension's code, the
  CSV import and the host itself; the assistant and the board call the same operations). Once
  the fact is set, staff may make the move; platform code may set the fact and make the move in
  the one write (the act's own batch). While the record is in the stage, a write that empties the
  fact is refused, the host's included.
- **The refusal names the fact first and says it is not entered by hand.** The missing read-only
  fields come first in `fields` (so `field`, which a UI asks for, is the fact), the details carry
  `setByHost: [...]`, and the message reads "Accepted needs Accepted at; Accepted at is recorded
  when it happens and cannot be entered by hand". The board's missing-field dialog offers only
  writable fields (`missingFieldOf`), so for a host fact it shows the message instead. `setByHost`
  is added by the engine, so a `states` refusal for a host move missing its read-only field
  carries it too; the `states` contract rule of ADR 0425 is unchanged.

## Consequences
- No migration, no new statement: the rule costs what a stage rule did.
- A stage's required fields are the business's settings, edited by whoever may write the stage
  object. Removing a host fact from a stage's list (or a business renaming the stage) is an admin's
  choice and drops the guarantee for that stage; a pack that must keep it can name the field in
  `requiredByType`, which the pack declares and no admin edits, when the whole stage type needs it.
- Jobs (step 5) declares `acceptedAt`, `signedOffAt` and `invoicedAt` read-only and lists them in
  the seeded Accepted, Signed off and Invoiced stages. The acts that set them are later steps:
  Jobs' `recordAcceptance` (step 5), the acceptance of a record (step 4), stage 35's invoice.
- Tests: `packages/core/test/stage-host-facts.test.ts`.
