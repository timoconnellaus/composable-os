# ADR 0712: Changing the sign-in address and a recent sign-in

Status: accepted, 2026-11-24 (stage 48, build steps 2, 3 and 3b; interview decisions 4 and 5).
Amends ADRs [0421](0421-the-client-app-binding-and-customer-sign-in.md) (the sign-in address) and
[0456](0456-the-hosts-sign-in-mail.md) (the host's sign-in mail). Builds on ADRs
[0402](0402-staff-and-customers.md), [0419](0419-native-sessions-and-customer-sign-in.md),
[0428](0428-buying-without-an-account.md), [0459](0459-anyone-starting-a-subscription.md),
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md) and [0487](0487-the-payer-and-the-holder.md).
Closes issue [#302](https://github.com/timoconnellaus/composable-os/issues/302).

## Context

A customer account's sign-in address is the identity the company links to (ADR 0421), and until
now nothing could change it: `me.update` refused the email, and staff editing the Person's
contact email left the old address as the sign-in key. A member who changes mailbox needs to move
their account, and the change is an account-takeover path: a stolen or forgotten-open session
could move the account to someone else's mailbox. The owner decided (stage 48, decisions 4 and 5):
a code emailed to the new address, entered by someone signed in within the last 15 minutes; the
old address always told; staff may start a change for a member who phones, and only the code at
the new address finishes it.

Separately, erase took every address a Person ever held, including one they moved away from that
another Person has since taken (#302): erasing the first deleted the second's account.

## Decision

### A recent sign-in (`sign_in_again`)

- **Acts that could hand an account to someone else need a sign-in within the last 15 minutes:**
  `me.email.change`, `me.email.confirm` and `me.deleteAccount`. Otherwise the call is refused with the new error code
  `sign_in_again` (HTTP 403, not 401: the session is good for everything else and a client must
  not drop it; `details.withinMinutes`). The blocks send the member through the code sign-in and
  back.
- **"Signed in at" is the session's own row,** the one the adapter says the call came with
  (`origin.sessionId`), and only while it is the caller's own account's: a browser session's
  `core_customer_session.created_at` (written once, at the code sign-in), or a native app's
  `core_device_session.created_at` (a refresh rotates tokens, never the start). No session, a
  foreign one or one dated in the future is not recent.
- **Exchanging a browser session for an app's tokens keeps its age.** `/auth/token` starts the
  device session at the browser session's own sign-in (`resolveSession` now returns
  `signedInAt`; `issueDeviceSession` takes it), so the exchange never makes an old sign-in recent.

### Changing the sign-in address

- **A record per request, `core_customer_email_change` (migration 0990):** the account, the new
  address (and its mailbox key, for counting), the address it replaces, who started it
  (`customer` or the staff user's id), the code's hash (salted with the row's id) and its expiry
  (15 minutes), tries left (5), when it was made, confirmed or ended and why (`replaced`,
  `cancelled`, `tries`, `in_use`, `unsent`). One open per account, by a partial unique index; a
  newer request ends the open one as `replaced` in the same batch.
- **Closed is final, in the database.** A trigger refuses any update to a confirmed or ended row
  (except reopening an `unsent` one). Every batch planned from an open change writes to it by id
  alone: a confirm sets `confirmed_at` first in its batch, a cancel or a newer request sets
  `ended_at`. Whichever commits second fails whole (`conflict`, `rule: email_change_closed`), so a
  cancel never answers `cancelled: true` for a change that went through, a request is never
  planned from an address the account no longer has, and two right codes at once apply once.
- **`me.email.change` (customer, `hostInternal`, recent sign-in):** emails a six-digit code to the
  new address and answers `{ newEmail, expiresAt }` the same whether the address is free, held by
  another Person or account, or erased. Whether it can be used is never looked at here.
- **`me.email.confirm` (customer, `hostInternal`, recent sign-in):** for the account's own
  session, signed in within 15 minutes whoever started the change (owner decision 4), with the
  code.
  A try is spent first, at once and on its own, so racing guesses still count; a wrong code says
  how many tries are left and the fifth ends the change. A right code for an address another
  Person, another account or the erased-address list holds is refused (`conflict`, "This address
  is already in use at the business", `rule: address_in_use`), ends the change and changes
  nothing: only the person who proved the mailbox learns it is in use. A change the account has
  moved on from (disabled, relinked, its address changed) is ended and said so (`change_stale`).
  A change that would give the Person more than 20 addresses is refused before a try is spent.
  Otherwise, in one batch
  with the audit row: the account's address; the Person's emails (the new address first and
  primary, the old sign-in address removed, every other address kept), written by the Person
  writer as a host change for the customer (ADR 0428); every other session of the account ended,
  web and app (the confirming one stays); a sign-in code still waiting for the old address
  deleted; a timeline activity "Sign-in address changed" naming no address. The code is redacted
  from the audit (`redact: ["code"]`). The Person's addresses are inserted at most 14 rows per
  statement, under D1's 100 bound variables (`person.update` shares the code).
- **After the commit,** never undoing the change and logged when it fails: the notice to the old
  address, whoever started the change, naming the new one only in part (`a•••@example.com`); and
  the payment provider given the new address (below).
- **Limits** are counted from these rows in D1, the same for every address: 5 requests per account
  in a rolling hour, 3 per mailbox (`mailboxKey`, ADR 0459) within a code's 15 minutes. A request
  is reserved before its code is sent: one conditional insert of its row, ended `unsent`, runs
  only while both counts are under their limits, and D1 runs one statement at a time, so parallel
  requests cannot pass them. The request's batch reopens the row once the code went out; one that
  did not go out stays `unsent`, still counted and never confirmable. The per-account,
  per-operation limit of every customer call (ADR 0402) applies on top. A refusal for a mailbox
  says that others asked for it lately, nothing about accounts.
- **Staff start a change, never finish one.** `customer.changeEmail` and
  `customer.cancelEmailChange` are admins' (`users:manage`), humans only, outside MCP: identity is
  not AI-configurable. The code goes to the new address and the member enters it, signed in to
  their account; the staff member's answer, the audit and the account card never carry it.
  `customer.list` shows an open change (the new address masked, who started it, when it expires)
  and an open erase request, for the staff card (step 7).

### The host's mail for it (amends ADR 0456)

- The code and the notice are the host's sign-in mail: sent with `callAsHost` purpose `sign-in`,
  so the email gatekeeper gives them the `email.signin` kind, which applies at once once an admin
  turned it on. The gatekeeper's fixed templates grow from one to three: the sign-in code, the
  address change's code ("Confirm your new … sign-in address", a six-digit code, 15 minutes) and
  the notice ("Your … sign-in address was changed", the new address only as
  `<first character>•••@<domain>`). Anything else is an ordinary send, as before.
- Only a send that went out counts. One the gate would hold for review is refused before anything
  is stored (`integration_error`), so a code never waits where an approver could read it (ADR
  0455), and the host's mail not being ready is a `config` refusal, the same for every address.

### Giving the provider the new address (step 3b)

- A new payments gatekeeper capability, `updateCustomerEmail({ customerRef, email, changeId })`:
  the host's own call only (the queue answers `isHostOrders()`; Code Mode, extensions, the
  assistant and MCP are refused), submitted as the action `payments.customer.email` (never
  auto-approvable; the host applies its own call at once). Stripe: `POST /v1/customers/:id` with
  `email`, idempotency key `cos-email-<changeId>-<customerRef>`. The fake records it per customer.
- After the commit, the host asks it for every provider customer the member pays through (one per
  subscription a guest started, ADR 0487; at most 20). A member who pays nothing needs no payments
  connection.

### Erase and former addresses (#302)

- Erase reads the change records for the subject's former sign-in addresses (a confirmed change's
  old address) and the addresses they asked for (an unconfirmed change's new one, a term only),
  before the account and its rows are deleted.
- **A former address is the subject's only while no other identified Person holds it now:** a
  live email of a Person outside the erase, or the sign-in address of a customer account linked to
  one. Former means from the audit, from an address change, or left behind in the Trash; a live
  email of the subject's is always theirs. Such an address is left out of the erase's terms and the
  erased-address list, so its account is not deleted and its mentions are not redacted. The check
  is in `personSubject`, the one place erase collects former addresses, and on the subject's own
  account's sign-in address in `queueErase` (staff may have moved that address to another Person
  without the account changing; the subject's account is still deleted, by its Person). So it holds
  for addresses moved by staff editing a Person's emails too, and #302 is closed whole.

## Consequences

- Clients get one new error code to handle (`sign_in_again`); `packages/client` passes codes
  through as strings, so nothing breaks.
- A member signed in for more than 15 minutes is asked to sign in again before asking for or
  confirming an address change, or deleting their account, in the browser and in the app. The
  code keeps working meanwhile.
- An address change ends the member's other sessions, including their other devices.
- The notice and the provider update can fail after the change committed; both are logged, not
  retried. A failed provider update leaves the provider's receipts going to the old address until
  staff change it at the provider. Not yet tried against a live provider account or a real mailbox.
- Erase redacts less: an address another Person holds now stays in the erased Person's old
  history, as the other Person's.

## Rejected

- **Changing the address by editing `primaryEmail`:** the sign-in address changes only when the
  new mailbox is proved (ADR 0421).
- **Reusing the sign-in code template for the change's code:** it says five minutes and "sign-in
  code"; the change's code lasts 15 and should say what it does. A template of its own, word for
  word, keeps the gatekeeper's rule exact.
- **Telling the asker an address is in use at the request:** it would let anyone probe who is a
  customer.
- **The limits on the Workers rate-limit bindings:** they are per isolate window and not reachable
  from an operation's context; the rows are already there, and counting them is exact.
- **No recent sign-in at confirm for a staff-started change** (the first build): it helps a member
  who kept only an old session, but lets a stolen long-lived app session finish a change staff
  were talked into starting. Decision 4 asks for a recent sign-in, so it holds for every confirm;
  a member who cannot sign in at all asks staff to change it another way.
- **Counting first and inserting after the send** (the first build): parallel requests all passed
  the count before any row existed (review of PR #384).
