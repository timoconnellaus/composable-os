# Stage 22: Customers and audiences

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Audiences and customers, Trust boundaries), [`CONTEXT.md`](../../CONTEXT.md), ADR
[0402](../adr/0402-staff-and-customers.md), [stage 14](14-teams-permissions.md),
ADRs 0003, 0008, 0018, 0019, 0023, 0025, 0244, 0245, 0247, 0320, and
`packages/core/src/principals.ts`, `pipeline.ts`, `invoke.ts`, `gate.ts`, `list.ts`,
`rate-limit.ts`.

Status: spec proposed. Builds on stage 20 and on **stage 14a** (the visibility seam). This stage
changes what the host exposes to people outside the org. It is reviewed with the most care of any
stage here.

## Goal

A person who is not staff can have an account. Signed in, they can read and change their own
records and nothing else: not another customer's records, not staff notes on their own record, not
the admin, the MCP surface or any SQL. A visitor with no account can call the few operations marked
public. Every existing operation stays staff-only until someone opens it on purpose, and opening
one shows up in review.

## What exists today (from the code)

- **Roles:** `admin`, `member`, `viewer` (`ROLES` in `packages/core/src/principals.ts`), in
  `core_user.role`. `core_user` is Better Auth's own table. Permissions are object-agnostic
  (`records:read`, `records:write`, …).
- **Actors:** people, MCP (role ∩ scopes), the assistant (as the person), extensions and
  automations (as the extension principal), system jobs.
- **One pipeline:** `invoke()` validates, gates, checks the role, runs the handler and writes one
  D1 batch with the audit row.
- **Visibility:** stage 14a's seam (ADR 0244) is specced, not built. A precedent is: private
  activities are filtered in the base views, search, embeddings and summaries.
- **No customer exists.** Every signed-in user is staff. There is no public operation; inbound
  webhooks arrive through a gatekeeper, not an operation.
- **Ghetto's app** has its own Better Auth users (clients and coaches) and its own `/api/app/*`
  routes in the Ghetto repository, outside any of this.

## Scope

### Audiences on operations
- An operation definition gains `audiences`, a non-empty subset of `staff`, `customer`, `public`.
  Left out, it is `["staff"]`.
- `invoke()` refuses a call whose principal's audience is not listed, before validation, with one
  error that does not say whether the operation exists.
- Operations open to `customer` or `public` may have risk class `read` or `write` only. The
  registry refuses to load one with any higher class.
- A generated file lists every operation open to `customer` or `public`, with its risk class. It
  is committed, and CI fails when the registry and the file differ. Opening an operation is then
  always a visible line in a diff.
- `defineTool` in the SDK gains the same key. A runtime extension that opens a tool to customers
  or the public is proposed at the highest risk class, the diff says so in words, and only a human
  admin can approve it.

### Customer accounts
- A **customer account** links to exactly one `core_person`. Tables are `core_customer` and its
  sessions, separate from `core_user`.
- Customer sign-in runs as a second Better Auth configuration with its own tables, cookie name and
  secret. A customer session cannot be read as a staff session by any code path, because it is
  never in the same table or cookie.
- Sign-in is by a one-time code sent to an email address. No passwords in this stage.
- At first sign-in the verified address is matched to a Person by the existing "same email" rule.
  One match links; none creates a Person; more than one creates nothing and tells staff, who merge
  first. The erased-address list is checked, as `sync.ingest` does.
- The principal is `{ kind: "customer", customerId, personId }`, and the audit actor is `customer`.
  A public call has principal `{ kind: "public" }`.

### What a customer can see: the `customer` key
- An object declares its customer and, field by field, what the customer may read and write:
  `customer: { field: "buyer", read: ["status", "total"], write: [] }`. Fields not listed are
  invisible to customers. Nothing is visible by default.
- The base records declare theirs in core: a Person is its own customer, with a short list of
  readable and writable fields (name, email, phone). Organisations, Activities and Tasks declare
  none in this stage.
- The visibility seam gains a customer scope: for a customer principal, every read is limited to
  rows whose customer field is their Person, and to the declared fields. Writes are checked the
  same way, and may set the customer field only to themselves.
- The seam is the only place this is enforced. An operation handler never filters by customer
  itself.

### Operations opened in this stage
- `me.get`, `me.update`: the customer's own Person, declared fields only.
- `my.list { object, filter?, sort?, cursor? }`, `my.get { object, id }`: generic reads of any
  object that declares a customer, through the seam.
- `customer.signOut`, `customer.sessions.list`, `customer.sessions.revoke` for the customer.
- For staff (`users:manage`): `customer.list`, `customer.disable`, `customer.enable`,
  `customer.revokeSessions`. A Person's page shows whether they have an account and when they last
  signed in.
- No generic customer write. A customer changes extension records only through a tool a pack
  opens to them.
- No public operation ships in this stage. The audience exists and is tested with a fixture.

### What customers and the public can never reach
The admin UI, `/mcp`, Code Mode, `query.sql`, dashboards, exports, the approval queue, the
assistant, and every operation not in the generated list. A request with a customer session to any
of them gets the same answer as a request with no session.

### Approvals, limits and audit
- A customer's call is not queued for approval. The gate allows or refuses it.
- Customer and public calls are rate limited per account and per operation, and public calls per
  client address through Cloudflare's rate limiting, with no address stored.
- Customer writes are audited with field diffs like any write. Customer reads are counted, not
  audited row by row (ADR 0090's rule for non-human readers, applied here).

### Erase and merge
- Erasing a Person deletes their customer account and sessions, and the address goes on the
  erased-address list as now.
- Merging two people moves the account to the survivor. When both have one, the merge is refused
  with a reason until staff disable one.

## Out of scope
- The HTTP surface these calls arrive on (stage 23). This stage is tested through `invoke()`.
- Passkeys, social sign-in, passwords.
- A customer acting for someone else (a parent for a child, a coach for a client).
- Staff seeing fewer records than today: that is stage 14a.
- Customer access to Activities (a customer-visible timeline).
- Moving Ghetto's existing accounts across (stage 27).

## Acceptance criteria
1. **Default closed:** with this stage merged and nothing else changed, the generated list holds
   only the operations named above, and every other operation refuses a customer and a public
   principal.
2. **Isolation, generically:** a test builds two customers, A and B, each with records in every
   fixture object that declares a customer, and calls every operation in the generated list as A
   with B's ids, B's filters and guessed ids. No response holds a value from B's rows, and no
   write changes one. The test reads the registry, so a newly opened operation is covered without
   being added by hand.
3. **Fields:** a field not listed in `read` never appears in a customer's response, including in
   filters, sorts, errors and field diffs. Filtering or sorting on one is refused.
4. **Closed surfaces:** a customer session gets the no-session answer from the admin routes,
   `/mcp`, `query.sql`, dashboards and exports.
5. **Sessions apart:** a customer cookie presented as a staff cookie, and the reverse, is refused.
6. **Risk floor:** an operation or tool declared with a higher risk class and a `customer` or
   `public` audience fails at load, with a message.
7. **Extensions:** a runtime extension opening a tool to customers is proposed at the highest risk
   class and cannot be approved by a non-human actor.
8. **Sign-in:** code sign-in links to the one matching Person, creates one when none matches, and
   refuses to link when several match; an erased address is refused.
9. **Erase and merge** behave as specified, and erase leaves no customer row, session or code.
10. **Limits:** rate limits hold per account and per operation; no client address is stored.
11. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Audience, Customer, Public)
    and `docs/architecture.md` are updated.

## Dependencies
- **Stage 14a.** The customer scope is one more scope on its seam. If 14a is not on `main`, this
  stage either waits or builds the seam for the read paths it needs, and 14a then extends it. The
  first is safer.
- Stage 20.

## Migrations and numbers
Migrations 0400 to 0409. ADRs 0410 to 0414, and ADR 0402 amended as built.

## Suggested build order
1. `audiences` on operations, the refusal in `invoke()`, the risk floor and the generated list.
   Nothing is opened yet.
2. The customer principal and the customer scope on the seam, with the isolation test written
   first against fixture objects.
3. Customer accounts and sign-in.
4. `me.*`, `my.*`, the staff operations and the Person page.
5. The `customer` key and `audiences` in the SDK, with the approval rules.
6. Erase and merge.

## To settle at the interview
- **Stage 14a first, or the seam built here?**
- **Sign-in methods.** Email code only is proposed. Ghetto's app has its own today; what its
  members expect matters.
- **Can one human be staff and a customer?** A coach who also buys a ticket. Proposed: two
  accounts that happen to share an address, never one session with both.
- **Generic `my.list` and `my.get`, or reads only through pack tools?** Generic reads mean less
  code per pack and one seam to test; pack tools mean a smaller surface.
- **Should any customer call ever wait for staff approval?** A refund request, for example.
  Proposed: no, such things are records a staff member then acts on.
- **A customer-visible timeline,** and whether that is this stage's or a later one's.
