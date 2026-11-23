# ADR 0648: A child's paper form copy goes to the guardian staff pick

Status: accepted, 2026-11-24 (stage 44, the owner's decision of 2026-11-24). Amends
[ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md) ("Paper for a
child"); builds on [ADR 0646](0646-erase-merge-and-retention-for-agreements.md) (erase and the
scrub) and [ADR 0540](0540-the-family-link.md) (the family link). Migration 0857.

## Context
ADR 0645 sent a paper form's copy, when staff press "Email a copy", only to an adult's own address.
For a child (a Person marked a minor, or a live dependant) it was refused for now: staff gave the
guardian the PDF download. The owner decided on 2026-11-24 that the copy goes to the linked parent
or guardian staff pick.

## Decision
- **Who.** `agreement.copy.preview` lists, for a child's paper form, the child's live guardians (the
  link not ended, both out of the Trash, as the seam reads it) that have an address, each with
  their Person id, name and the address it would go to: their linked, active sign-in address, else
  their primary address (the rule an adult's own copy uses, `paperCopyAddress`). Only guardians the
  member of staff may see through the seam are listed. A person with `agreements:paper` only, never
  an AI; not in MCP.
- **Send.** `agreement.copy.send` takes the chosen guardian's Person id and `confirmTo`, which must
  equal the host's current address for that guardian (`agreement_copy_address_changed`). The
  address never comes from input. Anyone who is not a live guardian of the child at the send is
  refused (`agreement_copy_not_guardian`), a guardian with no address too
  (`agreement_copy_no_address`), and no choice when one is needed
  (`agreement_copy_guardian_required`). With no linked guardian who has an address it is refused as
  before (`agreement_copy_minor`): staff download the PDF. An adult's form takes no guardian.
- **The database.** The copy row records the guardian (`guardian_id`). The insert trigger allows,
  for a paper acceptance only, the address of a live guardian of its Person (their linked sign-in
  address or one of their addresses), checked in the same batch, and nothing wider; with no
  guardian, migration 0854's rule holds unchanged. The guardian changes only to a merge's survivor,
  or to nothing once that Person is gone, recorded once as `guardian_erased_at` with the address
  cleared. No insert over an existing row, no other change of the address, a sent copy stays sent.
- **What it says.** The copy is drawn as the guardian's own download of a child's paper form: it
  says it was recorded from paper and names the child in the file; the name on the form, who signed
  it and staff's note are not in it (those are staff's with `agreements:manage`). The email says it
  is for someone linked to them as their parent or guardian. Nothing names another guardian.
- **Erase.** The row is the child's acceptance's but the address is the guardian's. Erasing the
  child erases the acceptance, which clears the address and owes the scrub (ADR 0646); the
  guardian's address is never in the child's erase subject. Erasing the guardian clears their
  address and their id from the row, cancels a copy not yet sent, turns down and redacts its
  pending approval, owes the scrub of the email gatekeeper, and puts the address on their erase
  subject (`agreementAddresses`). The child's acceptance is untouched.
- **Unchanged.** Exactly-once sending, the idempotency key `agreement-copy:<acceptance id>`, the
  host's agreements mail and the gatekeeper's rules.

## Consequences
- The guardian picked gets the child's copy; another guardian is never told of it.
- Staff's "Email a copy" on a child's paper form lists the guardians with their addresses, then
  confirms (the Person page's Agreements tab).

## Proof
`packages/core/test/agreement-copy.test.ts` (the preview to the right staff and never an AI; a
send to a picked guardian once, to the host's address for them; an ended link, a non-guardian, no
address, a stale `confirmTo` and raw writes refused; the adult path unchanged; each branch of the
trigger) and `packages/core/test/agreement-erase.test.ts` (erasing the child, erasing the guardian,
a merge, and the database's rules for clearing the guardian).
