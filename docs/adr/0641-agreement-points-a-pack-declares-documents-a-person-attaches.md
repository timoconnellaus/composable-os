# ADR 0641: Agreement points: a pack marks the place, a person attaches the documents

Status: accepted, 2026-11-23 (stage 44, build step 1; the declaration is inert until step 3).
Extends [ADR 0404](0404-behaviours-are-the-vocabulary.md) (behaviours are the vocabulary) and
[ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (`sellable`). Stage
44's spec, "The `agreements` behaviour".

## Context
Where agreement is needed differs by business: one gym has one waiver for everything, another a
waiver for kids' classes only. A pack cannot know a business's documents, and it must not hook
the writes that buy or book (ADR 0405). The business decides what is needed; the pack only knows
the places it could be.

## Decision
- **An object declares an agreement point**: `agreements: { point, label, suggests?, enter?,
  person? }` in the SDK (`packages/sdk/src/agreements.ts`), carried on the registry's object
  definition. `point` is a lowercase word objects may share; `label` is what the admin shows;
  `suggests` lists kinds the admin offers first. Without `enter` the point is checked where the
  object is bought, so the object must be `sellable`; with `enter` (states of the object's
  `states`) it is checked when a caller's record enters them, for the Person its `person`
  relation names. The contract check (`checkObjectAgreements`) refuses anything else.
- **Documents are attached by a person.** `agreement.attach` and `agreement.detach` (with
  `agreements:manage`, `actors: ["human"]`) add and remove `core_agreement_point` rows; only a
  `live` document is attached (a trigger refuses it otherwise) and only to a point an installed
  object declares (`agreement.points` lists them). `agreement.retire` detaches it everywhere.
  Each bumps `core_agreement_rev` (ADR 0640). Nothing is attached by default.
- **Inert in step 1.** Nothing asks a point yet: step 2 adds `agreementsDue`, step 3 the checks in
  the orders pipeline, `startSubscription` and the transition engine, and the points on
  Memberships, Bookings, Ticketing and Courses. Until then attaching changes what is recorded,
  never what anyone may do.

## Proof
`packages/core/test/agreements.test.ts`: a fixture pack's point listed with its label and
suggestions; attach refused for a draft (by the operation and the database) and for an undeclared
point; attach, detach and retire and their counter bumps; the contract check refusing a bad name,
an `enter` on an object without states, and a missing person relation.
