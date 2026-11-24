# ADR 0402: Staff and customers are different principals

Status: accepted, 2026-11-20 (design conversation and stage 22 interview).

## Context
Every signed-in user of the CRM is staff: `admin`, `member` or `viewer`, with
object-agnostic permissions (`packages/core/src/principals.ts`). Products built on the platform
have a second kind of user. A gym member opens the app to see their own programme. A ticket buyer
opens their own tickets. Neither may see anyone else's records, the admin, the MCP surface or
`query.sql`. A third kind has no account at all: a visitor reading an event page or starting a
checkout.

## Decision
- **Three audiences: `staff`, `customer`, `public`.** Every operation declares which audiences may
  call it. The default is `staff` only, so nothing existing opens up.
- **A customer is a Person who can sign in.** The customer account links to one `core_person` row.
  It is not a `core_user` row and never holds a staff role.
- **An object declares its customer.** An object names the relation field that says whose record
  it is (for example `customer: "buyer"`). A customer reads and writes only records where that
  field is their own Person, and only through operations that allow the `customer` audience.
- **Scoping is enforced at the visibility seam** of ADR 0244, not in each operation. Stage 22
  builds the seam's first door (one filtered source every read takes); stage 14a later adds staff
  scopes, the SQL rewrite and search hydration to the same seam.
- **Nothing is visible to a customer by default.** An object lists, field by field, what its
  customer may read and write.
- **Customers read generically and write through named tools.** `my.list` and `my.get` read any
  object that declares a customer; a customer changes records only through a tool a pack opens.
- **Customers and the public never reach** the admin UI, MCP, Code Mode, `query.sql`, dashboards,
  exports or the approval queue. Operations open to them carry a risk class at or below a floor
  set in code, and are rate limited.
- **Identity and policy stay not AI-configurable.** Which audience an operation allows is in code
  and changes by release. A runtime extension cannot open a tool to customers or the public; only
  shipped extensions and an org's own reviewed ones can.
- **A customer account is separate from a staff account,** in its own tables and cookie, even for
  the same human. Sign-in is a one-time code by email, and whether sign-up is open or by invite is
  a product setting.
- **A customer's call is never queued for approval.**
- **A customer can delete their account:** it is disabled at once, and an erase request goes to
  staff with a due date.

## Why
A staff role with few permissions is the wrong tool: staff permissions are about what kind of thing
you may do, and customer access is about whose records they are. Keeping the two apart means a
mistake in a role table can never show one customer another's data.

## Consequences
- Stage 22 does not wait for stage 14a. It builds the part of the seam it needs, and 14a must
  extend that seam and not add a second one.
- The seam gains field-level rules for customers, which ADR 0244 did not have for staff.
- Erase (ADR 0320) must also remove a person's customer account and sessions.
- Extension objects need the `customer` key in the contract: a contract addition.
- Left for later: passkeys and social sign-in, a customer acting for someone else, a timeline
  customers can see, and staff previewing an app as a customer.

## As built (stage 22, 2026-11-20)
Built as decided, with these additions and changes. Each has its own ADR.
- The seam's first door, and the one-seam test as a ratchet: [ADR 0410](0410-the-seams-first-door-as-built.md).
- The audience check, the risk floor and the generated list `packages/core/open-operations.json`:
  [ADR 0411](0411-audiences-on-operations-as-built.md).
- The customer and public principals, the pipeline's path for them, and the customer scope:
  [ADR 0412](0412-customer-scope-and-principals-as-built.md).
- A handler called from outside the org has no raw database; `hostInternal` is the one escape:
  [ADR 0413](0413-outside-handlers-have-no-raw-database.md).
- A pack's tool called by a customer runs as that customer, with per-tool field widening, and a
  runtime extension can open neither a tool nor an object:
  [ADR 0414](0414-pack-tools-run-as-the-customer.md).

Changed from the decision above:
- "Customers read generically and write through named tools" holds, and the tools write through
  two tool-only operations, `my.create` and `my.update`.
- A Person's email is readable by its customer and not writable. Changing it would have to say
  whether another Person has the address. Sign-in uses the account's own address.
- "Several people match" at first sign-in cannot happen while live emails are unique. The case
  that does happen is a Person who already has another account; it is handled the same way.
- A Person created at first sign-in is recorded as created by the inviting admin, or the first
  admin, because `core_person.created_by` is a staff user.
- A deploy-time floor that asks for review does not apply to customers or the public.
- Deleting an account: `me.deleteAccount` (`hostInternal`) disables the account, ends its
  sessions and creates the erase request in one batch; a second call makes no second request.
  The due date is `customer.settings` `eraseDueDays` (default 30, human admins only). Requests are
  listed and declined under Settings → Storage; a decline is emailed through the email-send
  gatekeeper as the admin who declined, after the decline commits. The daily maintenance cron
  (cos-app's, where the Trash purge and audit retention run) reminds admins once a day about an
  overdue request.
- Erase deletes the erase request rather than keeping it closed: only the audit trail (the
  request closed as `erased`) remains. It also deletes sign-in codes, invites and any account
  signed up with one of the person's addresses, and lists the account's own address as erased.
- Merge: when both people have an account and one is disabled, the disabled one is deleted; when
  both are disabled, the duplicate's is. Open erase requests follow the duplicate to the survivor
  unless the survivor has its own.
- Limits: a customer per account and operation; code requests per address asked for. Public calls
  have no account to key on and are limited per client address at the edge only (stage 23).

## Note, 2026-11-23 (ADR 0458)
The sign-up setting gains a third value, `buyers`: an invited address, one with an account, or the
buyer's address of an order a verified payment was applied to. `invite_only` stays the default.

## Note, 2026-11-23 (ADR 0540)
"A customer acting for someone else", left for later above, is built for one case: a guardian
(a parent) staff linked to a dependant (a child) reads, and where an object says so writes, the
dependant's records ([ADR 0540](0540-the-family-link.md)). The link is a core record made only by a
person on the staff with `people:link`; the seam alone decides what it gives, per object that opts
in (`customer.guardians`), and nothing else a customer reads or writes changed.

## Note, 2026-11-24 (ADR 0720)
The public may now create one kind of record besides a purchase: a submission to a published form,
through the host's one door, `intake.submit` (`toolOnly`, `hostInternal`, reached only from the
form's own pack's tool). The host writes it as its own change after its checks; nothing else opens
a write to the public ([ADR 0720](0720-the-intake-door-one-public-write.md)).

## Note, 2026-11-24 (ADR 0713)
Deleting an account now says first what it will do: `me.deleteAccount` without `confirm` is a
preview, and with `confirm: true` and the preview's `expect` it also sets each subscription the
member pays to end at its period's end (nothing refunded) and cancels their unpaid orders before
disabling the account and opening the request. Admins' notice says what was left for staff
([ADR 0713](0713-deleting-an-account-the-preview-and-its-consequences.md)).
