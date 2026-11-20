# ADR 0402: Staff and customers are different principals

Status: proposed, 2026-11-20 (design conversation). To be settled at the stage 22 interview.

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
- **Scoping is enforced at the visibility seam,** the one place stage 14a puts owner-based
  visibility (ADR 0244), not in each operation.
- **Customers and the public never reach** the admin UI, MCP, Code Mode, `query.sql`, dashboards,
  exports or the approval queue. Operations open to them carry a risk class at or below a floor
  set in code, and are rate limited.
- **Identity and policy stay not AI-configurable.** Which audience an operation allows is in code
  and changes by release or approved extension, never by an AI actor at run time.

## Why
A staff role with few permissions is the wrong tool: staff permissions are about what kind of thing
you may do, and customer access is about whose records they are. Keeping the two apart means a
mistake in a role table can never show one customer another's data.

## Consequences
- **Depends on stage 14a** (roles, teams and the visibility seam), which is specced and not built.
  Customer scoping is built on that seam or is built with it.
- Erase (ADR 0320) must also remove a person's customer account and sessions.
- Extension objects need the `customer` key in the contract: a contract addition.
- Open: one sign-in method for customers or several (email code, passkey, social), and whether a
  staff member can also be a customer with one account.
