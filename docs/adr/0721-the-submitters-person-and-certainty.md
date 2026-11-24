# ADR 0721: The submitter's Person, its certainty, and empty fields only

Status: accepted, 2026-11-24 (stage 29, build step 2). Amends
[ADR 0428](0428-buying-without-an-account.md): its address matcher is now shared. Builds on
[ADR 0720](0720-the-intake-door-one-public-write.md) and ADR 0247 (the same-email rule).

## Context
An enquiry is kept and linked to the right Person, but anyone can type anyone's address, and
confirming the address first would lose enquiries (decision 7). A guest's order already matches a
typed address to a Person (`resolveBuyer`); a form must match it the same way, without copying it.

## Decision
- **One matcher, shared**: `personForAddress` (`packages/core/src/customers/address-person.ts`),
  moved out of `orders/guests.ts`; `resolveBuyer` calls it with its own notice. One live Person
  with the address is theirs; none creates one in the call's batch (for the inviting or first
  admin, as at sign-in); several link none and admins are told to merge them. An address that is
  not one and an erased person's address are refused with the same words, "That email address
  cannot be used", as `order.start` refuses them.
- **Certainty, set by the host** on the submission: `account` (a signed-in customer: their own
  Person, whatever address they typed), `staff` (entered by staff, the address they typed matched),
  `address` (a visitor's typed address), and `link` (a personal link, step 5). An anonymous form
  has none (ADR 0725). A form with no question mapped to the Person's email has no Person unless
  the caller is signed in.
- **Empty fields only, for every certainty.** The answers to the questions mapped to the Person
  fill its name only when it has none of its own (no given or family name, and its shown name is
  one of its addresses) and its phone only when it has none. A name, a phone or an address already
  there is never changed, no address is added, and no customer account is touched. A new Person
  starts with the address, the name and the phone answered.
- **Staff see "unconfirmed address"**: the submission's certainty is `address`, and the notice to
  staff says it came from an unconfirmed address.
- **Spam makes no Person.** A submission kept as spam (ADR 0722) is linked to the caller's own
  Person when signed in and to none otherwise, and fills nothing.
- **Two first answers from one new address at once** each try to make a Person; the database keeps
  one address to one live Person and refuses the second batch. That caller is told "your answers
  were not kept: please send them again" (`conflict`, `rule: "intake_retry"`, through
  `explainFailure`, which the pipeline now runs on outside calls as on staff ones); sent again,
  it is matched to the first's Person.

## Consequences
- A stranger's phone or name fills a member's empty phone or name (decision 7 allows it; staff see
  the submission came from an unconfirmed address).
- Until erase covers submissions (step 7), `person.erase` does not remove a Person's submissions or
  the addresses typed in their answers. No shipped pack declares `intake` yet.
- A stranger who types a member's address attaches a message to the member, which staff see as
  unconfirmed; nothing on the member's record changes and nothing is sent to them but, in step 5,
  the receipt.
- Not yet tried on a live host.
