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
